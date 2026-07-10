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
import { appendFileSync, mkdirSync } from 'node:fs';
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

let unreachableSince = 0;
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

function start() {
  log(
    `up — port ${PORT}, poll ${POLL_MS}ms, unreachable-threshold ${UNREACHABLE_MS}ms, debounce ${DEBOUNCE_MS}ms, cap ${MAX_RESTARTS_PER_HR}/hr, unit ${UNIT}; durable log ${LOG_FILE}`,
  );
  setInterval(() => void poll().catch((e) => log(`poll error: ${e.message}`)), POLL_MS);
}

// Auto-start when run as the systemd unit (`node watchdog.mjs`). Tests set
// PAPERCUSP_WATCHDOG_NO_AUTOSTART=1 before importing so they can exercise the pure decision
// logic (shouldRestart) without launching setInterval / hitting the network.
if (process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART !== '1') start();
