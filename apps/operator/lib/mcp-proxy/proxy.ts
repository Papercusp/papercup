/**
 * Resilient local MCP proxy (mcp-host-availability-resilience-2026-06-22 P-005).
 *
 * WHY: the papercusp-su MCP endpoint is :3070/api/mcp, and :3070 restarts on every
 * deploy. A native MCP client (Claude Code) drops its connection on that restart and
 * does not re-discover tools → "toolless session". This always-up local proxy sits in
 * FRONT of :3070: the client connects HERE (opt-in), and the client→proxy connection
 * stays up across a :3070 deploy because THIS process never restarts on deploys. When
 * :3070 is briefly unreachable (mid-restart) the proxy RETRIES the forward, so a
 * tools/call issued during the window just waits a beat instead of erroring — the
 * restart is invisible to the agent.
 *
 * SAFETY — no double-execution (the load-bearing invariant): a tools/call is often a
 * non-idempotent WRITE. The base rule: RETRY freely only when the upstream connection was
 * REFUSED (ECONNREFUSED / pre-connect error) — i.e. the request provably never reached
 * :3070, so replaying it cannot double-apply. Once the socket has CONNECTED, an error
 * MIGHT mean :3070 already processed the call, so by default we do NOT retry — we surface
 * a 502.
 *
 * P-005 (mcp-reliability-hardening-2026-07-11) refines the post-connect case — the
 * "retry-once on a stale-socket reset" this header long anticipated — by CLASSIFYING the
 * forward (see prepareForward):
 *   - 'idempotent' (no tools/call: initialize / tools/list / ping / resources / prompts /
 *     notifications) → replaying has no side effect, so a post-connect failure IS retried
 *     (bounded, in-window). This directly targets the dropped-handshake "toolless session".
 *   - 'keyed' (a tools/call into which the proxy injects a per-request `_meta.idempotencyKey`)
 *     → the key preserves a completed result for a later explicit retry, but the proxy does
 *     NOT retry immediately: the original handler may still be running and its result row
 *     does not exist until it settles, so a concurrent replay can execute the mutation twice.
 *   - 'readonly' (EI-21268234394605529: EVERY tools/call in the batch names a verb in
 *     READ_ONLY_TOOLS) → re-running the call cannot double-apply anything, so a post-connect
 *     socket error IS retried once, in-window — while the timeout path stays on maxHoldMs
 *     exactly like 'keyed'/'opaque': `build:typecheck` legitimately runs ~160s and must never
 *     inherit the 8s handshake bound.
 *   - 'opaque' (a tools/call with no usable key — keying kill-switched off, body unparseable,
 *     or oversized) → the original invariant stands: NEVER replay a post-connect failure.
 * Kill-switch: PAPERCUSP_MCP_PROXY_KEYED_RETRY=0 forces every tools/call to 'opaque'
 * (exactly the pre-P-005 refused-only behavior); the idempotent-method retry is always safe
 * and stays on.
 *
 * The endpoint is STATELESS streamable-HTTP (no Mcp-Session-Id / handshake), so the
 * proxy is a pure per-request passthrough — no session state to lose across a restart.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { normalizeMcpName } from '@papercusp/tooldef';
import { isCheapRepeatingBeat } from '@papercusp/operator-core/lib/system-health/mcp-proxy-beats';
export { CHEAP_REPEATING_BEAT_PATHS, isCheapRepeatingBeat } from '@papercusp/operator-core/lib/system-health/mcp-proxy-beats';
// The one path this proxy answers itself. Shared with watchdog.mjs so the liveness probe and
// the route it probes cannot drift apart (WI-6743).
import { MCP_PROXY_LOCAL_HEALTH_PATH } from './budgets.mjs';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyServerTimeouts } from '../../bin/host-request-deadline';

/**
 * Dedicated upstream agent with keep-alive DISABLED — backend-reliability-100pct-2026-07-03 W1.3.
 *
 * ROOT CAUSE (measured 2026-07-03): forwarding through Node's GLOBAL agent (keepAlive:true,
 * maxSockets:Infinity on Node ≥19) POOLS + REUSES sockets to the :3070 cluster. A pooled socket
 * races the server/worker closing it (the :3070 http server advertises `keep-alive: timeout=61`,
 * AND SO_REUSEPORT workers recycle on lag) — so a forward can land on a half-closed socket, :3070's
 * parser sees a malformed request and returns its default `400 Bad Request` (connection:close, empty
 * body). The proxy treats that as a normal upstream RESPONSE (statusCode 400) and forwards it to the
 * agent as a spurious tool error — NOT covered by the refused-only retry. Reproduced at ~13% on
 * reuse-prone (sequential) traffic while direct :3070 was 15/15 clean. Every agent routes through
 * this proxy, so this was a prime source of the "transient tool errors under load".
 *
 * FIX: a fresh socket per forward eliminates the reuse race entirely. This proxy fronts a localhost
 * upstream, so the extra connect is microseconds. keepAlive:false is the correct, safe fix for the
 * reuse race; it does NOT bound concurrency, which is `maxSockets` below.
 *
 * EI-19305299022434394 — `maxSockets` was `Infinity` here, which is the OTHER half of the same
 * congestion-collapse bug this comment already describes for keep-alive: when :3070 accepts
 * connections but stalls, an unbounded agent keeps opening brand-new concurrent sockets for every
 * arriving request instead of queuing them — the more the upstream struggles, the more simultaneous
 * work the proxy piles onto it. Measured 2026-08-01: 3,450 requests held open simultaneously in one
 * second when :3070 stopped responding, with proxy elapsed times of 32-89 minutes. A finite
 * `maxSockets` makes Node's own `http.Agent` queue excess forwards internally instead of amplifying
 * them; `createMcpProxy`'s own `maxInFlight` admission control (below) then sheds with 429 once even
 * that queue backs up past a threshold, so the proxy never silently holds an unbounded number of
 * requests. Both bounds are env-overridable so a box that legitimately needs more headroom can raise
 * them without a code change.
 */
const DEFAULT_MAX_UPSTREAM_SOCKETS = Number(process.env.PAPERCUSP_MCP_PROXY_MAX_SOCKETS ?? 64);
const UPSTREAM_AGENT = new http.Agent({
  keepAlive: false,
  maxSockets: DEFAULT_MAX_UPSTREAM_SOCKETS > 0 ? DEFAULT_MAX_UPSTREAM_SOCKETS : Infinity,
});

/**
 * W8 (backend-reliability-100pct-2026-07-03) — make the proxy's forwarded FAILURES VISIBLE.
 * A non-2xx the proxy forwards, a retry-recovery, or a window-exhaustion NEVER creates a
 * `tool_invocations` row (the request errors at the HTTP layer, BELOW tool dispatch), so the
 * agent-facing failure rate was under-counted and "transient errors" felt normal — exactly how
 * the W1.3 stale-socket 400s stayed invisible. Append a structured JSONL record (journald-
 * independent, survives restart) that a health collector / SLO can ingest. NEVER throws —
 * telemetry must never break forwarding. Env override: PAPERCUSP_MCP_PROXY_FAILURE_LOG.
 *
 * ⚠ THE LEDGER IS SHARED AND MULTI-WRITER (EI-19388683897769817): this file is the real,
 * fleet-facing production telemetry a health collector reads, NOT a scratch log. Every
 * reader of it must apply `isNonInstanceRecord` (system-health/mcp-proxy-health.ts) to
 * exclude `listenPort: 0` (test/sidecar) rows, or it over-counts failures — measured live,
 * 18% of a 13,189-record sample were test-suite noise (28-record batches from short-lived
 * pids, `maxInFlight: 2` fixture values) with no env override set. `isNonInstanceRecord`
 * lives in exactly ONE reader today; a second consumer that forgets it silently inherits
 * the pollution (already shipped once and caught in review, see
 * plan `outage-must-not-be-silent-2026-08-02` D-005).
 */
