/**
 * Claude (`anthropic-messages` lane, `oauth-http` transport) adapter for the
 * provider-neutral request kernel.
 *
 * Plan `gateway-kernel-adoption-2026-08-29`, P-006 — the FOURTH and last cloud
 * `GatewayKernelAdapter`, expressing the protocol/transport-owned half of
 * `proxy`: per-attempt token resolution, egress selection, header construction,
 * the upstream call, and the retry/rotation DECISIONS.
 *
 * Everything else stays with `executeGatewayRequestKernel` or with the caller and
 * is deliberately absent here: abort wiring, the request ceiling, the bounded body
 * read, the TTFB-then-body-idle timer ladder, admission, in-flight registration,
 * and attempt/failover bookkeeping.
 *
 * ─── WHAT IS DELIBERATELY *NOT* IN THIS FILE ────────────────────────────────
 *
 * D-012 CONSTRAINT 1. Every governor/cooldown SIDE EFFECT stays caller-side, in
 * the `admission.observeAttempt` hook the caller passes to the kernel — NOT in a
 * selection hook here. The kernel guarantees `observeAttempt` fires once per
 * attempt regardless of retryability or pin, whereas it skips `selectFailover`
 * entirely on the final attempt and under a hard pin. These must survive both:
 *
 *   - `gov.penalize(...)` for a usage cap, a bare-429 pause, and a transport fail
 *   - `coolIp(...)` plus the ESCALATING streak maps (`ipBare429Streak`,
 *     `ipTransportFailStreak`) — both double per consecutive failure
 *   - the BARE-429 PERSISTENCE CIRCUIT (`bare429Streak`) and `bare429PauseUntil`
 *   - `egressFailStreak` / the egress circuit and `checkEgressProxyHealthAlarm`
 *
 * Putting any of them here would fail SILENTLY under a hard pin — the worst shape.
 * Left in `observeAttempt` they are covered by existing tests (gateway.test.ts:654
 * circuit, :3141/:3190 escalation + reset, :3237 alarm), so a mistake fails loudly.
 *
 * ALSO CALLER-SIDE, because the kernel has no concept of them: the absorb /
 * re-acquire path (it resets the slot-hold deadline AND sets `attempt = 0`, a
 * BUDGET RESET), the bounded transient-WAIT, the wedge-prevention shed, and the
 * model-downgrade pass.
 *
 * ─── THE THREE THINGS THIS LANE NEEDS FROM THE KERNEL ───────────────────────
 *
 *  1. IT RE-ATTEMPTS THE SAME ACCOUNT (D-011), on three distinct branches, none
 *     of which is a failover and none of which the live handler gates on the hard
 *     pin the way it gates rotation:
 *       - a bare TRANSPORT failure  → sibling egress IP (gateway.ts:4212)
 *       - a bare-burst 429          → sibling egress IP (gateway.ts:4744)
 *       - a 529 server overload     → back off, SAME account (gateway.ts:4521/:4752)
 *     Sibling-egress is attempted BEFORE rotation, matching the live
 *     `siblingEgressAvailable(...) || rotate(...)` order that request-kernel.ts
 *     documents at :148/:737.
 *
 *  2. IT COUNTS FAILOVERS BY *ACCOUNT* CHANGE, NEVER BY ROUTE KEY. The live
 *     handler increments only under `next.accountId !== active.accountId`
 *     (gateway.ts:4733-4735). Every same-account re-attempt above changes the
 *     egress key — and therefore any route key — so the bearer lane's legitimate
 *     count-by-key would inflate this lane's failover count on every sibling
 *     retry. The kernel counts a `selectReattempt` route as an attempt, not a
 *     failover, which is exactly the required semantics.
 *
 *  3. IT NEVER CALLS `pool.active()` (D-010). `proxy` spends this request's one
 *     `active()` across ~500 lines of selection above the kernel cut (dynamic pin,
 *     hard pin, health-aware pick, route-to-capacity walk, soft-pin failover,
 *     graceful degradation, fail-fast shed), and `active()` ADVANCES the
 *     round-robin. The already-resolved account arrives as `initialAccount`, so a
 *     double-advance is structurally impossible rather than merely avoided.
 */
