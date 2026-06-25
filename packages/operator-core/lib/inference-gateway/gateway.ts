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
  snapshotGovernors,
  effectiveRpm,
  effectivePaceMs,
  effectiveRpmFactor,
  PriorityAdmissionQueue,
  QueueFullError,
  AimdConcurrencyController,
  priorityFromLabel,
  tierOf,
  shedTierCaps,
  classifyHttpError,
  parseUsageResetMs,
  type RateLimitGovernor,
  type AdmissionSnapshot,
  type AimdSnapshot,
  type TierAdmissionConfig,
  type PriorityTierMap,
} from '@papercusp/papercusp-shared/agent';
import { withOAuthBeta } from './credential-store';
import { classifyCredential401Streak, DEFAULT_CREDENTIAL_401_DEAD_THRESHOLD } from './credential-health';
import { evaluateSelfHeal, pickReclaimTarget } from './gateway-self-heal';
import { probeEgress } from './egress-probe';
import { gatewayProviderStatuses, makeGatewayProviderAdapters, providerForGatewayRequest } from './provider-adapters';
import type { AccountEgress, ClaudeAccount } from '../deployment/account-pool';

/** `RequestInit` plus undici's `dispatcher` extension (per-account egress routing). The standard
 *  lib `RequestInit` type omits it, but Node's global `fetch` honors it. */
type UndiciDispatcher = import('undici').Dispatcher;
type FetchInit = RequestInit & { dispatcher?: UndiciDispatcher };

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
// Pre-admission wait (NO admission slot held → cannot wedge): how long a request parks waiting for an
// account's rate to clear before failing with a retry-after. Bumped 2→4 min (2026-06-22) so the gateway
// ABSORBS more transient throttles for the caller (it succeeds after a longer wait instead of surfacing a
// 429) — safe because no slot is held and the fail-fast-shed still bails immediately when the soonest reset
// is BEYOND this window (a doomed request never waits the full budget). Kept comfortably under the bee CLI's
// ~10-min SDK request timeout. Env-tunable. (The POST-admission 60s slot-hold deadline is a SEPARATE,
// wedge-bounded budget and is NOT changed here.)
const DEFAULT_MAX_QUEUE_WAIT_MS = Number(process.env.PAPERCUSP_GATEWAY_MAX_QUEUE_WAIT_MS) || 4 * 60 * 1000;
// EXTENDED POST-ADMISSION ABSORPTION (env-tunable, 2026-06-22). When > 0, rather than FORWARD a retryable
// transient throttle 429 to the caller (after rotation + the in-retry wait-budget are exhausted) the gateway
// RELEASES its admission slot and re-acquires — the re-acquire's wait holds NO slot, so it CANNOT wedge — looping
// until an account serves or this POST-admission budget runs out. So the caller WAITS LONGER and succeeds instead
// of getting a $0 429. Only a TRANSIENT throttle is absorbed (`transient` gate excludes multi-hour usage caps).
// RAMPED ON at 60s (2026-06-22, owner-ratified): wedge-safe by construction + a held-then-succeeded call beats a
// shed 429 that fails a bee at $0. Sized so maxQueueWaitMs + this stays under the bee CLI's ~10-min SDK timeout.
// 0 = OFF (legacy: shed/forward at the deadline). Env-tunable; injectable per-gateway via deps.requestAbsorbMs.
const DEFAULT_REQUEST_ABSORB_MS = Number(process.env.PAPERCUSP_GATEWAY_REQUEST_ABSORB_MS) || 60_000;
// P-003 (gateway-priority-tiers, SAFE variant of the priority throttle-park): tier-differential absorb
// patience. A higher-priority tier HOLDS the caller longer through a transient throttle-park (so it wins the
// recovered account); a batch tier sheds SOONER (freeing the slot for the high tier) — the OUTCOME of "serve
// highest tier first" WITHOUT a governor-wait-queue restructure (which collides with the absorb's gov-layer
// re-acquire). Applied only when the tier layer is on (`tierMap` set) and the absorb is on; identity (factor 1)
// otherwise. Env PAPERCUSP_GATEWAY_ABSORB_TIER_SCALE=0 disables. Factors ≤1.5, so maxQueueWaitMs + the scaled
// absorb stays under the bee CLI's ~10-min SDK timeout for a sanely-sized requestAbsorbMs.
const ABSORB_TIER_SCALE_ON = process.env.PAPERCUSP_GATEWAY_ABSORB_TIER_SCALE !== '0';
function absorbTierFactor(tier: number | undefined): number {
  if (!ABSORB_TIER_SCALE_ON || tier === undefined) return 1;
  if (tier <= 1) return 1.5; // interactive / queen / scout / overwatch — hold longest
  if (tier === 2) return 1.25; // su
  if (tier === 3) return 1; // bee — the baseline
  return 0.6; // tier 4+ (unknown / batch) — sheds soonest, freeing the slot for the high tiers
}
// INTERACTIVE FAIL-FAST (no-pin-hang follow-up #2, 2026-06-23): a HUMAN-facing caller (priority label
// `interactive` / `operator`) prefers a fast, clear retry-after over the long autonomous stall-absorb hold —
// a bee benefits from held-then-succeed, a person at a prompt does not. Their absorb is CAPPED at this (a brief
// transient blip is still absorbed; a sustained storm sheds quickly), while autonomous tier-1 roles (queen /
// scout / overwatch) keep the full tier-scaled hold — so this OVERRIDES absorbTierFactor's 1.5 for the human
// labels only. Env-tunable; 0 disables the cap (revert to the pure tier factor). The proactive health pick
// (no-pin fix above) already keeps these requests OFF the absorb in the common case; this only bounds the
// worst (whole-pool-throttled-but-recovering) case for a human.
const INTERACTIVE_ABSORB_MS = Number(process.env.PAPERCUSP_GATEWAY_INTERACTIVE_ABSORB_MS) || 8_000;
/** Priority labels that mark a HUMAN-facing caller (vs an autonomous role) → they get the fail-fast absorb cap. */
const HUMAN_PRIORITY_LABELS = new Set(['interactive', 'operator']);
// STALL ABSORPTION (2026-06-23, su-3650b incident fix #2): extend the in-request absorb to the dominant failure
// — TRANSPORT STALLS (Anthropic holding the connection → egress circuit). The 429-absorb can't help (no 429);
// under an Anthropic-wide stall storm every account TTFB-stalls, the gateway exhausts rotation + sheds a
// retryable 503, and the caller errors. With this on, the egress-exhausted shed instead RELEASES the slot +
// re-acquires (gov.acquire waits for a circuit-OPEN account's transport-pause to lift via the half-open probe)
// + retries — so the caller WAITS through the storm and succeeds. Bounded by the same absorb budget (no slot
// held during the wait → cannot wedge). Gated by requestAbsorbMs>0 (the absorb being on); kill-switch:
// PAPERCUSP_GATEWAY_ABSORB_STALLS=0 reverts to the immediate retryable-503 shed.
const ABSORB_STALLS_ON = process.env.PAPERCUSP_GATEWAY_ABSORB_STALLS !== '0';
/** G1 (WI-649): when ≥half the account pool is out of rotation (a FLEET-WIDE bare-burst storm), SUPPRESS the
 *  cross-account rotate-retry on a bare 429 — rotating A→B→C finds no capacity and just multiplies upstream
 *  load (the observed 2.4× fan-out: 152 upstream-429s / 63 requests + 108 failovers), sustaining the storm.
 *  Suppressing it lets the request fall through to the bounded transient-wait / absorb / fail-fast-shed so it
 *  makes ≈1 upstream call instead of ~2.4. The few-accounts-maxed→rotate-to-healthy path is preserved (this
 *  fires ONLY when <half the pool has rotation budget). Kill-switch: PAPERCUSP_GATEWAY_SUPPRESS_BAREBURST_ROTATE=0. */
const SUPPRESS_BAREBURST_ROTATE_ON = process.env.PAPERCUSP_GATEWAY_SUPPRESS_BAREBURST_ROTATE !== '0';
/** A header-less ("bare") upstream 429 carries no window/retry signal — but it comes with
 *  `x-should-retry: true`, i.e. a SHORT transient burst-throttle (capacity exists), NOT quota
 *  exhaustion (which sets retry-after / unified-window headers + x-should-retry:false). So pace the
 *  account for this short bounded backoff AND fail over — rotating off the momentarily-limited
 *  account instead of 429-looping it (the aviynw10 stuck-loop, 2026-06-17). Tuned to the observed
 *  transient-throttle duration: long enough to let it clear, short enough not to over-bench an
 *  account that's already recovered (which would thin the pool under broad concurrent contention). */
const BARE_429_FAILOVER_BACKOFF_MS = 15 * 1000;
/** SOFT-PIN failover threshold: the per-account in-flight count at/above which a header-PINNED request stops
 *  funneling onto its pinned account and yields to the healthiest idle sibling instead (owner-reported
 *  "unpinned 10+ sessions fine, but pinned breaks after a few" — pinning concentrates N concurrent sessions
 *  onto ONE account, saturating its per-account RPM/burst limit while the rest of the pool sits idle). A pin
 *  stays sticky for sequential/single-session use (in-flight 0-1 → cache affinity preserved); only a
 *  CONCURRENT pile-up on the pinned account spreads. Env-tunable. */
const PIN_YIELD_INFLIGHT = Number(process.env.PAPERCUSP_GATEWAY_PIN_YIELD_INFLIGHT) || 2;
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
// FALLBACK ceiling on the egress-circuit pause: the half-open probe now LIFTS the pause the instant the
// proxy recovers (out-duration = actual recovery, usually a few seconds), so this only bites when the probe
// is disabled or the proxy is genuinely dead. Shortened 60s→20s (2026-06-21) so a flaky proxy never strands
// a token-healthy account for a full minute even in the probe-off fallback path.
const EGRESS_CIRCUIT_OPEN_MS = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_CIRCUIT_MS) || 20_000;
/** FLAPPING BACKOFF (2026-06-22): a chronically-flapping egress proxy (circuit reopens soon after a readmit)
 *  gets a progressively LONGER open — doubling per reopen up to this cap — so we stop readmitting-and-failing
 *  it every EGRESS_CIRCUIT_OPEN_MS, which routes real bee requests back onto a known-bad proxy → 503. Observed
 *  during a sustained Rayobyte outage: 134 circuit opens in 50 min thrashing the same proxies. */
const EGRESS_CIRCUIT_OPEN_MAX_MS = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_CIRCUIT_MAX_MS) || 300_000;
/** A proxy stable (no reopen) for longer than this RESETS its flapping escalation — the next open is treated
 *  as fresh (base duration), so a one-off blip never inherits a chronic flapper's long backoff. */
const EGRESS_FLAP_RESET_MS = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_FLAP_RESET_MS) || 300_000;
/** Consecutive SUCCESSFUL egress probes required before readmitting a circuit-paused account. A flapping proxy
 *  (passes a probe, then stalls the real request) rarely strings two spaced probes together → it stays out;
 *  a genuinely-recovered proxy readmits after just one extra probe interval. =1 restores the old behavior. */
const EGRESS_PROBE_READMIT_STREAK = Number(process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_READMIT_STREAK) || 2;
/** Delay before the half-open egress PROBE fires after a circuit opens (egress-probe.ts re-tests the
 *  account's proxy through the same dispatcher). On success it clears the failure streak so the account
 *  readmits CLEAN at pause-expiry; `=0` disables the active probe (the natural pause-expiry half-open
 *  still applies). Env-tunable. */
const EGRESS_PROBE_DELAY_MS =
  process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_MS !== undefined ? Number(process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_MS) : 4_000;
/** Per-probe network timeout for the half-open egress probe — bounded so it never lingers on a still-dead
 *  proxy, yet generous enough to CONFIRM a recovered-but-slow proxy. The per-account egress squids
 *  legitimately take 1.3–6.1s under box load; the old 8s cap false-aborted healthy proxies ("egress probe
 *  STILL DOWN (operation aborted)") → the recovered account stayed circuit-paused the full window → the
 *  pool read "all throttled / no-fresh-account" → bees hung on their first inference with 0 invocations
 *  (WI-389). Kept under EGRESS_CIRCUIT_OPEN_MS − EGRESS_PROBE_DELAY_MS so the probe still fits inside the
 *  open window. Env-tunable. */
