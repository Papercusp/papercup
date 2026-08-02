#!/usr/bin/env node
/**
 * mcp-proxy (:9071) LIVENESS watchdog — EI-9237.
 *
 * Incident 2026-07-10 ~14:28-14:37 EDT: papercup-mcp-proxy.service's event loop wedged (port
 * held, ESTAB clients, zero responses) while :3070 upstream stayed healthy. The proxy exists
 * precisely so a :3070 deploy restart is invisible to MCP clients (mcp-host-availability-
 * resilience-2026-06-22 P-005) — but it is itself an unwatched single point of failure. `psu`
 * dials :9071 first at startup, so EVERY invocation hung with zero output until a human noticed
 * ~9 minutes later and ran `systemctl --user restart papercup-mcp-proxy` by hand. Because the
 * process stayed `active` (port listening, just not answering), systemd's own `Restart=always`
 * never fires on this class of wedge — same blind spot the bg-host / inference-gateway
 * watchdogs exist to cover for their own services.
 *
 * DETECTION: the proxy is a stateless HTTP/TCP passthrough with no internal request counters to
 * inspect (unlike the inference-gateway's /stats-based freeze detector), so end-to-end
 * REACHABILITY through :9071 (not a direct :3070 probe, which would miss a wedge in the proxy
 * itself) is the whole signal. ANY response at all — success or a proxied error status — proves
 * the event loop is alive and forwarding; only a timeout/abort/connection-refused counts as
 * unreachable. Restart once unreachable for >= UNREACHABLE_MS.
 *
 * SAFE FOR UNATTENDED OPERATION: same shape as the bg-host / inference-gateway watchdogs — a
 * restart debounce + a rolling-hour circuit breaker so a misfire can never restart-loop forever,
 * and a durable journald-INDEPENDENT log file (the 2026-06-22 EI-2434 journal-silence precedent:
 * a decision log nobody can read is as good as no log).
 *
 * Env (all optional): PAPERCUSP_MCP_PROXY_WATCHDOG_PORT, _POLL_MS, _UNREACHABLE_MS, _DEBOUNCE_MS,
 *   _MAX_RESTARTS_HR, _UNIT, _LOG.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { MCP_PROXY_RETRY_WINDOW_MS, PSU_CLIENT_HEADROOM_MS } from './budgets.mjs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_PORT) || 9071;
const POLL_MS = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POLL_MS) || 15_000;
/** The 2026-07-10 incident ran ~9min undetected; this threshold is deliberately short (2x the
 *  bg-host's 30s poll granularity) so a real wedge is caught within ~1min, not left to fester. */
const UNREACHABLE_MS = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_UNREACHABLE_MS) || 45_000;
const DEBOUNCE_MS = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_DEBOUNCE_MS) || 5 * 60_000;
const MAX_RESTARTS_PER_HR = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_MAX_RESTARTS_HR) || 6;
const UNIT = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_UNIT || 'papercup-mcp-proxy';
/** Durable, journald-INDEPENDENT decision log — see the bg-host / inference-gateway watchdogs'
 *  identical rationale (EI-2434: journald's stdout-socket capture was itself observed wedged). */
const LOG_FILE = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_LOG || join(homedir(), '.papercusp', 'mcp-proxy-watchdog.log');