function failureLogPath(): string {
  // Resolved per-call (not cached at module load) so the sink is env-overridable at runtime + testable.
  return process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG || join(homedir(), '.papercusp', 'mcp-proxy-failures.jsonl');
}
export const DEFAULT_FAILURE_LOG_MAX_BYTES = 10 * 1024 * 1024;
function failureLogMaxBytes(): number {
  const configured = Number(process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_FAILURE_LOG_MAX_BYTES;
}
export function shouldRotateFailureLog(sizeBytes: number, maxBytes = DEFAULT_FAILURE_LOG_MAX_BYTES): boolean {
  return sizeBytes >= maxBytes;
}
/**
 * PURE: should `recordProxyFailure` skip writing this call entirely? EI-19388683897769817 —
 * a test that constructs a proxy WITHOUT setting PAPERCUSP_MCP_PROXY_FAILURE_LOG must never
 * fall through to the real default `~/.papercusp/mcp-proxy-failures.jsonl` — that silently
 * appended ~18% test noise (short-lived-pid batches, `listenPort: 0`, fixture values like
 * `maxInFlight: 2`) into the shared production ledger every suite run. Guarded at the WRITE
 * site (not per-test) so a future test cannot forget: under vitest, only an EXPLICIT override
 * writes; the default path is skipped entirely rather than silently redirected, because
 * nothing in this suite depends on the default path being written to (the two tests that
 * assert on ledger content already set the override themselves). Exported as a pure
 * predicate (inputs, not env reads) so it is unit-testable without touching real env/fs.
 */
export function shouldSkipDefaultFailureLog(isTest: boolean, hasExplicitOverride: boolean): boolean {
  return isTest && !hasExplicitOverride;
}
function recordProxyFailure(rec: Record<string, unknown>): void {
  if (shouldSkipDefaultFailureLog(Boolean(process.env.VITEST), Boolean(process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG))) {
    return;
  }
  try {
    const path = failureLogPath();
    mkdirSync(dirname(path), { recursive: true }); // idempotent; failures are rare so this is cheap
    try {
      if (shouldRotateFailureLog(statSync(path).size, failureLogMaxBytes())) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      // A missing file is normal; concurrent writers may also win the rotation race.
    }
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch {
    /* telemetry must never break the proxy */
  }
}

export interface McpProxyOptions {
  listenPort: number;
  listenHost?: string;
  targetHost?: string;
  targetPort?: number;
  /** Resolve the current upstream per attempt. Used by packaged installs whose operator port changes per boot. */
  resolveTarget?: () => McpProxyTarget;
  /**
   * WI-41045 — the superuser MCP client config contains a bearer captured at
   * session boot. When the token file rotates, refresh it at the proxy boundary
   * instead of forwarding that stale client header. The path and reader are
   * injectable so rotation can be exercised without touching the host token.
   */
  superuserTokenPath?: string;
  readSuperuserToken?: (path: string) => string | null;
  /** Total wall-clock budget to keep retrying a refused upstream (a :3070 restart). */
  retryWindowMs: number;
  /** WI-6740: per-attempt wait for response headers on the write-free control-plane batch
   *  (initialize / tools/list / ping). Defaults to HANDSHAKE_UPSTREAM_TIMEOUT_MS; injectable
   *  so tests can drive a stalling upstream without sleeping 8s. Never applied to a tools/call. */
  handshakeTimeoutMs?: number;
  /** Delay between retries while the upstream is refusing connections. */
  retryBackoffMs?: number;
  /**
   * EI-19305299022434394 — the admission-control ceiling: shed a NEW request with 429 +
   * Retry-After the instant this many forwards are already in flight, BEFORE it ever opens an
   * upstream socket. Defaults to `DEFAULT_MAX_IN_FLIGHT` (env `PAPERCUSP_MCP_PROXY_MAX_IN_FLIGHT`).
   * Injectable so tests can drive shedding without spinning up hundreds of real connections.
   */
  maxInFlight?: number;
  /** Slots kept available for scheduler control-plane pulls when ordinary tool traffic fills
   * the proxy. Reserved traffic also gets a separate upstream socket pool so an admitted
   * recovery probe cannot sit behind the ordinary pool it is trying to diagnose. The hard
   * `maxInFlight` ceiling still applies to every request. */
  controlPlaneReserve?: number;
  /** Injectable ordinary upstream agent for deterministic queue-saturation tests/embedders. */
  upstreamAgent?: http.Agent;
  /** Injectable reserved-control-plane agent. Caller owns an injected agent's lifecycle. */
  controlPlaneAgent?: http.Agent;
  /**
   * EI-19305299022434394 — the absolute ceiling (ms) on how long a NON-idempotent forward
   * (a real tools/call: 'keyed' or 'opaque') may hold its upstream socket waiting for response
   * headers, distinct from `handshakeTimeoutMs` (which bounds only the write-free control-plane
   * batch). Generous by design — well above any legitimate tool's real runtime (`build:typecheck`
   * ~160s) — purely to stop the 32-89 minute silent parks a stalled-but-connected upstream can
   * otherwise hold a socket for. 0/undefined at the option level falls back to
   * `DEFAULT_MAX_HOLD_MS` (env `PAPERCUSP_MCP_PROXY_MAX_HOLD_MS`); pass `0` explicitly to disable.
   */
  maxHoldMs?: number;
  /**
   * EI-19305299022434394 — how often (ms) to log/record an in-flight heartbeat while at least
   * one forward is outstanding, so a stalled proxy is LOUD instead of silent (the proxy previously
   * logged only on completion/error, so total upstream silence produced total proxy silence too —
   * 106 minutes with zero log lines during the measured outage). Defaults to
   * `DEFAULT_HEARTBEAT_INTERVAL_MS` (env `PAPERCUSP_MCP_PROXY_HEARTBEAT_MS`); `0` disables.
   */
  heartbeatIntervalMs?: number;
  log?: (s: string) => void;
}

export interface McpProxyTarget {
  host: string;
  port: number;
  source?: string;
}

/** The shared host token used by the superuser MCP endpoint. */
export function defaultSuperuserTokenPath(): string {
  const configured = process.env.PAPERCUSP_MCP_TOKEN_FILE?.trim();
  return configured || join(homedir(), '.papercusp', 'superuser-token');
}

/** Read the current bearer without caching it across requests. */
export function readCurrentSuperuserToken(path = defaultSuperuserTokenPath()): string | null {
  try {
    const token = readFileSync(path, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

/** True only for the query form that opts a request into superuser MCP auth. */
export function isSuperuserMcpRequest(requestUrl: string): boolean {
  try {
    return new URL(requestUrl, 'http://127.0.0.1').searchParams.get('superuser') === '1';
  } catch {
    return false;
  }
}

/**
 * Replace a stale client bearer with the token currently on disk, but only on
 * the superuser MCP path. A missing/unreadable token preserves the original
 * headers so the upstream returns its normal auth failure rather than the
 * proxy inventing one.
 */
export function injectCurrentSuperuserBearer(
  requestUrl: string,
  headers: http.IncomingHttpHeaders,
  options: { tokenPath?: string; readToken?: (path: string) => string | null } = {},
): http.IncomingHttpHeaders {
  if (!isSuperuserMcpRequest(requestUrl)) return headers;
  const token = (options.readToken ?? readCurrentSuperuserToken)(options.tokenPath ?? defaultSuperuserTokenPath());
  if (!token?.trim()) return headers;
  const withoutAuthorization = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
  );
  return { ...withoutAuthorization, authorization: `Bearer ${token.trim()}` };
}

/**
 * `Connection` is hop-by-hop metadata for the client→proxy socket. Forwarding a client
 * `Connection: close` to the upstream makes the capped control-plane agent queue requests
 * onto sockets that are already closing; :3070 can then answer the queued request with an
 * empty 400. Let Node derive the upstream connection policy from its own agent instead.
 */
export function stripClientConnectionHeader(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const forwarded = { ...headers };
  delete forwarded.connection;
  return forwarded;
}

export function staticMcpProxyTarget(host: string, port: number): McpProxyTarget {
  return { host, port, source: 'static' };
}

export function readOperatorJsonTarget(path = join(homedir(), '.papercusp', 'operator.json')): McpProxyTarget | null {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8')) as { httpUrl?: string; port?: number | string };
    if (typeof d.httpUrl === 'string' && d.httpUrl.trim()) {
      const u = new URL(d.httpUrl);
      return { host: u.hostname || '127.0.0.1', port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), source: 'operator.json' };
    }
    const port = Number(d.port);
    if (Number.isFinite(port) && port > 0) return { host: '127.0.0.1', port, source: 'operator.json' };
  } catch {
    /* discovery unavailable */
  }
  return null;
}

function resolveTarget(opts: McpProxyOptions): McpProxyTarget {
  const dynamic = opts.resolveTarget?.();
  if (dynamic) return dynamic;
  const host = opts.targetHost ?? '127.0.0.1';
  const port = Number(opts.targetPort);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('mcp proxy targetPort must be set when resolveTarget is not provided');
  }
  return staticMcpProxyTarget(host, port);
}

/**
 * Pure retry decision (unit-tested): keep retrying ONLY while BOTH hold —
 *  (a) the upstream connection has NOT yet been established this attempt
 *      (`connected === false` ⇒ the request never reached :3070 ⇒ safe to replay), and
 *  (b) we are still inside the retry window.
 * `connected === true` ⇒ :3070 may already have processed the (possibly non-idempotent)
 * call ⇒ never replay.
 */
export function shouldRetry(connected: boolean, elapsedMs: number, windowMs: number): boolean {
  if (connected) return false;
  return elapsedMs < windowMs;
}

/** Post-connect failures are retried AT MOST this many times — a bounded "retry-once on a
 *  stale-socket reset". Bounding it caps the exposure of the server's documented
 *  commit→store race (a write that committed but died before persisting its replay row)
 *  to a single replay attempt. */
export const MAX_POST_CONNECT_RETRIES = 1;
/**
 * P-010 (mcp-reliability-hardening-2026-07-11) — admission-control backpressure absorption.
 * When :3070's event loop is CRITICALLY saturated it sheds a tools/call PRE-DISPATCH with
 * HTTP 429 + Retry-After (the tool never ran → no side effect). A 429 is defined by HTTP as
 * "the request was NOT fulfilled", so replaying it is write-safe for ANY ForwardClass — the
 * proxy ABSORBS it (drain → wait Retry-After → retry) so the agent just waits a beat instead
 * of seeing a spurious error, exactly like the refused-restart window. Bounded by BOTH the
 * retry window and a max count so a persistently-critical operator eventually surfaces the
 * 429 rather than hanging the client past its own timeout. Kill-switch:
 * PAPERCUSP_MCP_PROXY_ABSORB_429=0 (forwards the 429 straight through, pre-P-010 behavior).
 */
export const MAX_BACKPRESSURE_RETRIES = 20;
/** Clamp for a Retry-After wait so a missing/hostile header value can't wedge the proxy loop. */
const MAX_BACKPRESSURE_WAIT_MS = 3000;
/**
 * EI-16883 — boot-window status absorption. During a :3070 restart there is a window where
 * the socket ACCEPTS but the route table is not yet mounted: /api/mcp answers 404/405 (and
 * a booting worker can shed 503 before admission control is up). Like a 429, these statuses
 * mean the tool handler NEVER dispatched — the request was not fulfilled — so replaying is
 * write-safe for ANY ForwardClass. Measured 2026-07-19: 1,395 boot-window 405s passed
 * through to clients in 48h; each marks the MCP server "failed" in its Claude Code session,
 * drops + re-adds the tool catalog, and full-invalidates that session's prompt cache (the
 * dominant slice of the fleet's cache-write bill). Absorbed exactly like 429s — bounded by
 * the same retry window + max count, then surfaced honestly. Kill-switch:
 * PAPERCUSP_MCP_PROXY_ABSORB_BOOT=0. Cost: a GENUINE malformed-path 404/405 now surfaces
 * after the window instead of instantly — acceptable; well-formed clients never see these
 * statuses in steady state.
 */
export const BOOT_WINDOW_STATUSES: ReadonlySet<number> = new Set([404, 405, 503]);
/** Above this serialized size we do NOT rewrite the body to inject a key: re-stringifying a
 *  pathologically large tools/call would block the proxy loop, and that call is exactly the
 *  one we must not block on. Forgoing its key only drops it to 'opaque' (refused-only). */
const INJECT_MAX_BODY_BYTES = 256 * 1024;
/** Mirrors the server's validIdempotencyKey bound (_mcp-result-replay.ts KEY_MAX=200) so a
 *  client-supplied key we "respect" is one :3070 will actually honor for replay. */
const IDEM_KEY_MAX = 200;

function isValidIdemKey(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= IDEM_KEY_MAX;
}

/** How a forwarded request may be retried AFTER the socket connected:
 *  - 'idempotent' — no tools/call present → replaying has no side effect, always safe.
 *  - 'readonly'   — every tools/call names a READ_ONLY_TOOLS verb → a replay re-executes a
 *                   side-effect-free call, so it can never double-apply (EI-21268234394605529).
 *  - 'keyed'      — every tools/call carries a valid idempotencyKey → a replay dedups
 *                   server-side instead of double-applying the write.
 *  - 'opaque'     — a tools/call with no usable key → NEVER replay (write-safety default). */
export type ForwardClass = 'idempotent' | 'readonly' | 'keyed' | 'opaque';

export interface PreparedForward {
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  klass: ForwardClass;
}

/**
 * EI-21268234394605529 — verbs whose handler is PROVABLY side-effect-free, eligible for a
 * bounded post-connect socket-error replay ('readonly' class). CURATED ON PURPOSE: this
 * proxy is a dependency-free passthrough (node:http/node:crypto only), so it must not import
 * the tool catalog to derive effects. The safe failure direction is omission — a read
 * missing from this set keeps today's exact 'keyed' behavior, while a WRITE wrongly added
 * here could be silently double-applied on a replay. The writer-exclusion guard test in
 * proxy.test.ts pins known mutators OUT; when adding a name here, verify its handler
 * performs no writes (no PG mutations, no fs writes outside tmp, no external sends).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // build/type diagnostics (the reported failure: scoped tsc runs are pure reads)
  'build:typecheck',
  // dev observability reads
  'dev:pipeline_position', 'dev:pg_query', 'dev:service_health', 'dev:listening_ports',
  'dev:build_status', 'dev:migrations', 'dev:rate_governor_status',
  // documentation + search reads
  'docs:get', 'docs:search', 'docs:outline', 'search:fulltext', 'search:semantic',
  // memory recall (search ONLY — remember/forget mutate the store)
  'memory:search',
  // work-item / plan reads
  'work_items:list', 'work_items:get', 'work_items:claimable',
  'plans:get', 'plans:list', 'plans:items',
  // test-run history
  'testing:runs',
  // harness / fleet status snapshots
  'harness:list', 'harness:status', 'harness:get',
  'fleet:assignments', 'fleet:status',
  // coordination/state reads (presence/glance are pure snapshots;
  // coord:inbox EXCLUDED — reading marks messages read)
  'coord:presence', 'coord:glance',
  'events:catalog', 'facts:list', 'state:read',
  'locks:list', 'locks:queue',
  // capability discovery (find ONLY — tools:invoke EXECUTES arbitrary tools)
  'tools:find',
]);

function isReadOnlyToolCall(m: unknown): boolean {
  if (!m || typeof m !== 'object') return false;
  const params = (m as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return false;
  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' && READ_ONLY_TOOLS.has(name);
}
/**
 * Classify a forward and, for a tools/call, inject a per-request `_meta.idempotencyKey`
 * so a post-connect retry is write-safe (:3070 replays the stored result). PURE +
 * unit-tested; `genKey` is injected for determinism. A VALID client-supplied key is
 * respected (never overwritten); an INVALID one (the server would ignore it) drops the
 * whole request to 'opaque'. Only a POST JSON body can carry a tools/call.
 *
 * EI-21268234394605529: a batch whose every tools/call names a READ_ONLY_TOOLS verb
 * classifies 'readonly' BEFORE any key logic — replay safety comes from the tool's own
 * side-effect freedom, not stored-result dedup, so keys are neither needed nor injected
 * and the body is returned untouched.
 */
export function prepareForward(
  method: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  opts: { keyingEnabled: boolean; readonlyRetryEnabled?: boolean; genKey: () => string },
): PreparedForward {
  if (method !== 'POST' || body.length === 0) return { body, headers, klass: 'opaque' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, headers, klass: 'opaque' }; // non-JSON — cannot classify → safe default
  }
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  const isCall = (m: unknown): m is { method?: unknown; params?: Record<string, unknown> } =>
    !!m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call';
  const calls = msgs.filter(isCall);
  if (calls.length === 0) return { body, headers, klass: 'idempotent' }; // no write → free safe retry

  if (!opts.keyingEnabled) return { body, headers, klass: 'opaque' }; // kill-switch → refused-only
  if (body.length > INJECT_MAX_BODY_BYTES) return { body, headers, klass: 'opaque' };
  // EI-21268234394605529: a provably read-only tools/call may be replayed on a post-connect
  // socket error (re-executing a read cannot double-apply). Gated behind BOTH switches: the
  // keying master switch above (PAPERCUSP_MCP_PROXY_KEYED_RETRY=0 = pre-P-005 refused-only)
  // and its own PAPERCUSP_MCP_PROXY_READONLY_RETRY=0. Unknown / oversized / switched-off
  // bodies fall through to the existing keyed/opaque path unchanged.
  if (opts.readonlyRetryEnabled !== false && calls.every(isReadOnlyToolCall)) {
    return { body, headers, klass: 'readonly' }; // body untouched — no key injection needed
  }

  let mutated = false;
  for (const m of calls) {
    const params =
      m.params && typeof m.params === 'object' ? m.params : (m.params = {} as Record<string, unknown>);
    const meta =
      params._meta && typeof params._meta === 'object' ? (params._meta as Record<string, unknown>) : {};
    if (isValidIdemKey(meta.idempotencyKey)) continue; // respect a valid client key
    if (meta.idempotencyKey !== undefined) return { body, headers, klass: 'opaque' }; // invalid client key → can't safely retry
    meta.idempotencyKey = opts.genKey();
    params._meta = meta;
    m.params = params;
    mutated = true;
  }
  if (!mutated) return { body, headers, klass: 'keyed' }; // already client-keyed, body unchanged
  const newBody = Buffer.from(JSON.stringify(parsed), 'utf8');
  const newHeaders: http.IncomingHttpHeaders = { ...headers, 'content-length': String(newBody.length) };
  delete newHeaders['transfer-encoding'];
  return { body: newBody, headers: newHeaders, klass: 'keyed' };
}

