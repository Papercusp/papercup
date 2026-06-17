/**
 * The hive inference gateway — a localhost transparent `/v1/*` reverse proxy that PACES the
 * fleet's requests through the existing rate governor and injects the bound account's OAuth, so
 * one Max subscription can serve many concurrent bees without each `claude -p` bursting blind
 * (hive-inference-gateway-2026-06-09 P-006 + P-007).
 *
 * Per request:
 *   1. parse `model` + estimate tokens from the body (token-aware admission, P-010);
 *   2. `governor.acquire(est)` — BLOCK until a slot frees (backpressure, D-004) rather than
 *      bursting; a wait longer than `maxQueueWaitMs` returns a synthetic 429 + `retry-after`
 *      (so a multi-hour capacity pause doesn't pin an HTTP socket open for hours);
 *   3. inject `Authorization: Bearer <bound-account-token>` + `anthropic-beta: oauth-…`
 *      (the bee sends UNAUTHENTICATED to 127.0.0.1) and forward to api.anthropic.com,
 *      streaming SSE through untouched;
 *   4. feed every response's `anthropic-ratelimit-*` headers back into the governor
 *      (`recordResponse` → unified-utilization pace/pause, D-009) and `penalize()` on 429/529.
 *
 * The proxy is otherwise byte-transparent: it strips `content-encoding`/`content-length` on the
 * way back (undici already decoded the body) and forces `accept-encoding: identity` upstream.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import {
  governorForBackend,
  PriorityAdmissionQueue,
  priorityFromLabel,
  classifyHttpError,
  parseUsageResetMs,
  type RateLimitGovernor,
  type AdmissionSnapshot,
} from '@papercusp/papercup-shared/agent';
import { withOAuthBeta } from './credential-store';
import type { AccountEgress } from '../deployment/account-pool';

/** `RequestInit` plus undici's `dispatcher` extension (per-account egress routing). The standard
 *  lib `RequestInit` type omits it, but Node's global `fetch` honors it. */
type UndiciDispatcher = import('undici').Dispatcher;
type FetchInit = RequestInit & { dispatcher?: UndiciDispatcher };

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const DEFAULT_MAX_QUEUE_WAIT_MS = 2 * 60 * 1000; // 2 min: past this, fail-with-retry-after
/** A header-less ("bare") upstream 429 carries no window/retry signal — but it comes with
 *  `x-should-retry: true`, i.e. a SHORT transient burst-throttle (capacity exists), NOT quota
 *  exhaustion (which sets retry-after / unified-window headers + x-should-retry:false). So pace the
 *  account for this short bounded backoff AND fail over — rotating off the momentarily-limited
 *  account instead of 429-looping it (the aviynw10 stuck-loop, 2026-06-17). Tuned to the observed
 *  transient-throttle duration: long enough to let it clear, short enough not to over-bench an
 *  account that's already recovered (which would thin the pool under broad concurrent contention). */
const BARE_429_FAILOVER_BACKOFF_MS = 15 * 1000;
/** Inspect a NON-200 upstream body up to this many bytes for a usage/session-limit signature (the
 *  Claude-Code subscription cap — "You've hit your session limit · resets 10:50am" — a WALL the bee
 *  classifies as usage_limit + WON'T retry). Such error bodies are tiny; this just bounds the read.
 *  Successful 200 streams are NEVER peeked, so the hot path keeps zero added latency. */
const USAGE_LIMIT_PEEK_BYTES = 64 * 1024;
/** When a usage/session-limit message carries no parseable reset, pause the capped account this long. */
const USAGE_LIMIT_DEFAULT_PAUSE_MS = 60 * 60 * 1000;
/** Bounded INTERNAL retry: how many upstream attempts the gateway makes on a SINGLE client request,
 *  walking past usage-capped / transiently-throttled accounts before giving up and forwarding the error.
 *  The gateway absorbs transient throttles itself so a bee's SMALL CLI retry budget never exhausts (the
 *  observed $0 fail: "Server is temporarily limiting requests · Rate limited" → bee exits rc=1 in ~10s),
 *  and routes around a usage cap (which the bee won't retry at all). */