const EGRESS_PROBE_HTTP_TIMEOUT_MS =
  Number(process.env.PAPERCUSP_GATEWAY_EGRESS_PROBE_HTTP_MS) || 12_000;
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
// Fix 2 — serviceable-count admission clamp knobs (2026-06-23 thundering-herd fix). Live admission is clamped to
// MIN(aimd-effective, serviceableAccounts × PER_ACCOUNT_ADMISSION), floored at MIN_SERVICEABLE_ADMISSION so the
// pool always keeps a probe path. SERVICEABLE_CLAMP_MODEL is the (most-constrained) model whose per-(model,account)
// governor pause the serviceability check reads. OFF (PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP=0) ⇒ no clamp.
const SERVICEABLE_CLAMP_ON = process.env.PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP !== '0';
const PER_ACCOUNT_ADMISSION = Number(process.env.PAPERCUSP_GATEWAY_PER_ACCOUNT_ADMISSION) || 4;
const MIN_SERVICEABLE_ADMISSION = Number(process.env.PAPERCUSP_GATEWAY_MIN_ADMISSION) || 2;
const SERVICEABLE_CLAMP_TICK_MS = Number(process.env.PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP_TICK_MS) || 2000;
const SERVICEABLE_CLAMP_MODEL = process.env.PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP_MODEL || 'claude-opus-4';
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
 *  seconds (the bee `claude` CLI streams, + Anthropic emits `message_start` BEFORE it generates), so it gets
 *  a SHORT TTFB deadline — a stalled Anthropic socket (a soft-throttle that HOLDS the request, or an
 *  Anthropic-side flap) then aborts quickly instead of squatting its admission slot for the full 5min.
 *  Cut 60→30s (2026-06-22): account-side stalls dominate under throttle, and a real first byte arrives in
 *  seconds, so 30s is still a 6×+ margin — but it frees the slot + the retry budget twice as fast to route
 *  around the stalling account (the dominant "pinned/low-activity account still errored" failure mode).
 *  A NON-streaming request's headers only arrive AFTER the full generation, so it keeps the generous
 *  deadline (a short one would falsely abort a long completion). All env-overridable. */
const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_UPSTREAM_HEADERS_MS) || 5 * 60 * 1000;
const DEFAULT_UPSTREAM_STREAM_HEADERS_TIMEOUT_MS = Number(process.env.PAPERCUSP_GATEWAY_UPSTREAM_STREAM_HEADERS_MS) || 30 * 1000;
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
/** Cap on the `retry-after` the gateway ever HANDS A BEE on a shed/admission-timeout 429. The internal
 *  governor pause may be tens of minutes (a 7d-exhausted rolling window — see ROLLING_WINDOW_REPROBE_MAX_MS),
 *  but that's a ROUTING horizon (keep the account parked), NOT how long the bee should sleep: telling a bee
 *  "retry after 1800s" strands it (owner-reported 2026-06-21). Forward a short retry-after so the bee re-asks
 *  soon — by then routing has walked to a healthy account, or the stall-waker resumes it. Env-tunable. */
const BEE_RETRY_AFTER_CAP_S = Number(process.env.PAPERCUSP_GATEWAY_BEE_RETRY_AFTER_CAP_S) || 60;
/** Grace before a shutdown FORCE-destroys still-streaming connections (2026-06-22 audit). server.close()
 *  alone waits for every long-lived SSE stream to end → it hung past systemd's TimeoutStopSec and got
 *  force-killed (orphaned process). Drop idle keep-alives immediately, let near-done requests finish within
 *  this window, then destroy the rest so the restart is prompt. Well under the unit's TimeoutStopSec=30s. */
const GRACEFUL_SHUTDOWN_MS = Number(process.env.PAPERCUSP_GATEWAY_SHUTDOWN_GRACE_MS) || 5_000;
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
/** Header a spawn sets carrying its coord ownerId (== spawnId), so the gateway can attribute a
 *  rate-limit shed back to THIS bee and a coordinator can wake it once the account recovers
 *  (gateway-rate-limit-stall-autowake P-001). Stripped before the upstream forward. */
export const OWNER_HEADER = 'x-papercusp-owner';
const ANTHROPIC_VERSION = '2023-06-01';
/** Hop-by-hop + body-framing headers never copied verbatim across the proxy. */
const STRIP_REQUEST = new Set(['host', 'authorization', 'x-api-key', 'x-papercusp-account', 'x-papercusp-owner', 'content-length', 'accept-encoding', 'connection', 'transfer-encoding', 'keep-alive']);
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
  /** Clear an account's out-of-rotation pause ahead of its reset (the dual of onExhausted) — called when a
   *  half-open egress probe confirms the proxy recovered, so a token-healthy account rejoins rotation the
   *  instant transport is healthy rather than sitting out the full circuit window. Optional. */
  readmit?(accountId: string): void;
  /** HOT-RELOAD the pool (B-HOT-1): atomically swap the live entries WITHOUT a gateway restart, keeping
   *  this pool object's identity (the gateway holds it for life). Optional: a pool that can't hot-reload
   *  omits it. The launch-layer reload primitive re-resolves the DB account pool then calls this. */
  reload?(next: readonly ActiveAccount[]): void;
  /** Count of accounts currently IN rotation (not exhausted/paused) — the live capacity denominator the
   *  priority-tier `/stats` reports alongside the per-tier demand so an operator sees headroom vs queueing.
   *  Optional: a single-account pool omits it (the gateway then reports 1). */
  healthyCount?(extra?: (accountId: string) => boolean): number;
  /** Total accounts in the live pool — the DENOMINATOR for healthyCount() that the fleet-wide-bare-burst
   *  detector (G1, WI-649) needs to decide whether ≥half the pool is out of rotation (rotating would find
   *  no capacity). Optional: a single-account pool omits it (the gateway then treats the pool size as 1). */
  size?(): number;
  /** H3: non-advancing "current best" for read-only callers (stats/startup/health pollers) — see active(). */
  peek?(): ActiveAccount;
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
  /** Codex/OpenAI-compatible account pool. When present, non-Anthropic `/v1/*` routes
   *  (for example `/v1/responses`) are forwarded through this pool with bearer injection. */
  codexPool?: AccountPool;
  /** Upstream base URL. Default `https://api.anthropic.com`; a fake in tests. */
  upstreamBase?: string;
  /** OpenAI-compatible upstream base URL. Default `https://api.openai.com`. */
  openaiUpstreamBase?: string;
  /** `fetch` impl (injected in tests). Default global fetch. */
  fetchImpl?: typeof fetch;
  /** The governor for a model (default: the shared per-account `claude-code` governor). */
  governorFor?(model: string): RateLimitGovernor;
  /** Max admission wait before a synthetic 429+retry-after. Default 2 min. */
  maxQueueWaitMs?: number;
  /** POST-admission extended-absorption budget (ms). >0 = on a slot-hold-deadline shed, release the slot +
   *  re-acquire + retry (no slot held during the wait → no wedge) instead of 429ing, up to this budget. 0 = OFF. */
  requestAbsorbMs?: number;
  /** Cap on the extended-absorb budget for a HUMAN-facing caller (priority `interactive`/`operator`) so a
   *  person fails fast with a clear retry-after instead of the long autonomous hold. Default
   *  `INTERACTIVE_ABSORB_MS` (env `PAPERCUSP_GATEWAY_INTERACTIVE_ABSORB_MS`, 8s); 0 disables the cap. */
  interactiveAbsorbMs?: number;
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
  /** OPTIONAL priority-TIER admission layer (gateway-priority-tiers-2026-06-22, `GATEWAY_PRIORITY_TIERS`).
   *  Resolved + flag-gated by the launch layer: ABSENT ⇒ the gateway behaves byte-identically to today (a
   *  flat priority+aging gate). PRESENT ⇒ the queue gains per-tier in-flight caps + a reserved tier-1 floor,
   *  requests are tiered from the `x-papercusp-priority` role via `map`, and the AIMD shrink also sheds the
   *  bottom tier caps (4→3→2, holding tier 1). */
  priorityTiers?: {
    /** Role/label → tier map (`x-papercusp-priority` header value → admission band, 1 = highest). */
    map: PriorityTierMap;
    /** Steady-state per-tier caps + reserved tier-1 floor (the un-shed baseline). */
    config: TierAdmissionConfig;
  };
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
  /** Smooth each per-account RPM allowance into an even inter-request pace (governor.smoothRpm) so the
   *  fleet can't fire a sub-minute BURST that trips Anthropic's burst limit (the bare-burst 429 storm,
   *  2026-06-23). Throughput-neutral (the per-minute count gate still caps the rate). Default = env
   *  `PAPERCUSP_GATEWAY_RPM_SMOOTH` (on unless '0'); the test harness passes `false` so rapid-fire unit
   *  tests under a tiny maxQueueWaitMs are byte-identical. */
  smoothRpm?: boolean;
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
  /** CREDENTIAL-HEALTH alert side-channel (#5 PART A). Fired FIRE-AND-FORGET (never awaited, never
   *  throws into the request path) the FIRST time an account's credential 401s `credential401DeadThreshold`
   *  times IN A ROW *despite* the gateway's drop+refresh (`invalidateToken`) — i.e. the refresh keeps
   *  yielding the same invalid credential, so it's genuinely DEAD/expired, not merely stale-cached. The
   *  launch layer wires this to a LOUD escalation (severity 'blocker', meta.source 'credential-health',
   *  transition-only so it doesn't re-open every request) + a fleet broadcast. The streak resets on the
   *  next successful auth (a 2xx) for that account, which re-arms a fresh alert for a later episode. */
  onCredentialDead?(info: { accountId: string; consecutive401s: number }): void;
  /** Consecutive-401 streak that marks a credential DEAD (vs stale-cached) → fires `onCredentialDead`.
   *  Default `DEFAULT_CREDENTIAL_401_DEAD_THRESHOLD` (3); tests inject a small value. ≤0 disables the alert. */
  credential401DeadThreshold?: number;
}