/**
 * Post-connect retry decision (PURE + unit-tested): only a write-free request may be
 * replayed — the 'idempotent' control-plane class, or EI-21268234394605529's 'readonly'
 * class (every tools/call names a READ_ONLY_TOOLS verb, so re-execution cannot double-apply).
 * A keyed tools/call remains recoverable only AFTER its first execution stores a result; an
 * immediate retry can overlap that still-running call and double-apply the mutation.
 */
export function postConnectRetryable(
  klass: ForwardClass,
  retriesUsed: number,
  maxRetries: number,
  elapsedMs: number,
  windowMs: number,
): boolean {
  if (klass !== 'idempotent' && klass !== 'readonly') return false;
  if (retriesUsed >= maxRetries) return false;
  return elapsedMs < windowMs;
}

/**
 * WI-6740 — upstream SILENCE, the one failure class the retry ladder above did not cover.
 *
 * Every branch so far reacts to an upstream ERROR: refused (pre-connect), a socket reset
 * (post-connect), a 429, a boot-window status. But when :3070 ACCEPTS the connection and
 * then simply stops responding, nothing fails from the proxy's point of view — so no retry
 * path is ever entered. `forwardOnce` had no timeout, so the proxy waited indefinitely and
 * the CLIENT's own (shorter) timeout fired first.
 *
 * That is session-fatal, not a blip. An MCP client fetches the tool catalog ONCE, at
 * connect, so a ~10s stall landing on that handshake costs a MULTI-HOUR agent session its
 * entire tool plane ("Reconnected … but fetching tools failed: Request timed out", then
 * zero papercusp tools for the rest of its life). ~/.papercusp/mcp-proxy-watchdog.log
 * recorded 269 such stalls between 2026-07-10 and 2026-08-01, EVERY one followed by
 * `recovered (was unreachable 10s)` — which reads as benign self-healing at the watchdog's
 * layer and is why this went unfixed for three weeks. The severity is invisible to the
 * layer that observes it.
 *
 * Bound ONLY the 'idempotent' class — a batch containing NO tools/call, i.e. exactly the
 * control-plane handshake (initialize / tools/list / ping / resources / prompts). Those are
 * cheap catalog reads: one taking >8s is definitionally stalled, and replaying them is
 * free (no writes). A real tools/call MUST stay unbounded — `build:typecheck` legitimately
 * runs ~160s and `capability:bash` ~120s on this box, so a blanket upstream timeout would
 * convert working long tools into hard failures. That asymmetry is the whole design.
 */
