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
  QueueFullError,
  AimdConcurrencyController,
  priorityFromLabel,
  classifyHttpError,
  parseUsageResetMs,
  type RateLimitGovernor,
  type AdmissionSnapshot,
  type AimdSnapshot,
} from '@papercusp/papercusp-shared/agent';
import { withOAuthBeta } from './credential-store';
import { evaluateSelfHeal, pickReclaimTarget } from './gateway-self-heal';
import { probeEgress } from './egress-probe';
import type { AccountEgress, ClaudeAccount } from '../deployment/account-pool';

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
/** When EVERY pool account is transiently throttled at once, the gateway waits out the soonest
 *  account's short penalty and retries rather than forwarding a retryable (x-should-retry:true) 429.
 *  This caps that wait so a request can never hang on a hard/long reset (a multi-hour usage cap is
 *  forwarded, not waited on). Sized to cover a bare-429 burst penalty + slack. */
const ALL_THROTTLED_RECOVERY_WAIT_CAP_MS = 20 * 1000;
/** Total time a single client request may spend WAITING out short transient throttles (budget #2,
 *  separate from the rotation-attempt budget) before forwarding. Bounds the wait so a fleet-wide
 *  transient burst is absorbed but a request can never hang. */
const TRANSIENT_TOTAL_WAIT_BUDGET_MS = 30 * 1000;
/** Hard wall-clock ceiling on how long ONE client request may keep RETRYING internally (rotating across
 *  accounts + waiting out transient throttles) before it stops, sheds a retryable 429, and FREES its
 *  admission slot. This is the load-bearing rung of the WEDGE-PREVENTION THRESHOLD LADDER:
 *
 *    INTERNAL_RETRY_DEADLINE_MS (60s)  <  self-heal freeze (DEFAULT_SELFHEAL_FREEZE_MS, 75s)  <  watchdog freeze (120s)
 *
 *  Without it a request under a SLOW-upstream pool-wide storm could hold its slot for (≤INTERNAL_RETRY_MAX_
 *  ATTEMPTS upstream fetches, each seconds long under load) + the 30s transient-wait budget — exceeding
 *  75-120s. At the AIMD FLOOR (a few slots) a handful of such squatters saturate every slot with NO natural
 *  completion → the self-heal drain-clock ages → the valve can't keep up → the watchdog FULL-restarts the
 *  gateway (~15-30s of fleet-wide connection-refused = the "api error" the fleet sees). Shedding at the
 *  deadline keeps every slot cycling fast enough that the frozen-while-saturated wedge signature never forms.
 *  TRADEOFF: a bounded retryable 429 (+retry-after) to a few no-CLI-retry callers (scout/gym) is strictly
 *  better than a wedge that connection-refuses the WHOLE fleet. MUST stay < DEFAULT_SELFHEAL_FREEZE_MS. */
const INTERNAL_RETRY_DEADLINE_MS = Number(process.env.PAPERCUSP_GATEWAY_INTERNAL_RETRY_DEADLINE_MS) || 60 * 1000;
/** Inspect a NON-200 upstream body up to this many bytes for a usage/session-limit signature (the
 *  Claude-Code subscription cap — "You've hit your session limit · resets 10:50am" — a WALL the bee
 *  classifies as usage_limit + WON'T retry). Such error bodies are tiny; this just bounds the read.
 *  Successful 200 streams are NEVER peeked, so the hot path keeps zero added latency. */
const USAGE_LIMIT_PEEK_BYTES = 64 * 1024;
/** When a usage/session-limit message carries no parseable reset, pause the capped account this long. */
const USAGE_LIMIT_DEFAULT_PAUSE_MS = 60 * 60 * 1000;
/** An account-level org/subscription DISQUALIFICATION (a 403 that is NOT a transient throttle): the
 *  account's Anthropic org disabled OAuth API access, or Claude Code for the subscription. The account
 *  is unusable until an admin re-enables it, so pause it OUT of rotation this long (re-probes after) +
 *  fail over — instead of forwarding the 403, which hard-fails the bee AND, when the account is
 *  active(), 403-blocks the WHOLE fleet (the avi-storewolf incident, 2026-06-18). */
const ORG_DISALLOW_PAUSE_MS = 6 * 60 * 60 * 1000;
/** Body signatures of an org/subscription disqualification (403). Covers both observed forms: the
 *  OAuth-org disallow ("OAuth authentication is currently not allowed for this organization") and the
 *  spawned-claude-code disallow ("Claude subscription disabled for Claude Code"). */
const ORG_DISALLOWED_RE = /not allowed for this organization|subscription disabled for claude code|disabled for claude code/i;
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
/** Consecutive upstream TRANSPORT failures (a fetch stall/abort or connect error — NOT an HTTP status,
 *  which means the proxy WORKS) on ONE account before its egress circuit OPENS (B-GW-EGRESS, the
 *  2026-06-20 dead-proxy wedge). A transport failure never reaches Anthropic → never returns 429 → it
 *  fed NO account-health signal, so a DEAD egress proxy scored "healthiest", drew the MOST traffic, and
 *  overrode session pins (aviynw6/216.41.233.249, a half-dead squid CONNECT-hanging ~60s, wedged the
 *  whole gateway into a restart storm). A lone blip just briefly paces the account; a STREAK opens a
 *  longer circuit. Env-tunable. */
const EGRESS_FAIL_CIRCUIT_THRESHOLD = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_FAIL_THRESHOLD) || 3;
/** How long an OPEN egress circuit pauses the account — fed into the SAME gov.pausedUntil lever the 429
 *  hard-cap uses, so the existing pin-yield + cross-account selector already route around it. Short
 *  enough that the natural half-open (pause expires → the next request re-probes the account → a success
 *  closes the circuit, a transport failure re-opens it) retests soon; long enough to route the fleet
 *  around a dead proxy. Env-tunable. */
const EGRESS_CIRCUIT_OPEN_MS = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_CIRCUIT_MS) || 60_000;
/** Delay before the half-open egress PROBE fires after a circuit opens (egress-probe.ts re-tests the
 *  account's proxy through the same dispatcher). On success it clears the failure streak so the account
 *  readmits CLEAN at pause-expiry; `=0` disables the active probe (the natural pause-expiry half-open
 *  still applies). Env-tunable. */
const EGRESS_PROBE_DELAY_MS =
  process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_MS !== undefined ? Number(process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_MS) : 15_000;
/** Per-probe network timeout for the half-open egress probe — shorter than the probe default so it never
 *  lingers on a still-dead proxy. */
const EGRESS_PROBE_HTTP_TIMEOUT_MS = 8_000;
const DEFAULT_CONCURRENCY = 24; // the queue is the concurrency authority; governor does rate/pause
/** AIMD admission-concurrency defaults (inference-gateway-robustness-audit-2026-06-20 P1 / B-GW-1). The
 *  gateway shrinks the admission queue's EFFECTIVE maxConcurrent under sustained upstream 429s (fewer
 *  concurrent upstream calls = lower per-IP RPM = the throttle eases — breaking the retry-storm
 *  amplification) and additively recovers toward the cap when calls succeed. Semantics mirror the fleet
 *  AIMD gate (governor-registry.ts). Floor ≥1; tunable via deps.aimd / env. The floor stays a few slots
 *  so the pool can still rotate + absorb a short transient (the scout/gym no-CLI-retry protection). */
const DEFAULT_AIMD_FLOOR = Number(process.env.PAPERCUSP_GATEWAY_AIMD_FLOOR) || 4;
/** Net throttle pressure (429s minus successes) that trips one multiplicative halving — high enough that
 *  a lone transient 429 never shrinks the pool, low enough that a real storm reaches the floor fast. */
const DEFAULT_AIMD_DECREASE_THRESHOLD = Number(process.env.PAPERCUSP_GATEWAY_AIMD_DECREASE_THRESHOLD) || 6;
/** Consecutive clean 2xx that earn one additive +1 step back toward the cap (gentle recovery). */
const DEFAULT_AIMD_INCREASE_EVERY = Number(process.env.PAPERCUSP_GATEWAY_AIMD_INCREASE_EVERY) || 8;
/** Max requests allowed to WAIT for an admission slot before the gateway sheds load (429 + retry-after)
 *  instead of growing the backlog. Under a SUSTAINED pool-wide upstream throttle every in-flight request
 *  squats its slot for the full internal wait budget, so the queue would otherwise grow without bound
 *  until the gateway is wedged (the 2026-06-19/20 outages: queue hit 2k–3.6k deep, needing a manual
 *  restart). A bounded queue degrades to fast retryable 429s and self-recovers when the throttle clears.
 *  Env-tunable (PAPERCUSP_GATEWAY_MAX_QUEUED); generous by default so normal bursts still queue. */
const DEFAULT_MAX_QUEUED = Number(process.env.PAPERCUSP_GATEWAY_MAX_QUEUED) || 256;
/** retry-after (seconds) on a load-shed 429 — short, since the backlog drains as in-flight requests
 *  settle; the caller should retry soon (and will likely land once the burst/throttle eases). */
