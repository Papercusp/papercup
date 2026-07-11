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
 *   - 'keyed' (a tools/call into which the proxy injects a per-request `_meta.idempotencyKey`,
 *     reused across retries) → a post-connect retry is write-safe because :3070 REPLAYS the
 *     stored result (harness_shared.mcp_tool_results) instead of re-executing. Bounded to
 *     MAX_POST_CONNECT_RETRIES so the documented commit→store race is exposed at most once.
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
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
 * upstream, so the extra connect is microseconds. (A future scale refinement for thousands of
 * agents: a BOUNDED keep-alive agent with keepAliveMsecs well under the server's 61s timeout +
 * an explicit retry-once on a stale-socket reset — tracked in the plan. keepAlive:false is the
 * correct, safe fix now.)
 */
const UPSTREAM_AGENT = new http.Agent({ keepAlive: false, maxSockets: Infinity });

/**
 * W8 (backend-reliability-100pct-2026-07-03) — make the proxy's forwarded FAILURES VISIBLE.
 * A non-2xx the proxy forwards, a retry-recovery, or a window-exhaustion NEVER creates a
 * `tool_invocations` row (the request errors at the HTTP layer, BELOW tool dispatch), so the
 * agent-facing failure rate was under-counted and "transient errors" felt normal — exactly how
 * the W1.3 stale-socket 400s stayed invisible. Append a structured JSONL record (journald-
 * independent, survives restart) that a health collector / SLO can ingest. NEVER throws —
 * telemetry must never break forwarding. Env override: PAPERCUSP_MCP_PROXY_FAILURE_LOG.
 */