export const HANDSHAKE_UPSTREAM_TIMEOUT_MS = Number(
  process.env.PAPERCUSP_MCP_PROXY_HANDSHAKE_TIMEOUT_MS ?? 8_000,
);

/** Handshake-timeout replays allowed per request (→ up to 3 attempts ≈ 25s worst case,
 *  comfortably inside a typical ~30s client budget). Deliberately SEPARATE from
 *  MAX_POST_CONNECT_RETRIES: that bound exists because a socket error may have already
 *  applied a side effect, which cannot happen for a write-free idempotent batch. */
export const MAX_HANDSHAKE_TIMEOUT_RETRIES = 2;

/**
 * Whether an upstream-silence timeout should be replayed (PURE + unit-tested). Only the
 * write-free 'idempotent' control-plane class qualifies: any tools/call — including
 * 'readonly' (EI-21268234394605529), whose members legitimately run minutes
 * (`build:typecheck` ~160s) — stays on the generous maxHoldMs ceiling, never this 8s
 * handshake bound, and surfaces honestly instead of being replayed blind.
 */
export function handshakeTimeoutRetryable(
  klass: ForwardClass,
  retriesUsed: number,
  maxRetries: number,
  elapsedMs: number,
  windowMs: number,
): boolean {
  if (klass !== 'idempotent') return false;
  if (retriesUsed >= maxRetries) return false;
  return elapsedMs < windowMs;
}

/**
 * Whether an upstream STATUS is transient admission-control backpressure the proxy should
 * ABSORB (retry) rather than forward to the agent. Only 429 (P-010): HTTP defines 429 as
 * "not fulfilled", so a retry never double-applies — safe regardless of ForwardClass, unlike
 * a post-connect socket error whose side effect is unknown. PURE + unit-tested.
 */
export function isBackpressureStatus(status: number): boolean {
  return status === 429;
}

/** Bounded backpressure-retry decision (PURE + unit-tested): keep absorbing a 429 while
 *  under both the per-request max count and the retry window. */
export function backpressureRetryable(
  retriesUsed: number,
  maxRetries: number,
  elapsedMs: number,
  windowMs: number,
): boolean {
  return retriesUsed < maxRetries && elapsedMs < windowMs;
}

/**
 * Parse a `Retry-After` DELTA-SECONDS header into ms, clamped to [0, maxMs] with a fallback
 * when the header is absent/invalid — so a missing value still backs off and a hostile huge
 * value can't wedge the proxy loop. (We only emit delta-seconds server-side, so HTTP-date
 * forms aren't parsed.) PURE + unit-tested.
 */
export function retryAfterMs(
  header: string | string[] | undefined,
  fallbackMs: number,
  maxMs: number,
): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const secs = raw != null && raw !== '' ? Number(raw) : NaN;
  const ms = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : fallbackMs;
  return Math.max(0, Math.min(ms, maxMs));
}

interface ForwardOutcome {
  /** The upstream response, when one was received. */
  ures?: http.IncomingMessage;
  /** The error, when the forward failed. */
  err?: NodeJS.ErrnoException;
  /** Whether the TCP socket connected before the error (gates retry safety). */
  connected: boolean;
  /** WI-6740: the attempt was abandoned because upstream went SILENT past `timeoutMs`,
   *  as opposed to actively failing. Distinguished so the caller can apply the
   *  idempotent-only replay rule instead of the socket-error one. */
  timedOut?: boolean;
}

/** One forward attempt. Resolves with the upstream response OR an error + whether the
 *  socket had connected (so the caller can decide retry-safety). Never rejects.
 *  `timeoutMs` (WI-6740) bounds how long we wait for RESPONSE HEADERS; 0/undefined =
 *  unbounded, which is what every real tools/call still uses.
 *
 *  `signal` (WI-35737) lets the caller abandon an attempt whose CLIENT has gone away, so the
 *  proxy stops spending upstream capacity producing a response nobody can read. The caller
 *  passes one ONLY for the write-free 'idempotent' class — aborting a keyed/opaque tools/call
 *  mid-flight could leave a write half-applied, which is the same retry-safety rule
 *  `handshakeTimeoutRetryable` already enforces. Abort surfaces through the existing
 *  `upstream.on('error')` path as an ordinary failed attempt; the caller then sees
 *  `clientGone` and breaks instead of replaying. */
