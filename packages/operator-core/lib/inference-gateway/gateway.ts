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
      const token = await active.token();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || STRIP_REQUEST.has(k.toLowerCase())) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      // Every account is a Claude Max subscription OAuth credential → `Authorization: Bearer` + the
      // required `oauth-2025-04-20` beta. There is NO x-api-key path: this deployment has no billed
      // API key, and a raw key would 400 against the subscription-only beta (any x-api-key a bee
      // sends is stripped above by STRIP_REQUEST). NOTE for raw-SDK callers routed through here on a
      // Max token: the FIRST `system` block must be the Claude Code identifier or the request is
      // shunted to a far stricter bucket and 429s — the `claude` CLI bees already frame themselves.
      headers['authorization'] = `Bearer ${token}`;
      headers['anthropic-beta'] = withOAuthBeta(headers['anthropic-beta'] ?? (req.headers['anthropic-beta'] as string | undefined));
      if (!headers['anthropic-version']) headers['anthropic-version'] = ANTHROPIC_VERSION;
      headers['accept-encoding'] = 'identity';

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
      if (up.status === 429 || up.status === 529) {
        upstream429++;
        const reset = parseRateReset(hobj);
        const unifiedRejected = gov.snapshot().unified?.rejected === true;
        // Penalize ONLY a classic 429 carrying its own retry-after/reset. Skip it for:
        //  • a 529 — transient SERVER overload, not rate-limit budget; it must NOT pause the account;
        //  • a unified (rolling-window) rejection — recordResponse already set the BOUNDED re-probe
        //    pause, and penalizing to the full multi-hour unified reset is exactly the stale-pause /
        //    false-exhaustion bug (the rolling 5h window recovers continuously).
        //  • a bare framing-429 (no rate headers) — reset is empty, so this is a no-op anyway.
        if (up.status === 429 && !unifiedRejected && (reset.retryAfterMs !== undefined || reset.resetAt !== undefined)) {
          gov.penalize(reset);
        }
        // 5h-budget exhaustion (the unified window rejected) → fail over to another account that still
        // has budget so the fleet doesn't stall; the exhausted account rejoins the rotation at its
        // REAL reset (a rolling window the failover pool tracks separately from the bucket pause).
        if (unifiedRejected) {
          const next = pool.onExhausted(active.accountId, reset.resetAt ?? Date.now() + 5 * 60 * 60 * 1000);
          if (next && next.accountId !== active.accountId) failovers++;
        }
      } else if (up.status === 401) {
        active.invalidateToken?.();
      }

      const outHeaders: Record<string, string> = {};
      up.headers.forEach((v, k) => {
        if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders[k] = v;
      });
      res.writeHead(up.status, outHeaders);
      if (up.body) {
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
