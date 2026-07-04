#!/usr/bin/env node
/**
 * bg-host (DBOS routines / git-sync / substrate) ticker watchdog — 2026-06-20; freeze-signal rewritten
 * 2026-06-22 (EI-2421/EI-2434).
 *
 * `papercup-bg-host`'s event loop can get STARVED under heavy box load, freezing the routines + git-sync
 * ticker: the process stays `active` (so systemd Restart=always NEVER fires) but routines stop firing and
 * git-sync stops committing — ALL fleet work stops persisting to origin/staging (the recurring 2026-06-20
 * overnight freeze). On a real freeze we restart the unit to revive it (working tree is kopia-backed,
 * separate from the user-facing :3070).
 *
 * FREEZE SIGNAL — journald-INDEPENDENT (this is the 2026-06-22 fix). The original detector polled
 * `journalctl -u papercup-bg-host` and restarted on journal SILENCE. But journald's stdout-socket capture
 * wedged host-wide (EI-2434), so a perfectly HEALTHY, ticking bg-host showed an empty journal → the
 * watchdog false-concluded "frozen" → `systemctl restart` → EI-2186 boot-reconcile reclaimed every
 * in-flight bee spawn (the canary deaths, 2026-06-22). We now read the ticker's ACTUAL liveness directly
 * from Postgres — `MAX(last_fired_at)` across active routines (the SAME signal dev:service_health uses,
 * service-health.ts) — which the bg-host itself advances every tick and which no journald fault can fake.
 * If the newest routine fired > FREEZE_SILENCE_S ago while the unit is active, the ticker is genuinely
 * frozen → restart. If the freshness can't be read (psql/DB down), we treat it as UNKNOWN and skip — we
 * NEVER conclude "frozen" from a missing signal, so a measurement fault can't cause a false restart.
 *
 * SAFE FOR UNATTENDED OPERATION: a restart debounce + a circuit breaker (MAX_RESTARTS_PER_HR per rolling
 * hour, then it STOPS and only logs) so a misfire can't restart-loop the ticker. Decisions are mirrored to
 * a durable file (journald-independent) so a future incident is diagnosable even while journald is wedged.
 *
 * Env (all optional): PAPERCUSP_BGHOST_WATCHDOG_{UNIT,POLL_MS,SILENCE_S,DEBOUNCE_MS,MAX_RESTARTS_HR,DB_URL,LOG},
 *   PAPERCUSP_INTEGRATION_ROOT, DATABASE_URL.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { cpus, freemem, homedir, loadavg, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIT = process.env.PAPERCUSP_BGHOST_WATCHDOG_UNIT || 'papercup-bg-host';
const POLL_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_POLL_MS) || 30_000;
const FREEZE_SILENCE_S = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_SILENCE_S) || 100; // newest routine older than this while active = frozen
const DEBOUNCE_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_DEBOUNCE_MS) || 5 * 60_000;
const MAX_RESTARTS_PER_HR = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_MAX_RESTARTS_HR) || 8;
/** Throttled "still monitoring + ticker healthy" line so the durable log proves the watchdog is ACTIVELY
 *  reading freshness (not silently early-returning) — the operability gap that made this whole class
 *  invisible for 44h. First healthy poll logs immediately, then at most every HEARTBEAT_MS. */
const HEARTBEAT_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_HEARTBEAT_MS) || 10 * 60_000;
/** Durable, journald-INDEPENDENT decision log (EI-2434: journald can't be trusted to capture stdout). */
const LOG_FILE = process.env.PAPERCUSP_BGHOST_WATCHDOG_LOG || join(homedir(), '.papercusp', 'bghost-watchdog.log');