function forwardOnce(
  opts: McpProxyOptions,
  method: string,
  reqUrl: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  agent: http.Agent,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ForwardOutcome> {
  return new Promise((resolve) => {
    let target: McpProxyTarget;
    try {
      target = resolveTarget(opts);
    } catch (err) {
      resolve({ err: err as NodeJS.ErrnoException, connected: false });
      return;
    }
    let connected = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (o: ForwardOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(o);
    };
    const forwardedHeaders = stripClientConnectionHeader(
      injectCurrentSuperuserBearer(reqUrl, headers, {
        tokenPath: opts.superuserTokenPath,
        readToken: opts.readSuperuserToken,
      }),
    );
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method,
        path: reqUrl,
        // WI-41045: this is deliberately inside forwardOnce, not outside the
        // retry loop. A token can rotate between a reset and its replay.
        headers: {
          ...forwardedHeaders,
          host: `${target.host}:${target.port}`,
        },
        // W1.3: fresh socket per forward — never reuse a pooled keep-alive socket the :3070
        // cluster may be closing (the ~13% spurious-400 root cause). See UPSTREAM_AGENT above.
        agent,
        // WI-35737: abandon this attempt if the client disconnects (idempotent class only —
        // see the doc comment above). Node destroys the request and emits 'error' with
        // code ABORT_ERR, which the existing handler below turns into a normal outcome.
        signal,
      },
      (ures) => done({ ures, connected: true }),
    );
    upstream.on('socket', (s) => {
      // Once the TCP handshake completes, the request is (or may be) in flight at :3070.
      // A reused keep-alive socket is ALREADY connected — return without adding a
      // 'connect' listener (one per proxied request accumulated on the shared socket:
      // the MaxListenersExceededWarning in the unit journal, mcp-outage-triage-2026-07-02).
      if (s.connecting === false) {
        connected = true;
        return;
      }
      s.once('connect', () => {
        connected = true;
      });
    });
    upstream.on('error', (err: NodeJS.ErrnoException) => done({ err, connected }));
    // WI-6740: bound the wait for RESPONSE HEADERS. Note this is deliberately NOT
    // `upstream.setTimeout` (socket INACTIVITY): a stalled :3070 can keep the socket alive
    // while producing nothing, which inactivity never fires on. We want wall-clock silence.
    // `connected: true` is asserted so this can never be mistaken for a refused upstream
    // (which would be replayed unconditionally); the caller gates it on the idempotent class.
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        const err: NodeJS.ErrnoException = Object.assign(
          new Error(`upstream silent for ${timeoutMs}ms (no response headers)`),
          { code: 'ETIMEDOUT' },
        );
        upstream.destroy();
        done({ err, connected: true, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
    }
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

/**
 * EI-19294517824914302 — a CHEAP REPEATING BEAT must not inherit the restart-sized retry
 * window. This is the single highest-volume failure path on the box, and the cause is a
 * classifier gap, not a bug in either layer on its own.
 *
 * `prepareForward` classifies by MCP BATCH SHAPE: a POST whose JSON body contains no
 * `tools/call` is 'idempotent' (proxy.ts's `calls.length === 0` branch). That rule was
 * written for the MCP control-plane handshake — initialize / tools/list / ping — where a
 * long retry window is exactly right: a client fetches the tool catalog ONCE per session,
 * so losing that one request costs a multi-hour agent its whole tool plane (WI-6740).
 *
 * But a plain REST beat like bootstrap-su/heartbeat is not an MCP batch at all. It has no
 * `tools/call`, so it falls through the same branch and silently inherits a budget sized to
 * outlast a full :3070 restart. Its own handler deliberately returns a SOFT 503 —
 * "the launcher treats any failure as a missed beat, never an error loop"
 * (routes/agent-mcp/bootstrap-su.ts) — and the proxy, which cannot see that intent, turns
 * that one shrug into ~30 attempts over 27-42s.
 *
 * MEASURED 2026-08-01: 13,330 of 13,754 proxy failures in 90 minutes were this ONE path
 * (97%), with SUCCESSES recording `attempts:30, elapsedMs:42361`. With ~140 agents beating
 * every ~60s, transient upstream slowness is multiplied ~30x on the hottest path in the
 * system, which sustains the slowness that caused it — a textbook metastable retry storm.
 *
 * The asymmetry is the whole point, and it mirrors WI-6740's: retry the ONE-SHOT handshake
 * generously (losing it is session-fatal, replaying is free), but retry a beat that repeats
 * every ~60s barely at all (the next one is already on its way, and replaying it is what
 * causes the storm). Fix at the CLASSIFIER — never by making the endpoint lie about its
 * status code.
 *
 * ⚠ WI-35737 (2026-08-08) — membership is a PROPERTY ("high-frequency + soft failure +
 * replacement already scheduled"), not a fixed roster. The canonical list is shared with the
 * health reader in operator-core so retry and alarm classification cannot drift.
 *
 * The recurrence: `/api/agent-mcp/mid-turn-context` is the per-tool-batch memory-injection
 * search — simultaneously the most EXPENSIVE endpoint on the box (`searchMs` p50 1000ms,
 * p90 1364ms, max 4954ms over 522 samples) and one of the highest-frequency (every tool
 * batch, every agent). It carries no `tools/call`, so it took the 'idempotent' branch and
 * inherited the restart-sized window PLUS up to `MAX_HANDSHAKE_TIMEOUT_RETRIES` replays.
 *
 * MEASURED 2026-08-08 16:00-18:12Z, while :3070's data plane was intermittently stalling on
 * `withWorkspace:acquire(app)` (EI-19485014132257783 — the ROOT cause, not this file's):
 *   - handshake_timeout_retry: 385 of 540 (71%) were this ONE path
 *   - post_connect_retry:      175 of 245 (71%) were this ONE path
 *   - every `upstream_error` was `upstream silent for 8000ms (no response headers)`
 * Each replay re-runs that multi-second search against the upstream that is already failing
 * (`recovered after 2 attempts (12623ms)` is the SUCCESS case — it still cost two searches),
 * so the proxy multiplied load ~4x onto the exact dependency that was struggling and turned
 * a bursty upstream stall into a fleet-wide 429 outage. Same storm, same classifier, new path.
 *
 * The memory-injection paths satisfy the property: losing one is SOFT (the agent's turn simply
 * carries no memory-injection block — `injection.ts` degrades, it does not fail), and the
 * replacement is already scheduled (the next tool batch / the next turn).
 *
 * The canonical path list and predicate now live in operator-core and are shared with the
 * system-health reader. Keeping one classifier prevents a path from receiving the cheap-beat
 * retry budget while still being counted as a hard failure by health (EI-21304678711668996).
 */

/** Retry budget for a cheap repeating beat: one prompt re-attempt, then give up and let the
 *  NEXT beat carry the liveness signal. Deliberately far below `retryWindowMs`. */
export const CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS = 2000;

/** The retry window this REQUEST gets — the restart-sized default, unless it is a cheap
 *  repeating beat, which must fail fast rather than amplify (EI-19294517824914302). */
export function effectiveRetryWindowMs(url: string, windowMs: number): number {
  return isCheapRepeatingBeat(url) ? Math.min(CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS, windowMs) : windowMs;
}

/**
 * EI-19305299022434394 — the admission-control ceiling on TOTAL concurrent forwards this proxy
 * instance will hold at once, independent of `DEFAULT_MAX_UPSTREAM_SOCKETS` (which bounds
 * upstream TCP connections). Deliberately well ABOVE the socket bound so ordinary agent-count
 * queuing behind a busy-but-healthy upstream is never shed — this ceiling exists to catch the
 * genuinely runaway case (thousands held open) that the socket bound alone would still allow to
 * pile up in the agent's internal pending-request queue rather than being surfaced to a caller
 * at all.
 */
export const DEFAULT_MAX_IN_FLIGHT = Number(process.env.PAPERCUSP_MCP_PROXY_MAX_IN_FLIGHT ?? 200);
export const DEFAULT_CONTROL_PLANE_RESERVE = Number(process.env.PAPERCUSP_MCP_PROXY_CONTROL_PLANE_RESERVE ?? 8);
/**
 * EI-19305299022434394 — see `McpProxyOptions.maxHoldMs`. 10 minutes is comfortably above any
 * legitimate tool's real runtime (`build:typecheck` ~160s, `capability:bash` ~120s) while still
 * cutting off the 32-89 minute silent parks the report measured.
 */
export const DEFAULT_MAX_HOLD_MS = Number(process.env.PAPERCUSP_MCP_PROXY_MAX_HOLD_MS ?? 10 * 60_000);
/** EI-19305299022434394 — see `McpProxyOptions.heartbeatIntervalMs`. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = Number(process.env.PAPERCUSP_MCP_PROXY_HEARTBEAT_MS ?? 30_000);

/**
 * Whether a NEW request should be shed (429, before opening any upstream socket) given how many
 * forwards are already in flight. PURE + unit-tested. `maxInFlight <= 0` disables shedding
 * entirely (unbounded, the pre-fix behavior) — an explicit opt-out, never the default.
 */
export function shouldShedForInFlight(currentInFlight: number, maxInFlight: number): boolean {
  if (maxInFlight <= 0) return false;
  return currentInFlight >= maxInFlight;
}

const RESERVED_CONTROL_PLANE_TOOLS = new Set([
  'scheduler:get_next',
  'coord:orient',
  'coord:send',
  'loop:checkpoint',
  'session:request-compaction',
  'tools:find',
  'dev:service_health',
  'dev:pg_query',
  'loop:arm',
  'improvements:capture',
  'locks:acquire',
  'locks:queue',
  'locks:cancel_wait',
  'locks:release',
  'events:cancel',
  'work_items:checkpoint',
  'work_items:complete',
  'work_items:get',
  'work_items:release',
].map(normalizeMcpName));

// EI-21266423740643882 — the watchdog's session-plane probe is a plain JSON-RPC
// `tools/list`, not a tools/call named by RESERVED_CONTROL_PLANE_TOOLS. The admission reserve
// is useless to the probe that diagnoses a saturated proxy unless the MCP handshake itself is
// recognized. Keep this deliberately narrow: only the stateless, write-free calls required to
// establish/prove a session, not every idempotent resources/prompts request.
const RESERVED_CONTROL_PLANE_METHODS = new Set(['initialize', 'ping', 'tools/list']);
const TOOLS_INVOKE_NAME = normalizeMcpName('tools:invoke');

// psu launch/resume preflight uses plain REST rather than JSON-RPC. These calls
// are the human/fleet entry point and must retain access to the reserve while
// ordinary tool traffic is saturated. Heartbeat is intentionally absent: it is
// a cheap repeating beat and should fail fast rather than consume a reserved slot.
export const RESERVED_CONTROL_PLANE_PATHS = new Set([
  '/api/adv/sessions/resumable',
  '/api/agent-mcp/console/bootstrap-su/options',
  '/api/agent-mcp/console/bootstrap-su',
]);

/** Match a REST control-plane path without letting query strings or a harmless
 * trailing slash defeat the reserve classification. */
export function isReservedControlPlanePath(requestPath: unknown): boolean {
  if (typeof requestPath !== 'string') return false;
  const path = requestPath.split('?')[0]?.replace(/\/+$/, '') || '/';
  return RESERVED_CONTROL_PLANE_PATHS.has(path);
}

/** Fleet bootstrap, direct coordination delivery, continuation checkpoints, scheduler claims,
 * deferred tool discovery, bounded diagnostics, loop arming, incident capture, file-lock inspection,
 * file-lock cancellation/release, and continuation checkpoint writes are liveness/control-plane traffic:
 * if they cannot run, workers cannot orient, wake a blocker, persist a safe wake boundary, drain
 * the queue generating proxy load, recover a missing tool surface, keep themselves alive, file
 * the failure that needs fixing, inspect lock ownership, release a lock held during an edit,
 * or preserve the successor state needed to resume after a task boundary, cancel an event wait,
 * acquire/release a file lock around an edit, inspect a
 * work-item during recovery, release a claim during recovery, diagnose a service outage, or finish a work-item when
 * ordinary traffic has saturated the proxy. The MCP
 * client may send a canonical colon-form name or its `mcp__<server>__group_verb` advertisement
 * name; both are normalized through the shared tooldef helper before this narrow membership check.
 * Keep the reserved set deliberately narrow. `requestPath` covers the small
 * plain-REST bootstrap surface that cannot identify itself in a JSON-RPC body. */
export function isReservedControlPlaneCall(rawBody: Buffer, requestPath?: string): boolean {
  if (isReservedControlPlanePath(requestPath)) return true;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    // JSON-RPC permits a request body to contain a batch. Reserve the whole forward when
    // any member is a control-plane call: one HTTP request consumes one admission slot, and
    // hiding a scheduler/orientation call inside a batch must not make it compete with ordinary
    // traffic for the non-reserved ceiling.
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some((message) => {
      if (!message || typeof message !== 'object') return false;
      const call = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
      if (typeof call.method !== 'string') return false;
      if (RESERVED_CONTROL_PLANE_METHODS.has(call.method)) return true;
      if (call.method !== 'tools/call' || typeof call.params?.name !== 'string') return false;
      const calledTool = normalizeMcpName(call.params.name);
      if (RESERVED_CONTROL_PLANE_TOOLS.has(calledTool)) return true;
      if (calledTool !== TOOLS_INVOKE_NAME) return false;
      const invokeArgs = call.params.arguments;
      if (!invokeArgs || typeof invokeArgs !== 'object' || Array.isArray(invokeArgs)) return false;
      const target = (invokeArgs as { name?: unknown }).name;
      return typeof target === 'string' && RESERVED_CONTROL_PLANE_TOOLS.has(normalizeMcpName(target));
    });
  } catch {
    return false;
  }
}

/** Build the proxy HTTP server (does NOT listen — caller invokes .listen, or use
 *  startMcpProxy). Exposed for tests (drive it against a stub upstream). */
export function createMcpProxy(opts: McpProxyOptions): http.Server {
  const log = opts.log ?? ((s: string) => console.log(`[mcp-proxy] ${s}`));
  const backoff = opts.retryBackoffMs ?? 500;
  // P-006 (mcp-reliability-hardening-2026-07-11): instance-tag every failure record with
  // pid + listenPort + the resolved target, so a forensic read of the shared ledger can
  // attribute a failure to a SPECIFIC proxy instance (multiple instances / a restart across
  // the same ledger were previously indistinguishable — every record looked identical).
  const record = (rec: Record<string, unknown>): void => {
    let target: string | undefined;
    try {
      const t = resolveTarget(opts);
      target = `${t.host}:${t.port}`;
    } catch {
      /* target unresolved (misconfig / operator.json missing) — omit rather than throw */
    }
    recordProxyFailure({ pid: process.pid, listenPort: opts.listenPort, target, ...rec });
  };

  // EI-19305299022434394 — admission control + visibility state for THIS proxy instance.
  // `inFlightStarts` maps a per-request sequence id to its start time so the heartbeat can
  // report how long the OLDEST outstanding forward has been held, not just a bare count.
  const maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  // An explicitly injected max is predominantly a test/embedding contract; preserve its old
  // all-purpose semantics unless that caller also explicitly asks for a reserve.
  const controlPlaneReserve = Math.max(
    0,
    opts.controlPlaneReserve ?? (opts.maxInFlight === undefined ? DEFAULT_CONTROL_PLANE_RESERVE : 0),
  );
  const upstreamAgent = opts.upstreamAgent ?? UPSTREAM_AGENT;
  // Admission-only reservation is not end-to-end reservation: during the measured incident all
  // 64 ordinary sockets were occupied and even an admitted watchdog tools/list would have queued
  // behind them. A distinct pool gives the reserved slots real upstream capacity. Keep the pool
  // instance-local so its maxSockets follows an injected/env reserve; destroy only agents we own.
  const ownsControlPlaneAgent = opts.controlPlaneAgent === undefined;
  const controlPlaneAgent = opts.controlPlaneAgent ?? new http.Agent({
    keepAlive: false,
    maxSockets: Math.max(1, controlPlaneReserve),
  });
  const maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const inFlightStarts = new Map<number, number>();
  let nextInFlightId = 0;

  // Half 2 of EI-19305299022434394: the proxy previously logged ONLY on completion/error, so a
  // stalled upstream that never completes anything produced total silence (106 minutes with zero
  // log lines during the measured outage) — indistinguishable from an idle proxy.
  //
  // EI-19388661789704364: the ORIGINAL shape here was a single global `setInterval` that sampled
  // `inFlightStarts.size` on a fixed 30s cadence and only logged/recorded when that ONE instant
  // landed on a nonzero count. Measured live: zero `heartbeat` records across a 27MB / 30h+ ledger,
  // despite `shed_max_in_flight` proving the proxy DID hit its concurrency ceiling repeatedly — the
  // real traffic here is bursts of requests that each complete in milliseconds, so a 30s-aligned
  // sample essentially never coincides with one being outstanding. The exact case the heartbeat was
  // built for (one genuinely long-held/stalled forward) was therefore left to chance alignment
  // instead of being detected deterministically.
  //
  // Fixed by moving from a SAMPLED aggregate tick to a per-request THRESHOLD timer: the instant a
  // forward starts, schedule a check `heartbeatIntervalMs` out; if that SPECIFIC request is still
  // outstanding when the timer fires, it is — by construction — a real long hold (not a fast burst
  // that happened to be in flight at a sample instant), so it beats, then reschedules itself for as
  // long as the request remains open. This fires deterministically for any forward held at least
  // `heartbeatIntervalMs`, with no dependency on how many other requests are in flight or when.
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (heartbeatIntervalMs > 0) {
    // Deliberately does NOT contain the word "heartbeat" — that word marks a real per-request
    // beat event (tests and any production log-grep for `heartbeat` key off it), and this is a
    // one-time startup line, not a beat. EI-19388661789704364 asked for exactly this: a resolved
    // value logged at start so "is it armed at all" is never itself a guess.
    log(`in-flight stall watch armed: checkAfterMs=${heartbeatIntervalMs}`);
  }
  const stallTimers = new Map<number, NodeJS.Timeout>();
  function scheduleStallCheck(inFlightId: number, startedAt: number): void {
    if (heartbeatIntervalMs <= 0) return;
    const timer = setTimeout(() => {
      // The request may have completed (and cleared its slot) in the gap before this fired —
      // that is the common case and not a stall, so say nothing.
      if (!inFlightStarts.has(inFlightId)) return;
      const oldestAgeMs = Date.now() - startedAt;
      const count = inFlightStarts.size;
      log(`heartbeat: request #${inFlightId} held ${Math.round(oldestAgeMs / 1000)}s, ${count} in flight total`);
      record({ kind: 'heartbeat', inFlight: count, oldestAgeMs, maxInFlight, inFlightId });
      scheduleStallCheck(inFlightId, startedAt); // still outstanding — keep beating until it isn't
    }, heartbeatIntervalMs);
    timer.unref?.();
    stallTimers.set(inFlightId, timer);
  }

  // WI-41257 — inbound observability. The proxy already recorded failures it observed while
  // forwarding to :3070, but it had no signal for failures on its own client-facing socket. Node
  // exposes parser/socket failures through `clientError` and admission drops through `drop`; keep
  // those events separate from upstream failures so an operator can tell "the proxy could not
  // accept me" from ":3070 was unavailable". These counters are deliberately instance-local and
  // are also exposed by the proxy-local health route as a bounded snapshot.
  const inbound = {
    accepted: 0,
    active: 0,
    clientErrors: 0,
    socketResets: 0,
    drops: 0,
  };
  const resetSockets = new WeakSet<object>();
  const inboundSnapshot = (): typeof inbound => ({ ...inbound });
  const isSocketResetError = (error: Error): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ECONNRESET' || code === 'EPIPE' || /(?:socket|connection).*(?:reset|hang up)/i.test(error.message);
  };
  const socketDetails = (socket: object): Record<string, unknown> => {
    const peer = socket as {
      remoteAddress?: string;
      remotePort?: number;
      remoteFamily?: string;
    };
    return {
      remoteAddress: peer.remoteAddress,
      remotePort: peer.remotePort,
      remoteFamily: peer.remoteFamily,
    };
  };
  const recordInboundSocketReset = (socket: object | undefined, source: string): void => {
    if (socket && resetSockets.has(socket)) return;
    if (socket) resetSockets.add(socket);
    inbound.socketResets++;
    log(`inbound socket reset (${source})`);
    record({
      kind: 'inbound_socket_reset',
      event: source,
      socketResets: inbound.socketResets,
      ...(socket ? socketDetails(socket) : {}),
    });
  };
  const recordInboundClientError = (error: Error, socket: object): void => {
    inbound.clientErrors++;
    const socketReset = isSocketResetError(error);
    if (socketReset) {
      recordInboundSocketReset(socket, 'clientError');
    }
    const errorCode = (error as NodeJS.ErrnoException).code;
    const message = error.message || String(error);
    log(`inbound client error${socketReset ? ' / socket reset' : ''}: ${message}`);
    record({
      kind: 'inbound_client_error',
      event: 'clientError',
      errorCode,
      detail: message,
      socketReset,
      clientErrors: inbound.clientErrors,
      ...socketDetails(socket),
    });
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === MCP_PROXY_LOCAL_HEALTH_PATH) {
      let target: McpProxyTarget | null = null;
      try {
        target = resolveTarget(opts);
      } catch {
        target = null;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, target, inbound: inboundSnapshot() }));
      return;
    }
    // WI-35737 — CLIENT-DISCONNECT TRACKING. Before this, the proxy had no client-side
    // liveness signal at all (the only `req` listeners were the three below, all about
    // accumulating the request BODY), so a client that gave up — its own timeout fired, its
    // agent session died, the watchdog restarted it — bought nothing: the retry loop kept
    // replaying against upstream for a response with nowhere to go.
    //
    // ⚠ This is NOT a slot leak, and an earlier diagnosis on WI-35737 that said so was wrong
    // (withdrawn in comment 56302). The in-flight slot is released at RESPONSE-HEADER time —
    // the `return` after `ures.pipe(res)` below sits INSIDE the `try`, so the `finally` runs
    // while the SSE body is still streaming. Measured: across 2,305 heartbeat records the
    // max hold was 120,004ms against a 600,000ms `maxHoldMs`, i.e. the cap was never
    // approached. What this DOES cut is AMPLIFICATION: work spent on a dead client during
    // exactly the upstream-stall windows when capacity is scarcest.
    let clientGone = false;
    let abortAttempt: (() => void) | null = null;
    const noteClientGone = (source: 'response_close' | 'request_aborted'): void => {
      // 'close' also fires on NORMAL completion — `writableFinished` is what separates "the
      // response was fully sent" from "the peer vanished mid-flight". Without this guard
      // every successful request would mark itself aborted.
      if (clientGone || res.writableFinished) return;
      clientGone = true;
      recordInboundSocketReset(req.socket, source);
      abortAttempt?.();
    };
    res.on('close', () => noteClientGone('response_close'));
    req.on('aborted', () => noteClientGone('request_aborted'));
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', (error) => {
      if (isSocketResetError(error)) {
        recordInboundSocketReset(req.socket, 'request_error');
      } else {
        inbound.clientErrors++;
        log(`inbound client error (request): ${error.message || String(error)}`);
        record({
          kind: 'inbound_client_error',
          event: 'request_error',
          detail: error.message || String(error),
          clientErrors: inbound.clientErrors,
          ...socketDetails(req.socket),
        });
      }
      try {
        res.writeHead(400);
        res.end();
      } catch {
        /* client already gone */
      }
    });
    req.on('end', () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks);
        // EI-19305299022434394 — admission control, checked BEFORE any upstream socket is
        // opened (and before we even bother classifying the forward). A request that arrives
        // while `maxInFlight` forwards are already outstanding is shed immediately with 429 +
        // Retry-After instead of being allowed to pile onto an already-struggling upstream —
        // this is what stops the congestion-collapse feedback loop the unbounded agent used to
        // create (3,450 simultaneous held requests, measured 2026-08-01).
        const inFlightNow = inFlightStarts.size;
        const reservedControlPlane = isReservedControlPlaneCall(rawBody, req.url);
        const admissionCeiling = reservedControlPlane
          ? maxInFlight
          : maxInFlight > 0
            ? Math.max(1, maxInFlight - controlPlaneReserve)
            : maxInFlight;
        if (shouldShedForInFlight(inFlightNow, admissionCeiling)) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
          res.end(
            JSON.stringify({
              error: 'mcp_proxy_overloaded',
              detail: `proxy already has ${inFlightNow} request(s) in flight (admission max ${admissionCeiling}, hard max ${maxInFlight}) — shed before forwarding`,
              retryAfterSec: 2,
            }),
          );
          log(`shed request — ${inFlightNow} already in flight (max ${maxInFlight})`);
          record({ kind: 'shed_max_in_flight', method: req.method, path: req.url, inFlight: inFlightNow, maxInFlight, admissionCeiling, reservedControlPlane });
          return;
        }
        const inFlightId = nextInFlightId++;
        const inFlightStartedAt = Date.now();
        inFlightStarts.set(inFlightId, inFlightStartedAt);
        scheduleStallCheck(inFlightId, inFlightStartedAt);
        try {
          // P-005: classify the forward + (for a tools/call) inject a per-request
          // idempotencyKey ONCE, reused across every retry of THIS request so :3070 dedups a
          // replay instead of double-applying the write. Kill-switch:
          // PAPERCUSP_MCP_PROXY_KEYED_RETRY=0 forces tools/call to 'opaque' (refused-only).
          const keyingEnabled = process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY !== '0';
          // EI-21268234394605529: replay a provably read-only tools/call once on a
          // post-connect socket error (own kill-switch; the keying master switch above
          // disables it too). Defaults ON.
          const readonlyRetryEnabled =
            keyingEnabled && process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY !== '0';
          // P-010: absorb an admission-control 429 by retrying (kill-switch to opt out).
          const absorb429 = process.env.PAPERCUSP_MCP_PROXY_ABSORB_429 !== '0';
          const absorbBoot = process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT !== '0';
          const fwd = prepareForward(req.method ?? 'GET', req.headers, rawBody, { keyingEnabled, readonlyRetryEnabled, genKey: randomUUID });
          // EI-19294517824914302: a cheap repeating beat fails fast instead of burning the
          // restart-sized window (~30 attempts) and amplifying a transient stall ~30x.
          const retryWindowMs = effectiveRetryWindowMs(req.url ?? '/', opts.retryWindowMs);
          const started = Date.now();
          let attempts = 0;
          let postConnectRetries = 0;
          let backpressureRetries = 0;
          let handshakeTimeoutRetries = 0;
          let last: ForwardOutcome | undefined;
          // Retry loop: refused → replay across the window (shouldRetry); post-connect →
          // replay only an idempotent/readonly request, bounded (postConnectRetryable);
          // upstream 429 (admission-control backpressure) → absorb + retry (P-010).
          // eslint-disable-next-line no-constant-condition
          while (true) {
            // WI-35737: the client is gone — every further attempt is upstream capacity spent
            // on a response nobody can read, during the exact windows when it is scarcest.
            // Checked at the TOP so it also covers a client that left between two attempts.
            if (clientGone) break;
            attempts++;
            // WI-6740: bound the write-free control-plane batch tightly (see
            // HANDSHAKE_UPSTREAM_TIMEOUT_MS). EI-19305299022434394: a real tools/call is no
            // longer literally unbounded either — `maxHoldMs` (generous, default 10 min) is the
            // absolute ceiling that stops a stalled-but-connected upstream from silently
            // parking a socket for 32-89 minutes, while staying well above any legitimate tool's
            // real runtime (`build:typecheck` ~160s).
            // WI-35737: arm client-disconnect abort for THIS attempt — write-free class only.
            // A 'keyed'/'opaque' batch carries a tools/call whose side effect may already be
            // landing upstream, so we let it finish and simply discard the result; that is the
            // same retry-safety rule `handshakeTimeoutRetryable` applies, for the same reason.
            // (This costs nothing in practice: every failure in the measured 2026-08-08 window
            // — 540 handshake timeouts, 520 upstream errors, 245 post-connect retries — was
            // klass 'idempotent'.)
            const attemptAbort = fwd.klass === 'idempotent' ? new AbortController() : null;
            abortAttempt = attemptAbort ? (): void => attemptAbort.abort() : null;
            let outcome: ForwardOutcome;
            try {
              outcome = await forwardOnce(
                opts,
                req.method ?? 'GET',
                req.url ?? '/',
                fwd.headers,
                fwd.body,
                reservedControlPlane && controlPlaneReserve > 0
                  ? controlPlaneAgent
                  : upstreamAgent,
                fwd.klass === 'idempotent'
                  ? (opts.handshakeTimeoutMs ?? HANDSHAKE_UPSTREAM_TIMEOUT_MS)
                  : maxHoldMs > 0
                    ? maxHoldMs
                    : 0,
                attemptAbort?.signal,
              );
            } finally {
              abortAttempt = null;
            }
            // The abort above surfaces as an ordinary failed attempt; `clientGone` is what
            // decides, so a race between the abort landing and the response arriving cannot
            // write to a dead socket.
            if (clientGone) {
              record({
                kind: 'client_gone',
                method: req.method, path: req.url, klass: fwd.klass, attempts,
                elapsedMs: Date.now() - started,
              });
              break;
            }
            const elapsed = Date.now() - started;
            if (outcome.ures) {
              const ures = outcome.ures;
              const status = ures.statusCode ?? 502;
              // P-010: :3070 shed this tools/call (event loop critically saturated). The tool
              // NEVER dispatched (429 = not fulfilled) → replay is write-safe for any class.
              // Drain the shed response to free the socket, wait Retry-After, and retry within
              // the window so the saturation is invisible to the agent. When the operator stays
              // critical past the window/max, fall through and surface the 429 (honest, not a hang).
              // POST-only: every real MCP call is a POST. A GET/HEAD (health probes, the
              // watchdog's liveness check) that yields 404/405 must surface INSTANTLY —
              // absorbing it would stall probes for the whole retry window and read as a
              // wedge (worst case: the watchdog restart-loops the proxy, flapping the fleet).
              const bootAbsorbable = req.method === 'POST' && BOOT_WINDOW_STATUSES.has(status) && absorbBoot;
              if (
                ((isBackpressureStatus(status) && absorb429) || bootAbsorbable) &&
                backpressureRetryable(backpressureRetries, MAX_BACKPRESSURE_RETRIES, elapsed, retryWindowMs)
              ) {
                backpressureRetries++;
                const waitMs = retryAfterMs(ures.headers['retry-after'], backoff, MAX_BACKPRESSURE_WAIT_MS);
                ures.resume(); // discard the shed/boot-window body so the (keepAlive:false) socket is released
                record({
                  kind: isBackpressureStatus(status) ? 'absorb_429' : 'absorb_boot_status',
                  method: req.method, path: req.url, status, attempts, backpressureRetries, waitMs, elapsedMs: elapsed,
                });
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
              }
              res.writeHead(status, ures.headers);
              // WI-35737: an MCP response is an SSE stream that stays open long after headers
              // arrive (and long after this function returns and releases its in-flight slot).
              // `pipe` does NOT tear down the SOURCE when the destination dies, so without
              // this a client that vanishes mid-stream leaves :3070 writing into a dead socket
              // for the life of the stream. Safe for every class, unlike aborting a request
              // in flight: headers are already back, so the tools/call has run — destroying
              // the RESPONSE cannot half-apply anything.
              res.on('close', () => {
                if (!ures.destroyed) ures.destroy();
              });
              ures.pipe(res);
              if (attempts > 1) {
                log(`recovered after ${attempts} attempts (${Date.now() - started}ms) — :3070 came back`);
                record({ kind: 'recovered', method: req.method, path: req.url, status, attempts, postConnectRetries, klass: fwd.klass, elapsedMs: Date.now() - started });
              }
              // Forwarded a non-2xx: previously INVISIBLE (no tool_invocations row). A 4xx with
              // `connection: close` is the stale-socket-400 signature (W1.3) — record it so any
              // regression of that class is instantly visible, never silently "transient".
              if (status >= 400) {
                record({ kind: 'upstream_non2xx', method: req.method, path: req.url, status, attempts, elapsedMs: Date.now() - started, connection: (ures.headers['connection'] as string) ?? null });
              }
              return;
            }
            last = outcome;
            if (!outcome.connected) {
              // Refused / pre-connect: the request provably never reached :3070 → always safe to replay.
              if (shouldRetry(false, elapsed, retryWindowMs)) {
                await new Promise((r) => setTimeout(r, backoff));
                continue;
              }
              break;
            }
            // WI-6740: upstream went SILENT (not a socket error). Replay the write-free
            // handshake so a ~10s :3070 stall is a slightly-slower connect instead of a
            // session that is tool-dark for hours. Checked BEFORE the socket-error branch
            // so it gets its own (larger) bound rather than consuming MAX_POST_CONNECT_RETRIES.
            if (
              outcome.timedOut &&
              handshakeTimeoutRetryable(
                fwd.klass, handshakeTimeoutRetries, MAX_HANDSHAKE_TIMEOUT_RETRIES, elapsed, retryWindowMs,
              )
            ) {
              handshakeTimeoutRetries++;
              record({ kind: 'handshake_timeout_retry', method: req.method, path: req.url, klass: fwd.klass, attempts, handshakeTimeoutRetries, elapsedMs: elapsed });
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            // A timed-out handshake has exhausted its dedicated retry budget. Do not let it
            // fall through to the socket-error retry budget: that would add a fourth attempt
            // after the two allowed timeout retries and amplify the same silent upstream stall.
            if (outcome.timedOut) break;
            // Post-connect failure: replay ONLY an idempotent or server-keyed request, bounded.
            if (postConnectRetryable(fwd.klass, postConnectRetries, MAX_POST_CONNECT_RETRIES, elapsed, retryWindowMs)) {
              postConnectRetries++;
              record({ kind: 'post_connect_retry', method: req.method, path: req.url, klass: fwd.klass, attempts, elapsedMs: elapsed, detail: String(outcome.err?.message ?? '') });
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            break;
          }
          // WI-35737: the loop broke because the CLIENT left, not because upstream failed.
          // There is no socket to answer on, and writing the 502/503 below would both throw
          // and record a phantom `upstream_error` — inflating the very failure counts this
          // incident is being triaged from. The `finally` still releases the in-flight slot.
          if (clientGone) return;
          // Exhausted the window (or a post-connect error we must not / no longer replay).
          const refused = last && !last.connected;
          res.writeHead(refused ? 503 : 502, { 'content-type': 'application/json', 'retry-after': '5' });
          res.end(
            JSON.stringify({
              error: refused ? 'mcp_proxy_upstream_unavailable' : 'mcp_proxy_upstream_error',
              detail: String(last?.err?.message ?? last?.err ?? 'unknown'),
              attempts,
              windowMs: retryWindowMs,
              note: refused
                ? ':3070 refused connections for the whole retry window (restart took too long or is down)'
                : fwd.klass === 'opaque'
                  ? 'upstream errored AFTER connecting — not retried (avoids double-applying a non-idempotent tools/call)'
                  : `upstream errored AFTER connecting; retried ${postConnectRetries}× (${fwd.klass}) then surfaced the error`,
            }),
          );
          log(`upstream ${refused ? 'unavailable' : 'error'} after ${attempts} attempt(s): ${last?.err?.message ?? last?.err}`);
          record({ kind: refused ? 'exhausted_refused' : 'upstream_error', method: req.method, path: req.url, status: refused ? 503 : 502, attempts, postConnectRetries, klass: fwd.klass, elapsedMs: Date.now() - started, detail: String(last?.err?.message ?? last?.err ?? 'unknown') });
        } finally {
          // EI-19305299022434394: always release the in-flight slot, on every exit path
          // (success return, exhausted-window fallthrough, or an unexpected throw).
          inFlightStarts.delete(inFlightId);
          // EI-19388661789704364: cancel this request's own stall timer so a fast forward
          // never leaves a dangling scheduled check (and never fires one after completion).
          const stallTimer = stallTimers.get(inFlightId);
          if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimers.delete(inFlightId);
          }
        }
      })();
    });
  });
  // Adding a `clientError` listener disables Node's default socket destruction, so preserve the
  // default safety behavior after recording the event. The event may represent a parser error or
  // an ECONNRESET before an IncomingMessage exists; both are inbound and otherwise invisible.
  server.on('clientError', (error, socket) => {
    recordInboundClientError(error, socket);
    socket.destroy();
  });
  // Node emits `drop` when its connection admission limit rejects a socket. This is the closest
  // process-level signal to listen-backlog pressure; kernel-level SYN/backlog drops cannot be
  // observed by userland, so do not claim this counter is a complete refusal count.
  server.on('drop', (details) => {
    inbound.drops++;
    log(`inbound connection dropped (accept pressure): ${details?.remoteAddress ?? 'unknown peer'}`);
    record({
      kind: 'inbound_drop',
      event: 'drop',
      acceptPressure: true,
      drops: inbound.drops,
      ...details,
    });
  });
  server.on('connection', (socket) => {
    inbound.accepted++;
    inbound.active++;
    socket.once('close', () => {
      inbound.active = Math.max(0, inbound.active - 1);
    });
  });
  // EI-21275891049298859: the proxy is the MCP client's inbound HTTP server, so it
  // needs the same WI-1711 keep-alive policy as the operator it fronts. Leaving this
  // raw `http.createServer` on Node's 5s default let ptool finish tools/list, pause
  // briefly under install/CPU pressure, then race the server FIN on tools/call — two
  // concurrent calls surfaced ECONNRESET/UND_ERR_SOCKET without ever reaching the
  // proxy's upstream-failure ledger. Reuse the canonical 61s policy (including the
  // headersTimeout > keepAliveTimeout invariant and existing kill-switch) instead of
  // inventing a proxy-specific timeout surface.
  applyServerTimeouts(server);
  server.on('close', () => {
    for (const timer of stallTimers.values()) clearTimeout(timer);
    stallTimers.clear();
    if (ownsControlPlaneAgent) controlPlaneAgent.destroy();
  });
  return server;
}

/** Start the proxy from env/opts. Returns the listening server. */
export function startMcpProxy(opts: McpProxyOptions): http.Server {
  const log = opts.log ?? ((s: string) => console.log(`[mcp-proxy] ${s}`));
  const server = createMcpProxy(opts);
  server.listen(opts.listenPort, opts.listenHost ?? '127.0.0.1', () => {
    const target = opts.resolveTarget ? 'dynamic operator.json target' : `${opts.targetHost ?? '127.0.0.1'}:${opts.targetPort}`;
    log(
      `listening on ${opts.listenHost ?? '127.0.0.1'}:${opts.listenPort} → ${target} ` +
        `(retry-on-refused window ${opts.retryWindowMs}ms)`,
    );
  });
  return server;
}