const LOADSHED_RETRY_AFTER_SEC = 5;
/** Upstream stall guard (the 2026-06-19 deadlock fix). `doFetch`/the body stream had NO deadline, so a
 *  stalled upstream (socket accepted, no response — Anthropic during an overload) hung the proxy task
 *  forever; PriorityAdmissionQueue only frees a slot when the task settles, so each hang leaked a slot
 *  until the pool deadlocked at maxConcurrent (every request then queued + timed out, on every account).
 *  An AbortController turns the permanent hang into a normal reject → slot release → failover. Two
 *  activity-reset windows so a LEGITIMATELY long request is never clipped: a wait for response HEADERS
 *  and a per-chunk idle gap for the streamed BODY (reset on every byte — only a true stall trips it).
 *  The headers wait is split by mode (2026-06-20): a STREAMING request's first byte/headers arrive in
 *  seconds (the bee `claude` CLI streams), so it gets a SHORT TTFB deadline — a stalled Anthropic socket
 *  (healthy accounts, no throttle: an Anthropic-side flap) then aborts in ~60s instead of squatting its
 *  admission slot for the full 5min, which presented as a silent multi-minute wedge (4th outage tonight).
 *  A NON-streaming request's headers only arrive AFTER the full generation, so it keeps the generous
 *  deadline (a short one would falsely abort a long completion). All env-overridable. */
const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_UPSTREAM_HEADERS_MS) || 5 * 60 * 1000;
const DEFAULT_UPSTREAM_STREAM_HEADERS_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_UPSTREAM_STREAM_HEADERS_MS) || 60 * 1000;
const DEFAULT_UPSTREAM_BODY_IDLE_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_UPSTREAM_BODY_IDLE_MS) || 90 * 1000;
/** Max wait for an OAuth token refresh before the attempt is FAILED instead of hung (the 2026-06-20
 *  token-hang wedge). `active.token()` does a network refresh (grant_type=refresh_token) with NO deadline
 *  of its own AND runs BEFORE the upstream stall-guard is armed — so when the OAuth endpoint stalls (it
 *  tends to during an upstream incident) every in-flight slot that needed a refresh blocked there forever,
 *  pinning all maxConcurrent slots until a manual restart (symptom: counters frozen, multi-minute log
 *  silence, queue climbing to the shed cap — distinct from the streaming-TTFB wedge above). Bounding it
 *  turns the hang into a fast reject → penalize the account + the finally releases the slot. Generous by
 *  default (a refresh is normally <2s). Env-overridable. */
const DEFAULT_TOKEN_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_TOKEN_MS) || 20 * 1000;
/** Downstream (gateway→client) idle timeout: if the bee's socket makes NO progress for this long while
 *  we stream a response to it, tear the socket down so a hung / half-open client (got headers, stopped
 *  reading, never sent RST) cannot pin the proxy task — and thus its admission slot — forever. The
 *  upstream stall-guard aborts UPSTREAM only; a completed-upstream + dead-client stream had no path to
 *  resolve (res never 'finish' — can't flush; never 'close' — half-open; upstream never 'error' — done),
 *  so the slot pinned with frozen counters + silent logs (the 2026-06-20 wedge #2). `res.setTimeout`
 *  fires on socket INACTIVITY, so it distinguishes a hung client (fires → destroy → 'close' → release)
 *  from a slow-but-draining one (write progress keeps resetting it). Env-tunable. */
const DEFAULT_DOWNSTREAM_IDLE_MS = Number(process.env.PAPERCUSP_GATEWAY_DOWNSTREAM_IDLE_MS) || 2 * 60 * 1000;
/** Hard per-request lifetime ceiling — a UNIVERSAL backstop. The activity timers (upstream headers/body,
 *  token refresh, downstream idle) each bound a SPECIFIC hang; this bounds the WHOLE request regardless of
 *  cause, so a future/unknown unbounded await can never silently pin an admission slot (the recurring
 *  2026-06-20 wedge class). Generous — longer than any legitimate single turn (a long non-streaming
 *  generation waits the 5-min headers deadline + body) — so it only fires on a genuine wedge, never on live
 *  traffic. On fire it aborts the in-flight upstream AND destroys the client socket → every await resolves
 *  → the finally releases the slot. Env-tunable. */
const DEFAULT_REQUEST_CEILING_MS = Number(process.env.PAPERCUSP_GATEWAY_REQUEST_CEILING_MS) || 20 * 60 * 1000;
/** A header-PINNED request waits at most this long on its pinned account before failing over to the
 *  pool's active() account (Fault #3): the spawn-side drain selector pins by the cross-process budget
 *  projection, which can't see the gateway's live pacing, so a pinned account may be actively paced —
 *  we must NOT 429-loop the bee into a $0 hang. Short, so failover is quick; cache-affinity yields. */
const PINNED_FAILOVER_WAIT_MS = 10_000;
/** Max round-robin hops the admission router takes looking for an account whose governor has headroom
 *  RIGHT NOW before falling back to waiting on the chosen one. Bounds the walk to roughly the pool size
 *  so an UNPINNED request egresses through an account with capacity instead of hanging the full
 *  maxQueueWaitMs on one paused-governor account while siblings sit admittable (the 2026-06-18
 *  "accounts unused / opus hangs" bug: aviynw2/aviynw7 returned opus 200 upstream while the gateway
 *  pinned all egress to one paused account). */
const POOL_WALK_MAX_ATTEMPTS = 16;
/** In-process self-heal release valve (EI-2086). The external WEDGE watchdog (watchdog.mjs) recovers a
 *  wedged gateway by FULL-RESTARTING the process — dropping every in-flight request + the listener
 *  (~15-30s fleet-wide connection-refused) — on the `frozen 120s while saturated` signature. The
 *  gateway's own per-request guards (5-min non-streaming headers, 20-min hard ceiling) reclaim a stuck
 *  slot far SLOWER than 120s, so the watchdog's restart always wins → the routine recovery became an
 *  hourly restart (5× on 2026-06-20). This sweeper PRE-EMPTS it: when saturated AND nothing has
 *  NATURALLY drained for SELFHEAL_FREEZE_MS (< 120s), it aborts the oldest stuck slot in-process, so the
 *  gateway drains its own wedge with the listener + healthy traffic still up. Default on; `=0` disables. */
const DEFAULT_SELFHEAL_ENABLED = process.env.PAPERCUSP_GATEWAY_SELFHEAL !== '0';
/** How long the gateway may be saturated with NO natural completion before the valve reclaims a slot.
 *  Deliberately below the watchdog's 120s freeze threshold so self-heal pre-empts the full restart. */
const DEFAULT_SELFHEAL_FREEZE_MS = Number(process.env.PAPERCUSP_GATEWAY_SELFHEAL_FREEZE_MS) || 75_000;
/** Sweeper tick interval — also the spacing between successive reclaims while a wedge persists, so a
 *  multi-slot wedge drains a slot every poll (several reclaims land before the watchdog's 120s). */
const DEFAULT_SELFHEAL_POLL_MS = Number(process.env.PAPERCUSP_GATEWAY_SELFHEAL_POLL_MS) || 10_000;
/** Header a bee/spawn sets to prioritise its requests (interactive/queen > batch). */
export const PRIORITY_HEADER = 'x-papercusp-priority';
/** Header a spawn sets to pin its requests to one pool account for cache affinity
 *  (inference-gateway-multi-credential-routing P-003). Stripped before the upstream forward. */
export const ACCOUNT_HEADER = 'x-papercusp-account';
/** Response header naming the pool account the gateway ACTUALLY routed a request to. Lets the
 *  caller (psu launcher / bootstrap-su / tests / operator) detect a silent fallback off a pinned
 *  account — e.g. the pin was ignored because the gateway's pool didn't contain it (the
 *  stale-`local`-pool fault), or it failed over off a paced/paused account. Not forwarded upstream
 *  (it's set on the response back to the client). */