let lastRestart = 0;
let lastHeartbeat = 0;
const restartTimes = []; // epoch ms, rolling 1h, for the circuit breaker
let logDirEnsured = false;
const log = (m) => {
  const line = `[bghost-watchdog ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try {
    if (!logDirEnsured) {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      logDirEnsured = true;
    }
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* durable log unavailable — console.log remains; never let logging crash the watchdog */
  }
};

function sh(cmd, args) {
  return new Promise((resolve_) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => resolve_({ err, stdout: stdout || '' }));
  });
}

/** Resolve the bg-host's DATABASE_URL self-contained (no unit/host-config change): explicit override →
 *  process env → parse .env.local at the integration root (the same source the bg-host unit sources),
 *  found relative to THIS script so it works regardless of cwd. Returns null if unresolved (→ UNKNOWN). */
export function resolveDbUrl(readFile = readFileSync) {
  if (process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL) return process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const root = process.env.PAPERCUSP_INTEGRATION_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const env = readFile(resolve(root, '.env.local'), 'utf8');
    const m = env.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* no .env.local / unreadable → unknown */
  }
  return null;
}

/** Parse psql's `-tAqc` scalar output for the routine-idle age in seconds. Empty / NULL (no active
 *  routines or none fired yet) ⇒ null = UNKNOWN (never treat as frozen). */
export function parseIdleSec(stdout) {
  const v = String(stdout ?? '').trim();
  if (v === '' || v.toLowerCase() === 'null') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pure freeze verdict: a NUMBER idle age over the threshold = frozen; null (unknown) is NEVER frozen. */
export function isFrozen(idleSec, freezeSilenceS = FREEZE_SILENCE_S) {
  return idleSec != null && idleSec > freezeSilenceS;
}

/**
 * Pure restart decision (2026-06-23 — the routines-queue-saturation false-restart fix). A stale routine
 * `last_fired_at` (`routineIdleSec`) alone is AMBIGUOUS: it means a genuine ticker freeze OR merely a
 * SATURATED fire-queue — a few legitimate LONG routines (green-checkpoint ~25m, gym ~90m) holding every
 * `routines`-queue slot stall new claims/completions WITHOUT the event loop being frozen. Restarting THEN is
 * destructive: it kills the in-flight long routines mid-run, DBOS recovers them, they re-saturate → a 5-min
 * restart LOOP that never lets them finish + freezes git-sync (the 2026-06-23 deploy-freeze incident).
 *
 * Corroborate with the SCHEDULER's own liveness (`schedulerIdleSec` = newest `routinesTick` age): the tick
 * fires every ~30s on the SAME event loop but is NOT on the saturable `routines` queue, so a FRESH tick
 * proves the ticker is ALIVE (just busy) → NOT a freeze. Restart only when fires are stale AND the scheduler
 * is not confirmed-fresh (a real freeze stalls BOTH). A null scheduler signal (rare — the routines read
 * succeeded, so the same DB is reachable) falls back to the documented fire-staleness behavior.
 */
export function shouldRestart(idleSec, schedSec, freezeSilenceS = FREEZE_SILENCE_S) {
  if (!isFrozen(idleSec, freezeSilenceS)) return false; // fires unknown or healthy → never a freeze
  if (schedSec != null && !isFrozen(schedSec, freezeSilenceS)) return false; // scheduler alive ⇒ saturation, not a freeze
  return true; // fires stale AND scheduler also stale (or unreadable) ⇒ genuine freeze
}

function hostPressureSnapshot() {
  const cores = Math.max(1, cpus().length || 1);
  const load1 = loadavg()[0] || 0;
  const availableBytes = freemem();
  const totalBytes = totalmem();
  const loadPerCore = load1 / cores;
  const availableRatio = totalBytes > 0 ? availableBytes / totalBytes : 0;
  return {
    cores,
    load1,
    loadPerCore,
    availableRatio,
    hasHeadroom: loadPerCore < 0.85 && availableRatio > 0.10,
  };
}

export function circuitOpenMessage(reason, restartCount, cap, snapshot = hostPressureSnapshot()) {
  const host = snapshot
    ? ` Host snapshot: load1 ${snapshot.load1.toFixed(2)}/${snapshot.cores} cores (${snapshot.loadPerCore.toFixed(2)}/core), memory available ${Math.round(snapshot.availableRatio * 100)}%.`
    : '';
  const diagnosis = snapshot?.hasHeadroom
    ? 'Host has headroom; treat this as a bg-host ticker/event-loop/DBOS stall, not a fleet-wide load problem.'
    : 'Host pressure may be contributing; verify CPU/memory before shedding fleet load.';
  return `CIRCUIT OPEN: ${restartCount} restarts in the last hour >= cap ${cap} — NOT restarting (${reason}).${host} ${diagnosis} Investigate papercup-bg-host internals; do not use blanket load reduction as the remediation.`;
}

/** Read DATABASE_URL out of a process's /proc/<pid>/environ (same-user readable). The bg-host's ACTUAL
 *  running value — robust against .env.local not defining it literally (it doesn't on this box). */
function readProcEnvUrl(pid, readFile = readFileSync) {
  try {
    for (const kv of readFile(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      if (kv.startsWith('DATABASE_URL=')) return kv.slice('DATABASE_URL='.length);
    }
  } catch {
    /* not readable / process gone */
  }
  return null;
}

/** Async DB-URL resolution: sync sources (override / env / .env.local) first, then the ROBUST fallback —
 *  the bg-host unit's own running DATABASE_URL via its /proc environ. Returns null if all fail (→ UNKNOWN). */
async function resolveDbUrlAsync() {
  const direct = resolveDbUrl();
  if (direct) return direct;
  const r = await sh('systemctl', ['--user', 'show', UNIT, '-p', 'MainPID', '--value']);
  const pid = Number(r.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? readProcEnvUrl(pid) : null;
}

/** Newest routine fire age (seconds) from Postgres — the bg-host's true liveness. null on any read fault. */
async function routineIdleSec(dbUrl) {
  if (!dbUrl) return null;
  const q =
    'SELECT EXTRACT(EPOCH FROM (now() - MAX(last_fired_at)))::int ' +
    'FROM harness_shared.routines WHERE active = true AND last_fired_at IS NOT NULL';
  const r = await sh('psql', [dbUrl, '-tAqc', q]);
  if (r.err) return null;
  return parseIdleSec(r.stdout);
}

/** Newest `routinesTick` SCHEDULER execution age (seconds) — the TRUE ticker-liveness signal, independent of
 *  `routines`-fire-queue saturation (the tick is a scheduled workflow, NOT enqueued on the saturable queue).
 *  A fresh tick while routine fires are stale = a busy/saturated queue, not a frozen event loop. null on any
 *  read fault ⇒ UNKNOWN (shouldRestart falls back to the documented fire-staleness behavior). */
async function schedulerIdleSec(dbUrl) {
  if (!dbUrl) return null;
  const q =
    "SELECT EXTRACT(EPOCH FROM (now() - to_timestamp(MAX(created_at)/1000.0)))::int " +
    "FROM dbos.workflow_status WHERE name = 'routinesTick'";
  const r = await sh('psql', [dbUrl, '-tAqc', q]);
  if (r.err) return null;
  return parseIdleSec(r.stdout);
}

function restart(reason) {
  const now = Date.now();
  if (now - lastRestart < DEBOUNCE_MS) {
    log(`SUPPRESS (debounce ${Math.round((DEBOUNCE_MS - (now - lastRestart)) / 1000)}s left): ${reason}`);
    return;
  }
  while (restartTimes.length && now - restartTimes[0] > 3_600_000) restartTimes.shift();
  if (restartTimes.length >= MAX_RESTARTS_PER_HR) {
    log(circuitOpenMessage(reason, restartTimes.length, MAX_RESTARTS_PER_HR));
    return;
  }
  lastRestart = now;
  restartTimes.push(now);
  log(`FROZEN -> restarting ${UNIT}: ${reason}`);
  execFile('systemctl', ['--user', 'restart', UNIT], (err) => log(err ? `restart FAILED: ${err.message}` : 'restart issued OK'));
}

async function poll() {
  const act = await sh('systemctl', ['--user', 'is-active', UNIT]);
  if (act.stdout.trim() !== 'active') {
    // not active → a crash; Restart=always handles that. Don't interfere.
    return;
  }
  const dbUrl = await resolveDbUrlAsync();
  const idleSec = await routineIdleSec(dbUrl);
  if (idleSec == null) {
    // Liveness UNKNOWN (psql/DB unreadable) — NEVER conclude frozen from a missing signal (that was the
    // EI-2434 false-restart bug). Skip this poll.
    log(`routine-freshness UNKNOWN (psql/DB unreadable) — skipping (not concluding frozen)`);
    return;
  }
  if (isFrozen(idleSec)) {
    // Routine fires are stale — but corroborate with the SCHEDULER before restarting (2026-06-23 fix). A
    // SATURATED routines fire-queue (legit long routines holding every slot) stalls fires WITHOUT a frozen
    // event loop; restarting then kills them mid-run + re-saturates → the 5-min restart LOOP that froze
    // git-sync + deploys for hours. Only restart if the scheduler (routinesTick) is ALSO stale.
    const schedSec = await schedulerIdleSec(dbUrl);
    if (!shouldRestart(idleSec, schedSec)) {
      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now;
        log(`fire-queue SATURATED, not frozen — routine last_fired_at ${idleSec}s stale BUT scheduler (routinesTick) fired ${schedSec}s ago (event loop alive). NOT restarting (would kill in-flight long routines + re-saturate).`);
      }
      return;
    }
    restart(`${UNIT} routine fires ${idleSec}s stale AND scheduler (routinesTick) ${schedSec == null ? 'UNKNOWN' : `${schedSec}s`} ago (> ${FREEZE_SILENCE_S}s) while active — ticker genuinely frozen (PG-confirmed, journald-independent)`);
    return;
  }
  // Healthy. Emit a throttled heartbeat so the durable log shows the watchdog is actively monitoring.
  const now = Date.now();
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    log(`ticker healthy — newest routine fired ${idleSec}s ago (<= ${FREEZE_SILENCE_S}s)`);
  }
}

function start() {
  log(`up — unit ${UNIT}, poll ${POLL_MS}ms, freeze-silence ${FREEZE_SILENCE_S}s, debounce ${DEBOUNCE_MS}ms, cap ${MAX_RESTARTS_PER_HR}/hr; signal=PG-routine-freshness (journald-independent); durable log ${LOG_FILE}`);
  setInterval(() => void poll().catch((e) => log(`poll error: ${e.message}`)), POLL_MS);
}

// Auto-start as the systemd unit (`node bghost-watchdog.mjs`). Tests set PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART=1
// before importing to exercise the pure decision logic without the poll loop / network.
if (process.env.PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART !== '1') start();