/* ────────────────────────────────────────────────────────────────────────────
 * SESSION-PLANE probe — EI-19299524366372518 (2026-08-01 incident).
 *
 * The /api/health probe above answers "is the event loop alive?". It CANNOT answer
 * "can a client actually get a tool catalog?", and on 2026-08-01 those diverged for
 * ~100 minutes: /api/health returned 200 in ~2ms continuously while the MCP session
 * plane was completely dead. Fleet tool throughput fell 2759 -> 44 calls/30min, 29 su
 * sessions went dark for a median of 80 minutes, and this watchdog logged nothing but
 * its routine 10s blips. Every consumer of :9071 cares about the tool catalog; nobody
 * cares about /api/health. So we probe the thing that matters.
 *
 * COST. The probe asks for a SINGLE tool (`?tools=`), so a healthy poll is ~4KB/15s.
 * The unfiltered catalog is ~980KB / 742 tools and is fetched ONLY as a confirmation
 * step before acting (see below) — never on the steady-state path. That matters: this
 * incident involved a resource-starved operator, and a watchdog that adds ~65KB/s plus
 * a 742-tool assembly every 15s would be pushing the thing it is meant to protect.
 *
 * TWO FALSE-POSITIVE TRAPS, both measured on the live endpoint, both guarded:
 *
 *  1. UNAUTHENTICATED reads as dead. With a missing/expired bearer the server returns
 *     HTTP 200 with ZERO tools — its own error text says so explicitly: "this MCP
 *     session is UNAUTHENTICATED, so it exposes NO tools (this is NOT 'a healthy server
 *     with zero tools')". A watchdog that restarted services because its own credential
 *     expired would be strictly worse than the blindness it replaces, so `auth` is a
 *     PROBE-CONFIG fault: logged loudly, never counted as a service failure.
 *
 *  2. A STALE FILTER NAME reads as dead. `?tools=does-not-exist` also returns HTTP 200,
 *     zero tools, and NO error — indistinguishable from an empty catalog. Renaming
 *     PROBE_TOOL would otherwise arm a permanent false alarm. Hence `empty` is treated
 *     as AMBIGUOUS, never as a verdict: it triggers one unfiltered confirmation fetch,
 *     and a healthy confirmation reports the stale filter as a config warning instead.
 *
 * THRESHOLD. Deliberately longer than the reachability path's 45s: the proxy is *designed*
 * to absorb an upstream gap up to its own retry window (that is the entire point of the
 * service), so acting sooner would fight the resilience layer. Default = window + headroom
 * (120s today) — detection in ~2min against the ~100min this incident actually took.
 *
 * DERIVED, not hard-coded (WI-6738). A literal here would be the same latent bug this
 * watchdog's sibling fix just removed: raise PAPERCUSP_MCP_PROXY_RETRY_MS and a frozen 120s
 * would start alarming DURING legitimate absorption. Sharing budgets.mjs means the whole
 * system's "how long may the proxy legitimately take?" answer moves in one place.
 * ──────────────────────────────────────────────────────────────────────────── */
const UPSTREAM_PORT = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_UPSTREAM_PORT) || 3070;
const HANDSHAKE_TIMEOUT_MS = Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_HANDSHAKE_TIMEOUT_MS) || 10_000;
const HANDSHAKE_UNHEALTHY_MS =
  Number(process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_HANDSHAKE_UNHEALTHY_MS) ||
  MCP_PROXY_RETRY_WINDOW_MS + PSU_CLIENT_HEADROOM_MS;
/** Any single stable tool name; correctness does NOT depend on it (trap 2 above). */
const PROBE_TOOL = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_PROBE_TOOL || 'coord:orient';
/**
 * DATA-PLANE probe tool (WI-6739). Must be READ-ONLY and must actually touch Postgres —
 * the whole point is to execute a query, not to prove the registry can be serialised.
 * `facts:list` is a cheap scoped SELECT with no side effects.
 */
const DB_PROBE_TOOL = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_TOOL || 'facts:list';
const SUPERUSER_TOKEN_FILE = join(homedir(), '.papercusp', 'superuser-token');

let unreachableSince = 0;
let handshakeFailingSince = 0;
let dataFailingSince = 0;
let lastRestart = 0;
const restartTimes = []; // epoch ms of recent restarts (rolling 1h window for the circuit breaker)