import type { GatewayTransportId } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import {
  GatewayRequestKernelError,
  type GatewayKernelAdapter,
  type GatewayKernelAttemptContext,
  type GatewayKernelRoute,
  type GatewayKernelRouteContext,
  type GatewayKernelUpstreamResponse,
} from './request-kernel';

const CLAUDE_TRANSPORT: GatewayTransportId = 'oauth-http';

/** Why a route exists. Drives `prepareAttempt` and, critically, keeps every route
 *  key distinct — which is what the kernel's route-cycle guard reads. */
export type ClaudeRouteReason = 'initial' | 'sibling-egress' | 'overload-backoff' | 'rotate';

/** An egress binding as this adapter sees it. `entry` is opaque and handed back to
 *  `dispatcherFor` unchanged, exactly as the live handler passes `picked.entry`. */
export interface ClaudeEgressPick {
  entry: unknown;
  key: string;
}

export interface ClaudeRouteValue {
  account: ActiveAccount;
  egress: ClaudeEgressPick;
  reason: ClaudeRouteReason;
}

/**
 * Why a non-2xx attempt failed, as read from the response BODY (D-013).
 *
 * The live handler cannot tell a hard per-account USAGE CAP from a transient
 * bare-burst 429 by status and headers alone — util can read 0 on a capped
 * account because the cap is a different meter — so it peeks the error body and
 * classifies the text (gateway.ts:4425-4459). The same is true of a 403, whose
 * org/subscription disqualification is only visible in the body (:4632).
 *
 * That classification therefore CANNOT live in the caller's
 * `admission.observeAttempt`: the kernel hands that hook `{ context, response,
 * error }` with no body (request-kernel.ts:110-114). The adapter is the only
 * place holding the body before a retry decision, so it peeks and classifies
 * here — while the Anthropic-specific PREDICATES stay caller-side behind
 * `classifyResponse`, and every governor/cooldown SIDE EFFECT stays caller-side
 * in `observeAttempt` exactly as D-012 constraint 1 requires.
 */
export type ClaudeFailureKind =
  /** Hard per-account wall named by the body → pause the account to its reset, rotate. */
  | 'usage-cap'
  /** 403 org/subscription disqualification → pause the account, rotate. */
  | 'org-disallowed'
  /** Per-IP edge throttle (no window headers) → sibling egress IP first, else rotate. */
  | 'bare-429'
  /** A window/`retry-after` 429 → rotate after a backoff; never a sibling-IP retry. */
  | 'rate-429'
  /** 529 server overload → back off on the SAME account; never an account signal. */
  | 'overload'
  /** Not retryable — hand it straight to the caller, as the live handler forwards it. */
  | 'forward';

export interface ClaudeResponseClassification {
  kind: ClaudeFailureKind;
  /** When the account should stay out of rotation until (usage cap / org pause). */
  resetAt?: number;
  /** Opaque passthrough for the caller's `observeAttempt` — streaks, alerts, log suffixes. */
  detail?: unknown;
}

export interface ClaudeClassifyInput {
  status: number;
  headers: Record<string, string>;
  /** The peeked body prefix, decoded as UTF-8. Empty when the peek timed out. */
  body: string;
}

export type ClaudeChunk = Uint8Array;

export interface ClaudeResponseMetadata {
  /** Account that actually served the attempt (`x-papercusp-routed-account`). */
  accountId: string;
  /** Upstream response headers, lowercased keys, pre-strip. */
  headers: Record<string, string>;
  /** Egress key that served, so the caller can clear its transport-fail streak. */
  egressKey: string;
  /**
   * Body-derived failure classification (D-013), or null for a 2xx and whenever
   * no `classifyResponse` was supplied. The caller's `observeAttempt` reads this
   * to fire `gov.penalize` / cooldowns / streak alerts, and the selection hooks
   * read it to pick the retry branch — one classification, two consumers, so the
   * body is peeked exactly once per attempt.
   */
  classification: ClaudeResponseClassification | null;
}

