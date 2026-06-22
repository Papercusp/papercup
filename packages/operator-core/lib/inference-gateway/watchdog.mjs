#!/usr/bin/env node
/**
 * Inference-gateway WEDGE watchdog — inference-gateway-robustness-audit-2026-06-20 P0.
 *
 * A wedged gateway stays UP (process alive, port listening), so systemd Restart=always never fires; the
 * two 2026-06-20 wedges ran SILENTLY for 6-38 min until a human noticed. This polls /stats and auto-
 * restarts on the wedge signature, turning a multi-minute silent outage into ~one poll of auto-recovery.
 *
 * Wedge signature (must HOLD for FREEZE_MS): totalRequests NOT advancing AND queueDepth>0 AND
 * inFlight>=maxConcurrent — work is waiting but NOTHING drains. A normal throttle still advances
 * totalRequests (requests trickle through), so this never false-positives on a paced/paused pool. Also
 * restarts if /stats is unreachable for UNREACHABLE_MS (the HTTP listener itself died/hung).
 *
 * SAFE FOR UNATTENDED OPERATION: a restart debounce (DEBOUNCE_MS) + a circuit breaker
 * (MAX_RESTARTS_PER_HR per rolling hour, then it STOPS restarting and only logs) so a misfire can never
 * restart-loop the gateway overnight — worst case it gives up and waits for a human.
 *
 * Env (all optional): PAPERCUSP_GATEWAY_PORT, _WATCHDOG_POLL_MS, _WATCHDOG_FREEZE_MS,
 *   _WATCHDOG_UNREACHABLE_MS, _WATCHDOG_DEBOUNCE_MS, _WATCHDOG_MAX_RESTARTS_HR, _WATCHDOG_UNIT.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788;
const POLL_MS = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_POLL_MS) || 15_000;
const FREEZE_MS = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_FREEZE_MS) || 120_000;
const UNREACHABLE_MS = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_UNREACHABLE_MS) || 60_000;
const DEBOUNCE_MS = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_DEBOUNCE_MS) || 5 * 60_000;
const MAX_RESTARTS_PER_HR = Number(process.env.PAPERCUSP_GATEWAY_WATCHDOG_MAX_RESTARTS_HR) || 4;
const UNIT = process.env.PAPERCUSP_GATEWAY_WATCHDOG_UNIT || 'papercup-inference-gateway';
/** Durable, journald-INDEPENDENT decision log. The systemd journal's stdout-socket capture
 *  (/run/systemd/journal/stdout) was observed wedged host-wide (2026-06-22, EI-2421): the watchdog's
 *  console.log restart decisions were invisible in journald for 44h, which is exactly why "is the
 *  watchdog the thing restarting the gateway?" was undiagnosable for days. So we ALSO append every
 *  restart / suppress / circuit-open decision to this file (synchronous append, visible to readers
 *  immediately). A standalone supervisor that runs precisely WHEN the operator/PG may be down is the
 *  canonical "must be a file, not Postgres" case (storage-policy). Env-tunable. */
const LOG_FILE = process.env.PAPERCUSP_GATEWAY_WATCHDOG_LOG || join(homedir(), '.papercusp', 'gateway-watchdog.log');

let lastTotal = -1;
let frozenSince = 0;
let frozenSelfHeal = -1; // selfHealReclaims captured when the current freeze started — detects the in-process valve draining it
let unreachableSince = 0;
let lastRestart = 0;
const restartTimes = []; // epoch ms of recent restarts (rolling 1h window for the circuit breaker)

let logDirEnsured = false;
const log = (m) => {
  const line = `[gw-watchdog ${new Date().toISOString()}] ${m}`;
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
  log(`WEDGE -> restarting ${UNIT}: ${reason}`);
  execFile('systemctl', ['--user', 'restart', UNIT], (err) =>
    log(err ? `restart FAILED: ${err.message}` : 'restart issued OK'),
  );
  // reset detection state so a fresh boot gets a clean baseline
  lastTotal = -1;
  frozenSince = 0;
  frozenSelfHeal = -1;
  unreachableSince = 0;
}