const INTERNAL_RETRY_MAX_ATTEMPTS = 6;
/** Short backoff before retrying a TRANSIENT 429 on a freshly-rotated account (the throttle is
 *  account-specific, so a different account usually sidesteps it; the pause just avoids a hot loop). */
const TRANSIENT_429_BACKOFF_MS = 400;
/** Backoff before retrying a 529 (SERVER overload — not account budget, so we don't penalize/rotate the
 *  account; just wait briefly for the upstream to recover). */
const OVERLOAD_529_BACKOFF_MS = 1000;
const DEFAULT_CONCURRENCY = 24; // the queue is the concurrency authority; governor does rate/pause
/** A header-PINNED request waits at most this long on its pinned account before failing over to the
 *  pool's active() account (Fault #3): the spawn-side drain selector pins by the cross-process budget
 *  projection, which can't see the gateway's live pacing, so a pinned account may be actively paced —
 *  we must NOT 429-loop the bee into a $0 hang. Short, so failover is quick; cache-affinity yields. */
const PINNED_FAILOVER_WAIT_MS = 10_000;
/** Header a bee/spawn sets to prioritise its requests (interactive/queen > batch). */
export const PRIORITY_HEADER = 'x-papercusp-priority';
/** Header a spawn sets to pin its requests to one pool account for cache affinity
 *  (inference-gateway-multi-credential-routing P-003). Stripped before the upstream forward. */
export const ACCOUNT_HEADER = 'x-papercusp-account';
const ANTHROPIC_VERSION = '2023-06-01';
/** Hop-by-hop + body-framing headers never copied verbatim across the proxy. */
const STRIP_REQUEST = new Set(['host', 'authorization', 'x-api-key', 'x-papercusp-account', 'content-length', 'accept-encoding', 'connection', 'transfer-encoding', 'keep-alive']);
const STRIP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

/** The account the gateway currently egresses through — its id + a fresh-token getter. */
export interface ActiveAccount {
  accountId: string;
  token(): Promise<string>;
  invalidateToken?(): void;
  /** Per-account upstream egress (per-account IP routing — D-003). When set, the gateway forwards
   *  THIS account's upstream requests through a dedicated undici Dispatcher (an HTTP/SOCKS proxy or
   *  a bound source IP) so each Max subscription egresses from its own IP. Absent ⇒ default egress. */
  egress?: AccountEgress;
}

/**
 * A pool of accounts the gateway can fail over between (EI-535). `active()` is the account requests
 * egress through right now; `onExhausted` fires when the active account hits its 5h unified budget
 * (an upstream 429 with the unified window rejected) so the pool rotates to another account that
 * still has budget — returning the new active, or null when none is left (the gateway then degrades
 * to pausing until the reset, the pre-failover behavior).
 */
export interface AccountPool {
  active(): ActiveAccount;
  onExhausted(exhaustedId: string, resetAt: number): ActiveAccount | null;
  /** Per-request cache-affinity routing (inference-gateway-multi-credential-routing P-002): return
   *  the pool entry named by the `x-papercusp-account` header, or null when the id is unknown (the
   *  caller falls back to `active()`). A bee is pinned to one account for its whole life so its
   *  conversation cache — which is per-credential — survives. Optional: a single-account pool omits it. */
  select?(accountId: string): ActiveAccount | null;
}