export interface ClaudePreparedAttempt {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  accountId: string;
  dispatcher: unknown;
}

/** Structural view of a WHATWG `Response`, so a unit test can drive this adapter
 *  with a plain object and no network. */
export interface ClaudeFetchResponse {
  status: number;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  body: (AsyncIterable<Uint8Array> & { cancel?(): Promise<void> | void }) | null;
}

export interface ClaudeFetchInit {
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  signal: AbortSignal;
  dispatcher: unknown;
}

export interface ClaudeAdapterOptions {
  /**
   * The account `proxy` already resolved above the kernel cut — the D-010 replay.
   * The adapter has no pool handle for INITIAL selection and therefore cannot
   * advance the round-robin a second time.
   */
  initialAccount: ActiveAccount;
  /** Rotation pool. Absent ⇒ single-account mode; rotation declines. */
  pool?: AccountPool;
  upstreamUrl: string;
  method: string;
  /** Headers minus auth; `authorization` is layered on per attempt. */
  baseHeaders: Record<string, string>;
  body: Uint8Array | null;
  /**
   * Request-derived streaming flag. Supplied by the caller rather than parsed here
   * because it is decided ABOVE the kernel (it also picks the headers-stall
   * budget), so parsing it again would be the two-parsers drift D-007 corrected.
   * An error response to a streaming request is still a streaming request.
   */
  streaming: boolean;
  /** Bounds `account.token()`, mirroring the live `withDeadline` token guard. */
  tokenTimeoutMs: number;
  /** Backoff applied to an account parked without an explicit rate reset. */
  failoverBackoffMs: number;
  /** 529 server-overload backoff (live `OVERLOAD_529_BACKOFF_MS`). */
  overloadBackoffMs: number;
  pickEgress(account: ActiveAccount, now: number): ClaudeEgressPick;
  siblingEgressAvailable(account: ActiveAccount, now: number, currentKey: string): boolean;
  dispatcherFor(account: ActiveAccount, entry: unknown): unknown | Promise<unknown>;
  fetch(url: string, init: ClaudeFetchInit): Promise<ClaudeFetchResponse>;
  /** Parses `anthropic-ratelimit-*` / `retry-after` into an epoch-ms instant. */
  rateReset(headers: Record<string, string>): { resetAt: number | null; retryAfterMs: number | null };
  /**
   * Caller's veto on cross-account rotation for THIS attempt — the live
   * `suppressBareBurstRotate` (gateway.ts:4721, G1/WI-649). A fleet-wide bare
   * burst means rotating A→B→C finds no capacity and merely sustains the storm,
   * so the caller suppresses it and falls through to its bounded transient-wait.
   * Returning false here declines rotation WITHOUT consuming a pool slot.
   */
  canRotate?(): boolean;
  /**
   * Classifies a peeked NON-2xx body (D-013). Absent ⇒ no body is ever peeked and
   * the adapter falls back to status-only retryability, which is what the pure
   * transport tests drive.
   *
   * The callback keeps every Anthropic-specific predicate (`classifyHttpError`,
   * `parseUsageReset`, `ORG_DISALLOWED_RE`) in the caller where it already lives;
   * the adapter contributes the peek, the replay, and the branch — not provider
   * knowledge.
   */
  classifyResponse?(input: ClaudeClassifyInput): ClaudeResponseClassification;
  /** Bytes of a non-2xx body to peek for classification (live `USAGE_LIMIT_PEEK_BYTES`). */
  peekBytes?: number;
  /**
   * Bound on the classification peek. The live handler wraps `peekBody` in a
   * `withDeadline` because the peek reader is NOT wired to the attempt abort, so an
   * acknowledged-but-never-delivered error body would otherwise hold the admission
   * slot past the stall deadline (gateway.ts:4433-4449). On timeout the body is
   * cancelled and the attempt is treated as unclassifiable — i.e. forwarded.
   */
  peekTimeoutMs?: number;
  now?(): number;
}