/** Distinguish an INTERNAL wedge (a true deadlock/leak a restart fixes) from an EXTERNAL stall a
 *  restart can NOT fix and would only worsen by dropping every in-flight bee/queen spawn (EI-2421).
 *  The frozen-while-saturated signature ALSO fires when the whole account pool is rate-limit exhausted
 *  (every account paused / circuit-open → nothing trickles → totalRequests genuinely frozen), or while
 *  the gateway's own in-process self-heal valve (gateway.ts SELFHEAL_FREEZE_MS, < this 120s freeze) is
 *  already reclaiming the wedge. In those cases a restart is pure harm. Returns a reason string when the
 *  stall is external/self-healing (→ SUPPRESS the restart), else null (→ a real wedge, restart). */
export function externalStallReason(s, selfHealAtFreezeStart) {
  const now = Date.now();
  const pausedUntil = Number(s?.pausedUntil) || 0;
  const selfHeal = Number(s?.selfHealReclaims) || 0;
  const unified = s?.unified || {};
  if (pausedUntil > now) return `active account governor-paused ${Math.round((pausedUntil - now) / 1000)}s — rate-limit, not a wedge`;
  if (unified.rejected === true) return `unified budget window exhausted (rejected) — rate-limit, not a wedge`;
  if (selfHealAtFreezeStart >= 0 && selfHeal > selfHealAtFreezeStart)
    return `in-process self-heal valve already reclaiming (${selfHealAtFreezeStart}->${selfHeal}) — let it drain`;
  return null;
}

async function poll() {
  let s;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    const r = await fetch(`http://127.0.0.1:${PORT}/stats`, { signal: ctrl.signal });
    clearTimeout(t);
    s = await r.json();
    unreachableSince = 0;
  } catch (e) {
    const now = Date.now();
    if (!unreachableSince) {
      unreachableSince = now;
      log(`/stats unreachable (${e.message})`);
    } else if (now - unreachableSince >= UNREACHABLE_MS) {
      restart(`/stats unreachable ${Math.round((now - unreachableSince) / 1000)}s`);
    }
    return;
  }
  const now = Date.now();
  const total = Number(s.totalRequests) || 0;
  const queued = Number(s.queueDepth) || 0;
  const inFlight = Number(s.inFlight) || 0;
  const maxConc = Number(s?.admission?.maxConcurrent ?? 0) || 0;
  const stuck = total === lastTotal && queued > 0 && maxConc > 0 && inFlight >= maxConc;
  if (stuck) {
    if (!frozenSince) {
      frozenSince = now;
      frozenSelfHeal = Number(s.selfHealReclaims) || 0;
      log(`freeze candidate: total=${total} queued=${queued} inFlight=${inFlight}/${maxConc} selfHeal=${frozenSelfHeal}`);
    } else if (now - frozenSince >= FREEZE_MS) {
      const ext = externalStallReason(s, frozenSelfHeal);
      if (ext) {
        // Not a wedge — a rate-limit/self-heal stall a restart can't fix. Re-baseline (don't restart-spam)
        // and keep watching: if it becomes a TRUE internal wedge (external signal clears but still frozen),
        // a later poll will see ext===null and restart.
        log(`SUPPRESS restart — stall is EXTERNAL/self-healing: ${ext}. A restart would only drop in-flight spawns. total=${total} ${inFlight}/${maxConc}`);
        frozenSince = now;
        frozenSelfHeal = Number(s.selfHealReclaims) || 0;
      } else {
        restart(`totalRequests frozen @${total}, ${queued} queued, ${inFlight}/${maxConc} in-flight for ${Math.round((now - frozenSince) / 1000)}s`);
      }
    }
  } else {
    if (frozenSince) log(`freeze cleared (total ${lastTotal}->${total})`);
    frozenSince = 0;
    frozenSelfHeal = -1;
  }
  lastTotal = total;
}

function start() {
  log(
    `up — port ${PORT}, poll ${POLL_MS}ms, freeze ${FREEZE_MS}ms, debounce ${DEBOUNCE_MS}ms, cap ${MAX_RESTARTS_PER_HR}/hr, unit ${UNIT}; suppress-restart-on-external-stall ON; durable log ${LOG_FILE}`,
  );
  setInterval(() => void poll().catch((e) => log(`poll error: ${e.message}`)), POLL_MS);
}

// Auto-start when run as the systemd unit (`node watchdog.mjs`). Tests set PAPERCUSP_WATCHDOG_NO_AUTOSTART=1
// before importing so they can exercise the pure decision logic (externalStallReason) without the poll loop.
if (process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART !== '1') start();