let logDirEnsured = false;
const log = (m) => {
  const line = `[mcp-proxy-watchdog ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try {
    if (!logDirEnsured) {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      logDirEnsured = true;
    }
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* durable log unavailable (perm/disk) — console.log remains the fallback; never let logging crash the watchdog */
  }
};

/** Pure decision: given how long the proxy has been continuously unreachable, should we restart
 *  now? Exported so the threshold logic is unit-testable without a live poll loop / network. */
export function shouldRestart(unreachableSinceMs, nowMs, thresholdMs = UNREACHABLE_MS) {
  if (!unreachableSinceMs) return false;
  return nowMs - unreachableSinceMs >= thresholdMs;
}

/**
 * Pure verdict for one session-plane probe. Split out from the network call so the
 * exact 2026-08-01 miss is expressible as a unit test: a target that answers
 * /api/health with 200/2ms but cannot serve a tool catalog MUST be judged unhealthy.
 *
 *   'ok'    — a well-formed JSON-RPC result carrying a NON-EMPTY tool catalog. Proves
 *             the whole path a real client needs: session established, bearer accepted,
 *             registry assembled, response serialised.
 *   'auth'  — the credential was rejected. A PROBE-CONFIG fault, never a service fault.
 *   'empty' — 200 + zero tools + no error. AMBIGUOUS (stale filter vs genuinely empty
 *             registry); the caller must confirm before treating it as a verdict.
 *   'dead'  — no response, non-200, unparseable, or a non-auth JSON-RPC error.
 */
export function classifyProbeResult({ networkError, status, json } = {}) {
  if (networkError) return 'dead';
  if (status !== 200) return 'dead';
  if (!json || typeof json !== 'object') return 'dead';
  const err = json.error;
  if (err) {
    const text = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
    // The server reports a bad/expired bearer as a -32603 whose message names the cause.
    return text.includes('auth') || text.includes('bearer') || text.includes('unauthenticated')
      ? 'auth'
      : 'dead';
  }
  const tools = json.result?.tools;
  if (!Array.isArray(tools)) return 'dead';
  return tools.length > 0 ? 'ok' : 'empty';
}

/**
 * Pure remediation decision, given a confirmed-unhealthy proxy probe and a probe of the
 * upstream taken at the same moment.
 *
 * The discrimination is the point. On 2026-08-01 the proxy was fine and :3070 was wedged
 * — restarting the proxy would have accomplished nothing while burning a slot in the
 * circuit breaker and making the log lie about what was broken. Only a :3070 restart
 * cleared it (all 29 dark sessions recovered inside the 7 minutes after it).
 */
/**
 * Pure verdict for one DATA-PLANE probe — the third plane, and the one that actually
 * failed on 2026-08-01 (WI-6739).
 *
 * That outage had THREE distinct planes and only the third was broken:
 *   /api/health      → 200 in ~2ms, continuously.
 *   session plane    → fine. Of the whole peak hour only 9 `/api/mcp` requests failed…
 *   data plane       → …against 5,542 failed DB-backed `bootstrap-su/heartbeat` POSTs.
 * :3070 was ECONNREFUSING a dead Postgres endpoint (a stale embedded-pg port) while its
 * event loop, its HTTP server and its in-memory tool registry were all perfectly healthy.
 * So a `tools/list` probe — which is served from the registry and never queries PG — stays
 * GREEN throughout. A detector that is green during the incident it exists to catch is
 * worse than no detector, because it actively reassures. Hence: execute a real read-only
 * tool and require it to come back.
 *
 * The classification is deliberately conservative so this can never cry wolf:
 *   'ok'     — a JSON-RPC result came back. The query ran.
 *   'config' — a JSON-RPC error that is NOT connection-shaped (bad args, renamed tool).
 *              OUR fault, never the service's — logged, never alarmed.
 *   'dead'   — no response / timeout / non-200 (a 408 is literally what clients saw), or a
 *              JSON-RPC error naming a connection failure (the tool ran and could not reach PG).
 */
export function classifyDataPlaneResult({ networkError, status, json } = {}) {
  if (networkError) return 'dead'; // timeout — a pool waiting on a dead endpoint never answers
  if (status !== 200) return 'dead'; // 408/5xx — the exact client-visible symptom on 2026-08-01
  if (!json || typeof json !== 'object') return 'dead';
  const err = json.error;
  if (err) {
    const text = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
    if (text.includes('auth') || text.includes('bearer') || text.includes('unauthenticated')) return 'config';
    // A tool that RAN but could not reach the database is the signal, not a config fault.
    const connectionShaped =
      text.includes('econnrefused') ||
      text.includes('etimedout') ||
      text.includes('econnreset') ||
      text.includes('connect ') ||
      text.includes('connection') ||
      text.includes('pool') ||
      text.includes('timeout');
    return connectionShaped ? 'dead' : 'config';
  }
  return json.result ? 'ok' : 'config';
}

export function decideHandshakeAction(proxyKind, upstreamKind) {
  if (proxyKind === 'ok') return 'none';
  if (proxyKind === 'auth') return 'none'; // our own credential; never a service verdict
  return upstreamKind === 'ok' ? 'restart-proxy' : 'upstream-wedged';
}

/** Read the superuser bearer fresh each probe (32 bytes; picks up rotation for free). */
function readProbeToken() {
  try {
    return readFileSync(SUPERUSER_TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Extract the JSON-RPC payload from either an SSE frame or a plain JSON body. */
function parseMcpBody(text) {
  const frame = text.split('\n').find((l) => l.startsWith('data: '));
  try {
    return JSON.parse(frame ? frame.slice(6) : text);
  } catch {
    return null;
  }
}

/**
 * One session-plane probe against `port`. `full: true` drops the single-tool filter and
 * asks for the whole catalog — the confirmation path only (see the cost note above).
 */
async function probeMcp(port, { full = false } = {}) {
  const token = readProbeToken();
  if (!token) return { kind: 'auth', detail: `no superuser token at ${SUPERUSER_TOKEN_FILE}` };
  const qs = `superuser=1&client=mcp-proxy-watchdog${full ? '' : `&tools=${encodeURIComponent(PROBE_TOOL)}`}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp?${qs}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const json = parseMcpBody(await res.text());
    const kind = classifyProbeResult({ status: res.status, json });
    return { kind, detail: kind === 'ok' ? `${json.result.tools.length} tools` : (json?.error?.message ?? `HTTP ${res.status}`) };
  } catch (e) {
    return { kind: 'dead', detail: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a real read-only tool through a real MCP session, so the probe exercises the
 * DATABASE, not just the tool registry. See classifyDataPlaneResult for why.
 */
async function probeDataPlane(port) {
  const token = readProbeToken();
  if (!token) return { kind: 'config', detail: `no superuser token at ${SUPERUSER_TOKEN_FILE}` };
  const qs = `superuser=1&client=mcp-proxy-watchdog-db&tools=${encodeURIComponent(DB_PROBE_TOOL)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp?${qs}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: DB_PROBE_TOOL, arguments: { scope: 'workspace' } },
      }),
    });
    const json = parseMcpBody(await res.text());
    const kind = classifyDataPlaneResult({ status: res.status, json });
    return { kind, detail: kind === 'ok' ? 'query returned' : (json?.error?.message ?? `HTTP ${res.status}`) };
  } catch (e) {
    return { kind: 'dead', detail: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function restart(reason) {
  const now = Date.now();
  if (now - lastRestart < DEBOUNCE_MS) {
    log(`SUPPRESS (debounce ${Math.round((DEBOUNCE_MS - (now - lastRestart)) / 1000)}s left): ${reason}`);
    return;
  }
  while (restartTimes.length && now - restartTimes[0] > 3_600_000) restartTimes.shift();
  if (restartTimes.length >= MAX_RESTARTS_PER_HR) {
    log(`CIRCUIT OPEN: ${restartTimes.length} restarts in the last hour >= cap ${MAX_RESTARTS_PER_HR} — NOT restarting (${reason}). Manual attention needed.`);
    return;
  }
  lastRestart = now;
  restartTimes.push(now);
  log(`WEDGED -> restarting ${UNIT}: ${reason}`);
  execFile('systemctl', ['--user', 'restart', UNIT], (err) =>
    log(err ? `restart FAILED: ${err.message}` : 'restart issued OK'),
  );
  unreachableSince = 0;
}

async function poll() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    // ANY http response (including a proxied 4xx/5xx) proves the event loop answered — that's
    // the whole liveness signal. We deliberately do not inspect the body/status further; the
    // wedge signature is "nothing comes back at all", not "the upstream returned an error".
    await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (unreachableSince) log(`recovered (was unreachable ${Math.round((Date.now() - unreachableSince) / 1000)}s)`);
    unreachableSince = 0;
  } catch (e) {
    const now = Date.now();
    if (!unreachableSince) {
      unreachableSince = now;
      log(`unreachable (${e.message})`);
    } else if (shouldRestart(unreachableSince, now, UNREACHABLE_MS)) {
      restart(`unreachable for ${Math.round((now - unreachableSince) / 1000)}s (${e.message})`);
    }
  }
}

let lastAuthLog = 0;
let lastUpstreamLog = 0;
let lastDataLog = 0;
let lastDataConfigLog = 0;
const LOG_THROTTLE_MS = 10 * 60_000;

/**
 * Data-plane poll (WI-6739) — runs only once the session plane is GREEN, because that is
 * precisely the blind spot: on 2026-08-01 the catalog served fine while every DB-backed
 * call timed out for ~100 minutes and nothing anywhere alarmed.
 *
 * Never restarts the proxy. A :3070 that cannot reach Postgres is not a proxy fault, and
 * restarting the proxy would burn a circuit-breaker slot while the log blamed the wrong
 * service — the same reasoning as the upstream branch in pollHandshake.
 */
async function pollDataPlane() {
  const { kind, detail } = await probeDataPlane(PORT);

  if (kind === 'ok') {
    if (dataFailingSince) {
      log(`data plane recovered (was failing ${Math.round((Date.now() - dataFailingSince) / 1000)}s)`);
      dataFailingSince = 0;
    }
    return;
  }

  if (kind === 'config') {
    const now = Date.now();
    if (now - lastDataConfigLog > LOG_THROTTLE_MS) {
      lastDataConfigLog = now;
      log(`PROBE CONFIG: data-plane probe tool "${DB_PROBE_TOOL}" did not execute (${detail}) — this watchdog is BLIND to the WI-6739 class until fixed, but it is OUR probe config, not a service fault. Set PAPERCUSP_MCP_PROXY_WATCHDOG_DB_PROBE_TOOL to a live read-only tool.`);
    }
    return;
  }

  const now = Date.now();
  if (!dataFailingSince) {
    dataFailingSince = now;
    log(`data plane FAILING (${detail}) — session plane and /api/health are GREEN; that combination is the WI-6739 signature`);
    return;
  }
  if (!shouldRestart(dataFailingSince, now, HANDSHAKE_UNHEALTHY_MS)) return;

  if (now - lastDataLog > LOG_THROTTLE_MS) {
    lastDataLog = now;
    const secs = Math.round((now - dataFailingSince) / 1000);
    log(
      `CRITICAL: MCP DATA plane dead ${secs}s while the session plane and /api/health stay GREEN (${detail}). ` +
        `This is the 2026-08-01 signature (WI-6739): the operator on :${UPSTREAM_PORT} is serving its tool catalog from memory while every DB-backed call times out — most likely a dead/stale Postgres endpoint it will retry forever. ` +
        `Restarting ${UNIT} would NOT fix this and is being withheld. Remediation: check :${UPSTREAM_PORT}'s journal for repeated "connect ECONNREFUSED" to its DB port, then restart the operator host.`,
    );
  }
}