export type ClaudeKernelAdapter = GatewayKernelAdapter<
  ClaudeRouteValue,
  ClaudePreparedAttempt,
  ClaudeChunk,
  ClaudeResponseMetadata
>;

export type ClaudeUpstream = GatewayKernelUpstreamResponse<ClaudeChunk, ClaudeResponseMetadata>;

function headersToObject(headers: ClaudeFetchResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Bound the token read exactly as the live handler's `withDeadline` does. The
 *  kernel owns the TTFB and body-idle deadlines, but token work happens inside
 *  `prepareAttempt` and carries its own. */
async function withTokenDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pull up to `limit` bytes off the body for classification, then hand back a body
 * that REPLAYS them ahead of the remainder — the live handler's
 * `peekedHead` + `peekedRest` forward path (gateway.ts:5014-5019), expressed as a
 * single stream so the kernel's downstream relay stays unaware a peek happened.
 */
async function peekBody(
  body: AsyncIterable<Uint8Array> & { cancel?(): Promise<void> | void },
  limit: number,
): Promise<{ head: Uint8Array; body: AsyncIterable<Uint8Array> & { cancel?(): Promise<void> | void } }> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size < limit) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    const chunk = next.value as Uint8Array;
    chunks.push(chunk);
    size += chunk.length;
  }
  const head = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const replay = {
    async *[Symbol.asyncIterator]() {
      if (head.length) yield head;
      if (done) return;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value as Uint8Array;
      }
    },
    cancel: () => body.cancel?.(),
  };
  return { head, body: replay };
}