export interface GatewayDeps {
  /** Single-account fallback: a fresh bearer for the bound account (the resolver's `current`).
   *  Superseded by `pool` when present. */
  token?(): Promise<string>;
  /** Drop the cached token (called on an upstream 401). */
  invalidateToken?(): void;
  /** Single-account fallback: bound account id — scopes the governor bucket + pool attribution.
   *  Superseded by `pool` when present. */
  accountId?: string;
  /** Multi-account failover pool (EI-535). When present, supersedes accountId/token/invalidateToken:
   *  the gateway reads the active account per request + fails over on 5h exhaustion. */
  pool?: AccountPool;
  /** Upstream base URL. Default `https://api.anthropic.com`; a fake in tests. */
  upstreamBase?: string;
  /** `fetch` impl (injected in tests). Default global fetch. */
  fetchImpl?: typeof fetch;
  /** The governor for a model (default: the shared per-account `claude-code` governor). */
  governorFor?(model: string): RateLimitGovernor;
  /** Max admission wait before a synthetic 429+retry-after. Default 2 min. */
  maxQueueWaitMs?: number;
  /** Concurrency authority — max requests forwarded at once (the queue cap). Default 24. */
  concurrency?: number;
  /** Aging interval for the priority queue (ms a waiter takes to gain +1 priority). Default 1000. */
  agingIntervalMs?: number;
  log?(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Fired with each upstream response's headers + status + the account that served it (pool
   *  projection / observability) — the gateway is the only process that sees the unified-budget
   *  headers, so this is how the cross-process drain projection (account utilization) is fed. */
  onResponse?(headers: Record<string, string | undefined>, status: number, model: string, accountId: string): void;
}

export interface GatewayStats {
  accountId: string;
  upstreamBase: string;
  totalRequests: number;
  inFlight: number;
  queueDepth: number;
  /** Per-priority queue breakdown (P-011 / P-014). */
  admission: AdmissionSnapshot;
  upstream429: number;
  queued429: number;
  /** Count of 5h-exhaustion failovers between pool accounts (EI-535). */
  failovers: number;
  upstreamErrors: number;
  /** The bound account's most-constraining unified window, if seen (D-009 / P-014). */
  unified?: { window: string; utilization: number; resetAt: number; rejected: boolean };
  pausedUntil: number;
}

/** Rough token estimate for admission (refined once the account exposes real headroom). */
export function estimateTokens(body: unknown): { inTok: number; outTok: number } {
  let inTok = 0;
  let outTok = 0;
  if (body && typeof body === 'object') {
    const b = body as { max_tokens?: number; system?: unknown; messages?: unknown };
    // ~4 chars/token over the serialized system + messages.
    const text = JSON.stringify({ system: b.system ?? '', messages: b.messages ?? [] });
    inTok = Math.ceil(text.length / 4);
    outTok = typeof b.max_tokens === 'number' ? b.max_tokens : 1024;
  }
  return { inTok, outTok };
}

/** Parse an upstream rate-limit reset (prefer the unified unix-seconds window) → {resetAt, retryAfterMs}. */
export function parseRateReset(h: Record<string, string | undefined>, now = Date.now()): { resetAt?: number; retryAfterMs?: number } {
  const out: { resetAt?: number; retryAfterMs?: number } = {};
  const unified = h['anthropic-ratelimit-unified-5h-reset'] ?? h['anthropic-ratelimit-unified-reset'];
  if (unified && /^\d+$/.test(unified)) out.resetAt = Number(unified) * 1000;
  else {
    const iso = h['anthropic-ratelimit-requests-reset'];
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isNaN(t)) out.resetAt = t;
  }
  const ra = h['retry-after'];
  if (ra && /^\d+$/.test(ra)) out.retryAfterMs = Number(ra) * 1000;
  // Guard: a wildly-large retry-after that disagrees with a near unified reset is untrustworthy
  // (observed: retry-after 15210s vs a 10-min reset). Prefer resetAt when both present.
  if (out.resetAt && out.retryAfterMs && out.resetAt - now > 0 && out.retryAfterMs > out.resetAt - now) {
    out.retryAfterMs = undefined;
  }
  return out;
}

/**
 * Parse the unified-5h rolling budget window from an upstream response (present on 200s too, not
 * just 429s) → the fraction used + the reset boundary. This is the cross-process signal the drain
 * selector routes by (more Max subscriptions = more aggregate 5h budget — the capacity lever).
 * `utilization` is a fraction where 1.0 = 100% (1.01 = over budget); `windowResetAt` is epoch ms.
 */
export function parseUnifiedWindow(h: Record<string, string | undefined>): { utilization?: number; windowResetAt?: number } {
  const out: { utilization?: number; windowResetAt?: number } = {};
  const u = h['anthropic-ratelimit-unified-5h-utilization'] ?? h['anthropic-ratelimit-unified-utilization'];
  if (u !== undefined) {
    const n = Number(u);
    if (Number.isFinite(n) && n >= 0) out.utilization = n;
  }
  const r = h['anthropic-ratelimit-unified-5h-reset'] ?? h['anthropic-ratelimit-unified-reset'];
  if (r && /^\d+$/.test(r)) out.windowResetAt = Number(r) * 1000;
  return out;
}