export const ROUTED_ACCOUNT_HEADER = 'x-papercusp-routed-account';
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
  /** HOT-RELOAD the pool (B-HOT-1): atomically swap the live entries WITHOUT a gateway restart, keeping
   *  this pool object's identity (the gateway holds it for life). Optional: a pool that can't hot-reload
   *  omits it. The launch-layer reload primitive re-resolves the DB account pool then calls this. */
  reload?(next: readonly ActiveAccount[]): void;
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
  /** Wall-clock ceiling on internal retrying before a request sheds + frees its slot (wedge-prevention
   *  ladder). Default 60s (`INTERNAL_RETRY_DEADLINE_MS`); tests inject a tiny value to exercise the shed. */
  internalRetryDeadlineMs?: number;
  /** B-HOT-2: live pool config (version + account ids) for `GET /admin/config`. Absent ⇒ the endpoint
   *  reports `hotReload:false`. */
  adminConfig?: () => { version: number; accounts: string[] };
  /** B-HOT-2: hot-reload the account pool from the DB source-of-truth for `POST /admin/reload` (the
   *  on-demand twin of the launch-layer poll). Absent ⇒ `/admin/reload` returns 503 (not hot-reloadable). */
  onAdminReload?: () => Promise<{ changed: boolean; version: number; accounts: string[] }>;
  /** Concurrency authority — max requests forwarded at once (the queue cap). Default 24. */
  concurrency?: number;
  /** Max requests allowed to WAIT for a slot before the gateway sheds load (429 + retry-after) instead
   *  of growing an unbounded backlog. Prevents the slot-squat-under-sustained-throttle wedge. Default 256. */
  maxQueued?: number;
  /** Aging interval for the priority queue (ms a waiter takes to gain +1 priority). Default 1000. */
  agingIntervalMs?: number;
  /** Max wait for upstream RESPONSE HEADERS before the request is aborted as stalled. A stalled
   *  upstream (Anthropic accepts the socket during an overload but never responds) used to hang the
   *  proxy task forever, leaking its admission slot until the pool deadlocked (the 2026-06-19 outage).
   *  Generous by default because NON-streaming headers arrive only after the full generation; streaming
   *  headers are near-instant. Default 5 min (env PAPERCUSP_GATEWAY_UPSTREAM_HEADERS_MS). */
  upstreamHeadersTimeoutMs?: number;
  /** Headers/TTFB deadline for STREAMING requests (`stream:true`) — their first byte arrives in seconds,
   *  so a much shorter wait recovers from an Anthropic-side stall fast instead of squatting the slot for
   *  the generous non-streaming deadline. Default 60s (env PAPERCUSP_GATEWAY_UPSTREAM_STREAM_HEADERS_MS). */
  upstreamStreamHeadersTimeoutMs?: number;
  /** Max GAP between upstream BODY bytes once a response is streaming, before it is aborted as stalled.
   *  Reset on every chunk, so a legitimately long stream is never clipped — only a true mid-stream
   *  stall trips it. Default 90s (env PAPERCUSP_GATEWAY_UPSTREAM_BODY_IDLE_MS). */
  upstreamBodyIdleTimeoutMs?: number;
  /** Max wait for an OAuth token refresh (`active.token()`) before the attempt fails instead of hanging.
   *  token() does a deadline-less network refresh and runs BEFORE the upstream stall-guard, so a stalled
   *  refresh used to pin every admission slot until a manual restart (the 2026-06-20 token-hang wedge).
   *  Default 20s (env PAPERCUSP_GATEWAY_TOKEN_MS). */
  tokenTimeoutMs?: number;
  /** Downstream-idle timeout (ms): a hung/half-open client that stops reading mid-response is torn down
   *  after this much socket inactivity so it can't pin the proxy task's admission slot (the 2026-06-20
   *  wedge #2). Default 2 min (env PAPERCUSP_GATEWAY_DOWNSTREAM_IDLE_MS). */
  downstreamIdleMs?: number;
  /** Hard per-request lifetime ceiling (ms) — the universal backstop: a request that somehow outlives all
   *  activity timers is force-terminated (upstream abort + socket destroy) so it can't pin a slot from an
   *  unknown hang. Default 20 min (env PAPERCUSP_GATEWAY_REQUEST_CEILING_MS). */
  requestCeilingMs?: number;
  /** AIMD admission-concurrency tuning (B-GW-1). The gateway shrinks the admission queue's effective
   *  maxConcurrent under sustained upstream 429s and additively recovers when calls succeed. The cap is
   *  `concurrency`; these override the floor + the trip thresholds. Omit for env/defaults (floor 4,
   *  halve at net-pressure 6, +1 per 8 clean). Set `floor` ≥ cap to effectively DISABLE AIMD. */
  aimd?: { floor?: number; decreaseFactor?: number; decreaseThreshold?: number; increaseEvery?: number };
  /** In-process self-heal release valve (EI-2086): pre-empt the external watchdog's full restart by
   *  aborting the oldest stuck slot when saturated + nothing has naturally drained for `freezeMs`. Omit
   *  for env/defaults (enabled, freeze 75s, poll 10s). `enabled:false` disables it (e.g. unit tests
   *  that don't want the timer). */
  selfHeal?: { enabled?: boolean; freezeMs?: number; pollMs?: number };
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
  /** Count of 429s returned because the admission queue hit `maxQueued` (load-shed, not a task error). */
  shed429: number;
  /** Count of 429s shed at ADMISSION because the WHOLE pool was throttled with a far-off reset — the
   *  fail-fast path (B-GW-1) that frees the slot immediately instead of taking the acquire/retry path. */
  shedAllThrottled: number;
  /** The admission backlog cap that triggers load-shedding (0 = unbounded). */
  maxQueued: number;
  /** The CONFIGURED admission-concurrency cap (the AIMD ceiling). `admission.maxConcurrent` is the LIVE
   *  effective concurrency after AIMD adaptation; this is the ceiling it recovers toward. */
  concurrencyCap: number;
  /** AIMD admission-concurrency state (B-GW-1): effective vs cap/floor + lifetime decrease/increase
   *  counts — the dashboard's adaptive-throttle signal (a climbing `decreases` = a sustained storm). */
  aimd: AimdSnapshot;
  /** Count of 5h-exhaustion failovers between pool accounts (EI-535). */
  failovers: number;
  upstreamErrors: number;
  /** Count of egress-circuit OPENs (B-GW-EGRESS): how many times a per-account egress proxy hit the
   *  consecutive-transport-failure threshold and was paused out of rotation. A climbing value = a
   *  flapping/dead proxy IP (distinct from `upstreamErrors`, which also counts Anthropic-side stalls). */
  egressCircuitOpens: number;
  /** Count of in-process self-heal slot-reclaims (EI-2086) — how many times the release valve pre-empted
   *  a watchdog full-restart. A climbing value = the gateway is wedging but recovering itself instead of
   *  restarting; pair it with the watchdog's restart count to see the valve doing its job. */
  selfHealReclaims: number;
  /** The bound account's most-constraining unified window, if seen (D-009 / P-014). */
  unified?: { window: string; utilization: number; resetAt: number; rejected: boolean };
  pausedUntil: number;
  /** Prompt-cache instrumentation (#0, 2026-06-21): per-account + total cache read/write tokens with
   *  hit/miss counts, failover-induced misses tagged. `hitRate` = read/(read+create+input) — how much of
   *  the input context was a cache HIT vs a cold (re)write. Surfaces the cost of routing a bee off its
   *  cache-warm account. */
  cache: {
    read: number;
    create: number;
    input: number;
    hits: number;
    misses: number;
    failoverMisses: number;
    hitRate: number;
    byAccount: Record<string, { read: number; create: number; hits: number; misses: number; failoverMisses: number; hitRate: number }>;
  };
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