export function createClaudeKernelAdapter(opts: ClaudeAdapterOptions): ClaudeKernelAdapter {
  const now = opts.now ?? (() => Date.now());

  // Accounts already attempted, so rotation cannot cycle back. The kernel's own
  // route-cycle guard keys on the ROUTE KEY, and ours carry a sequence number to
  // permit same-account re-attempts (D-011) — so the account-level guard has to be
  // explicit here, same reasoning as the bearer and oauth adapters.
  const triedAccounts = new Set<string>([opts.initialAccount.accountId]);
  // 529 is a SERVER-overload signal, not an account signal: the live handler backs
  // off and retries the same account without penalising or rotating it. Bound it
  // per account so a persistently-529ing upstream cannot spin the same account
  // forever — the kernel's attempt budget is the outer bound, this is the inner one.
  const overloadRetried = new Set<string>();
  let seq = 0;

  const routeFor = (account: ActiveAccount, reason: ClaudeRouteReason): GatewayKernelRoute<ClaudeRouteValue> => {
    const egress = opts.pickEgress(account, now());
    seq += 1;
    return {
      // Distinct per attempt: a same-account re-attempt MUST present a new key or
      // the kernel's route-cycle guard rejects it (D-011). This is the single
      // easiest way to break a reattempt silently, hence the explicit sequence.
      key: `claude:${account.accountId}:${reason}:${seq}`,
      accountId: account.accountId,
      transport: CLAUDE_TRANSPORT,
      value: { account, egress, reason },
    };
  };

  const resolveResetAt = (
    context: GatewayKernelRouteContext<ClaudeRouteValue, ClaudeChunk, ClaudeResponseMetadata>,
  ): number => {
    // A body-derived wall carries its OWN reset — the usage cap's parsed reset
    // instant, or the org-disallow pause. The live handler hands exactly that to
    // `pool.onExhausted` (gateway.ts:4733 via `internalRetry.exhaustResetAt`,
    // set to `usageCapResetAt` at :4526), so it must win over a header-derived
    // window: a capped account parked only to the short failover backoff would
    // rejoin the round-robin while still walled.
    const classified = context.lastResponse?.metadata?.classification;
    if (typeof classified?.resetAt === 'number' && Number.isFinite(classified.resetAt)) return classified.resetAt;
    const headers = context.lastResponse?.metadata?.headers;
    if (headers) {
      const parsed = opts.rateReset(headers);
      if (typeof parsed.resetAt === 'number' && Number.isFinite(parsed.resetAt)) return parsed.resetAt;
    }
    return now() + opts.failoverBackoffMs;
  };

  return {
    selectInitial() {
      // No `pool.active()` — see the header note (D-010).
      return routeFor(opts.initialAccount, 'initial');
    },

    selectReattempt(context) {
      const currentRoute = context.currentRoute;
      if (!currentRoute) return null;
      const { account, egress } = currentRoute.value;
      const status = context.lastResponse?.status ?? null;
      const kind = context.lastResponse?.metadata?.classification?.kind ?? null;

      // 529 SERVER overload — back off and retry the SAME account. Deliberately
      // first: it is a distinct branch from the egress-rotation cases below, and
      // the live handler treats it as `{ rotate: false }` (gateway.ts:4521)
      // regardless of whether a sibling egress IP happens to exist. Not gated on
      // the pin — retrying a hard-pinned account does not leave it.
      if (kind === 'overload' || (kind === null && status === 529)) {
        if (overloadRetried.has(account.accountId)) return null;
        overloadRetried.add(account.accountId);
        return routeFor(account, 'overload-backoff');
      }

      // Sibling egress IP on the SAME account, before parking it — the live
      // `siblingEgressAvailable(...) || rotate(...)` order. ONLY two shapes take
      // it (D-013): a bare TRANSPORT failure, and a BARE-burst 429, which is a
      // per-IP edge throttle rather than an account signal. A usage cap, an
      // org-disallowed 403 and a windowed rate-429 are all ACCOUNT-level walls in
      // the live handler — it sets `rotate: true` for each (gateway.ts:4526,
      // :4592/:4535, :4635) and never retries the same credential on a new IP —
      // so they fall through to `selectFailover`.
      const transportFailure = context.lastResponse === null && context.lastError !== null;
      const siblingEligible =
        transportFailure || (kind === null ? status === 429 || (status !== null && status >= 500) : kind === 'bare-429');
      if (!siblingEligible) return null;
      if (!opts.siblingEgressAvailable(account, now(), egress.key)) return null;
      return routeFor(account, 'sibling-egress');
    },

    selectFailover(context) {
      // Hard pins never reach here — the kernel declines them before consulting
      // the adapter, and D-011 did not change that suppression.
      const currentRoute = context.currentRoute;
      if (!currentRoute) return null;

      // A 529 is server overload, never an account signal: the live handler backs
      // off on the same account and never rotates. Decline rather than park a
      // healthy account for someone else's outage.
      const kind = context.lastResponse?.metadata?.classification?.kind ?? null;
      if (kind === 'overload' || (kind === null && context.lastResponse?.status === 529)) return null;

      // The caller's fleet-wide bare-burst veto (G1). Checked BEFORE touching the
      // pool: `onExhausted` both PARKS and returns, so consulting it here and then
      // discarding the result would park an account for nothing.
      if (opts.canRotate && !opts.canRotate()) return null;
      if (!opts.pool) return null;

      const current = currentRoute.value.account.accountId;
      // D-012 CONSTRAINT 2: exactly ONE `onExhausted` call site. It both parks the
      // current account AND returns the next one, so a second call site would leak
      // one parked account per retry — a failure that surfaces only as accounts
      // mysteriously going cold under load.
      const next = opts.pool.onExhausted(current, resolveResetAt(context));
      if (!next || next.accountId === current) return null;
      if (triedAccounts.has(next.accountId)) return null;
      triedAccounts.add(next.accountId);
      return routeFor(next, 'rotate');
    },

    async prepareAttempt(context: GatewayKernelAttemptContext<ClaudeRouteValue>): Promise<ClaudePreparedAttempt> {
      const { account, egress } = context.route.value;
      // Per attempt, not per request: a rotation must present the NEW account's
      // credential, which is why the live handler resolves the token inside its
      // loop body rather than once above it (gateway.ts:~4053).
      const token = await withTokenDeadline(
        account.token(),
        opts.tokenTimeoutMs,
        `token refresh '${account.accountId}'`,
      );
      const dispatcher = await opts.dispatcherFor(account, egress.entry);
      return {
        url: opts.upstreamUrl,
        method: opts.method,
        headers: { ...opts.baseHeaders, authorization: `Bearer ${token}` },
        body: opts.body,
        accountId: account.accountId,
        dispatcher,
      };
    },

    async executeAttempt(
      prepared: ClaudePreparedAttempt,
      context: GatewayKernelAttemptContext<ClaudeRouteValue>,
    ): Promise<ClaudeUpstream> {
      let response: ClaudeFetchResponse;
      try {
        response = await opts.fetch(prepared.url, {
          method: prepared.method,
          headers: prepared.headers,
          body: prepared.body,
          signal: context.signal,
          dispatcher: prepared.dispatcher,
        });
      } catch (error) {
        // A raw throw normalizes to retryable:FALSE, which would silently disable
        // the transport-failure branch of selectReattempt — one of this lane's
        // three same-account retries (gateway.ts:4212, the sibling-egress rotate).
        // The live handler treats a transport failure as recoverable, so mark it.
        throw new GatewayRequestKernelError(
          `inference-gateway: claude upstream failed: ${(error as Error).message}`,
          { code: 'upstream-error', outcome: 'upstream-error', status: 502, retryable: true },
        );
      }
      const headers = headersToObject(response.headers);

      // D-013: classify a NON-2xx from its body, then replay the peeked bytes so
      // the forward path stays byte-identical. A 2xx is NEVER peeked — the hot
      // path keeps zero added latency and no false-positive risk, matching the
      // live handler's own note (gateway.ts:4377-4378).
      let classification: ClaudeResponseClassification | null = null;
      let body = response.body;
      if (opts.classifyResponse && response.status >= 300) {
        let head = Buffer.alloc(0) as Uint8Array;
        if (body) {
          try {
            const peeked = await withTokenDeadline(
              peekBody(body, opts.peekBytes ?? 8192),
              opts.peekTimeoutMs ?? 30_000,
              'classification peek',
            );
            head = peeked.head;
            body = peeked.body;
          } catch {
            // The peek reader is not wired to the attempt abort, so an
            // acknowledged-but-undelivered body must not hold the slot. Cancel it
            // and treat the attempt as unclassifiable — the live fallback at
            // gateway.ts:4439-4449, which forwards rather than guessing.
            try {
              await body.cancel?.();
            } catch {
              /* drain the stalled body */
            }
            body = null;
          }
        }
        classification = opts.classifyResponse({
          status: response.status,
          headers,
          body: Buffer.from(head).toString('utf8'),
        });
      }

      return {
        status: response.status,
        // Request-derived, as the live handler's span is (D-007).
        streaming: opts.streaming,
        // REQUIRED: the kernel re-validates the lane against `response.transport`
        // (request-kernel.ts:936), not against the route's — omitting it fails as
        // "lane does not support transport undefined", which reads like a lane
        // misconfiguration rather than a missing field.
        transport: CLAUDE_TRANSPORT,
        metadata: {
          accountId: prepared.accountId,
          headers,
          egressKey: context.route.value.egress.key,
          classification,
        },
        body,
        // Drives whether the kernel consults selectReattempt/selectFailover at all
        // (request-kernel.ts:951). It DEFAULTS TO FALSE, so omitting it silently
        // disables every retry branch this adapter implements.
        //
        // CLASSIFIED (D-013): retry exactly the shapes the live handler retries.
        // Note this makes a plain 5xx NON-retryable, which is live parity, not a
        // narrowing: `proxy` only ever builds an `internalRetry` inside its
        // 429/529, 403 and 401 branches (gateway.ts:4399/:4605/:4675) — there is
        // no 5xx branch at all, so a 500/502/503 is FORWARDED unretried. The
        // status-only fallback below is what the pure transport tests drive.
        retryable: classification
          ? classification.kind !== 'forward'
          : response.status === 429 || response.status === 529,
        discard: body?.cancel ? () => body?.cancel?.() : undefined,
      };
    },
  };
}