/**
 * Parse the unified-7d (weekly) rolling budget window from an upstream response
 * (`anthropic-ratelimit-unified-7d-*`) — the LONGER Claude Max limit alongside the 5h.
 * Sibling of parseUnifiedWindow: `utilization7d` is a fraction (1.0 = 100%); `windowResetAt7d`
 * is epoch ms. Surfaced read-only on the Accounts tab (accounts-pool-tab P-006); not (yet) a
 * routing input — the 5h window remains the drain selector's signal.
 */
export function parseUnified7dWindow(h: Record<string, string | undefined>): { utilization7d?: number; windowResetAt7d?: number } {
  const out: { utilization7d?: number; windowResetAt7d?: number } = {};
  const u = h['anthropic-ratelimit-unified-7d-utilization'];
  if (u !== undefined) {
    const n = Number(u);
    if (Number.isFinite(n) && n >= 0) out.utilization7d = n;
  }
  const r = h['anthropic-ratelimit-unified-7d-reset'];
  if (r && /^\d+$/.test(r)) out.windowResetAt7d = Number(r) * 1000;
  return out;
}

function headersToObject(h: Headers): Record<string, string | undefined> {
  const o: Record<string, string | undefined> = {};
  h.forEach((v, k) => {
    o[k.toLowerCase()] = v;
  });
  return o;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Read up to `capBytes` of a web ReadableStream into a `head` Buffer. If the stream ENDS within the cap
 * (the usual case for tiny error/limit bodies), `rest` is null and `head` is the whole body. If the cap
 * is hit first (a large streamed response), `rest` is a Node Readable yielding the REMAINING bytes (the
 * head is returned separately so the caller writes it first). Lets the gateway peek a NON-200 upstream
 * body for a usage/session-limit signature without buffering successful 200 streams. The generator's
 * finally cancels the reader on natural end OR an early destroy(), so a discarded body never leaks the
 * upstream connection.
 */
async function peekBody(
  webStream: ReadableStream<Uint8Array>,
  capBytes: number,
): Promise<{ head: Buffer; rest: Readable | null }> {
  const reader = webStream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      reader.releaseLock?.();
      return { head: Buffer.concat(chunks), rest: null };
    }
    chunks.push(Buffer.from(value));
    total += value.byteLength;
    if (total >= capBytes) break;
  }
  const head = Buffer.concat(chunks);
  const rest = Readable.from(
    (async function* () {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield Buffer.from(value);
        }
      } finally {
        reader.cancel?.().catch(() => {});
      }
    })(),
  );
  return { head, rest };
}