/** Reject if `p` doesn't settle within `ms` — bounds an otherwise deadline-less await (the OAuth token
 *  refresh, which has no timeout of its own and runs before the upstream stall-guard). The timer is
 *  unref'd so it never keeps the event loop alive, and is cleared the moment `p` settles. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    t.unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
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
  const internalRetryDeadlineMs = deps.internalRetryDeadlineMs ?? INTERNAL_RETRY_DEADLINE_MS;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const upstreamHeadersTimeoutMs = deps.upstreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS;
  const upstreamStreamHeadersTimeoutMs = deps.upstreamStreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_STREAM_HEADERS_TIMEOUT_MS;
  const upstreamBodyIdleTimeoutMs = deps.upstreamBodyIdleTimeoutMs ?? DEFAULT_UPSTREAM_BODY_IDLE_TIMEOUT_MS;
  const tokenTimeoutMs = deps.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  const downstreamIdleMs = deps.downstreamIdleMs ?? DEFAULT_DOWNSTREAM_IDLE_MS;
  const requestCeilingMs = deps.requestCeilingMs ?? DEFAULT_REQUEST_CEILING_MS;
  const log = deps.log ?? (() => {});
  const maxQueued = deps.maxQueued ?? DEFAULT_MAX_QUEUED;
  const selfHealEnabled = deps.selfHeal?.enabled ?? DEFAULT_SELFHEAL_ENABLED;
  const selfHealFreezeMs = deps.selfHeal?.freezeMs ?? DEFAULT_SELFHEAL_FREEZE_MS;
  const selfHealPollMs = deps.selfHeal?.pollMs ?? DEFAULT_SELFHEAL_POLL_MS;
  const queue = new PriorityAdmissionQueue({ maxConcurrent: concurrency, agingIntervalMs: deps.agingIntervalMs, maxQueued });

  // AIMD adaptive admission concurrency (B-GW-1): the queue's maxConcurrent is the cap; this controller
  // shrinks the LIVE effective concurrency under sustained upstream 429s (driving queue.setMaxConcurrent
  // down → fewer concurrent upstream calls → lower per-IP RPM → the throttle eases, breaking the
  // retry-storm amplification) and additively recovers toward the cap as calls succeed. Fed by
  // aimd.recordThrottle() on each upstream 429 + aimd.recordSuccess() on each forwarded 2xx below.
  const aimd = new AimdConcurrencyController({
    cap: concurrency,
    floor: deps.aimd?.floor ?? DEFAULT_AIMD_FLOOR,
    decreaseFactor: deps.aimd?.decreaseFactor,
    decreaseThreshold: deps.aimd?.decreaseThreshold ?? DEFAULT_AIMD_DECREASE_THRESHOLD,
    increaseEvery: deps.aimd?.increaseEvery ?? DEFAULT_AIMD_INCREASE_EVERY,
    onChange: (eff) => {
      queue.setMaxConcurrent(eff);
      log('warn', `inference-gateway: AIMD admission concurrency → ${eff}/${concurrency} (effective/cap)`);
    },
  });

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
    // undici's ProxyAgent is an HTTP-CONNECT proxy client — it does NOT speak SOCKS. A socks:// (or any
    // non-http(s)) proxyUrl CONSTRUCTS without error but fails at REQUEST time (the proxy rejects the
    // HTTP CONNECT), which would silently 502 every request for this account. So honor only http(s)
    // proxies here; a non-http(s) scheme is IGNORED with a loud warning and we fall through to a bound
    // source IP (localAddress) if set, else default shared egress — fail SAFE, never silently break an
    // account. Native SOCKS egress is a tracked follow-up (WI-284).
    const httpProxy = eg.proxyUrl && /^https?:\/\//i.test(eg.proxyUrl) ? eg.proxyUrl : undefined;
    if (eg.proxyUrl && !httpProxy) {
      log('warn', `inference-gateway: egress proxyUrl for '${account.accountId}' ('${eg.proxyUrl}') is not http(s) — undici ProxyAgent is HTTP-CONNECT only; ignoring it (native SOCKS is a follow-up, WI-284)`);
    }
    if (!httpProxy && !eg.localAddress) return undefined;
    const key = `${account.accountId}|${httpProxy ?? ''}|${eg.localAddress ?? ''}`;
    const hit = dispatcherCache.get(key);
    if (hit) return hit;
    try {
      undiciMod ??= await import('undici');
      const d: UndiciDispatcher = httpProxy
        ? new undiciMod.ProxyAgent(httpProxy)
        : new undiciMod.Agent({ connect: { localAddress: eg.localAddress } });
      dispatcherCache.set(key, d);
      return d;
    } catch (e) {
      log('warn', `egress dispatcher for '${account.accountId}' failed (${(e as Error).message}); using default egress`);
      return undefined;
    }
  }

  // Egress circuit-breaker state (B-GW-EGRESS, 2026-06-20 dead-proxy wedge): per-account consecutive
  // upstream TRANSPORT-failure streak (a stall/abort/connect-fail carries NO HTTP status, so unlike a
  // 429 it never fed account health → a DEAD egress proxy scored "healthiest" + got flooded + overrode
  // pins). Reset on any upstream RESPONSE (even a 429 — the proxy works). A streak ≥ threshold opens the
  // account's circuit via gov.pausedUntil (the same lever the 429 hard-cap uses). `egressProbePending`
  // dedupes the half-open probe.
  const egressFailStreak = new Map<string, number>();
  const egressProbePending = new Set<string>();
  /** Half-open egress probe: after a circuit opens, re-test the account's proxy with the SAME dispatcher
   *  the gateway uses (egress-probe.ts). On success it clears the failure streak so the account readmits
   *  CLEAN when its pause expires (the natural half-open) — the pause itself is lifted by EXPIRY, since
   *  the shared governor's pausedUntil is take-MAX (can only extend, never shorten: a 429 streak = real
   *  exhaustion). Best-effort, unref'd, never throws into the request path. `EGRESS_PROBE_DELAY_MS=0`
   *  disables the active probe (pause-expiry half-open still applies). */
  function scheduleEgressProbe(account: ActiveAccount): void {
    if (EGRESS_PROBE_DELAY_MS <= 0 || egressProbePending.has(account.accountId)) return;
    egressProbePending.add(account.accountId);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const probe = await probeEgress(
            { id: account.accountId, egress: account.egress } as ClaudeAccount,
            { timeoutMs: EGRESS_PROBE_HTTP_TIMEOUT_MS },
          );
          if (probe.exitIp) {
            egressFailStreak.delete(account.accountId);
            log('warn', `inference-gateway: egress half-open probe for '${account.accountId}' RECOVERED (exit ${probe.exitIp}) — readmits clean at pause-expiry`);
          } else {
            log('warn', `inference-gateway: egress half-open probe for '${account.accountId}' STILL DOWN (${probe.error ?? 'no exit IP'}) — stays circuit-paused`);
          }
        } catch (err) {
          log('warn', `inference-gateway: egress probe error for '${account.accountId}': ${(err as Error).message}`);
        } finally {
          egressProbePending.delete(account.accountId);
        }
      })();
    }, EGRESS_PROBE_DELAY_MS);
    t.unref?.();
  }

  let totalRequests = 0;
  let upstream429 = 0;
  let queued429 = 0;
  let shed429 = 0; // load-shed: 429s returned because the admission queue was at maxQueued (backlog cap)
  let shedAllThrottled = 0; // fail-fast: 429s shed at admission because the whole pool was throttled (B-GW-1)
  let upstreamErrors = 0;
  let failovers = 0;
  let egressCircuitOpens = 0; // B-GW-EGRESS: per-account egress-proxy circuit opens (dead/flapping IP, transport-failure streak)
  let selfHealReclaims = 0; // EI-2086: in-process release-valve slot reclaims (pre-empted watchdog restarts)

  // Prompt-cache instrumentation (#0, 2026-06-21): a PASSIVE per-account tally of cache read/write tokens
  // parsed from each response's usage (the `message_start` SSE event), so we can SEE the prompt-cache hit
  // rate per account + the cost of routing a bee off its cache-warm account. Zero hot-path cost: the
  // observer runs ALONGSIDE the client pipe (never in it) and detaches after the first event.
  const CACHE_MISS_MIN_TOKENS = 1024; // ignore tiny requests — only a non-trivial cold prefix counts as a "miss"
  interface CacheTally { read: number; create: number; input: number; hits: number; misses: number; failoverMisses: number; }
  const newTally = (): CacheTally => ({ read: 0, create: 0, input: 0, hits: 0, misses: 0, failoverMisses: 0 });
  const cacheByAccount = new Map<string, CacheTally>();
  const cacheTotal = newTally();
  function recordCacheUsage(accountId: string, input: number, read: number, create: number, didFailover: boolean): void {
    const t = cacheByAccount.get(accountId) ?? newTally();
    for (const x of [t, cacheTotal]) {
      x.read += read;
      x.create += create;
      x.input += input;
      // HIT = reused a cached prefix. MISS = processed a non-trivial prefix with NO cache read (a cold
      // (re)write — first-time, expired, or wrong-account). A miss that FOLLOWED a failover is routing-induced.
      if (read > 0) x.hits++;
      else if (input + create >= CACHE_MISS_MIN_TOKENS) {
        x.misses++;
        if (didFailover) x.failoverMisses++;
      }
    }
    cacheByAccount.set(accountId, t);
  }
  // Attach a bounded, passive 'data' observer that captures the message_start usage then detaches. Runs
  // ALONGSIDE the client pipe (never in it), so it adds zero client-visible latency and can never break the
  // stream (all parsing is wrapped + best-effort).
  function observeCacheUsage(stream: Readable, accountId: string, didFailover: boolean): void {
    let buf = '';
    let done = false;
    const onData = (chunk: Buffer) => {
      if (done) return;
      buf += chunk.toString('utf8');
      const m = buf.match(/^data: (\{"type":"message_start".*\})$/m);
      if (m) {
        done = true;
        stream.off('data', onData);
        try {
          const u = (JSON.parse(m[1]) as { message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } }).message?.usage;
          if (u) recordCacheUsage(accountId, u.input_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, didFailover);
        } catch {
          /* malformed message_start — ignore; never break the stream */
        }
      } else if (buf.length > 32_768) {
        done = true; // message_start not in the first 32KB (non-stream JSON / odd framing) → give up
        stream.off('data', onData);
      }
    };
    stream.on('data', onData);
  }
  const cacheRate = (t: CacheTally): number => {
    const denom = t.read + t.create + t.input;
    return denom > 0 ? Math.round((t.read / denom) * 1000) / 1000 : 0;
  };
  function cacheSnapshot(): GatewayStats['cache'] {
    const byAccount: GatewayStats['cache']['byAccount'] = {};
    for (const [id, t] of cacheByAccount) {
      byAccount[id] = { read: t.read, create: t.create, hits: t.hits, misses: t.misses, failoverMisses: t.failoverMisses, hitRate: cacheRate(t) };
    }
    return {
      read: cacheTotal.read,
      create: cacheTotal.create,
      input: cacheTotal.input,
      hits: cacheTotal.hits,
      misses: cacheTotal.misses,
      failoverMisses: cacheTotal.failoverMisses,
      hitRate: cacheRate(cacheTotal),
      byAccount,
    };
  }

  // Self-heal in-flight registry (EI-2086): every request currently holding an admission slot, keyed by
  // a per-request id, carrying its start time + stream flag + an abort hook (the same force-terminate
  // path as the hard-ceiling backstop). The sweeper reclaims the oldest stuck slot from here.
  interface InFlightEntry {
    id: number;
    startedAt: number;
    isStream: boolean;
    reclaimed: boolean; // set when the self-heal valve aborts it → the finally skips the drain-clock bump
    abort: (reason: string) => void;
  }
  const inFlightReg = new Map<number, InFlightEntry>();
  let reqSeq = 0;
  // The TRUE drain signal: epoch ms of the last NATURAL completion (a real upstream settle, NOT a
  // self-heal abort). `msSinceLastDrain` = now - lastDrainAt is what the valve keys on, so a wedge we
  // are actively reclaiming stays "stalled" until a request genuinely completes or saturation eases.
  let lastDrainAt = Date.now();

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
      shed429,
      shedAllThrottled,
      maxQueued,
      concurrencyCap: concurrency,
      aimd: aimd.snapshot(),
      failovers,
      upstreamErrors,
      egressCircuitOpens,
      selfHealReclaims,
      unified: snap.unified,
      pausedUntil: snap.pausedUntil,
      cache: cacheSnapshot(),
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
    // Streaming requests get the SHORT TTFB headers deadline (first byte in seconds); non-streaming the
    // generous one (headers only after the full generation). Default false → generous, so an unparseable
    // body never gets the short clip.
    let isStream = false;
    if (url.startsWith('/v1/messages') && bodyBuf.length) {
      try {
        const j = JSON.parse(bodyBuf.toString('utf8')) as { model?: string; stream?: boolean };
        if (typeof j.model === 'string') model = j.model;
        if (j.stream === true) isStream = true;
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

    // ROUTE TO CAPACITY (2026-06-18, owner-reported "accounts unused / opus hangs"): if the chosen
    // UNPINNED (or pinned-yielded-to-active) account's governor is currently PAUSED, round-robin the
    // pool to an account whose governor has headroom NOW — rather than hanging the full maxQueueWaitMs
    // (2 min) on a paused account while sibling accounts sit admittable (some Max accounts return opus
    // 200 upstream while others are 429-paused; the pool must egress through one with capacity). A
    // still-pinned request is left on its pin (it already yielded to active() above if its pin was
    // paused). `pool.active()` round-robins, so each hop advances to a different account.
    if (active.accountId !== pinned?.accountId && gov.state.pausedUntil > Date.now()) {
      let soonestPaused = gov.state.pausedUntil;
      let found = false;
      for (let walk = 0; walk < POOL_WALK_MAX_ATTEMPTS; walk++) {
        const cand = pool.active();
        const cgov = governorForAccount(model, cand.accountId);
        if (cgov.state.pausedUntil <= Date.now()) {
          active = cand;
          gov = cgov;
          found = true;
          break;
        }
        soonestPaused = Math.min(soonestPaused, cgov.state.pausedUntil);
      }
      // FAIL-FAST SHED when the WHOLE reachable pool is throttled (B-GW-1 / audit P1). The walk found no
      // account with headroom AND the soonest reset is beyond maxQueueWaitMs — so gov.acquire would just
      // fast-fail with a 429 anyway (its first iteration returns null when the pause exceeds maxWaitMs,
      // never forwarding). Shed NOW instead: free the admission slot immediately (no acquire/retry path
      // squatting it) and return an ACCURATE pool-wide retry-after + a distinct signal, rather than the
      // chosen-account retry-after the acquire-timeout path emits. A NEARER pause (≤ maxQueueWaitMs) falls
      // through to acquire, which waits it out → real 200, and the post-acquire retry-loop still absorbs a
      // short transient for an in-process caller — AIMD (above), not this shed, bounds that absorb's blast
      // radius by shrinking how many slots are admitted at once.
      if (!found && soonestPaused - Date.now() > maxQueueWaitMs) {
        totalRequests++;
        shedAllThrottled++;
        const retryAfterSec = Math.max(1, Math.ceil((soonestPaused - Date.now()) / 1000));
        log('warn', `inference-gateway: whole pool throttled (soonest reset ${retryAfterSec}s > admission wait cap) → fail-fast shed 429 (slot freed, not squatted)`);
        sendJson(
          res,
          429,
          { type: 'error', error: { type: 'rate_limit_error', message: `inference-gateway: all accounts throttled; retry after ${retryAfterSec}s` }, gateway: true },
          { 'retry-after': String(retryAfterSec), [ROUTED_ACCOUNT_HEADER]: active.accountId },
        );
        return;
      }
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
        { 'retry-after': String(retryAfterSec), [ROUTED_ACCOUNT_HEADER]: active.accountId },
      );
      return;
    }

    // Downstream-idle guard (2026-06-20 wedge #2): a hung/half-open bee that stopped reading mid-stream
    // had no deadline — the upstream stall-guard aborts UPSTREAM only, so a completed-upstream + dead
    // client pinned the admission slot forever. Tear the socket down after downstreamIdleMs of NO socket
    // progress → res emits 'close' → the streaming await below resolves → finally releases the slot.
    res.setTimeout(downstreamIdleMs, () => res.destroy());

    // Opt-in per-request routing trace (PAPERCUSP_GATEWAY_ROUTE_LOG=1): logs the pinned account
    // requested via the x-papercusp-account header vs the account this request ACTUALLY egressed on
    // — the ground-truth diagnostic for "is my pin landing / failing over". Off by default (noisy).
    if (process.env.PAPERCUSP_GATEWAY_ROUTE_LOG === '1') {
      log('info', `gw-route: client=${req.socket?.remotePort ?? '?'} want=${wantAccount ?? '-'} routed=${active.accountId} model=${model}`);
    }

    // Upstream stall guard (2026-06-19 deadlock fix). An activity-reset deadline that aborts the
    // upstream call if it stalls, so a hung upstream can never pin the proxy task (and leak its
    // admission slot) forever. Hoisted above the try so `finally` clears it as a backstop. The
    // AbortController itself is per-attempt (created in the loop), but the timer handle lives here.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const clearStall = () => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = undefined; }
    };
    // Hard per-request lifetime ceiling (universal backstop): regardless of WHICH await a request is stuck
    // in, force it to terminate after requestCeilingMs so it can never pin its admission slot from an
    // unknown hang. Aborts the in-flight upstream (currentAc) AND destroys the client socket → every await
    // below (fetch / peekBody / the streaming pipe) resolves → the finally releases the slot.
    let currentAc: AbortController | undefined;
    const ceilingTimer = setTimeout(() => {
      log('error', `inference-gateway: request hit the ${requestCeilingMs}ms hard ceiling on '${active.accountId}' — force-terminating (slot backstop)`);
      try { currentAc?.abort(new Error(`request ceiling: ${requestCeilingMs}ms`)); } catch { /* already settled */ }
      try { res.destroy(); } catch { /* already torn down */ }
    }, requestCeilingMs);
    ceilingTimer.unref?.();
    // Register in the self-heal in-flight registry (EI-2086) BEFORE the try so the finally ALWAYS
    // deregisters it. abort() mirrors the hard-ceiling backstop (abort the current attempt + destroy the
    // socket) so a reclaimed request frees its admission slot the same proven way.
    const reqId = ++reqSeq;
    inFlightReg.set(reqId, {
      id: reqId,
      startedAt: Date.now(),
      isStream,
      reclaimed: false,
      abort: (reason) => {
        try { currentAc?.abort(new Error(reason)); } catch { /* already settled */ }
        try { res.destroy(); } catch { /* already torn down */ }
      },
    });
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
      let transientWaitedMs = 0; // total time spent WAITING out short transient throttles (budget #2)
      // Wedge-prevention ladder: the wall-clock instant past which this request STOPS retrying, sheds a
      // retryable 429, and frees its admission slot — strictly before the self-heal valve (75s) / watchdog
      // (120s) would forcibly reclaim it. Computed from the slot-acquire moment (this is the same request
      // lifetime the inFlightReg `startedAt` tracks), so total slot-hold is bounded under any storm.
      const retryDeadlineAt = Date.now() + internalRetryDeadlineMs;
      for (;;) {
        // Bound the OAuth token refresh (2026-06-20 token-hang wedge). active.token() does a deadline-less
        // network refresh AND runs before the per-attempt stall-guard below, so a stalled refresh used to
        // pin this admission slot forever (every slot hung here → manual-restart-only recovery). On
        // timeout/failure: penalize THIS account out of rotation (the per-request selector routes the
        // bee's retry to a healthy account) and return a retryable 503. The finally releases the slot, so
        // one stalled credential can never wedge the pool.
        let token: string;
        try {
          token = await withDeadline(active.token(), tokenTimeoutMs, `token refresh '${active.accountId}'`);
        } catch (e) {
          upstreamErrors++;
          log('error', `inference-gateway: token refresh failed on '${active.accountId}': ${(e as Error).message} — penalizing account + 503`);
          gov.penalize({ retryAfterMs: BARE_429_FAILOVER_BACKOFF_MS, resetAt: Date.now() + BARE_429_FAILOVER_BACKOFF_MS });
          if (!res.headersSent) {
            sendJson(
              res,
              503,
              { type: 'error', error: { type: 'overloaded_error', message: `inference-gateway: token refresh stalled on '${active.accountId}'; retry shortly` }, gateway: true },
              { 'retry-after': '5', [ROUTED_ACCOUNT_HEADER]: active.accountId },
            );
          }
          return;
        }
        const headers: Record<string, string> = { ...baseHeaders, authorization: `Bearer ${token}` };

        // Per-attempt abort + stall deadline: aborts THIS upstream call (headers or body) if it
        // stalls, converting a permanent hang into a reject → the finally releases the admission slot.
        const ac = new AbortController();
        currentAc = ac; // expose this attempt's controller to the hard-ceiling backstop
        const armStall = (ms: number) => {
          clearStall();
          stallTimer = setTimeout(() => ac.abort(new Error(`upstream stall: no activity for ${ms}ms`)), ms);
          stallTimer.unref?.();
        };
        let up: Response;
        try {
          const init: FetchInit = { method: req.method ?? 'POST', headers, signal: ac.signal };
          if (bodyBuf.length) init.body = new Uint8Array(bodyBuf);
          // Per-account IP routing: forward this account's request through its dedicated egress
          // dispatcher (proxy / bound source IP) when configured; absent ⇒ default (shared) egress.
          const dispatcher = await dispatcherFor(active);
          if (dispatcher) init.dispatcher = dispatcher;
          // Wait for response HEADERS under the headers deadline; once they arrive, switch to the
          // per-chunk body-idle deadline (reset on each streamed byte below).
          // WEDGE-PREVENTION LADDER: while waiting for headers the request has made NO progress, so it may
          // not hold its admission slot past the retry deadline — cap the headers wait by the remaining
          // deadline (Math.max floor so an at-deadline retry still gets a brief attempt, not a 0ms abort).
          // This bounds even the generous 5-min non-streaming headers timeout under an upstream stall storm.
          // NB: only the HEADERS wait is deadline-capped; once headers arrive we arm body-idle (below), which
          // is NOT deadline-bounded — a healthy long STREAM keeps its slot as long as bytes flow (progress
          // resets body-idle), so this never aborts a legitimately-streaming response.
          const headersStallMs = isStream ? upstreamStreamHeadersTimeoutMs : upstreamHeadersTimeoutMs;
          armStall(Math.max(1, Math.min(headersStallMs, retryDeadlineAt - Date.now())));
          up = await doFetch(`${upstreamBase}${url}`, init as RequestInit);
          armStall(upstreamBodyIdleTimeoutMs);
          // Transport succeeded for THIS account (response headers arrived) — its egress proxy works, so
          // clear its transport-failure streak. A 429/5xx still means the proxy WORKED (just throttled —
          // that's the 429 path's job, not the egress circuit's).
          egressFailStreak.delete(active.accountId);
        } catch (e) {
          clearStall();
          upstreamErrors++;
          const stalled = ac.signal.aborted;
          log('error', `upstream fetch ${stalled ? 'STALLED (aborted)' : 'failed'} on '${active.accountId}': ${(e as Error).message}`);
          // TRANSPORT-FAILURE EGRESS CIRCUIT BREAKER (B-GW-EGRESS, 2026-06-20 dead-proxy wedge) — SCOPED
          // to accounts that egress through an HTTP PROXY. A fetch that STALLS (a dead/half-dead proxy
          // CONNECT-hangs → the stall-guard aborts) or fails to connect never reaches Anthropic, so —
          // unlike a 429 — it carries NO HTTP status and never fed account health. A DEAD egress proxy
          // therefore accrued ZERO penalty: the router kept scoring it "healthiest", routed the MOST
          // traffic to it, AND overrode session pins onto it ("yields to liveness") — one half-dead
          // Rayobyte squid (aviynw6/216.41.233.249, 60s CONNECT hangs) wedged the whole gateway into a
          // restart storm. Fix: feed the transport failure into the SAME gov.pausedUntil lever the 429
          // hard-cap uses (so the existing pin-yield + cross-account selector route around it), escalate
          // a consecutive STREAK to a longer OPEN circuit, and ROTATE + retry rather than 502-ing the bee.
          //   SCOPING: only an account WITH an http proxy can have a DEAD proxy. An account with NO proxy
          //   that transport-fails is an Anthropic/network-side stall (the proxy can't be the fault), so
          //   it keeps the existing fast-502 — the bee's CLI retries, the next request lands on the
          //   failover-rotated active(), and AIMD shrinks concurrency under a sustained Anthropic stall —
          //   and its healthy account is NOT penalized. (Mirrors dispatcherFor's http(s)-proxy check.)
          const hasEgressProxy = !!active.egress?.proxyUrl && /^https?:\/\//i.test(active.egress.proxyUrl);
          if (hasEgressProxy) {
            const streak = (egressFailStreak.get(active.accountId) ?? 0) + 1;
            egressFailStreak.set(active.accountId, streak);
            const circuitOpen = streak >= EGRESS_FAIL_CIRCUIT_THRESHOLD;
            const pauseMs = circuitOpen ? EGRESS_CIRCUIT_OPEN_MS : TRANSIENT_429_BACKOFF_MS;
            const resetAt = Date.now() + pauseMs;
            // take-MAX (recordPenalty) → this never SHORTENS a legitimate longer 429/usage-cap pause.
            gov.penalize({ retryAfterMs: pauseMs, resetAt });
            if (circuitOpen) {
              egressCircuitOpens++;
              log('warn', `inference-gateway: EGRESS CIRCUIT OPEN for '${active.accountId}' (${streak} consecutive transport failures) — out of rotation ${Math.round(pauseMs / 1000)}s; half-open retest on pause-expiry`);
              scheduleEgressProbe(active);
            }
            // ROUTE AROUND IT: rotate to a healthy account + retry on the same admission slot (like the
            // usage-cap path). pool.onExhausted also marks this account out of the round-robin until
            // resetAt and hands back the next account with budget.
            // WEDGE-PREVENTION LADDER: only rotate+retry while still WITHIN the slot-hold deadline. Under an
            // Anthropic-WIDE stall storm (every proxy account TTFB-stalls — not a dead proxy), this branch
            // would otherwise chain INTERNAL_RETRY_MAX_ATTEMPTS × ~60s stalls and squat the slot for minutes
            // (past the 75s self-heal / 120s watchdog → the restart storm). Past the deadline → fall through
            // to the fast retryable 503 below, freeing the slot so the bee's CLI retries against a recovered pool.
            if (attempt < INTERNAL_RETRY_MAX_ATTEMPTS - 1 && Date.now() < retryDeadlineAt) {
              const next = pool.onExhausted(active.accountId, resetAt);
              if (next && next.accountId !== active.accountId) {
                failovers++;
                active = next;
                gov = governorForAccount(model, active.accountId);
                attempt++;
                log('warn', `inference-gateway: transport ${stalled ? 'stall' : 'failure'} on egress proxy → failover to '${active.accountId}' (attempt ${attempt})`);
                continue;
              }
            }
            // No healthy account left / rotation budget spent — return a RETRYABLE 503 (the bee's CLI
            // retries; the next request lands on the failover-rotated active()), never a terminal 502.
            if (!res.headersSent) {
              sendJson(
                res,
                503,
                { type: 'error', error: { type: 'overloaded_error', message: `inference-gateway: egress proxy ${stalled ? 'stall' : 'transport error'} on '${active.accountId}'; retry shortly` }, gateway: true },
                { 'retry-after': '5', [ROUTED_ACCOUNT_HEADER]: active.accountId },
              );
            }
            return;
          }
          // No egress proxy → an Anthropic/network-side stall, not a dead proxy: preserve the existing
          // fast-502 (the bee's CLI retries those; the next request lands on the failover-rotated
          // active()). The upstream stall-guard already aborted the hang; do not penalize a healthy account.
          sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `inference-gateway upstream ${stalled ? 'stall timeout' : 'error'}: ${(e as Error).message}` }, gateway: true });
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
          // AIMD signal (B-GW-1, refined 2026-06-21 budget-aware routing): a 429 shrinks GLOBAL admission
          // concurrency ONLY when it's genuine pool-wide over-drive — i.e. we could NOT route it around to a
          // healthy account. recordThrottle() is therefore DEFERRED to the failover decision below: a
          // per-account quota/throttle 429 that successfully fails over to a healthy account is a ROUTING
          // event, NOT global pressure, so it must not shrink concurrency. (The bug it fixes: every 429 —
          // incl. quota-429s from the 98-99%-maxed accounts the round-robin kept hitting — recorded a
          // throttle, collapsing effective→AIMD-floor while 5/8 accounts sat at 55-91% headroom, so 34
          // requests queued behind a 4-wide gate and timed out → the owner-reported bee "API errors".)
          // 529 is server-overload (not per-IP RPM) and never counts.
          const reset = parseRateReset(hobj);
          const unifiedRejected = gov.snapshot().unified?.rejected === true;
          // Anthropic's AUTHORITATIVE per-request signal: `x-should-retry: true` on a 429 means a SHORT
          // TRANSIENT burst-throttle (capacity exists, retry), NOT quota/5h exhaustion (which sets
          // x-should-retry:false + window/retry-after headers). This OVERRIDES a stale governor
          // `unified.rejected` latch: a single past 5h-window rejection used to mis-mark every later
          // transient opus 429 as "5h-exhausted", so the gateway rotated through ALL accounts treating
          // each as dead and forwarded the retryable 429 (the owner-reported "accounts aren't saturated
          // but the gateway 429s" bug, 2026-06-18). Trust x-should-retry over the latched flag.
          const shouldRetry = String((hobj['x-should-retry'] ?? '')).toLowerCase() === 'true';
          // A BARE 429: rate_limit_error with NO window headers — a transient burst throttle (the
          // aviynw10 stuck-loop, 2026-06-17). A 429 may ALSO be a hard usage/session CAP — the BODY names
          // it ("hit your session limit"); util can be 0 on a capped account (a DIFFERENT meter than the
          // rolling window), so only the body reveals it. Peek the tiny error body to tell them apart.
          const bare429 =
            up.status === 429 &&
            reset.retryAfterMs === undefined &&
            reset.resetAt === undefined &&
            (!unifiedRejected || shouldRetry);
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
        } else if (up.status === 403) {
          // Account-level org/subscription DISQUALIFICATION (not a transient throttle): the account's
          // Anthropic org disabled OAuth API access, or Claude Code for the subscription. Forwarding the
          // 403 hard-fails the bee AND, when this account is active(), 403-blocks the WHOLE fleet
          // (avi-storewolf, 2026-06-18). Treat it like a hard cap: pause this account out of rotation +
          // fail over to a healthy one. A DIFFERENT 403 (not org/subscription) is forwarded unchanged.
          if (up.body) {
            const peek = await peekBody(up.body, USAGE_LIMIT_PEEK_BYTES);
            peekedHead = peek.head;
            peekedRest = peek.rest;
            if (ORG_DISALLOWED_RE.test(peek.head.toString('utf8'))) {
              const resetAt = Date.now() + ORG_DISALLOW_PAUSE_MS;
              gov.penalize({ resetAt });
              internalRetry = { rotate: true, backoffMs: 0, exhaustResetAt: resetAt };
              log('warn', `inference-gateway: account '${active.accountId}' org/subscription-disallowed (403) → pausing ${Math.round(ORG_DISALLOW_PAUSE_MS / 3600000)}h + failover to a healthy account`);
            }
          }
        } else if (up.status === 401) {
          active.invalidateToken?.();
        }

        // Internal retry with TWO SEPARATE budgets, so a fleet-wide transient burst is waited out without
        // burning the rotation budget:
        //   (1) INTERNAL_RETRY_MAX_ATTEMPTS bounds ROTATIONS across accounts (+ 529 server-overload back-offs).
        //   (2) TRANSIENT_TOTAL_WAIT_BUDGET_MS bounds WAITING for a SHORT transient throttle to clear.
        // The bug this fixes (owner-reported, 2026-06-18): with N accounts ALL transiently throttled on
        // opus at once (x-should-retry:true — capacity exists), the old single-budget loop rotated through
        // a few accounts, hit the attempt cap BEFORE exhausting the pool, and forwarded the retryable 429
        // — which an in-process caller (scout/gym, no CLI retry budget) can't absorb → $0 no-ideas.
        // Now: rotate while fresh accounts remain AND the rotation budget holds; otherwise, if the throttle
        // is SHORT (exhaustResetAt within the recovery cap — NOT a multi-hour usage cap) and the wait budget
        // holds, WAIT the soonest account's penalty out + retry the recovered `active`. Both budgets bound
        // total latency, so a request can never hang. A usage cap / multi-hour reset is forwarded, not waited.
        if (internalRetry) {
          let proceed = false;
          // Fix B (budget-aware routing): did this per-account 429 successfully fail over to a HEALTHY,
          // different account? If so it's a routing event, not global over-drive — AIMD must ignore it.
          let routedAround = false;
          let backoff = internalRetry.backoffMs;
          // A genuinely transient throttle resets within the recovery cap; a usage cap / org pause is hours out.
          const transient =
            internalRetry.exhaustResetAt > 0 &&
            internalRetry.exhaustResetAt - Date.now() <= ALL_THROTTLED_RECOVERY_WAIT_CAP_MS;
          if (attempt < INTERNAL_RETRY_MAX_ATTEMPTS - 1) {
            if (internalRetry.rotate) {
              const next = pool.onExhausted(active.accountId, internalRetry.exhaustResetAt);
              if (next && next.accountId !== active.accountId) {
                failovers++;
                active = next;
                gov = governorForAccount(model, active.accountId);
                attempt++;
                proceed = true;
                routedAround = true; // routed a per-account quota-429 to a healthy account → NOT global pressure
              }
            } else {
              // 529 server-overload: back off + retry the SAME account (no penalty/rotation).
              attempt++;
              proceed = true;
            }
          }
          if (!proceed && transient) {
            // Rotation can't help (no fresh account, or rotation budget spent) but the throttle is SHORT
            // and capacity exists — wait the soonest account's penalty out + retry. `active`'s penalty
            // expires during the wait, so the retry re-hits the recovered account. Bounded by the wait budget.
            const waitMs = Math.min(
              Math.max(0, internalRetry.exhaustResetAt - Date.now()),
              ALL_THROTTLED_RECOVERY_WAIT_CAP_MS,
              Math.max(0, retryDeadlineAt - Date.now()), // never wait PAST the wedge-prevention deadline
            );
            if (waitMs > 0 && transientWaitedMs + waitMs <= TRANSIENT_TOTAL_WAIT_BUDGET_MS) {
              transientWaitedMs += waitMs;
              backoff = waitMs;
              proceed = true;
              log('warn', `inference-gateway: all accounts transiently throttled on ${model} → wait ${waitMs}ms + retry (wait-budget ${transientWaitedMs}/${TRANSIENT_TOTAL_WAIT_BUDGET_MS}ms)`);
            }
          }
          // WEDGE-PREVENTION LADDER: regardless of remaining rotation/wait budget, never keep retrying (and
          // squatting this admission slot) past the deadline. Shed now — fall through to forward the upstream
          // 429 (retryable) so the slot frees BEFORE the self-heal valve (75s) / watchdog (120s) would reclaim
          // it. This caps total slot-hold time, which is what stops the frozen-while-saturated wedge from
          // forming at the AIMD floor under a slow-upstream storm.
          if (proceed && Date.now() >= retryDeadlineAt) {
            proceed = false;
            shedAllThrottled++;
            log('warn', `inference-gateway: internal-retry deadline ${internalRetryDeadlineMs}ms hit on '${active.accountId}' (model ${model}) → shed 429, free slot (wedge-prevention ladder)`);
          }
          // AIMD throttle signal (Fix B): record a throttle ONLY for a 429 we could NOT route around to a
          // healthy account — the genuine pool-wide-saturation signal (we waited / shed / will forward it).
          // A routed-around per-account quota-429 stays invisible to global AIMD, so one account hitting its
          // quota can no longer choke the whole gateway's admission concurrency.
          if (up.status === 429 && !routedAround) aimd.recordThrottle();
          if (proceed) {
            clearStall(); // this attempt is done; the next iteration arms a fresh deadline
            peekedRest?.destroy(); // discard the throttled/capped account's body
            if (backoff > 0) {
              await new Promise<void>((r) => {
                const t = setTimeout(r, backoff);
                t.unref?.();
              });
            }
            log('warn', `inference-gateway: upstream ${up.status} → internal retry attempt=${attempt} wait=${transientWaitedMs}ms on '${active.accountId}'`);
            continue;
          }
        }

        // AIMD clean signal (B-GW-1): a forwarded 2xx means this account had real capacity — drain the
        // throttle pressure + nudge admission concurrency back up toward the cap. A forwarded non-2xx
        // (a 4xx client error, or a 429 we chose not to retry) is neither throttle nor clean-capacity,
        // so it neither shrinks nor grows the limit (a 429 already recorded its throttle above).
        if (up.status >= 200 && up.status < 300) aimd.recordSuccess();

        const outHeaders: Record<string, string> = {};
        up.headers.forEach((v, k) => {
          if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders[k] = v;
        });
        // Detectability: name the account this request ACTUALLY egressed on, so a silent fallback
        // off a pin (unknown id / paced-account failover) is visible to the caller, not invisible.
        outHeaders[ROUTED_ACCOUNT_HEADER] = active.accountId;
        res.writeHead(up.status, outHeaders);
        if (peekedHead !== null) {
          // We already consumed this body via peekBody — write the peeked head, then stream any remainder.
          if (peekedHead.length) res.write(peekedHead);
          if (peekedRest) {
            peekedRest.on('data', () => armStall(upstreamBodyIdleTimeoutMs)); // reset idle deadline per chunk
            peekedRest.pipe(res);
            await new Promise<void>((resolve) => {
              res.on('finish', () => resolve());
              res.on('close', () => resolve());
              res.on('error', () => resolve());
              peekedRest!.on('error', () => { res.destroy(); resolve(); });
              // Wedge-prevention (the stuck-stream slot leak): also force-resolve on the ceiling/self-heal
              // abort so a half-open-client + hung-body stream can't pin its admission slot forever.
              const onAbort = () => {
                try { peekedRest!.destroy(); } catch { /* already torn down */ }
                try { res.destroy(); } catch { /* already torn down */ }
                resolve();
              };
              if (ac.signal.aborted) onAbort();
              else ac.signal.addEventListener('abort', onAbort, { once: true });
            });
          } else {
            res.end();
          }
        } else if (up.body) {
          const nodeStream = Readable.fromWeb(up.body as Parameters<typeof Readable.fromWeb>[0]);
          // Reset the body-idle deadline on every chunk so a legitimately long stream is never clipped —
          // only a genuine mid-stream stall (no bytes for upstreamBodyIdleTimeoutMs) trips the abort,
          // which surfaces as a stream 'error' below → resolve → finally releases the slot.
          nodeStream.on('data', () => armStall(upstreamBodyIdleTimeoutMs));
          // Cache instrumentation (#0): PASSIVE observer — tally this request's prompt-cache read/write from
          // the message_start event WITHOUT touching the client pipe. `attempt > 0` ⇒ the request failed over
          // off its initially-selected account, so a miss here is routing-induced.
          observeCacheUsage(nodeStream, active.accountId, attempt > 0);
          nodeStream.pipe(res);
          await new Promise<void>((resolve) => {
            res.on('finish', () => resolve());
            res.on('close', () => resolve());
            res.on('error', () => resolve());
            nodeStream.on('error', () => {
              res.destroy();
              resolve();
            });
            // Wedge-prevention — the 80-min stuck-stream slot leak (2026-06-21). This await previously
            // listened ONLY to res/nodeStream events, so a stream where the CLIENT is half-open (never emits
            // res 'close') AND the upstream body has ended-or-hung (never emits nodeStream 'error') pinned its
            // admission slot FOREVER — surviving every self-heal reclaim AND the 20-min hard ceiling, because
            // both abort `ac` (=currentAc) yet this await ignored that abort. (Observed: slot #178 held 4800s.)
            // Make the abort ALSO force-tear-down both streams + resolve, so a reclaim/ceiling actually frees it.
            const onAbort = () => {
              try { nodeStream.destroy(); } catch { /* already torn down */ }
              try { res.destroy(); } catch { /* already torn down */ }
              resolve();
            };
            if (ac.signal.aborted) onAbort();
            else ac.signal.addEventListener('abort', onAbort, { once: true });
          });
        } else {
          res.end();
        }
        clearStall();
        return;
      }
    } finally {
      clearStall();
      clearTimeout(ceilingTimer);
      const entry = inFlightReg.get(reqId);
      if (entry) {
        inFlightReg.delete(reqId);
        // A NATURAL completion (not a self-heal abort) refreshes the drain clock — proof the gateway is
        // draining, which keeps the valve dormant. A reclaimed request deliberately does NOT, so an
        // actively-reclaimed wedge stays "stalled" and the next tick frees another slot.
        if (!entry.reclaimed) lastDrainAt = Date.now();
      }
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
    if (req.method === 'GET' && url === '/admin/config') {
      // B-HOT-2: the LIVE config snapshot — pool version + account ids + the admission/AIMD state — so an
      // operator / gateway:status tool can read what the gateway is actually running, no restart.
      const s = stats();
      sendJson(res, 200, {
        ...(deps.adminConfig ? deps.adminConfig() : { hotReload: false }),
        admission: s.admission,
        concurrencyCap: s.concurrencyCap,
        aimd: s.aimd,
        upstreamBase,
      });
      return;
    }
    if (req.method === 'POST' && url === '/admin/reload') {
      // B-HOT-2: on-demand HOT-RELOAD — re-resolve the DB account pool + swap it live NOW (vs the 60s poll).
      if (!deps.onAdminReload) {
        sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: 'inference-gateway: hot-reload not wired on this gateway' }, gateway: true });
        return;
      }
      req.resume(); // drain any request body so the socket releases cleanly
      void deps
        .onAdminReload()
        .then((r) => sendJson(res, 200, { ok: true, ...r }))
        .catch((e) => sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: `inference-gateway: reload failed: ${(e as Error).message}` }, gateway: true }));
      return;
    }
    if (!url.startsWith('/v1/')) {
      sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'inference-gateway only proxies /v1/*' }, gateway: true });
      return;
    }
    const pri = priorityFromLabel((req.headers[PRIORITY_HEADER] as string | undefined) ?? undefined);
    queue.run(pri, () => proxy(req, res, url)).catch((e) => {
      // Load-shed (queue at maxQueued): a retryable 429 + retry-after, NOT a crash — this is the
      // backpressure that keeps the gateway responsive + self-recovering under a sustained throttle
      // instead of growing an unbounded backlog until it wedges.
      if (e instanceof QueueFullError) {
        shed429++;
        // proxy() never ran, so the request body was never consumed — drain it (and close the
        // connection) or the unread socket stays busy and can't be released cleanly (leaks sockets;
        // hangs a graceful server.close()).
        req.resume();
        if (!res.headersSent) {
          sendJson(
            res,
            429,
            { type: 'error', error: { type: 'rate_limit_error', message: `inference-gateway: backlog full (${queue.snapshot().queued} waiting); shedding load, retry shortly` }, gateway: true },
            { 'retry-after': String(LOADSHED_RETRY_AFTER_SEC), connection: 'close' },
          );
        }
        return;
      }
      upstreamErrors++;
      log('error', `proxy handler crashed: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: 'inference-gateway internal error' }, gateway: true });
      else res.destroy();
    });
  });

  // Self-heal release-valve sweeper (EI-2086): tick the pure decider against live admission metrics +
  // the in-flight registry and reclaim the oldest stuck slot to pre-empt the watchdog's full restart.
  // unref'd so it never keeps the process alive; cleared on close().
  let selfHealTimer: ReturnType<typeof setInterval> | undefined;
  if (selfHealEnabled) {
    selfHealTimer = setInterval(() => {
      try {
        // Read queue.snapshot() directly (NOT stats(), which advances the pool round-robin cursor).
        const admission = queue.snapshot();
        const decision = evaluateSelfHeal(
          {
            inFlight: admission.running,
            queueDepth: admission.queued,
            maxConcurrent: admission.maxConcurrent,
            msSinceLastDrain: Date.now() - lastDrainAt,
          },
          selfHealFreezeMs,
        );
        if (!decision.reclaim) return;
        const target = pickReclaimTarget([...inFlightReg.values()]);
        if (!target) return; // saturated per the counters but the registry is momentarily empty — skip
        target.reclaimed = true;
        selfHealReclaims++;
        log(
          'error',
          `inference-gateway: SELF-HEAL release valve — ${decision.reason} (slot #${target.id}, held ${Math.round((Date.now() - target.startedAt) / 1000)}s, stream=${target.isStream}; reclaim #${selfHealReclaims})`,
        );
        target.abort('inference-gateway self-heal: reclaiming wedged slot to pre-empt watchdog restart');
      } catch (e) {
        log('warn', `inference-gateway: self-heal sweep error: ${(e as Error).message}`);
      }
    }, selfHealPollMs);
    selfHealTimer.unref?.();
  }

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
      if (selfHealTimer) clearInterval(selfHealTimer);
      // Tear down any per-account egress dispatchers (best-effort; they hold sockets).
      for (const d of dispatcherCache.values()) void (d as { close?: () => Promise<void> }).close?.();
      dispatcherCache.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export type InferenceGateway = ReturnType<typeof createInferenceGateway>;