/**
 * Session-plane poll — the detector /api/health cannot be (EI-19299524366372518).
 * Runs alongside the reachability poll rather than replacing it: that one still covers
 * the EI-9237 frozen-event-loop class, and dropping it would trade one blind spot for
 * another.
 */
async function pollHandshake() {
  let { kind, detail } = await probeMcp(PORT);

  // 'empty' is ambiguous, never a verdict — confirm against the unfiltered catalog
  // before believing it (trap 2: a renamed PROBE_TOOL looks exactly like a dead registry).
  if (kind === 'empty') {
    const confirm = await probeMcp(PORT, { full: true });
    if (confirm.kind === 'ok') {
      log(`PROBE CONFIG: filter tool "${PROBE_TOOL}" matched nothing but the catalog is healthy (${confirm.detail}) — set PAPERCUSP_MCP_PROXY_WATCHDOG_PROBE_TOOL to a live tool name. NOT a service fault.`);
      kind = 'ok';
    } else {
      ({ kind, detail } = confirm);
      if (kind === 'empty') kind = 'dead'; // confirmed empty registry on a real client path
    }
  }

  if (kind === 'ok') {
    if (handshakeFailingSince) {
      log(`session plane recovered (was failing ${Math.round((Date.now() - handshakeFailingSince) / 1000)}s)`);
      handshakeFailingSince = 0;
    }
    // Session plane green is exactly when the WI-6739 class hides. Check the data plane.
    await pollDataPlane();
    return;
  }

  if (kind === 'auth') {
    const now = Date.now();
    if (now - lastAuthLog > LOG_THROTTLE_MS) {
      lastAuthLog = now;
      log(`PROBE CONFIG: session probe cannot authenticate (${detail}) — this watchdog is BLIND until fixed, but that is OUR credential, not a service fault, so nothing will be restarted.`);
    }
    return; // never let our own bad credential restart a healthy service
  }

  const now = Date.now();
  if (!handshakeFailingSince) {
    handshakeFailingSince = now;
    log(`session plane FAILING (${detail}) — /api/health may still be green; that is the point of this probe`);
    return;
  }
  if (!shouldRestart(handshakeFailingSince, now, HANDSHAKE_UNHEALTHY_MS)) return;

  const secs = Math.round((now - handshakeFailingSince) / 1000);
  const upstream = await probeMcp(UPSTREAM_PORT);
  const action = decideHandshakeAction(kind, upstream.kind);

  if (action === 'restart-proxy') {
    restart(`session plane dead ${secs}s through :${PORT} while upstream :${UPSTREAM_PORT} serves tools — proxy is the culprit (${detail})`);
    handshakeFailingSince = 0;
    return;
  }

  // Upstream is the culprit. Restarting the proxy cannot fix it and would burn a
  // circuit-breaker slot while the log blamed the wrong service — so we do not.
  if (now - lastUpstreamLog > LOG_THROTTLE_MS) {
    lastUpstreamLog = now;
    log(
      `CRITICAL: MCP session plane dead ${secs}s and the UPSTREAM operator :${UPSTREAM_PORT} is the culprit (proxy: ${detail}; upstream: ${upstream.detail}). ` +
        `Restarting ${UNIT} would NOT fix this and is being withheld. This is the 2026-08-01 signature (WI-6739): /api/health stays 200/2ms while every client is dark. ` +
        `Remediation: restart the operator host serving :${UPSTREAM_PORT}.`,
    );
  }
}