function failureLogPath(): string {
  // Resolved per-call (not cached at module load) so the sink is env-overridable at runtime + testable.
  return process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG || join(homedir(), '.papercusp', 'mcp-proxy-failures.jsonl');
}
function recordProxyFailure(rec: Record<string, unknown>): void {
  try {
    const path = failureLogPath();
    mkdirSync(dirname(path), { recursive: true }); // idempotent; failures are rare so this is cheap
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
  /** Total wall-clock budget to keep retrying a refused upstream (a :3070 restart). */
  retryWindowMs: number;
  /** Delay between retries while the upstream is refusing connections. */
  retryBackoffMs?: number;
  log?: (s: string) => void;
}

export interface McpProxyTarget {
  host: string;
  port: number;
  source?: string;
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
 *  - 'keyed'      — every tools/call carries a valid idempotencyKey → a replay dedups
 *                   server-side instead of double-applying the write.
 *  - 'opaque'     — a tools/call with no usable key → NEVER replay (write-safety default). */
export type ForwardClass = 'idempotent' | 'keyed' | 'opaque';

export interface PreparedForward {
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  klass: ForwardClass;
}

/**
 * Classify a forward and, for a tools/call, inject a per-request `_meta.idempotencyKey`
 * so a post-connect retry is write-safe (:3070 replays the stored result). PURE +
 * unit-tested; `genKey` is injected for determinism. A VALID client-supplied key is
 * respected (never overwritten); an INVALID one (the server would ignore it) drops the
 * whole request to 'opaque'. Only a POST JSON body can carry a tools/call.
 */
export function prepareForward(
  method: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  opts: { keyingEnabled: boolean; genKey: () => string },
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
 * Post-connect retry decision (PURE + unit-tested): a forward that CONNECTED and then failed
 * may be replayed only when it is 'idempotent' or server-dedup 'keyed', bounded to
 * `maxRetries` and within the window. 'opaque' never replays — the load-bearing invariant.
 */
export function postConnectRetryable(
  klass: ForwardClass,
  retriesUsed: number,
  maxRetries: number,
  elapsedMs: number,
  windowMs: number,
): boolean {
  if (klass === 'opaque') return false;
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
}

/** One forward attempt. Resolves with the upstream response OR an error + whether the
 *  socket had connected (so the caller can decide retry-safety). Never rejects. */
function forwardOnce(
  opts: McpProxyOptions,
  method: string,
  reqUrl: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
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
    const done = (o: ForwardOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(o);
    };
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method,
        path: reqUrl,
        headers: { ...headers, host: `${target.host}:${target.port}` },
        // W1.3: fresh socket per forward — never reuse a pooled keep-alive socket the :3070
        // cluster may be closing (the ~13% spurious-400 root cause). See UPSTREAM_AGENT above.
        agent: UPSTREAM_AGENT,
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
    if (body.length) upstream.write(body);
    upstream.end();
  });
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

  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__mcp_proxy_health') {
      let target: McpProxyTarget | null = null;
      try {
        target = resolveTarget(opts);
      } catch {
        target = null;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, target }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => {
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
        // P-005: classify the forward + (for a tools/call) inject a per-request
        // idempotencyKey ONCE, reused across every retry of THIS request so :3070 dedups a
        // replay instead of double-applying the write. Kill-switch:
        // PAPERCUSP_MCP_PROXY_KEYED_RETRY=0 forces tools/call to 'opaque' (refused-only).
        const keyingEnabled = process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY !== '0';
        // P-010: absorb an admission-control 429 by retrying (kill-switch to opt out).
        const absorb429 = process.env.PAPERCUSP_MCP_PROXY_ABSORB_429 !== '0';
        const fwd = prepareForward(req.method ?? 'GET', req.headers, rawBody, { keyingEnabled, genKey: randomUUID });
        const started = Date.now();
        let attempts = 0;
        let postConnectRetries = 0;
        let backpressureRetries = 0;
        let last: ForwardOutcome | undefined;
        // Retry loop: refused → replay across the window (shouldRetry); post-connect →
        // replay only an idempotent/keyed request, bounded (postConnectRetryable);
        // upstream 429 (admission-control backpressure) → absorb + retry (P-010).
        // eslint-disable-next-line no-constant-condition
        while (true) {
          attempts++;
          const outcome = await forwardOnce(opts, req.method ?? 'GET', req.url ?? '/', fwd.headers, fwd.body);
          const elapsed = Date.now() - started;
          if (outcome.ures) {
            const ures = outcome.ures;
            const status = ures.statusCode ?? 502;
            // P-010: :3070 shed this tools/call (event loop critically saturated). The tool
            // NEVER dispatched (429 = not fulfilled) → replay is write-safe for any class.
            // Drain the shed response to free the socket, wait Retry-After, and retry within
            // the window so the saturation is invisible to the agent. When the operator stays
            // critical past the window/max, fall through and surface the 429 (honest, not a hang).
            if (
              isBackpressureStatus(status) &&
              absorb429 &&
              backpressureRetryable(backpressureRetries, MAX_BACKPRESSURE_RETRIES, elapsed, opts.retryWindowMs)
            ) {
              backpressureRetries++;
              const waitMs = retryAfterMs(ures.headers['retry-after'], backoff, MAX_BACKPRESSURE_WAIT_MS);
              ures.resume(); // discard the 429 body so the (keepAlive:false) socket is released
              record({ kind: 'absorb_429', method: req.method, path: req.url, attempts, backpressureRetries, waitMs, elapsedMs: elapsed });
              await new Promise((r) => setTimeout(r, waitMs));
              continue;
            }
            res.writeHead(status, ures.headers);
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
            if (shouldRetry(false, elapsed, opts.retryWindowMs)) {
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            break;
          }
          // Post-connect failure: replay ONLY an idempotent or server-keyed request, bounded.
          if (postConnectRetryable(fwd.klass, postConnectRetries, MAX_POST_CONNECT_RETRIES, elapsed, opts.retryWindowMs)) {
            postConnectRetries++;
            record({ kind: 'post_connect_retry', method: req.method, path: req.url, klass: fwd.klass, attempts, elapsedMs: elapsed, detail: String(outcome.err?.message ?? '') });
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          break;
        }
        // Exhausted the window (or a post-connect error we must not / no longer replay).
        const refused = last && !last.connected;
        res.writeHead(refused ? 503 : 502, { 'content-type': 'application/json', 'retry-after': '5' });
        res.end(
          JSON.stringify({
            error: refused ? 'mcp_proxy_upstream_unavailable' : 'mcp_proxy_upstream_error',
            detail: String(last?.err?.message ?? last?.err ?? 'unknown'),
            attempts,
            windowMs: opts.retryWindowMs,
            note: refused
              ? ':3070 refused connections for the whole retry window (restart took too long or is down)'
              : fwd.klass === 'opaque'
                ? 'upstream errored AFTER connecting — not retried (avoids double-applying a non-idempotent tools/call)'
                : `upstream errored AFTER connecting; retried ${postConnectRetries}× (${fwd.klass}) then surfaced the error`,
          }),
        );
        log(`upstream ${refused ? 'unavailable' : 'error'} after ${attempts} attempt(s): ${last?.err?.message ?? last?.err}`);
        record({ kind: refused ? 'exhausted_refused' : 'upstream_error', method: req.method, path: req.url, status: refused ? 503 : 502, attempts, postConnectRetries, klass: fwd.klass, elapsedMs: Date.now() - started, detail: String(last?.err?.message ?? last?.err ?? 'unknown') });
      })();
    });
  });
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