export function createInferenceGateway(deps: GatewayDeps) {
  const upstreamBase = (deps.upstreamBase ?? DEFAULT_UPSTREAM).replace(/\/$/, '');
  const doFetch = deps.fetchImpl ?? fetch;
  const maxQueueWaitMs = deps.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const log = deps.log ?? (() => {});
  const queue = new PriorityAdmissionQueue({ maxConcurrent: concurrency, agingIntervalMs: deps.agingIntervalMs });

  // A single-account deps set synthesizes a one-entry, no-failover pool; a real `pool` supersedes it.
  const pool: AccountPool =
    deps.pool ??
    (() => {
      const accountId = deps.accountId;
      const token = deps.token;
      if (!accountId || !token) throw new Error('inference-gateway: createInferenceGateway needs a `pool` or accountId+token');
      const single: ActiveAccount = { accountId, token, invalidateToken: deps.invalidateToken };
      return { active: () => single, onExhausted: () => null };
    })();

  // Governor is per (model, account). Reading the active account at call time means a failover
  // transparently moves pacing onto the new account's fresh bucket. The QUEUE is the concurrency
  // authority, so make the governor's own concurrency cap non-binding (raise it to the queue cap)
  // and let the governor enforce only rate/pause/pace — safe in the gateway's own process.
  const governorForAccount = (model: string, accountId: string): RateLimitGovernor => {
    const g = deps.governorFor ? deps.governorFor(model) : governorForBackend('claude-code', model, undefined, accountId);
    if (g.state.limits.maxConcurrent < concurrency) g.state.limits.maxConcurrent = concurrency;
    return g;
  };

  // Per-account egress dispatchers (per-account IP routing — D-003): a Max subscription can be pinned
  // to its own outbound IP via an HTTP/SOCKS proxy or a bound source address, so N subscriptions don't
  // all share one egress IP. Built lazily from undici + cached per (accountId + binding).
  const dispatcherCache = new Map<string, UndiciDispatcher>();
  let undiciMod: typeof import('undici') | undefined;
  async function dispatcherFor(account: ActiveAccount): Promise<UndiciDispatcher | undefined> {
    const eg = account.egress;
    if (!eg || (!eg.proxyUrl && !eg.localAddress)) return undefined;
    const key = `${account.accountId}|${eg.proxyUrl ?? ''}|${eg.localAddress ?? ''}`;
    const hit = dispatcherCache.get(key);
    if (hit) return hit;
    try {
      undiciMod ??= await import('undici');
      const d: UndiciDispatcher = eg.proxyUrl
        ? new undiciMod.ProxyAgent(eg.proxyUrl)
        : new undiciMod.Agent({ connect: { localAddress: eg.localAddress } });
      dispatcherCache.set(key, d);
      return d;
    } catch (e) {
      log('warn', `egress dispatcher for '${account.accountId}' failed (${(e as Error).message}); using default egress`);
      return undefined;
    }
  }

  let totalRequests = 0;
  let upstream429 = 0;
  let queued429 = 0;
  let upstreamErrors = 0;
  let failovers = 0;

  function stats(): GatewayStats {
    // Reflect the active account's opus bucket (the fleet's class) for the headline unified window.
    const active = pool.active();
    const gov = governorForAccount('claude-opus-4', active.accountId);
    const snap = gov.snapshot();
    const admission = queue.snapshot();
    return {
      accountId: active.accountId,
      upstreamBase,
      totalRequests,
      inFlight: admission.running,
      queueDepth: admission.queued,
      admission,
      upstream429,
      queued429,
      failovers,
      upstreamErrors,
      unified: snap.unified,
      pausedUntil: snap.pausedUntil,
    };
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown, extra?: Record<string, string>) {
    res.writeHead(status, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(body));
  }

  async function proxy(req: http.IncomingMessage, res: http.ServerResponse, url: string) {
    const bodyBuf = await readBody(req);
    let model = 'claude-opus-4';
    let est = { inTok: 0, outTok: 1024 };
    if (url.startsWith('/v1/messages') && bodyBuf.length) {
      try {
        const j = JSON.parse(bodyBuf.toString('utf8')) as { model?: string };
        if (typeof j.model === 'string') model = j.model;
        est = estimateTokens(j);
      } catch {
        /* non-JSON body (e.g. a count_tokens variant) — keep defaults */
      }
    }
    // Cache-affinity routing (P-002/P-003): a spawn pins its requests to one account via the
    // x-papercusp-account header so its per-credential conversation cache survives; an unknown id
    // (or no header / a single-account pool) falls back to the active account — today's behavior.
    const wantAccount = (req.headers[ACCOUNT_HEADER] as string | undefined)?.trim();
    const pinned = (wantAccount && pool.select?.(wantAccount)) || null;
    const poolActive = pool.active();
    // Fault #3 — pinned-but-paced failover. The spawn-side drain selector pins a bee to an account by
    // its cross-process BUDGET projection, which can't see the gateway's LIVE pacing — so it can pin a
    // bee to an account that's currently paced/exhausted by recent 429s. Strict-honoring the header
    // would 429-loop that bee into an indefinite $0 hang (alive, no model calls). So cache-affinity
    // YIELDS TO LIVENESS: if the pinned account's live governor is paused (or can't admit within a
    // short window), serve this request through the pool's active() (failover-walked to a healthy
    // account). The pin still holds for the bee's later requests — each re-checks, so it returns to
    // its per-credential cache once the account recovers.
    const canFailover = pinned !== null && poolActive.accountId !== pinned.accountId;
    let active = pinned ?? poolActive;
    let gov = governorForAccount(model, active.accountId);
    if (canFailover && active.accountId === pinned!.accountId && gov.state.pausedUntil > Date.now()) {
      log('warn', `inference-gateway: pinned '${pinned!.accountId}' paused → routing via active '${poolActive.accountId}' (cache-affinity yields to liveness)`);
      active = poolActive;
      gov = governorForAccount(model, active.accountId);
    }

    totalRequests++;
    // A still-pinned request gets only a SHORT admission wait, then fails over to active() rather than
    // waiting the full maxQueueWaitMs and 429-looping the bee.
    const stillPinned = canFailover && active.accountId === pinned!.accountId;
    let release = await gov.acquire(est, { maxWaitMs: stillPinned ? PINNED_FAILOVER_WAIT_MS : maxQueueWaitMs });
    if (!release && stillPinned) {
      log('warn', `inference-gateway: pinned '${pinned!.accountId}' admission-timeout → failover to active '${poolActive.accountId}'`);
      active = poolActive;
      gov = governorForAccount(model, active.accountId);
      release = await gov.acquire(est, { maxWaitMs: maxQueueWaitMs });
    }
    if (!release) {
      queued429++;
      const retryAfterSec = Math.max(1, Math.ceil((gov.state.pausedUntil - Date.now()) / 1000));
      log('warn', `admission timed out for ${model}; 429 retry-after ${retryAfterSec}s (account ${active.accountId})`);
      sendJson(
        res,
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: `inference-gateway: account '${active.accountId}' paced/paused; retry after ${retryAfterSec}s` }, gateway: true },
        { 'retry-after': String(retryAfterSec) },
      );
      return;
    }

    try {
      // Constant request headers (everything but the per-account Authorization/dispatcher, set per attempt).
      // Every account is a Claude Max subscription OAuth credential → `Authorization: Bearer` + the
      // required `oauth-2025-04-20` beta. There is NO x-api-key path: this deployment has no billed
      // API key, and a raw key would 400 against the subscription-only beta (any x-api-key a bee
      // sends is stripped above by STRIP_REQUEST). NOTE for raw-SDK callers routed through here on a
      // Max token: the FIRST `system` block must be the Claude Code identifier or the request is
      // shunted to a far stricter bucket and 429s — the `claude` CLI bees already frame themselves.
      const baseHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || STRIP_REQUEST.has(k.toLowerCase())) continue;
        baseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      baseHeaders['anthropic-beta'] = withOAuthBeta(baseHeaders['anthropic-beta'] ?? (req.headers['anthropic-beta'] as string | undefined));
      if (!baseHeaders['anthropic-version']) baseHeaders['anthropic-version'] = ANTHROPIC_VERSION;
      baseHeaders['accept-encoding'] = 'identity';

      // INTERNAL FAILOVER LOOP. On most responses this runs ONCE. It re-runs only to route past a
      // usage/session CAP ("You've hit your session limit · resets 10:50am") — a hard wall the bee
      // classifies as `usage_limit` and will NOT retry, so the gateway must rotate to a healthy account
      // and return a GOOD response itself rather than forwarding the wall (the account-routing-fault the
      // owner flags: a $0 bee while idle accounts sit unused). A transient/bare 429 is NOT looped here —
      // the bee's CLI retries those, and the next request lands on the failover-rotated active().
      let attempt = 0;
      for (;;) {
        const token = await active.token();
        const headers: Record<string, string> = { ...baseHeaders, authorization: `Bearer ${token}` };

        let up: Response;
        try {
          const init: FetchInit = { method: req.method ?? 'POST', headers };
          if (bodyBuf.length) init.body = new Uint8Array(bodyBuf);
          // Per-account IP routing: forward this account's request through its dedicated egress
          // dispatcher (proxy / bound source IP) when configured; absent ⇒ default (shared) egress.
          const dispatcher = await dispatcherFor(active);
          if (dispatcher) init.dispatcher = dispatcher;
          up = await doFetch(`${upstreamBase}${url}`, init as RequestInit);
        } catch (e) {
          upstreamErrors++;
          log('error', `upstream fetch failed: ${(e as Error).message}`);
          sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `inference-gateway upstream error: ${(e as Error).message}` }, gateway: true });
          return;
        }

        const hobj = headersToObject(up.headers);
        gov.recordResponse(hobj);
        deps.onResponse?.(hobj, up.status, model, active.accountId);

        // A peeked NON-200 body, kept so it can be FORWARDED if we end up not retrying. Successful 200
        // streams are NEVER peeked — the hot path keeps zero added latency + no false-positive risk.
        let peekedHead: Buffer | null = null;
        let peekedRest: Readable | null = null;
        // When set, the gateway re-attempts (usually on a rotated account) before responding — absorbing
        // a transient throttle / routing past a usage cap so the bee never sees the error.
        let internalRetry: { rotate: boolean; backoffMs: number; exhaustResetAt: number } | null = null;

        if (up.status === 429 || up.status === 529) {
          upstream429++;
          const reset = parseRateReset(hobj);
          const unifiedRejected = gov.snapshot().unified?.rejected === true;
          // A BARE 429: rate_limit_error with NO window headers — a transient burst throttle (the
          // aviynw10 stuck-loop, 2026-06-17). A 429 may ALSO be a hard usage/session CAP — the BODY names
          // it ("hit your session limit"); util can be 0 on a capped account (a DIFFERENT meter than the
          // rolling window), so only the body reveals it. Peek the tiny error body to tell them apart.
          const bare429 =
            up.status === 429 && !unifiedRejected && reset.retryAfterMs === undefined && reset.resetAt === undefined;
          let usageCapResetAt: number | undefined;
          if (up.body) {
            const peek = await peekBody(up.body, USAGE_LIMIT_PEEK_BYTES);
            peekedHead = peek.head;
            peekedRest = peek.rest;
            const text = peek.head.toString('utf8');
            if (classifyHttpError({ status: undefined, message: text }, 'anthropic').class === 'usage_limit') {
              usageCapResetAt = parseUsageResetMs(text) ?? Date.now() + USAGE_LIMIT_DEFAULT_PAUSE_MS;
            }
          }
          if (up.status === 529) {
            // SERVER overload — NOT account budget; don't penalize/rotate the account, just back off + retry.
            internalRetry = { rotate: false, backoffMs: OVERLOAD_529_BACKOFF_MS, exhaustResetAt: 0 };
          } else if (usageCapResetAt !== undefined) {
            // Hard cap on THIS account → pause it to its reset (the pin yields to liveness + the selector
            // skips it), then rotate + retry immediately (the bee classifies usage_limit as a no-retry wall).
            gov.penalize({ resetAt: usageCapResetAt });
            internalRetry = { rotate: true, backoffMs: 0, exhaustResetAt: usageCapResetAt };
          } else {
            // A transient/bare/unified-window 429 — account-specific. Pace this account, then rotate to a
            // fresh one + retry after a short backoff (a different account usually sidesteps the throttle),
            // so the bee's SMALL CLI retry budget never exhausts ("Server is temporarily limiting requests"
            // → $0 rc=1). NB: a unified rolling-window rejection already had its BOUNDED re-probe pause set
            // by recordResponse — do NOT penalize to the full multi-hour reset (the stale-pause bug).
            let exhaustResetAt: number;
            if (!unifiedRejected && (reset.retryAfterMs !== undefined || reset.resetAt !== undefined)) {
              gov.penalize(reset);
              exhaustResetAt = reset.resetAt ?? Date.now() + Math.min(reset.retryAfterMs ?? BARE_429_FAILOVER_BACKOFF_MS, 5 * 60 * 1000);
            } else if (bare429) {
              gov.penalize({ retryAfterMs: BARE_429_FAILOVER_BACKOFF_MS, resetAt: Date.now() + BARE_429_FAILOVER_BACKOFF_MS });
              exhaustResetAt = Date.now() + BARE_429_FAILOVER_BACKOFF_MS;
            } else {
              exhaustResetAt = reset.resetAt ?? Date.now() + 5 * 60 * 60 * 1000; // unifiedRejected: bounded pause already set
            }
            internalRetry = { rotate: true, backoffMs: TRANSIENT_429_BACKOFF_MS, exhaustResetAt };
          }
        } else if (up.status === 401) {
          active.invalidateToken?.();
        }

        // Bounded INTERNAL retry: absorb a transient throttle / route past a usage cap so the bee gets a
        // GOOD response instead of exhausting its own small CLI retry budget (or hitting a no-retry wall).
        // If no fresh account remains to rotate to, stop + forward the error (genuinely out of capacity).
        if (internalRetry && attempt < INTERNAL_RETRY_MAX_ATTEMPTS - 1) {
          let proceed = true;
          if (internalRetry.rotate) {
            const next = pool.onExhausted(active.accountId, internalRetry.exhaustResetAt);
            if (next && next.accountId !== active.accountId) {
              failovers++;
              active = next;
              gov = governorForAccount(model, active.accountId);
            } else {
              proceed = false; // no other account to try → don't spin on the same one; forward the error.
            }
          }
          if (proceed) {
            peekedRest?.destroy(); // discard the throttled/capped account's body
            attempt++;
            if (internalRetry.backoffMs > 0) {
              await new Promise<void>((r) => {
                const t = setTimeout(r, internalRetry!.backoffMs);
                t.unref?.();
              });
            }
            log('warn', `inference-gateway: upstream ${up.status} → internal retry ${attempt} on '${active.accountId}'`);
            continue;
          }
        }

        const outHeaders: Record<string, string> = {};
        up.headers.forEach((v, k) => {
          if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders[k] = v;
        });
        res.writeHead(up.status, outHeaders);
        if (peekedHead !== null) {
          // We already consumed this body via peekBody — write the peeked head, then stream any remainder.
          if (peekedHead.length) res.write(peekedHead);
          if (peekedRest) {
            peekedRest.pipe(res);
            await new Promise<void>((resolve) => {
              res.on('finish', () => resolve());
              res.on('close', () => resolve());
              peekedRest!.on('error', () => { res.destroy(); resolve(); });
            });
          } else {
            res.end();
          }
        } else if (up.body) {
          const nodeStream = Readable.fromWeb(up.body as Parameters<typeof Readable.fromWeb>[0]);
          nodeStream.pipe(res);
          await new Promise<void>((resolve) => {
            res.on('finish', () => resolve());
            res.on('close', () => resolve());
            nodeStream.on('error', () => {
              res.destroy();
              resolve();
            });
          });
        } else {
          res.end();
        }
        return;
      }
    } finally {
      release();
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/healthz') {
      const s = stats();
      sendJson(res, s.pausedUntil > Date.now() ? 503 : 200, { ok: true, ...s });
      return;
    }
    if (req.method === 'GET' && (url === '/stats' || url === '/admin/stats')) {
      sendJson(res, 200, stats());
      return;
    }
    if (!url.startsWith('/v1/')) {
      sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'inference-gateway only proxies /v1/*' }, gateway: true });
      return;
    }
    const pri = priorityFromLabel((req.headers[PRIORITY_HEADER] as string | undefined) ?? undefined);
    queue.run(pri, () => proxy(req, res, url)).catch((e) => {
      upstreamErrors++;
      log('error', `proxy handler crashed: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: 'inference-gateway internal error' }, gateway: true });
      else res.destroy();
    });
  });

  return {
    server,
    stats,
    listen(port = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          const p = typeof addr === 'object' && addr ? addr.port : port;
          log('info', `inference-gateway listening on 127.0.0.1:${p} → ${upstreamBase} (account ${pool.active().accountId})`);
          resolve(p);
        });
      });
    },
    port(): number {
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : 0;
    },
    close(): Promise<void> {
      // Tear down any per-account egress dispatchers (best-effort; they hold sockets).
      for (const d of dispatcherCache.values()) void (d as { close?: () => Promise<void> }).close?.();
      dispatcherCache.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export type InferenceGateway = ReturnType<typeof createInferenceGateway>;