function start() {
  log(
    `up — port ${PORT}, poll ${POLL_MS}ms, unreachable-threshold ${UNREACHABLE_MS}ms, debounce ${DEBOUNCE_MS}ms, cap ${MAX_RESTARTS_PER_HR}/hr, unit ${UNIT}; durable log ${LOG_FILE}`,
  );
  log(
    `session-plane probe — tools/list via :${PORT} every ${POLL_MS}ms (filter "${PROBE_TOOL}", timeout ${HANDSHAKE_TIMEOUT_MS}ms), unhealthy after ${HANDSHAKE_UNHEALTHY_MS}ms, upstream :${UPSTREAM_PORT}`,
  );
  log(
    `data-plane probe (WI-6739) — tools/call "${DB_PROBE_TOOL}" via :${PORT}, runs whenever the session plane is green, unhealthy after ${HANDSHAKE_UNHEALTHY_MS}ms; catches a DB-dead operator that still serves its tool catalog`,
  );
  setInterval(() => void poll().catch((e) => log(`poll error: ${e.message}`)), POLL_MS);
  setInterval(() => void pollHandshake().catch((e) => log(`handshake poll error: ${e.message}`)), POLL_MS);
}

// Auto-start when run as the systemd unit (`node watchdog.mjs`). Tests set
// PAPERCUSP_WATCHDOG_NO_AUTOSTART=1 before importing so they can exercise the pure decision
// logic (shouldRestart) without launching setInterval / hitting the network.
if (process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART !== '1') start();