export interface GatewayStats {
  accountId: string;
  upstreamBase: string;
  totalRequests: number;
  inFlight: number;
  queueDepth: number;
  /** Per-priority queue breakdown (P-011 / P-014). With the priority-TIER layer on, `admission.byTier`
   *  carries the per-tier {cap,inFlight,queued} and `admission.tier1Reserve` the reserved floor. */
  admission: AdmissionSnapshot;
  /** Priority-TIER admission summary (gateway-priority-tiers-2026-06-22) — the per-tier
   *  {tier,cap,inFlight,queued} from the queue PLUS the pool-wide `healthyAccounts` capacity denominator,
   *  and the reserved tier-1 floor. PRESENT only when the tier layer is configured (flag ON); ABSENT under
   *  flag-OFF so the stats payload is byte-identical to today. */
  priorityTiers?: {
    healthyAccounts: number;
    tier1Reserve: number;
    tiers: { tier: number; cap: number | null; inFlight: number; queued: number }[];
  };
  upstream429: number;
  queued429: number;
  /** Count of 429s returned because the admission queue hit `maxQueued` (load-shed, not a task error). */
  shed429: number;
  /** Count of 429s shed at ADMISSION because the WHOLE pool was throttled with a far-off reset — the
   *  fail-fast path (B-GW-1) that frees the slot immediately instead of taking the acquire/retry path. */
  shedAllThrottled: number;
  /** G1 (WI-649): count of bare-429 rotate-retries SUPPRESSED because ≥half the pool was out of rotation
   *  (a fleet-wide bare-burst storm) — the request fell through to the bounded wait/absorb/shed instead of
   *  fanning out another upstream call. A climbing value = the gateway is actively damping a storm. */
  bareBurstRotateSuppressed: number;
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
  /** Per-account egress transport-failure tally (2026-06-22 audit) — which proxy is failing, for the Rayobyte
   *  fix (log-independent, since the journald circuit-open logs are unreliable). Empty when no egress proxies. */
  egressFailsByAccount: Record<string, number>;
  /** Per-account upstream-ATTEMPT tally (2026-06-22 audit) — the DENOMINATOR for egressFailsByAccount. A single
   *  bee request can make several attempts (failover rotations), so this counts attempts-through-this-account's-
   *  proxy, not distinct requests. Only accounts that reached the egress dial appear. */
  egressAttemptsByAccount: Record<string, number>;
  /** Per-account egress transport-failure RATE = egressFailsByAccount / egressAttemptsByAccount (0..1, 4dp). The
   *  VOLUME-FAIR culprit signal: raw fail counts rank the BUSIEST proxy worst, but a low-traffic proxy failing
   *  95% of its few attempts is the true dead proxy. Sort DESC by this to pick the Rayobyte proxy to fix/pull.
   *  Only accounts with ≥1 attempt appear. */
  egressFailRateByAccount: Record<string, number>;
  /** Count of in-process self-heal slot-reclaims (EI-2086) — how many times the release valve pre-empted
   *  a watchdog full-restart. A climbing value = the gateway is wedging but recovering itself instead of
   *  restarting; pair it with the watchdog's restart count to see the valve doing its job. */
  selfHealReclaims: number;
  /** Count of rate-limit STALL candidates recorded (P-002): all-throttled sheds to an identified bee. The
   *  full {ownerId, accountId, soonestResetAt} events are on GET /admin/stalls (for the stall-waker). */
  stallsRecorded: number;
  /** Per-backend Codex/OpenAI counters (2026-06-22 audit) — kept SEPARATE from the Claude counters above so
   *  /stats distinguishes Codex health from Claude health. All zero until Codex accounts are configured. */
  codex: { requests: number; upstream429: number; failovers: number; errors: number };
  /** Bee-FACING final 503s (2026-06-22 audit) — what the bee receives after the gateway exhausts internal
   *  retries. Makes egress-proxy leakage visible (it isn't a rate shed, so shedAllThrottled never counted it). */
  beeFacing503: { egressExhausted: number; tokenStall: number };
  /** The bound account's most-constraining unified window, if seen (D-009 / P-014). */
  unified?: { window: string; utilization: number; resetAt: number; rejected: boolean };
  /** RPM-SMOOTHING observability (hive-inference-gateway-stability P-005): is the burst-dodging pace
   *  actually engaged, AS DATA not inference. The gateway runs its OWN per-account governor registry
   *  (invisible to dev:rate_governor_status), so this is the only window into "is smoothing working".
   *  `engaged` = the gateway-wide smoothRpm config; `byAccount` = each gateway governor's effective pace:
   *  `smoothRpm` engaged on it, the configured `rpm` floor, the time-decayed learned `rpmFactor`, the
   *  effective per-minute allowance `effRpm` = floor(rpm × rpmFactor), the header-driven `paceDelayMs`,
   *  and the EFFECTIVE inter-request pace ENFORCED `effectivePaceMs` = max(paceDelayMs, smoothing floor
   *  60_000/effRpm). effectivePaceMs > 0 ⇒ requests are being spaced (the burst-dodge is live). Present
   *  only once a per-account governor exists; ABSENT (undefined) on a never-served gateway so the payload
   *  stays byte-identical to before. */
  smoothing?: {
    engaged: boolean;
    byAccount: Record<
      string,
      {
        smoothRpm: boolean;
        rpm: number | null;
        rpmFactor: number;
        effRpm: number | null;
        paceDelayMs: number;
        effectivePaceMs: number;
      }
    >;
  };
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

/** The actionable SHAPE of a 429 — the hard-evidence distinction the recurring "is this real capacity?"
 *  question always needs, made loggable. The gateway already DERIVES these internally; naming them lets
 *  the journal record WHICH kind every 429 was, so a capacity-vs-routing read comes from data, not a guess:
 *   - `bare-burst`         — x-should-retry:true, NO window/retry-after headers → a TRANSIENT burst throttle:
 *                            CAPACITY EXISTS, the move is rotate/retry, NOT "we're out".
 *   - `usage-cap`          — the body named a session/usage limit → a REAL per-account wall (pause to reset).
 *   - `rate-window`        — a per-window retry-after / unified reset is present → wait the bounded window.
 *   - `unified-5h-rejected`— the rolling 5h budget latched over-util (no per-request retry signal).
 *   - `unclassified`       — not a 429, or none of the above. */
export type Gateway429Shape = 'bare-burst' | 'usage-cap' | 'rate-window' | 'unified-5h-rejected' | 'unclassified';

export function classify429Shape(o: {
  status: number;
  /** The peeked body named a usage/session limit (a hard per-account wall) — takes precedence. */
  isUsageCap: boolean;
  /** The gateway's `bare429` verdict: a 429 with no window headers + (x-should-retry or no latch). */
  bare: boolean;
  /** A per-window `retry-after` / unified reset boundary was present on the response. */
  hasWindowReset: boolean;
  /** The governor's unified 5h window is latched rejected (over its utilization). */
  unifiedRejected: boolean;
}): Gateway429Shape {
  if (o.status !== 429) return 'unclassified';
  if (o.isUsageCap) return 'usage-cap';
  if (o.bare) return 'bare-burst';
  if (o.hasWindowReset) return 'rate-window';
  if (o.unifiedRejected) return 'unified-5h-rejected';
  return 'unclassified';
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
// Exported for direct unit tests (byte-exact head/rest split + cap-boundary correctness is load-bearing —
// a bug here truncates/corrupts the error body the gateway forwards, or buffers a 200 stream).
export async function peekBody(
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
  const openaiUpstreamBase = (deps.openaiUpstreamBase ?? 'https://api.openai.com').replace(/\/$/, '');
  const doFetch = deps.fetchImpl ?? fetch;
  const maxQueueWaitMs = deps.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS;
  const requestAbsorbMs = deps.requestAbsorbMs ?? DEFAULT_REQUEST_ABSORB_MS;
  const interactiveAbsorbMs = deps.interactiveAbsorbMs ?? INTERACTIVE_ABSORB_MS;
  const internalRetryDeadlineMs = deps.internalRetryDeadlineMs ?? INTERNAL_RETRY_DEADLINE_MS;
  const credential401DeadThreshold = deps.credential401DeadThreshold ?? DEFAULT_CREDENTIAL_401_DEAD_THRESHOLD;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  // Default OFF: the LAUNCH layer (startGatewayService) opts production in from the env (like priorityTiers).
  // Off-by-default keeps every direct-construction unit test byte-identical (their tiny maxQueueWaitMs is
  // incompatible with second-scale pacing — a test opts in explicitly with a realistic maxQueueWaitMs).
  const smoothRpm = deps.smoothRpm ?? false;
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
  // Priority-TIER layer (gateway-priority-tiers-2026-06-22, flag-gated upstream): when `deps.priorityTiers`
  // is present the queue gains per-tier in-flight caps + a reserved tier-1 floor; when absent it is a flat
  // priority+aging gate, byte-identical to before. `tierMap` resolves a request's `x-papercusp-priority`
  // role → its band; `baseTierCaps` is the steady-state ceiling the AIMD shrink sheds from (4→3→2 first).
  const tierLayer = deps.priorityTiers;
  const tiered = !!tierLayer;
  const tierMap = tierLayer?.map;
  const baseTierCaps: Record<number, number> = { ...(tierLayer?.config.caps ?? {}) };
  const queue = new PriorityAdmissionQueue({
    maxConcurrent: concurrency,
    agingIntervalMs: deps.agingIntervalMs,
    maxQueued,
    ...(tierLayer ? { tiers: tierLayer.config } : {}),
  });

  // AIMD adaptive admission concurrency (B-GW-1): the queue's maxConcurrent is the cap; this controller
  // shrinks the LIVE effective concurrency under sustained upstream 429s (driving queue.setMaxConcurrent
  // down → fewer concurrent upstream calls → lower per-IP RPM → the throttle eases, breaking the
  // retry-storm amplification) and additively recovers toward the cap as calls succeed. Fed by
  // aimd.recordThrottle() on each upstream 429 + aimd.recordSuccess() on each forwarded 2xx below.
  // SERVICEABLE-COUNT ADMISSION CLAMP (2026-06-23 thundering-herd fix): the AIMD cap reacts to admission-QUEUE
  // pressure, NOT to how many accounts can actually SERVE. When only 1-2 accounts are unpaused it would still
  // admit the full cap, so a resume-burst piles all of it onto the few healthy accounts and 429s them into a
  // cascade (the observed aviynw→definitelyahuman chain). `serviceableAdmissionCapFn` (assigned below, once the
  // pool + governors exist) returns (serviceable accounts × PER_ACCOUNT_ADMISSION), floored so the pool can
  // always probe back; `applyAdmissionCap` sets live concurrency to MIN(aimd-effective, that), and a periodic
  // tick re-applies it as accounts pause/recover (not just on an AIMD change). Identity (∞) until assigned, and
  // OFF (PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP=0) ⇒ byte-identical to the old `setMaxConcurrent(eff)`.
  let serviceableAdmissionCapFn: () => number = () => Number.POSITIVE_INFINITY;
  let lastAimdEff = concurrency;
  const applyAdmissionCap = (eff: number): void => {
    lastAimdEff = eff;
    const capped = Math.max(1, Math.min(eff, serviceableAdmissionCapFn()));
    queue.setMaxConcurrent(capped);
    // TIER-AWARE SHEDDING (step 4): as live concurrency shrinks (AIMD storm OR few serviceable accounts), shed
    // the bottom tier caps (4→3→2, holding tier 1) by the SAME number of lost slots — so the protected
    // interactive lane keeps its full ceiling while the sheddable batch bands give up headroom first. On
    // recovery the caps re-grow. No-op without the tier layer (flag-OFF stays byte-identical).
    if (tiered) {
      const shedCaps = shedTierCaps(baseTierCaps, concurrency - capped);
      for (const [t, cap] of Object.entries(shedCaps)) queue.setTierCap(Number(t), cap);
    }
  };
  const aimd = new AimdConcurrencyController({
    cap: concurrency,
    floor: deps.aimd?.floor ?? DEFAULT_AIMD_FLOOR,
    decreaseFactor: deps.aimd?.decreaseFactor,
    decreaseThreshold: deps.aimd?.decreaseThreshold ?? DEFAULT_AIMD_DECREASE_THRESHOLD,
    increaseEvery: deps.aimd?.increaseEvery ?? DEFAULT_AIMD_INCREASE_EVERY,
    onChange: (eff) => {
      applyAdmissionCap(eff);
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
  const providerAdapters = makeGatewayProviderAdapters({
    claudePool: pool,
    codexPool: deps.codexPool ?? null,
    anthropicUpstreamBase: upstreamBase,
    openaiUpstreamBase,
  });

  // Governor is per (model, account). Reading the active account at call time means a failover
  // transparently moves pacing onto the new account's fresh bucket. The QUEUE is the concurrency
  // authority, so make the governor's own concurrency cap non-binding (raise it to the queue cap)
  // and let the governor enforce only rate/pause/pace — safe in the gateway's own process.
  const governorForAccount = (model: string, accountId: string): RateLimitGovernor => {
    const g = deps.governorFor ? deps.governorFor(model) : governorForBackend('claude-code', model, undefined, accountId);
    if (g.state.limits.maxConcurrent < concurrency) g.state.limits.maxConcurrent = concurrency;
    // Smooth the static-floor RPM allowance into an even pace (subscription accounts return no per-minute
    // headers, so paceDelayMs stays 0 → the count gate alone lets effRpm fire as an instant burst that trips
    // the sub-minute burst limit). Gateway-only opt-in; the fleet concurrency governor is left untouched.
    g.state.smoothRpm = smoothRpm;
    return g;
  };

  // Fix 2 (serviceable-count admission clamp): now that `pool` + `governorForAccount` exist, give the clamp its
  // real implementation + start the periodic re-clamp. An account is SERVICEABLE iff the pool has it in rotation
  // (no hard-429 / transport-circuit pause — what `active()` round-robins over) AND its governor for the
  // representative model isn't predictively paused (near its rolling cap). Conservative by design: a tighter
  // count → a tighter clamp → safer under a storm; the MIN floor still lets the pool probe its way back.
  serviceableAdmissionCapFn = () => {
    if (!SERVICEABLE_CLAMP_ON || !pool.healthyCount) return Number.POSITIVE_INFINITY;
    const now = Date.now();
    const serviceable = pool.healthyCount((id) => governorForAccount(SERVICEABLE_CLAMP_MODEL, id).state.pausedUntil <= now);
    return Math.max(MIN_SERVICEABLE_ADMISSION, serviceable * PER_ACCOUNT_ADMISSION);
  };

  // G1 (WI-649): FLEET-WIDE bare-burst detector. True when ≥half the pool is currently OUT OF ROTATION
  // (pool.exhaustedUntil — the short bare-429 paces / hard caps / transport circuits that other in-flight
  // requests already rotated off), i.e. rotating this bare-429 onto "another" account would find no capacity
  // and just multiply upstream load. Reads the POOL's own rotation state (NOT the per-account governor) so it
  // stays correct under a shared-governor test pool, and counts the CURRENT (just-bursted) account as still
  // available (its onExhausted hasn't run yet) — so a LONE account bursting in an otherwise-healthy pool (the
  // few-maxed→rotate-to-healthy case) is never mistaken for a fleet-wide storm.
  const isFleetWideBareBurst = (): boolean => {
    if (!SUPPRESS_BAREBURST_ROTATE_ON || !pool.healthyCount || !pool.size) return false;
    const total = pool.size();
    if (total < 2) return false; // single-account pool: nothing to rotate to anyway
    return pool.healthyCount() * 2 <= total; // ≤half the pool has rotation budget ⇒ ≥half is penalized
  };
  // Re-apply the clamp on a cadence so it tracks accounts pausing/recovering even while the AIMD effective is
  // stable (e.g. pinned at the floor under a storm) — onChange alone only fires on an AIMD change. Unref'd so it
  // never holds the process open; cleared on close().
  const serviceableClampTimer = SERVICEABLE_CLAMP_ON ? setInterval(() => applyAdmissionCap(lastAimdEff), SERVICEABLE_CLAMP_TICK_MS) : undefined;
  serviceableClampTimer?.unref?.();

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
  // FLAPPING BACKOFF state (2026-06-22): per-account reopen count + last-open time, so a proxy that keeps
  // reopening soon after readmit gets a progressively longer circuit-open (decays via EGRESS_FLAP_RESET_MS).
  const egressReopenCount = new Map<string, number>();
  const egressLastOpenAt = new Map<string, number>();
  // Per-account egress transport-failure TALLY (2026-06-22 audit) — surfaced in /stats so an operator can see
  // WHICH proxy is failing and fix the right one. The journald 'EGRESS CIRCUIT OPEN' logs are unreliable, so
  // this is the durable, log-independent culprit signal for the Rayobyte fix.
  const egressFailsByAccount = new Map<string, number>();
  // Per-account upstream ATTEMPT tally — the DENOMINATOR for egressFailsByAccount, so /stats can surface a
  // VOLUME-FAIR egress failure RATE (2026-06-22 audit). Raw fail counts rank the BUSIEST proxy worst (the
  // hand-triaged "aviynw is the culprit" was just the busiest account); the normalized rate finds the true
  // dead proxy — a low-traffic account failing 95% of its few attempts. Counts every attempt that reaches the
  // egress dial (post token-refresh), so a single bee request that failover-rotates increments once per account.
  const egressAttemptsByAccount = new Map<string, number>();
  /** Per-account TRANSPORT pause the egress circuit set (= the resetAt handed to gov.penalize), so the
   *  half-open probe can lift exactly THAT pause on recovery without ever shortening a real 429 pause. */
  const egressPauseUntil = new Map<string, number>();
  /** CREDENTIAL-HEALTH state (#5 PART A): per-account CONSECUTIVE upstream-401 streak. The gateway's 401
   *  handler drops+refreshes the cached token; if the refresh keeps yielding the SAME invalid credential it
   *  just 401s again — a SILENT dead-credential outage (spawns/evals die "produced no turn", no fleet alert).
   *  We count consecutive 401s per account and, the FIRST time the streak crosses credential401DeadThreshold,
   *  fire the loud `onCredentialDead` side-channel ONCE per episode. RESET on the next successful auth (a 2xx
   *  for that account — see the 2xx success path), which re-arms the alert for a later episode. */
  const credential401Streak = new Map<string, number>();
  /** Half-open egress probe: after a circuit opens, re-test the account's proxy (egress-probe.ts) on a short
   *  LOOP. On the FIRST success it LIFTS the transport pause IMMEDIATELY — clears the streak, lifts the
   *  governor's transport pause (gov.liftTransportPause, a no-op if a real 429 pause superseded it), and
   *  readmits the account to the round-robin — so a flaky proxy that recovers in seconds rejoins rotation in
   *  seconds, NOT at the full circuit-window expiry. Before 2026-06-21 the probe only cleared the streak and
   *  the account waited the whole window (take-MAX pausedUntil can't be shortened) — which kept the only
   *  token-healthy accounts out together → empty-pool "all throttled" sheds. Keeps probing until recovery OR
   *  the circuit pause expires (bounded fallback). Best-effort, unref'd, never throws into the request path.
   *  `EGRESS_PROBE_DELAY_MS=0` disables it (pause-expiry half-open still applies). */
  function scheduleEgressProbe(account: ActiveAccount, gov: RateLimitGovernor, pausedUntil: number): void {
    if (EGRESS_PROBE_DELAY_MS <= 0 || egressProbePending.has(account.accountId)) return;
    egressProbePending.add(account.accountId);
    let probeSuccessStreak = 0; // consecutive OK probes; readmit only at EGRESS_PROBE_READMIT_STREAK (flap filter)
    const runProbe = (): void => {
    const t = setTimeout(() => {
      void (async () => {
        let readmitted = false;
        try {
          const probe = await probeEgress(
            { id: account.accountId, egress: account.egress } as ClaudeAccount,
            { timeoutMs: EGRESS_PROBE_HTTP_TIMEOUT_MS },
          );
          if (probe.exitIp) {
            probeSuccessStreak++;
            if (probeSuccessStreak >= EGRESS_PROBE_READMIT_STREAK) {
              egressFailStreak.delete(account.accountId);
              // H8 (inference-gateway-audit-2026-06-23): a CONFIRMED recovery (2 stable probes) resets the flap
              // escalation. Clearing the reopen count + last-open stamp means a LATER isolated blip re-opens at the
              // BASE backoff (~20s), not the escalated 2**reopen exile (up to 5min). A genuinely-flapping proxy
              // can't pass 2 stable probes, so it never reaches here — only a real recovery clears the history,
              // so sparse unrelated blips on a recovered-and-serving account stop compounding into a long exile.
              egressReopenCount.delete(account.accountId);
              egressLastOpenAt.delete(account.accountId);
              gov.liftTransportPause(egressPauseUntil.get(account.accountId) ?? pausedUntil); // C3: lift the LIVE pause (an escalated reopen extends it past the captured value); no-op if a real 429 superseded it
              pool.readmit?.(account.accountId); // rejoin the round-robin
              egressPauseUntil.delete(account.accountId);
              readmitted = true;
              log('warn', `inference-gateway: egress probe for '${account.accountId}' RECOVERED (exit ${probe.exitIp}) after ${probeSuccessStreak} stable probes — readmitted`);
            } else {
              log('warn', `inference-gateway: egress probe for '${account.accountId}' OK ${probeSuccessStreak}/${EGRESS_PROBE_READMIT_STREAK} — confirming stability before readmit`);
            }
          } else {
            // H10 (inference-gateway-audit-2026-06-23): DECREMENT, don't hard-reset. One slow/failed probe (a box
            // under load makes probes legitimately take 1.3–6.1s) would otherwise perpetually restart the 2-strict-
            // consecutive streak, so a recovered-but-jittery proxy never readmits before its pause elapses. A
            // leaky count (success +1, fail −1) still readmits a mostly-healthy proxy and keeps a dead one at 0.
            probeSuccessStreak = Math.max(0, probeSuccessStreak - 1);
            log('warn', `inference-gateway: egress probe for '${account.accountId}' STILL DOWN (${probe.error ?? 'no exit IP'}) — stays circuit-paused`);
          }
        } catch (err) {
          probeSuccessStreak = Math.max(0, probeSuccessStreak - 1); // H10: decrement (tolerate a transient probe error), not hard-reset
          log('warn', `inference-gateway: egress probe error for '${account.accountId}': ${(err as Error).message}`);
        } finally {
          // Keep probing until the proxy is CONFIRMED stable (readmitted) OR the circuit pause expires.
          // C3 (2026-06-23): compare against the LIVE deadline (egressPauseUntil), NOT the captured `pausedUntil`
          // from the FIRST open. An escalated reopen extends egressPauseUntil to a LONGER deadline; the stale
          // constant would stop the probe early, stranding a now-longer-paused account with NO active probe → it
          // sits out the full escalated backoff even after the proxy recovers (defeating the half-open mechanism
          // for exactly the chronically-flapping proxies it exists for). The live map is the source of truth.
          if (!readmitted && Date.now() < (egressPauseUntil.get(account.accountId) ?? pausedUntil)) runProbe();
          else egressProbePending.delete(account.accountId);
        }
      })();
    }, EGRESS_PROBE_DELAY_MS);
    t.unref?.();
    };
    runProbe();
  }

  let totalRequests = 0;
  let upstream429 = 0;
  let queued429 = 0;
  let shed429 = 0; // load-shed: 429s returned because the admission queue was at maxQueued (backlog cap)
  let shedAllThrottled = 0; // fail-fast: 429s shed at admission because the whole pool was throttled (B-GW-1)
  let bareBurstRotateSuppressed = 0; // G1 (WI-649): bare-429 rotate-retries suppressed because ≥half the pool was out of rotation (fleet-wide storm)
  let upstreamErrors = 0;
  let failovers = 0;
  let egressCircuitOpens = 0; // B-GW-EGRESS: per-account egress-proxy circuit opens (dead/flapping IP, transport-failure streak)
  // Per-backend (Codex/OpenAI) counters (2026-06-22 audit): the Codex path's 429s/failovers/errors are tracked
  // SEPARATELY so /stats can distinguish Codex health from Claude health (the shared counters above stay
  // Claude-only). All zero until Codex accounts are configured.
  let codexRequests = 0;
  let codexUpstream429 = 0;
  let codexFailovers = 0;
  let codexUpstreamErrors = 0;
  // Bee-FACING final 503s (2026-06-22 audit). What the bee actually RECEIVES after the gateway exhausts its
  // internal retries — distinct from the per-attempt upstreamErrors above and from shedAllThrottled (rate
  // sheds). Before this they were invisible in /stats, hiding that egress-proxy degradation (not rate limits)
  // had become the dominant bee-facing failure mode.
  let beeEgressExhausted = 0; // 503 after all egress-proxy retries stalled/errored (the flaky-proxy leak)
  let beeTokenStall = 0; // 503 from a stalled OAuth token refresh
  let selfHealReclaims = 0; // EI-2086: in-process release-valve slot reclaims (pre-empted watchdog restarts)

  // Rate-limit STALL events (gateway-rate-limit-stall-autowake P-002): when the gateway sheds an
  // all-throttled 429 to an IDENTIFIED bee (x-papercusp-owner present), record {ownerId, accountId,
  // soonestResetAt} so a stall-waker can confirm the bee actually went idle and wake it once the account
  // recovers. A bounded ring buffer surfaced on GET /admin/stalls; the gateway itself NEVER wakes (it stays
  // a thin proxy — the coordinator owns the confirm-wait-wake state).
  interface StallEvent { ownerId: string; accountId: string; soonestResetAt: number; at: number; }
  const STALL_BUFFER_MAX = 256;
  const recentStalls: StallEvent[] = [];
  let stallsRecorded = 0;
  function recordStall(ownerId: string | undefined, accountId: string, soonestResetAt: number): void {
    if (!ownerId) return; // only bees that identified themselves (x-papercusp-owner) are wake-able
    stallsRecorded++;
    recentStalls.push({ ownerId, accountId, soonestResetAt, at: Date.now() });
    if (recentStalls.length > STALL_BUFFER_MAX) recentStalls.splice(0, recentStalls.length - STALL_BUFFER_MAX);
  }

  // Per-owner LAST-ROUTED account (routed-account-visibility, 2026-06-22): the account that ACTUALLY served
  // this owner's most-recent turn, so a session can show "my turn → <account>" in its statusline (the gateway
  // already strips the routing headers, so the caller never sees the response header directly). Updated on the
  // served-response chokepoint; a bounded Map keyed by ownerId (delete-oldest over the cap). Read-only on
  // GET /admin/route?owner=<id>. Cheap: one Map.set on the hot path.
  interface RouteEntry { account: string; model: string; at: number; }
  const ROUTE_MAP_MAX = 4096;
  const lastRouteByOwner = new Map<string, RouteEntry>();
  function recordRoute(ownerId: string | undefined, accountId: string, model: string): void {
    if (!ownerId) return; // only identified callers (x-papercusp-owner present) are addressable
    if (!lastRouteByOwner.has(ownerId) && lastRouteByOwner.size >= ROUTE_MAP_MAX) {
      const oldest = lastRouteByOwner.keys().next().value; // Map preserves insertion order → oldest first
      if (oldest !== undefined) lastRouteByOwner.delete(oldest);
    }
    lastRouteByOwner.set(ownerId, { account: accountId, model, at: Date.now() });
  }

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
    const active = pool.peek ? pool.peek() : pool.active(); // H3: observe WITHOUT advancing the rr-cursor
    const gov = governorForAccount('claude-opus-4', active.accountId);
    const snap = gov.snapshot();
    const admission = queue.snapshot();
    // Priority-tier /stats (step 5): per-tier demand from the queue + the pool-wide healthy-account
    // capacity denominator. Present only with the tier layer (admission.byTier set) → flag-OFF stays
    // byte-identical. `healthyCount()` is absent on a single-account pool → report 1.
    const priorityTiers = admission.byTier
      ? {
          healthyAccounts: pool.healthyCount ? pool.healthyCount() : 1,
          tier1Reserve: admission.tier1Reserve ?? 0,
          tiers: admission.byTier,
        }
      : undefined;
    // P-005 smoothing observability: surface each gateway per-account governor's EFFECTIVE pace so
    // "is smoothing working?" is data. Enumerate the gateway's own registry (only the gateway sets
    // `smoothRpm` on a per-account governor → typeof boolean uniquely selects them; the fleet
    // concurrency governor leaves it undefined). The active/bound account is added from `snap` first
    // so it is present even when a test injects governors via deps.governorFor (registry bypassed).
    const now = Date.now();
    const paceEntry = (st: typeof snap) => ({
      smoothRpm: st.smoothRpm === true,
      rpm: st.limits.rpm ?? null,
      rpmFactor: Math.round(effectiveRpmFactor(st, now) * 1000) / 1000,
      effRpm: effectiveRpm(st, now),
      paceDelayMs: st.paceDelayMs,
      effectivePaceMs: effectivePaceMs(st, now),
    });
    const smoothingByAccount: NonNullable<GatewayStats['smoothing']>['byAccount'] = {};
    if (typeof snap.smoothRpm === 'boolean') smoothingByAccount[active.accountId] = paceEntry(snap);
    for (const gs of snapshotGovernors()) {
      if (gs.accountId && typeof gs.state.smoothRpm === 'boolean' && !smoothingByAccount[gs.accountId]) {
        smoothingByAccount[gs.accountId] = paceEntry(gs.state);
      }
    }
    const smoothing = Object.keys(smoothingByAccount).length
      ? { engaged: smoothRpm, byAccount: smoothingByAccount }
      : undefined;
    return {
      accountId: active.accountId,
      upstreamBase,
      totalRequests,
      inFlight: admission.running,
      queueDepth: admission.queued,
      admission,
      ...(priorityTiers ? { priorityTiers } : {}),
      upstream429,
      queued429,
      shed429,
      shedAllThrottled,
      bareBurstRotateSuppressed,
      maxQueued,
      concurrencyCap: concurrency,
      aimd: aimd.snapshot(),
      failovers,
      upstreamErrors,
      egressCircuitOpens,
      egressFailsByAccount: Object.fromEntries(egressFailsByAccount),
      egressAttemptsByAccount: Object.fromEntries(egressAttemptsByAccount),
      egressFailRateByAccount: Object.fromEntries(
        [...egressAttemptsByAccount].map(([id, attempts]) => [
          id,
          attempts > 0 ? Math.round(((egressFailsByAccount.get(id) ?? 0) / attempts) * 10_000) / 10_000 : 0,
        ]),
      ),
      selfHealReclaims,
      stallsRecorded,
      codex: { requests: codexRequests, upstream429: codexUpstream429, failovers: codexFailovers, errors: codexUpstreamErrors },
      beeFacing503: { egressExhausted: beeEgressExhausted, tokenStall: beeTokenStall },
      unified: snap.unified,
      ...(smoothing ? { smoothing } : {}),
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
    // The bee's coord ownerId (== spawnId), if it identified itself — lets the gateway attribute an
    // all-throttled shed back to this bee for the stall-waker (P-002). Absent ⇒ not wake-able (no-op).
    const wantOwner = (req.headers[OWNER_HEADER] as string | undefined)?.trim() || undefined;
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

    // PROACTIVE HEALTH-AWARE PICK FOR UNPINNED REQUESTS (no-pin-hang fix, 2026-06-23). `pool.active()` is a
    // blind round-robin, so an unpinned request COMMITS to whatever account it lands on — including a budget-
    // exhausted or flaky-EGRESS-PROXY account whose governor isn't paused THIS instant — and only rotates
    // REACTIVELY after the upstream stalls/429s, burning the internal-retry + stall-absorb ladder (the
    // observed ~90s no-pin hang that surfaces to the caller as an opaque 500, while a request PINNED to a
    // healthy account returned 200 in <25s). The reactive walk below only fires when the chosen account is
    // ALREADY governor-paused, so a not-yet-circuit-open flaky proxy slips through. Steer up front instead:
    // among governor-healthy accounts pick the one with the freshest egress proxy (no unrecovered transport-
    // failure streak, no live transport pause) and the most residual budget (lowest unified utilization). Only
    // for UNPINNED requests (a pin already expresses an explicit choice + has its liveness-yield above), and we
    // only SWITCH to a strictly-different account — a single-account / all-paused pool keeps today's behavior
    // (the reactive walk + fail-fast shed below still handle the all-paused case). `pool.active()` advances the
    // rr-cursor exactly like the reactive walk, so fairness/cursor semantics are unchanged.
    // Health score (lower = better): governor-paused / live-transport-paused ⇒ never pick (Infinity); else a
    // recent UNRECOVERED transport failure (egressFailStreak>0, cleared on the next success) is the dead/flaky-
    // proxy hint — bucket those behind every clean account (+1) so a clean one always wins, then break ties by
    // lowest unified utilization (most residual budget). u ∈ [0,1] keeps the flaky bucket disjoint; a clean,
    // idle, fresh-proxy account scores 0. SHARED by the unpinned proactive pick AND the soft-pin failover.
    const now0 = Date.now();
    const keyOf = (cgov: RateLimitGovernor, accountId: string): number => {
      if (cgov.state.pausedUntil > now0) return Infinity;
      if ((egressPauseUntil.get(accountId) ?? 0) > now0) return Infinity;
      const u = cgov.snapshot().unified?.utilization ?? 0;
      const flaky = (egressFailStreak.get(accountId) ?? 0) > 0 ? 1 : 0;
      return flaky + u;
    };
    if (pinned === null) {
      // SEED with the round-robin pick so a healthy active() is KEPT — round-robin fairness is preserved and
      // only a STRICTLY-better account displaces it. A key-0 active (healthy, idle, fresh proxy) can't be beaten
      // → skip the walk entirely (zero added cost on the happy path). A paused/paced/flaky active (key > 0)
      // triggers a bounded scan for a healthier sibling; finding none leaves `active` unchanged so the reactive
      // paused-walk + fail-fast shed below still handle the genuinely all-throttled case exactly as before.
      let bestCand = active;
      let bestGov = gov;
      let bestKey = keyOf(gov, active.accountId);
      for (let walk = 0; bestKey > 0 && walk < POOL_WALK_MAX_ATTEMPTS; walk++) {
        const cand = pool.active();
        if (cand.accountId === bestCand.accountId) continue;
        const cgov = governorForAccount(model, cand.accountId);
        const key = keyOf(cgov, cand.accountId);
        if (key < bestKey) {
          bestKey = key;
          bestCand = cand;
          bestGov = cgov;
        }
      }
      if (bestCand.accountId !== active.accountId) {
        active = bestCand;
        gov = bestGov;
      }
    } else {
      // SOFT-PIN FAILOVER (pinned-concentration fix, 2026-06-23, owner-reported "unpinned 10+ sessions fine but
      // PINNED breaks after a few"): a pin is a cache-affinity PREFERENCE, not a hard funnel. Pinning N CONCURRENT
      // sessions onto one account saturates ITS per-account RPM/burst limit while the rest of the pool sits idle,
      // so the pinned requests 429 even though the pool has capacity. The pause-yield above only fires on a HARD
      // governor pause, and the proactive pick above is unpinned-only — so a busy-but-not-paused pin slips through
      // to a reactive 429. Here: yield THIS request to the healthiest, least-loaded sibling whenever the pinned
      // account is STRESSED — paused/flaky/near-cap (keyOf > 0) OR slammed by concurrent pinned sessions
      // (in-flight ≥ PIN_YIELD_INFLIGHT). The pin still holds for sequential/single-session requests (in-flight
      // 0-1 → keyOf 0 → no yield → warm per-credential cache preserved); only a concurrent pile-up spreads.
      const load = (cgov: RateLimitGovernor): number => (cgov.state.inFlight >= PIN_YIELD_INFLIGHT ? 1 : 0);
      let bestKey = keyOf(gov, active.accountId) + load(gov);
      if (bestKey > 0) {
        let bestCand = active;
        let bestGov = gov;
        for (let walk = 0; walk < POOL_WALK_MAX_ATTEMPTS; walk++) {
          const cand = pool.active();
          if (cand.accountId === pinned!.accountId) continue;
          const cgov = governorForAccount(model, cand.accountId);
          const key = keyOf(cgov, cand.accountId) + load(cgov);
          if (key < bestKey) {
            bestKey = key;
            bestCand = cand;
            bestGov = cgov;
          }
        }
        if (bestCand.accountId !== active.accountId) {
          log(
            'warn',
            `inference-gateway: pinned '${pinned!.accountId}' stressed (inflight=${gov.state.inFlight}) → soft-pin failover to '${bestCand.accountId}' (cache-affinity yields to load/liveness)`,
          );
          active = bestCand;
          gov = bestGov;
        }
      }
    }

    // ROUTE TO CAPACITY (2026-06-18, owner-reported "accounts unused / opus hangs"): if the chosen
    // UNPINNED (or pinned-yielded-to-active) account's governor is currently PAUSED, round-robin the
    // pool to an account whose governor has headroom NOW — rather than hanging the full maxQueueWaitMs
    // (2 min) on a paused account while sibling accounts sit admittable (some Max accounts return opus
    // 200 upstream while others are 429-paused; the pool must egress through one with capacity). A
    // still-pinned request is left on its pin (it already yielded to active() above if its pin was
    // paused). `pool.active()` round-robins, so each hop advances to a different account.
    // Walk whenever the CHOSEN account's live governor is paused — PINNED or unpinned. Gated on the GOVERNOR
    // pause, NOT pool.active()/exhaustedUntil (which only tracks ACTUAL-429 exhaustion, never a PREDICTIVE
    // pause): a 97%-7d account is predictively paused but not 429'd, so pool.active() still returns it — the
    // old `active != pinned` guard (and the canFailover==(poolActive!=pin) yield) then stranded a bee PINNED
    // to such an account on its own paused pin and 429'd it ("account X paced/paused; retry after Ns") instead
    // of yielding to liveness (owner-reported 2026-06-21). Now a paused pin walks to a healthy account too.
    const chosenWasPin = pinned !== null && active.accountId === pinned.accountId;
    // Serving a SERVICEABLE soft-paused account as a last resort (predictively near its cap but Anthropic
    // still ALLOWS it) → acquire with allowSoftPaused so the governor admits it. See the graceful-degradation
    // tier below.
    let serveSoft = false;
    if (gov.state.pausedUntil > Date.now()) {
      let soonestPaused = gov.state.pausedUntil;
      let found = false;
      // Best SERVICEABLE soft-paused fallback: predictively paused (still ALLOWED, util < 1) AND its egress
      // proxy is up — usable if NO fully-healthy account exists, so we serve residual budget instead of
      // manufacturing "all accounts throttled" from accounts that can still serve (owner-reported 2026-06-21:
      // a pin to a 0.98-7d / 0.05-5h account was shed though it was serviceable). Lowest-util wins (most residual).
      let softCand: ActiveAccount | null = null;
      let softGov: RateLimitGovernor | null = null;
      let softUtil = Infinity;
      // H1 (inference-gateway-audit-2026-06-23): COLLECT the least-loaded healthy candidate across the bounded
      // walk rather than early-returning the FIRST one. Under a mass-pause that flips N accounts paused in one
      // tick, the in-flight wave scans the same paused prefix and would all converge on the SAME first-healthy
      // account + 429 it → cascade (the observed aviynw→definitelyahuman chain). Routing to the account with the
      // MOST residual budget (lowest unified utilization) — together with the admission clamp that caps the burst
      // size — keeps the wave off a single account. (Mirrors the soft-pause lowest-util pick below.)
      let healthyCand: ActiveAccount | null = null;
      let healthyGov: RateLimitGovernor | null = null;
      let healthyUtil = Infinity;
      for (let walk = 0; walk < POOL_WALK_MAX_ATTEMPTS; walk++) {
        const cand = pool.active();
        const cgov = governorForAccount(model, cand.accountId);
        if (cgov.state.pausedUntil <= Date.now()) {
          const u = cgov.snapshot().unified?.utilization ?? 0; // no util data ⇒ treat as idle (eligible)
          if (u < healthyUtil) {
            healthyUtil = u;
            healthyCand = cand;
            healthyGov = cgov;
          }
          continue; // keep walking — pick the LEAST-loaded healthy account, don't stack on the first
        }
        soonestPaused = Math.min(soonestPaused, cgov.state.pausedUntil);
        if (cgov.softPaused(Date.now()) && (egressPauseUntil.get(cand.accountId) ?? 0) <= Date.now()) {
          const u = cgov.snapshot().unified?.utilization ?? 1;
          if (u < softUtil) {
            softUtil = u;
            softCand = cand;
            softGov = cgov;
          }
        }
      }
      if (healthyCand && healthyGov) {
        active = healthyCand;
        gov = healthyGov;
        found = true;
      }
      if (found && chosenWasPin) {
        log('warn', `inference-gateway: pinned '${pinned!.accountId}' paused → routed to '${active.accountId}' (cache-affinity yields to liveness)`);
      }
      // GRACEFUL DEGRADATION (2026-06-21): no fully-IDLE account, but a SERVICEABLE soft-paused one exists
      // (predictively near its cap, yet still ALLOWED by Anthropic, proxy up) → SERVE it (residual budget)
      // rather than shed. Only the genuinely-exhausted case (every account hard-rejected / transport-down)
      // falls through to the shed below. This is what lets a pin to a 98%-account run instead of 429ing.
      if (!found && softCand && softGov) {
        active = softCand;
        gov = softGov;
        found = true;
        serveSoft = true;
        log('warn', `inference-gateway: no idle account → SERVING serviceable near-cap account '${active.accountId}' (util ${softUtil.toFixed(2)}, still allowed) instead of shedding`);
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
        // P-002: the whole pool is out of budget until `soonestPaused` — record a stall candidate so the
        // waker can wake this bee then (only if it identified itself + its CLI doesn't recover on its own).
        recordStall(wantOwner, active.accountId, soonestPaused);
        const retryAfterSec = Math.min(BEE_RETRY_AFTER_CAP_S, Math.max(1, Math.ceil((soonestPaused - Date.now()) / 1000)));
        log('warn', `inference-gateway: whole pool throttled (soonest reset ${Math.ceil((soonestPaused - Date.now()) / 1000)}s > admission wait cap) → fail-fast shed 429 (slot freed; bee retry-after ${retryAfterSec}s)`);
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
    const stillPinned = pinned !== null && active.accountId === pinned.accountId;
    let release = await gov.acquire(est, { maxWaitMs: stillPinned ? PINNED_FAILOVER_WAIT_MS : maxQueueWaitMs, allowSoftPaused: serveSoft });
    if (!release && stillPinned) {
      log('warn', `inference-gateway: pinned '${pinned!.accountId}' admission-timeout → failover to active '${poolActive.accountId}'`);
      active = poolActive;
      gov = governorForAccount(model, active.accountId);
      release = await gov.acquire(est, { maxWaitMs: maxQueueWaitMs, allowSoftPaused: serveSoft });
    }
    if (!release) {
      queued429++;
      const retryAfterSec = Math.min(BEE_RETRY_AFTER_CAP_S, Math.max(1, Math.ceil((gov.state.pausedUntil - Date.now()) / 1000)));
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
    // H12 (inference-gateway-audit-2026-06-23): a STABLE per-request abort signal. `currentAc` is re-created per
    // attempt, so during an absorb RE-ACQUIRE (which holds NO upstream fetch) it is already settled → aborting it
    // does nothing. The ceiling + the self-heal reclaim abort THIS too, and the absorb re-acquires below wait on
    // it — so a reclaimed/ceilinged request truly CANCELS its parked gov.acquire instead of waiting the full
    // absorb budget after being declared freed (which mis-reported self-heal progress + risked a double reclaim).
    const reqAbort = new AbortController();
    const ceilingTimer = setTimeout(() => {
      log('error', `inference-gateway: request hit the ${requestCeilingMs}ms hard ceiling on '${active.accountId}' — force-terminating (slot backstop)`);
      try { currentAc?.abort(new Error(`request ceiling: ${requestCeilingMs}ms`)); } catch { /* already settled */ }
      try { reqAbort.abort(new Error(`request ceiling: ${requestCeilingMs}ms`)); } catch { /* already aborted */ } // H12: cancel a parked absorb re-acquire
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
        try { reqAbort.abort(new Error(reason)); } catch { /* already aborted */ } // H12: cancel a parked absorb re-acquire
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
      // Did this request ROTATE to a different account (⇒ the pool has a serviceable ALTERNATIVE)? Gates the
      // stall-absorb (#2): a lone permanently-dead proxy (no alternative) must shed FAST; only a multi-account
      // stall storm — alternatives that flap/recover via the half-open probe — is worth holding the caller for.
      let everRotated = false;
      // Wedge-prevention ladder: the wall-clock instant past which this request STOPS retrying, sheds a
      // retryable 429, and frees its admission slot — strictly before the self-heal valve (75s) / watchdog
      // (120s) would forcibly reclaim it. Computed from the slot-acquire moment (this is the same request
      // lifetime the inFlightReg `startedAt` tracks), so total slot-hold is bounded under any storm.
      let retryDeadlineAt = Date.now() + internalRetryDeadlineMs;
      // EXTENDED ABSORPTION (env-gated): the wall-clock past which we stop the release-slot-and-re-acquire
      // park-retry loop and finally shed. 0 = OFF (the slot-hold deadline above is the only bound, as before).
      // P-003 (safe variant): scale the budget by the request's TIER so a high-priority caller out-waits a batch
      // one for the recovered account (the priority-throttle-park OUTCOME, no governor wait-queue). Identity off.
      const priLabel = (req.headers[PRIORITY_HEADER] as string | undefined)?.trim().toLowerCase();
      const reqTier = tierMap ? tierOf(priLabel ?? undefined, tierMap) : undefined;
      let effAbsorbMs = requestAbsorbMs > 0 ? Math.round(requestAbsorbMs * absorbTierFactor(reqTier)) : 0;
      // INTERACTIVE FAIL-FAST: a human-facing caller (interactive/operator) sheds fast instead of being held
      // through the storm — cap their absorb (see INTERACTIVE_ABSORB_MS). Autonomous roles keep the full hold.
      if (interactiveAbsorbMs > 0 && effAbsorbMs > interactiveAbsorbMs && priLabel !== undefined && HUMAN_PRIORITY_LABELS.has(priLabel)) {
        effAbsorbMs = interactiveAbsorbMs;
      }
      const absorbDeadlineAt = effAbsorbMs > 0 ? Date.now() + effAbsorbMs : 0;
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
            beeTokenStall++;
            // P-002 autowake-coverage (2026-06-22): record a stall so the stall-waker re-wakes an IDENTIFIED bee
            // when this account recovers, instead of the bee just dying on a retryable 503 with nobody retrying.
            recordStall(wantOwner, active.accountId, Math.max(gov.state.pausedUntil, Date.now() + 30_000));
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
          // Per-account egress ATTEMPT tally (denominator for egressFailsByAccount → /stats egressFailRateByAccount).
          // Counted here (token refresh already succeeded, so the egress proxy is about to be dialed) — a token
          // stall above never reached the proxy and must not count as an egress attempt.
          egressAttemptsByAccount.set(active.accountId, (egressAttemptsByAccount.get(active.accountId) ?? 0) + 1);
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
            egressFailsByAccount.set(active.accountId, (egressFailsByAccount.get(active.accountId) ?? 0) + 1);
            const circuitOpen = streak >= EGRESS_FAIL_CIRCUIT_THRESHOLD;
            // FLAPPING BACKOFF: a proxy that reopens within EGRESS_FLAP_RESET_MS of its last open is chronic —
            // double its open each time (capped) so we stop thrashing it; one stable for longer resets to base.
            let openMs = EGRESS_CIRCUIT_OPEN_MS;
            if (circuitOpen) {
              const now = Date.now();
              const stableFor = now - (egressLastOpenAt.get(active.accountId) ?? 0);
              // C2: only ESCALATE the flap backoff for a DEAD proxy (connect-error). A TTFB STALL (Anthropic
              // holding) hits every account repeatedly during a hold-storm; doubling its open would exile a
              // budget-healthy account up to EGRESS_CIRCUIT_OPEN_MAX_MS when it recovers in seconds — keep stalls
              // at the BASE open so they rejoin fast (the absorb + half-open probe carry the recovery).
              const reopen = !stalled && stableFor < EGRESS_FLAP_RESET_MS ? (egressReopenCount.get(active.accountId) ?? 0) + 1 : 0;
              egressReopenCount.set(active.accountId, reopen);
              egressLastOpenAt.set(active.accountId, now);
              openMs = Math.min(EGRESS_CIRCUIT_OPEN_MS * 2 ** reopen, EGRESS_CIRCUIT_OPEN_MAX_MS);
            }
            const pauseMs = circuitOpen ? openMs : TRANSIENT_429_BACKOFF_MS;
            const resetAt = Date.now() + pauseMs;
            // take-MAX (recordPenalty) → this never SHORTENS a legitimate longer 429/usage-cap pause.
            // transport:true — this pauses the account ONLY to route around its bad egress PROXY (pin-yield reads
            // pausedUntil); it is NOT a rate/budget signal, so the account-pool exhaustion/scale-out observer +
            // the fleet AIMD must NOT count it (a flaky proxy must never mark a quota-healthy account "exhausted").
            gov.penalize({ retryAfterMs: pauseMs, resetAt, transport: true });
            if (circuitOpen) {
              egressCircuitOpens++;
              egressPauseUntil.set(active.accountId, resetAt); // mark the TRANSPORT pause so the probe can lift exactly it on recovery
              const reopen = egressReopenCount.get(active.accountId) ?? 0;
              log('warn', `inference-gateway: EGRESS CIRCUIT OPEN for '${active.accountId}' (${streak} consecutive transport failures${reopen > 0 ? `, flap×${reopen}` : ''}) — out of rotation ≤${Math.round(pauseMs / 1000)}s; half-open probe readmits after ${EGRESS_PROBE_READMIT_STREAK} stable probes`);
              scheduleEgressProbe(active, gov, resetAt);
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
                everRotated = true;
                active = next;
                gov = governorForAccount(model, active.accountId);
                attempt++;
                log('warn', `inference-gateway: transport ${stalled ? 'stall' : 'failure'} on egress proxy → failover to '${active.accountId}' (attempt ${attempt})`);
                continue;
              }
            }
            // STALL ABSORPTION (#2, su-3650b incident): the DOMINANT failure under an Anthropic-wide stall storm
            // dies HERE (every proxy account TTFB-stalls → rotation exhausted). The 429-absorb can't help (no
            // 429). So before sheding the retryable 503, if absorb budget remains, HOLD the caller: release the
            // slot (the re-acquire's wait holds NO slot → cannot wedge), re-acquire on the pool's current-best
            // account (gov.acquire waits for a circuit-OPEN account's transport-pause to lift via the half-open
            // probe), and retry — so the caller WAITS through the storm and succeeds instead of erroring. Kill-
            // switch PAPERCUSP_GATEWAY_ABSORB_STALLS=0.
            //   everRotated GUARD (wires up the documented purpose of `everRotated` decl'd above): only a
            //   MULTI-account storm (we actually rotated → the pool HAS flapping/recovering alternatives) is
            //   worth holding the caller for. A LONE permanently-dead proxy (everRotated false → no alternative)
            //   must shed FAST — re-acquiring on the SAME dead account would just re-stall for the whole absorb
            //   budget (8–60s), the bug the egress-circuit "LONE dead proxy sheds FAST" / "N consecutive
            //   failures → 503" / autowake-503 / streak-reset tests assert against.
            if (ABSORB_STALLS_ON && everRotated && absorbDeadlineAt > 0 && Date.now() < absorbDeadlineAt && !res.headersSent) {
              release();
              release = () => {};
              let cand = active;
              let candGov = gov;
              try {
                cand = pool.active();
                candGov = governorForAccount(model, cand.accountId);
              } catch {
                /* pool empty / all-exhausted → keep the current account; the re-acquire still waits for recovery */
              }
              const reacq = await candGov.acquire(est, {
                maxWaitMs: Math.max(0, absorbDeadlineAt - Date.now()),
                allowSoftPaused: serveSoft,
                signal: reqAbort.signal, // H12: a reclaim/ceiling truly cancels this parked re-acquire
              });
              if (reacq) {
                release = reacq;
                active = cand;
                gov = candGov;
                retryDeadlineAt = Date.now() + internalRetryDeadlineMs; // fresh slot-hold budget for the retry
                attempt = 0;
                transientWaitedMs = 0;
                log(
                  'warn',
                  `inference-gateway: stall-absorb on '${active.accountId}' — holding the caller through the egress stall storm instead of a 503 (${Math.round((absorbDeadlineAt - Date.now()) / 1000)}s budget left)`,
                );
                continue;
              }
              // re-acquire timed out within the budget → fall through to the retryable 503 (release is the no-op → finally safe)
            }
            // No healthy account left / rotation budget spent — return a RETRYABLE 503 (the bee's CLI
            // retries; the next request lands on the failover-rotated active()), never a terminal 502.
            if (!res.headersSent) {
              beeEgressExhausted++;
              // P-002 autowake-coverage (2026-06-22): the dominant bee-facing-503 exit. Record a stall so the
              // stall-waker re-wakes an IDENTIFIED bee once this account/proxy recovers — without this the bee
              // just dies (the gateway's biggest "nothing goes through" path went unrecorded → /admin/stalls empty).
              recordStall(wantOwner, active.accountId, Math.max(gov.state.pausedUntil, Date.now() + 30_000));
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
          // (Deliberate: NOT absorbed — absorbing a no-proxy stall would hold callers through a persistent
          // Anthropic-side stall storm, the 2026-06-19 deadlock the HEADERS-stall + chaos tests guard against.)
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
        // G1 (WI-649): set in the bare-429 branch when ≥half the pool is out of rotation — suppresses the
        // cross-account rotate-retry below so a fleet-wide storm doesn't fan out ~2.4 upstream calls/request.
        let suppressBareBurstRotate = false;
        // Hard-evidence 429-shape suffix for the retry log (set inside the 429 block where the headers are in
        // scope; empty for non-429). Makes the capacity-vs-routing read come from data, not a guess.
        let shape429Suffix = '';

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
            let peek: { head: Buffer; rest: Readable | null };
            try {
              peek = await withDeadline(peekBody(up.body, USAGE_LIMIT_PEEK_BYTES), upstreamBodyIdleTimeoutMs, 'peekBody');
            } catch {
              // BOUNDED peek (2026-06-22 audit F3): peekBody's reader isn't wired to ac.abort, so a non-200 body
              // that's ACK'd but never arrives would hold the slot past the stall deadline. Cap it + treat as
              // un-peekable (empty head → no usage-cap/org classification → forwarded as a normal error).
              try {
                await up.body.cancel();
              } catch {
                /* drain the stalled body */
              }
              peek = { head: Buffer.alloc(0), rest: null };
            }
            peekedHead = peek.head;
            peekedRest = peek.rest;
            const text = peek.head.toString('utf8');
            if (classifyHttpError({ status: undefined, message: text }, 'anthropic').class === 'usage_limit') {
              usageCapResetAt = parseUsageResetMs(text) ?? Date.now() + USAGE_LIMIT_DEFAULT_PAUSE_MS;
            }
          }
          // Hard-evidence 429-shape suffix (gateway-429-shape-observability): everything needed is in scope here
          // (headers + the bare/usage-cap classification). bare-burst = CAPACITY EXISTS (transient) — an account at
          // util5h/util7d ≪ 1 that 429s here is NOT a quota wall; usage-cap = a real per-account wall. Surfacing
          // util5h/util7d at the 429 site lets a capacity-vs-routing read come from data, not a guess.
          if (up.status === 429) {
            const shape429 = classify429Shape({
              status: up.status,
              isUsageCap: usageCapResetAt !== undefined,
              bare: bare429,
              hasWindowReset: reset.retryAfterMs !== undefined || reset.resetAt !== undefined,
              unifiedRejected,
            });
            const u5 = hobj['anthropic-ratelimit-unified-5h-utilization'] ?? hobj['anthropic-ratelimit-unified-utilization'] ?? '-';
            const u7 = hobj['anthropic-ratelimit-unified-7d-utilization'] ?? '-';
            shape429Suffix = ` [429-shape=${shape429} x-should-retry=${shouldRetry} retry-after=${reset.retryAfterMs ?? '-'}ms util5h=${u5} util7d=${u7}]`;
            // BARE-BURST ORIGIN CAPTURE (WI-650/G2): a bare-burst is the unexplained throttle the fleet hits at
            // util≪1 — and the G2 experiment proved it is NOT a per-account rate/concurrency wall (one account
            // sustains ≥64 concurrent opus with zero bare-bursts), so it is a SHARED edge/infra-layer throttle.
            // On THAT shape, append the provenance headers that say WHO threw it: a Cloudflare/edge throttle
            // carries `server: cloudflare` + `cf-ray` (and usually NO Anthropic request-id); an Anthropic
            // app-layer 429 carries `request-id`/`anthropic-organization-id`. Captured into the same suffix so
            // every production bare-burst self-classifies in journald — "Anthropic or CDN edge?" reads from data.
            if (shape429 === 'bare-burst') {
              const origin = ([
                ['server', hobj['server']],
                ['cf-ray', hobj['cf-ray']],
                ['via', hobj['via']],
                ['req-id', hobj['request-id'] ?? hobj['x-request-id']],
                ['org', hobj['anthropic-organization-id']],
                ['unified-status', hobj['anthropic-ratelimit-unified-status']],
              ] as const)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ');
              shape429Suffix += ` [bare-burst-origin ${origin || 'no-provenance-headers'}]`;
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
              // rateLimited:true — this is a per-minute/burst RATE 429 → AIMD-decrease this account's learned rpm
              // (predict→wait→learn→retry, 2026-06-22) so decideRate paces future requests under its real rate.
              gov.penalize({ ...reset, rateLimited: true });
              exhaustResetAt = reset.resetAt ?? Date.now() + Math.min(reset.retryAfterMs ?? BARE_429_FAILOVER_BACKOFF_MS, 5 * 60 * 1000);
            } else if (bare429) {
              gov.penalize({ retryAfterMs: BARE_429_FAILOVER_BACKOFF_MS, resetAt: Date.now() + BARE_429_FAILOVER_BACKOFF_MS, rateLimited: true });
              exhaustResetAt = Date.now() + BARE_429_FAILOVER_BACKOFF_MS;
              // G1 (WI-649): a bare-burst is a TRANSIENT throttle (capacity exists) — distinct from the usage-cap
              // wall handled above. If ≥half the pool is already out of rotation, rotating onto "another" account
              // finds no capacity and just sustains the storm → suppress the rotate-retry so this request falls
              // through to the bounded transient-wait / absorb / fail-fast-shed (≈1 upstream call, not ~2.4).
              suppressBareBurstRotate = isFleetWideBareBurst();
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
            let peek: { head: Buffer; rest: Readable | null };
            try {
              peek = await withDeadline(peekBody(up.body, USAGE_LIMIT_PEEK_BYTES), upstreamBodyIdleTimeoutMs, 'peekBody');
            } catch {
              // BOUNDED peek (2026-06-22 audit F3): peekBody's reader isn't wired to ac.abort, so a non-200 body
              // that's ACK'd but never arrives would hold the slot past the stall deadline. Cap it + treat as
              // un-peekable (empty head → no usage-cap/org classification → forwarded as a normal error).
              try {
                await up.body.cancel();
              } catch {
                /* drain the stalled body */
              }
              peek = { head: Buffer.alloc(0), rest: null };
            }
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
          // Drop+refresh the cached token (unchanged request semantics — a STALE cached token recovers
          // on the next request's refresh). CREDENTIAL-HEALTH (#5 PART A): a DEAD/expired credential 401s
          // AGAIN after the refresh yields the same invalid credential — silently breaking spawns/evals
          // with no fleet alert. Count consecutive 401s per account; the FIRST tick the streak crosses the
          // dead threshold, fire the loud alert side-channel ONCE (fire-and-forget — never block/throw the
          // request path). The streak resets on the next 2xx for this account (success path below).
          active.invalidateToken?.();
          const streak = (credential401Streak.get(active.accountId) ?? 0) + 1;
          credential401Streak.set(active.accountId, streak);
          if (classifyCredential401Streak(streak, credential401DeadThreshold)) {
            log('error', `inference-gateway: credential for '${active.accountId}' is DEAD — ${streak} consecutive 401s despite token refresh; firing credential-health alert`);
            try {
              deps.onCredentialDead?.({ accountId: active.accountId, consecutive401s: streak });
            } catch {
              /* fire-and-forget: the alert side-channel must NEVER throw into the request hot path */
            }
          }
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
            if (internalRetry.rotate && suppressBareBurstRotate) {
              // G1 (WI-649): FLEET-WIDE bare-burst — ≥half the pool is out of rotation, so rotating A→B→C finds
              // no capacity and just multiplies upstream load, sustaining the storm. SUPPRESS the rotate-retry:
              // leave proceed=false so we fall through to the bounded transient-WAIT / absorb / fail-fast-shed
              // below (≈1 upstream call/request instead of ~2.4). recordThrottle still fires below (routedAround
              // stays false) — an un-routable bare-burst IS genuine pool-wide saturation, so AIMD shrinks admission.
              bareBurstRotateSuppressed++;
            } else if (internalRetry.rotate) {
              const next = pool.onExhausted(active.accountId, internalRetry.exhaustResetAt);
              if (next && next.accountId !== active.accountId) {
                failovers++;
                everRotated = true;
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
            // HARD-EVIDENCE 429 SHAPE (gateway-429-shape-observability): `shape429Suffix` names WHICH kind of 429
            // this was (computed in the 429 block where the headers are in scope), so "is the pool actually out of
            // capacity?" reads from the journal instead of a guess — bare-burst = CAPACITY EXISTS (transient), usage-cap
            // = a real per-account wall, with the account's live util5h/util7d at the 429 site.
            log(
              'warn',
              `inference-gateway: upstream ${up.status} → internal retry attempt=${attempt} wait=${transientWaitedMs}ms on '${active.accountId}'${shape429Suffix}`,
            );
            continue;
          }
          // EXTENDED ABSORPTION (env-gated, requestAbsorbMs): we are about to FORWARD a retryable failure to the
          // caller — rotation + the transient wait-budget are exhausted (proceed=false). If it is a TRANSIENT
          // rate-429 (capacity returns soon — `transient` excludes a multi-hour usage cap) OR a 529 SERVER-OVERLOAD
          // (Anthropic-side, retryable), and absorb budget remains, RELEASE the admission slot (the wait below holds
          // NO slot → it CANNOT wedge), wait the throttle/overload out, re-acquire, and retry — so the caller WAITS
          // and succeeds instead of erroring. Role-agnostic: any caller, not just a bee. absorbDeadlineAt=0 ⇒ off.
          if (!proceed && absorbDeadlineAt > 0 && Date.now() < absorbDeadlineAt) {
            clearStall();
            peekedRest?.destroy();
            release(); // free the slot NOW — the wait below admits nothing until an account has serviceable budget
            release = () => {}; // guard the `finally` against a double-release if the re-acquire below fails
            // A 529 does NOT rate-pause the account (server overload, not per-account budget), so the re-acquire
            // below would return IMMEDIATELY → back off first (the 529's retry-after) to avoid hammering the
            // overload. A rate-429's re-acquire instead WAITS out the account's penalty pause, so it needs no extra
            // backoff here — keeping the validated 429 path byte-identical.
            if (up.status === 529 && backoff > 0) {
              await new Promise<void>((r) => {
                const t = setTimeout(r, Math.min(backoff, Math.max(0, absorbDeadlineAt - Date.now())));
                t.unref?.();
              });
            }
            const reacq = await gov.acquire(est, { maxWaitMs: Math.max(0, absorbDeadlineAt - Date.now()), allowSoftPaused: serveSoft, signal: reqAbort.signal }); // H12: reclaim/ceiling cancels this parked re-acquire
            if (reacq) {
              release = reacq;
              retryDeadlineAt = Date.now() + internalRetryDeadlineMs; // fresh slot-hold budget for the retry
              attempt = 0;
              transientWaitedMs = 0; // the absorb is a SEPARATE outer budget from the in-retry transient wait
              log('warn', `inference-gateway: absorb-retry on '${active.accountId}' — holding the caller instead of forwarding a ${up.status} (${Math.round((absorbDeadlineAt - Date.now()) / 1000)}s budget left)`);
              continue;
            }
            // re-acquire timed out within the absorb budget → fall through to forward (release is the no-op → finally safe)
          }
        }

        // AIMD clean signal (B-GW-1): a forwarded 2xx means this account had real capacity — drain the
        // throttle pressure + nudge admission concurrency back up toward the cap. A forwarded non-2xx
        // (a 4xx client error, or a 429 we chose not to retry) is neither throttle nor clean-capacity,
        // so it neither shrinks nor grows the limit (a 429 already recorded its throttle above).
        if (up.status >= 200 && up.status < 300) {
          aimd.recordSuccess();
          // CREDENTIAL-HEALTH (#5 PART A): a 2xx is a SUCCESSFUL auth for this account's credential — clear
          // its consecutive-401 streak so a later dead-credential episode re-arms a fresh alert (and a
          // recovered-but-previously-flapping credential never carries a stale streak into a false alert).
          if (credential401Streak.has(active.accountId)) credential401Streak.delete(active.accountId);
        }
        // P-002 autowake-coverage (2026-06-22): a FORWARDED retryable rate-limit (a 429/529 the gateway could not
        // retry away) to an IDENTIFIED bee → record a stall so the stall-waker re-wakes it when this account
        // recovers. This is the DOMINANT "nothing goes through" exit (a forwarded upstream 429) that previously
        // recorded nothing → /admin/stalls sat empty while the whole pool was throttled.
        else if ((up.status === 429 || up.status === 529) && wantOwner) {
          recordStall(wantOwner, active.accountId, Math.max(gov.state.pausedUntil, Date.now() + 30_000));
        }

        const outHeaders: Record<string, string> = {};
        up.headers.forEach((v, k) => {
          if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders[k] = v;
        });
        // Detectability: name the account this request ACTUALLY egressed on, so a silent fallback
        // off a pin (unknown id / paced-account failover) is visible to the caller, not invisible.
        outHeaders[ROUTED_ACCOUNT_HEADER] = active.accountId;
        recordRoute(wantOwner, active.accountId, model); // per-owner last-routed → GET /admin/route (statusline)
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

  async function proxyOpenAi(req: http.IncomingMessage, res: http.ServerResponse, url: string) {
    const adapter = providerAdapters.codex;
    if (!adapter.pool || !adapter.upstreamBase) {
      req.resume();
      sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: adapter.unavailableMessage ?? 'inference-gateway: Codex provider unavailable' }, gateway: true });
      return;
    }
    const wantAccount = (req.headers[ACCOUNT_HEADER] as string | undefined)?.trim();
    let active: ActiveAccount;
    try {
      const pinned = (wantAccount && adapter.pool.select?.(wantAccount)) || null;
      active = pinned ?? adapter.pool.active();
    } catch (e) {
      req.resume();
      sendJson(res, 503, { type: 'error', error: { type: 'api_error', message: (e as Error).message || adapter.unavailableMessage || 'inference-gateway: Codex provider unavailable' }, gateway: true });
      return;
    }
    // BOUNDED body read (2026-06-22 audit F1): a Codex bee that stalls mid-upload must not hold this admission
    // slot forever — the Claude proxy's ceiling timer covers its readBody; the codex path had none, and
    // proxyOpenAi never registers in inFlightReg so the self-heal valve can't reclaim it. Cap it + free the slot.
    let bodyBuf: Buffer;
    try {
      bodyBuf = await withDeadline(readBody(req), requestCeilingMs, `codex readBody '${active.accountId}'`);
    } catch {
      try {
        req.destroy();
      } catch {
        /* already torn down */
      }
      if (!res.headersSent) {
        sendJson(res, 503, { type: 'error', error: { type: 'overloaded_error', message: 'inference-gateway: Codex request body read stalled; retry shortly' }, gateway: true });
      }
      return;
    }
    // Stream detection — PARITY with the Claude proxy (backlog #1 / 2026-06-22 audit follow-up): a stream:true
    // request gets the SHORT TTFB headers deadline + a per-chunk body-idle guard; non-streaming keeps the
    // generous headers deadline. Without this a stalled codex STREAM squatted its admission slot for the full
    // GENEROUS upstreamHeadersTimeoutMs (no stream TTFB) and, once headers arrived, had NO body-idle guard —
    // the same slot-squat / connection-leak class the Claude path was hardened against.
    let isStream = false;
    if (bodyBuf.length) {
      try {
        if ((JSON.parse(bodyBuf.toString('utf8')) as { stream?: boolean }).stream === true) isStream = true;
      } catch {
        /* non-JSON body — keep the generous (non-stream) deadline */
      }
    }
    const headersStallMs = isStream ? upstreamStreamHeadersTimeoutMs : upstreamHeadersTimeoutMs;
    totalRequests++;
    codexRequests++;
    res.setTimeout(downstreamIdleMs, () => res.destroy());

    // Single stall timer — the headers TTFB, then re-armed per body chunk as the body-idle deadline (mirrors
    // the Claude proxy). unref'd so it never keeps the loop alive; cleared on every exit path.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const clearStall = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };

    // RESILIENCE PARITY with the Claude path (2026-06-22 audit): rotate to another Codex account + retry on
    // a 429, a transport failure, or a token-read failure — instead of FORWARDING the error to the bee (the
    // same "route around, don't surface" bug-class the Claude path was hardened against). `codexPool.onExhausted`
    // marks the failing account out of rotation + returns the next one. Bounded by INTERNAL_RETRY_MAX_ATTEMPTS;
    // the body is buffered (bodyBuf) so each attempt re-sends cleanly. The retry only runs BEFORE headers are
    // written; once we stream a response we commit to it.
    const rotateCodex = (resetAt: number): boolean => {
      const next = adapter.pool!.onExhausted(active.accountId, resetAt);
      if (next && next.accountId !== active.accountId) {
        codexFailovers++;
        active = next;
        return true;
      }
      return false;
    };
    for (let attempt = 0; attempt < INTERNAL_RETRY_MAX_ATTEMPTS; attempt++) {
      const canRetry = attempt < INTERNAL_RETRY_MAX_ATTEMPTS - 1;
      let token: string;
      try {
        token = await withDeadline(active.token(), tokenTimeoutMs, `codex token '${active.accountId}'`);
      } catch (e) {
        codexUpstreamErrors++;
        log('error', `inference-gateway: Codex token read failed on '${active.accountId}': ${(e as Error).message}`);
        if (canRetry && rotateCodex(Date.now() + BARE_429_FAILOVER_BACKOFF_MS)) continue;
        if (!res.headersSent) {
          sendJson(
            res,
            503,
            { type: 'error', error: { type: 'overloaded_error', message: `inference-gateway: Codex token unavailable for '${active.accountId}'` }, gateway: true },
            { 'retry-after': '5', [ROUTED_ACCOUNT_HEADER]: active.accountId },
          );
        }
        return;
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || STRIP_REQUEST.has(k.toLowerCase())) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      headers.authorization = `Bearer ${token}`;
      headers['accept-encoding'] = 'identity';

      const ac = new AbortController();
      // armStall(ms): abort THIS attempt's upstream call if it makes no progress for ms — first as the headers
      // TTFB (short for streams), then re-armed per body chunk below as the body-idle deadline.
      const armStall = (ms: number) => {
        clearStall();
        stallTimer = setTimeout(() => ac.abort(new Error(`openai upstream stall: no activity for ${ms}ms`)), ms);
        stallTimer.unref?.();
      };
      let up: Response;
      try {
        const init: FetchInit = { method: req.method ?? 'POST', headers, signal: ac.signal };
        if (bodyBuf.length) init.body = new Uint8Array(bodyBuf);
        const dispatcher = await dispatcherFor(active);
        if (dispatcher) init.dispatcher = dispatcher;
        armStall(headersStallMs); // SHORT TTFB for streams; generous otherwise
        up = await doFetch(`${adapter.upstreamBase}${url}`, init as RequestInit);
        armStall(upstreamBodyIdleTimeoutMs); // headers arrived → switch to the per-chunk body-idle deadline
      } catch (e) {
        clearStall();
        codexUpstreamErrors++;
        active.invalidateToken?.();
        // Transport failure (dead/hanging proxy or network) → route around to another Codex account + retry.
        if (canRetry && rotateCodex(Date.now() + BARE_429_FAILOVER_BACKOFF_MS)) continue;
        if (!res.headersSent) {
          sendJson(
            res,
            502,
            { type: 'error', error: { type: 'api_error', message: `inference-gateway: Codex upstream failed: ${(e as Error).message}` }, gateway: true },
            { [ROUTED_ACCOUNT_HEADER]: active.accountId },
          );
        } else {
          res.destroy();
        }
        return;
      }

      // 429 → ROTATE + retry (route around) rather than forwarding the throttle to the bee.
      if (up.status === 429) {
        codexUpstream429++;
        if (canRetry) {
          const reset = parseRateReset(headersToObject(up.headers));
          if (rotateCodex(reset.resetAt ?? Date.now() + BARE_429_FAILOVER_BACKOFF_MS)) {
            clearStall();
            try { await up.body?.cancel(); } catch { /* drain the throttle body before retrying */ }
            continue;
          }
        }
        // no rotate target / out of attempts → fall through and forward the 429 (the bee's CLI retries)
      } else if (up.ok) {
        aimd.recordSuccess();
      }

      const outHeaders: Record<string, string> = { [ROUTED_ACCOUNT_HEADER]: active.accountId };
      up.headers.forEach((v, k) => {
        if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders[k] = v;
      });
      res.writeHead(up.status, outHeaders);
      if (!up.body) {
        clearStall();
        res.end();
        return;
      }
      // Stream the body with a per-chunk body-idle guard (parity with the Claude proxy): reset the deadline on
      // every chunk so a long stream is never clipped, but a genuine mid-stream stall (no bytes for
      // upstreamBodyIdleTimeoutMs) aborts → the stream errors → we tear down both ends. Await completion so the
      // admission slot is held for the stream's life (forwarded-concurrency parity) and released cleanly.
      const nodeStream = Readable.fromWeb(up.body as Parameters<typeof Readable.fromWeb>[0]);
      nodeStream.on('data', () => armStall(upstreamBodyIdleTimeoutMs));
      nodeStream.pipe(res);
      await new Promise<void>((resolve) => {
        res.on('finish', () => resolve());
        res.on('close', () => resolve());
        res.on('error', () => resolve());
        nodeStream.on('error', () => {
          res.destroy();
          resolve();
        });
        // A body-idle (or ceiling) abort must force-tear-down both ends + resolve so the slot is actually freed
        // — mirrors the Claude path's wedge-prevention onAbort (the 2026-06-21 stuck-stream slot leak).
        const onAbort = () => {
          try { nodeStream.destroy(); } catch { /* already torn down */ }
          try { res.destroy(); } catch { /* already torn down */ }
          resolve();
        };
        if (ac.signal.aborted) onAbort();
        else ac.signal.addEventListener('abort', onAbort, { once: true });
      });
      clearStall();
      return;
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
    if (req.method === 'GET' && (url === '/admin/stalls' || url.startsWith('/admin/stalls?'))) {
      // P-002: recent rate-limit stall candidates for the stall-waker (gateway-rate-limit-stall-autowake).
      // `?since=<epochMs>` returns only events after that watermark (the waker passes its last-seen `now`).
      const since = Number(url.match(/[?&]since=(\d+)/)?.[1] ?? 0);
      sendJson(res, 200, { ok: true, now: Date.now(), stalls: recentStalls.filter((s) => s.at > since) });
      return;
    }
    if (req.method === 'GET' && url.startsWith('/admin/route')) {
      // routed-account-visibility (2026-06-22): the account that served `?owner=<id>`'s most-recent turn, so a
      // session's statusline can show "my turn → <account>". `{account:null}` when that owner hasn't been seen.
      const owner = decodeURIComponent(url.match(/[?&]owner=([^&]+)/)?.[1] ?? '');
      const e = owner ? lastRouteByOwner.get(owner) : undefined;
      sendJson(res, 200, { ok: true, now: Date.now(), owner: owner || null, account: e?.account ?? null, model: e?.model ?? null, at: e?.at ?? null });
      return;
    }
    if (req.method === 'GET' && url === '/admin/config') {
      // B-HOT-2: the LIVE config snapshot — pool version + account ids + the admission/AIMD state — so an
      // operator / gateway:status tool can read what the gateway is actually running, no restart.
      const s = stats();
      sendJson(res, 200, {
        ...(deps.adminConfig ? deps.adminConfig() : { hotReload: false }),
        providers: gatewayProviderStatuses(providerAdapters),
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
    const priLabel = (req.headers[PRIORITY_HEADER] as string | undefined) ?? undefined;
    const pri = priorityFromLabel(priLabel);
    // Tier the request from its `x-papercusp-priority` role (only when the tier layer is on — `tierMap`
    // present). Passed to queue.run as `opts.tier`; it is IGNORED by the queue when the tier layer is off,
    // so this is a safe no-op under flag-OFF.
    const tier = tierMap ? tierOf(priLabel, tierMap) : undefined;
    // Route OpenAI-compatible Codex traffic to the Codex pool. `/v1/responses`
    // is unambiguously Codex; `/v1/models` is shared, so the request-aware
    // router uses a Codex account pin to keep Codex model discovery off the
    // Anthropic proxy while preserving Claude model probes.
    const handler = providerForGatewayRequest(url, req.headers, providerAdapters).id === 'codex' ? proxyOpenAi : proxy;
    queue.run(pri, () => handler(req, res, url), tier !== undefined ? { tier } : undefined).catch((e) => {
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
          log('info', `inference-gateway listening on 127.0.0.1:${p} → ${upstreamBase} (account ${(pool.peek ? pool.peek() : pool.active()).accountId})`);
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
      if (serviceableClampTimer) clearInterval(serviceableClampTimer);
      // Tear down any per-account egress dispatchers (best-effort; they hold sockets).
      for (const d of dispatcherCache.values()) void (d as { close?: () => Promise<void> }).close?.();
      dispatcherCache.clear();
      // PROMPT shutdown (2026-06-22 audit): server.close() alone waits for EVERY in-flight connection — but
      // Claude responses are long-lived SSE streams, so it hung past systemd's TimeoutStopSec and got
      // force-killed (orphaned node in the cgroup, slow restarts). Stop accepting + drop idle keep-alives
      // now, then after GRACEFUL_SHUTDOWN_MS destroy any still-streaming connection so we exit promptly.
      const srv = server as http.Server & { closeIdleConnections?: () => void; closeAllConnections?: () => void };
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        srv.close(() => finish());
        try {
          srv.closeIdleConnections?.();
        } catch {
          /* older node / already closing */
        }
        const t = setTimeout(() => {
          try {
            srv.closeAllConnections?.();
          } catch {
            /* older node */
          }
          finish();
        }, GRACEFUL_SHUTDOWN_MS);
        t.unref?.();
      });
    },
  };
}

export type InferenceGateway = ReturnType<typeof createInferenceGateway>;
