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
 * non-idempotent WRITE. We therefore RETRY ONLY when the upstream connection was
 * REFUSED (ECONNREFUSED / pre-connect error) — i.e. the request provably never reached
 * :3070, so replaying it cannot double-apply. Once the socket has connected, an error
 * MIGHT mean :3070 already processed the call, so we do NOT retry — we surface a 502.
 * That trades a rare mid-flight failure (client re-issues) for the guarantee that a
 * restart-window retry never re-runs a write.
 *
 * The endpoint is STATELESS streamable-HTTP (no Mcp-Session-Id / handshake), so the
 * proxy is a pure per-request passthrough — no session state to lose across a restart.
 */
import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
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
  targetHost: string;
  targetPort: number;
  /** Total wall-clock budget to keep retrying a refused upstream (a :3070 restart). */
  retryWindowMs: number;
  /** Delay between retries while the upstream is refusing connections. */
  retryBackoffMs?: number;
  log?: (s: string) => void;
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
    let connected = false;
    let settled = false;
    const done = (o: ForwardOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(o);
    };
    const upstream = http.request(
      {
        host: opts.targetHost,
        port: opts.targetPort,
        method,
        path: reqUrl,
        headers: { ...headers, host: `${opts.targetHost}:${opts.targetPort}` },
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

  return http.createServer((req, res) => {
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
        const body = Buffer.concat(chunks);
        const started = Date.now();
        let attempts = 0;
        let last: ForwardOutcome | undefined;
        // Retry loop — guarded by shouldRetry (refused-only + window).
        // eslint-disable-next-line no-constant-condition
        while (true) {
          attempts++;
          const outcome = await forwardOnce(opts, req.method ?? 'GET', req.url ?? '/', req.headers, body);
          if (outcome.ures) {
            const ures = outcome.ures;
            const status = ures.statusCode ?? 502;
            res.writeHead(status, ures.headers);
            ures.pipe(res);
            if (attempts > 1) {
              log(`recovered after ${attempts} attempts (${Date.now() - started}ms) — :3070 came back`);
              recordProxyFailure({ kind: 'recovered', method: req.method, path: req.url, status, attempts, elapsedMs: Date.now() - started });
            }
            // Forwarded a non-2xx: previously INVISIBLE (no tool_invocations row). A 4xx with
            // `connection: close` is the stale-socket-400 signature (W1.3) — record it so any
            // regression of that class is instantly visible, never silently "transient".
            if (status >= 400) {
              recordProxyFailure({ kind: 'upstream_non2xx', method: req.method, path: req.url, status, attempts, elapsedMs: Date.now() - started, connection: (ures.headers['connection'] as string) ?? null });
            }
            return;
          }
          last = outcome;
          if (!shouldRetry(outcome.connected, Date.now() - started, opts.retryWindowMs)) break;
          await new Promise((r) => setTimeout(r, backoff));
        }
        // Exhausted the window (or a post-connect error we must not replay).
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
              : 'upstream errored AFTER connecting — not retried (avoids double-applying a non-idempotent tools/call)',
          }),
        );
        log(`upstream ${refused ? 'unavailable' : 'error'} after ${attempts} attempt(s): ${last?.err?.message ?? last?.err}`);
        recordProxyFailure({ kind: refused ? 'exhausted_refused' : 'upstream_error', method: req.method, path: req.url, status: refused ? 503 : 502, attempts, elapsedMs: Date.now() - started, detail: String(last?.err?.message ?? last?.err ?? 'unknown') });
      })();
    });
  });
}

/** Start the proxy from env/opts. Returns the listening server. */
export function startMcpProxy(opts: McpProxyOptions): http.Server {
  const log = opts.log ?? ((s: string) => console.log(`[mcp-proxy] ${s}`));
  const server = createMcpProxy(opts);
  server.listen(opts.listenPort, opts.listenHost ?? '127.0.0.1', () =>
    log(
      `listening on ${opts.listenHost ?? '127.0.0.1'}:${opts.listenPort} → ${opts.targetHost}:${opts.targetPort} ` +
        `(retry-on-refused window ${opts.retryWindowMs}ms)`,
    ),
  );
  return server;
}
