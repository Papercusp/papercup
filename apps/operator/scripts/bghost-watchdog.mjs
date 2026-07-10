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
 * BOOT GRACE (EI-8901, 2026-07-10) — the staleness signal (`MAX(last_fired_at)` / `MAX(created_at)` for
 * routinesTick) is read from Postgres and so SPANS process restarts: a freshly-restarted unit that hasn't
 * ticked yet still reads as "frozen for Nmin" (the age of the LAST tick from the PREVIOUS generation), and
 * papercup-bg-host takes ~4-5min to boot (ExecStartPre esbuild bundle), longer under load. With
 * DEBOUNCE_MS=5min this manifests as a RESTART STORM: every new generation is judged frozen before it can
 * possibly tick, gets restarted again, forever (until the hourly circuit breaker opens). The fix: after a
 * restart (by us OR anyone else — `systemctl restart papercup-bg-host` by hand hits the same trap), grant a
 * BOOT GRACE measured from systemd's OWN `ActiveEnterTimestampMonotonic` (restart-attribution-safe,
 * independent of this watchdog's own in-memory state) — skip the freeze judgment entirely while the unit
 * has been active less than BOOT_GRACE_MS. A boot-time-unknown reading (systemctl/proc read failure) does
 * NOT grant grace (fails to the pre-existing behavior, never invents extra suppression from a missing
 * signal — same asymmetry principle as `isFrozen`).
 *
 * BACKOFF + ALERT (WI-3630, 2026-07-10 — completes the restart-storm fix above; EI-8901 landed (a)/(b)).
 * The boot-grace check stops the storm in the common case, but a boot that runs even LONGER than
 * BOOT_GRACE_MS (worse host pressure than observed) would still hit the OLD flat DEBOUNCE_MS and get
 * killed right as it might have finished booting. Each ACTUAL restart now counts as a "consecutive
 * strike": the debounce before the NEXT restart may fire DOUBLES per strike (BACKOFF_MULTIPLIER, capped
 * at MAX_DEBOUNCE_MS) — so an unusually slow boot gets progressively more room instead of being re-killed
 * on the same fixed clock, and the strike counter resets the moment a poll observes the ticker genuinely
 * healthy again. From ALERT_AFTER_RESTARTS consecutive strikes — well before the MAX_RESTARTS_PER_HR
 * circuit breaker — `alertFleet()` best-effort broadcasts to every running agent via
 * `harness_shared.coord_event_log` (the same table `coord:send`/severe-event-broadcast write: to:['*'],
 * surface 'messages', so it lands in coord:inbox for every agent's next turn, journald-independent and
 * independent of THIS watchdog's own log file — the EI-2434 precedent showed a durable log nobody tails
 * is invisible for 44h; a running fleet that could actually intervene should see it).
 *
 * Env (all optional): PAPERCUSP_BGHOST_WATCHDOG_{UNIT,POLL_MS,SILENCE_S,DEBOUNCE_MS,MAX_RESTARTS_HR,DB_URL,LOG,
 *   BOOT_GRACE_MS,BACKOFF_MULTIPLIER,MAX_DEBOUNCE_MS,ALERT_AFTER_RESTARTS}, PAPERCUSP_INTEGRATION_ROOT, DATABASE_URL.
 */
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { cpus, freemem, homedir, hostname, loadavg, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIT = process.env.PAPERCUSP_BGHOST_WATCHDOG_UNIT || 'papercup-bg-host';
const POLL_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_POLL_MS) || 30_000;
const FREEZE_SILENCE_S = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_SILENCE_S) || 100; // newest routine older than this while active = frozen
const DEBOUNCE_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_DEBOUNCE_MS) || 5 * 60_000;
const MAX_RESTARTS_PER_HR = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_MAX_RESTARTS_HR) || 8;
/** Skip the freeze judgment while the unit has been active less than this long (EI-8901): the observed
 *  boot takes ~4-5min under load; default is a bit over 2x that plus buffer so a slow boot never gets
 *  judged frozen mid-boot. */
const BOOT_GRACE_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_BOOT_GRACE_MS) || 8 * 60_000;
/** WI-3630: each consecutive restart multiplies the debounce by this much (capped at MAX_DEBOUNCE_MS) — an
 *  unusually slow boot (worse than BOOT_GRACE_MS anticipated) gets progressively more room instead of being
 *  re-killed on the same fixed clock. */
const BACKOFF_MULTIPLIER = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_BACKOFF_MULTIPLIER) || 2;
const MAX_DEBOUNCE_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_MAX_DEBOUNCE_MS) || 30 * 60_000;
/** WI-3630: fire `alertFleet()` once consecutive restarts reach this — well before MAX_RESTARTS_PER_HR (the
 *  hard breaker), so a running fleet sees a developing storm instead of only a fully-tripped one. */
const ALERT_AFTER_RESTARTS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_ALERT_AFTER_RESTARTS) || 2;
/** Throttled "still monitoring + ticker healthy" line so the durable log proves the watchdog is ACTIVELY
 *  reading freshness (not silently early-returning) — the operability gap that made this whole class
 *  invisible for 44h. First healthy poll logs immediately, then at most every HEARTBEAT_MS. */
const HEARTBEAT_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_HEARTBEAT_MS) || 10 * 60_000;
/** Durable, journald-INDEPENDENT decision log (EI-2434: journald can't be trusted to capture stdout). */
const LOG_FILE = process.env.PAPERCUSP_BGHOST_WATCHDOG_LOG || join(homedir(), '.papercusp', 'bghost-watchdog.log');
/** deploys:vintage self-report sink (fleet-reliability-verification-2026-07-10 P-008) — see the
 *  matching constant in inference-gateway/watchdog.mjs for the rationale (this watchdog is itself
 *  a tracked runtime). Default target :3070 (always-up release operator, two-port model). */
const VINTAGE_URL = process.env.PAPERCUSP_RUNTIME_VINTAGE_URL || 'http://127.0.0.1:3070/api/internal/runtime-vintage';

let lastRestart = 0;
let lastHeartbeat = 0;
const restartTimes = []; // epoch ms, rolling 1h, for the circuit breaker
// WI-3630: consecutive-restart strike count driving the backoff + alert. Resets to 0 the moment a poll
// observes the ticker genuinely healthy (NOT merely "within boot grace" — a storm isn't over until a
// routine actually fires fresh again).
let consecutiveRestarts = 0;
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

/** Pure boot-grace verdict (EI-8901): a NUMBER active-for age under the grace window means "still booting,
 *  don't judge" — null/undefined (unknown boot time) is NEVER grace (fails to the pre-existing behavior;
 *  never invents suppression from a missing signal, mirroring `isFrozen`'s null-is-never-frozen asymmetry). */
export function withinBootGrace(activeForSec, bootGraceMs = BOOT_GRACE_MS) {
  return activeForSec != null && activeForSec >= 0 && activeForSec * 1000 < bootGraceMs;
}

/** How long (seconds) the unit has been in its CURRENT active generation — from systemd's own
 *  ActiveEnterTimestampMonotonic (µs since boot) vs. the current boot-relative clock (/proc/uptime),
 *  which sidesteps wall-clock/timezone parsing entirely and is safe even if a restart happened from
 *  outside this watchdog (`systemctl restart` by hand, or a prior watchdog process that has since died).
 *  Returns null (UNKNOWN) on any read fault — property absent/zero (unit never active), unreadable
 *  /proc/uptime, or a non-finite parse. */
async function unitActiveForSec(readFile = readFileSync) {
  let uptimeSec;
  try {
    uptimeSec = parseFloat(String(readFile('/proc/uptime', 'utf8')).trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
  if (!Number.isFinite(uptimeSec)) return null;
  const r = await sh('systemctl', ['--user', 'show', UNIT, '-p', 'ActiveEnterTimestampMonotonic', '--value']);
  if (r.err) return null;
  const activeMonoUsec = Number(r.stdout.trim());
  if (!Number.isFinite(activeMonoUsec) || activeMonoUsec <= 0) return null;
  const activeForSec = uptimeSec - activeMonoUsec / 1_000_000;
  return activeForSec >= 0 ? activeForSec : null;
}

/** Pure exponential-backoff debounce (WI-3630): the debounce before the NEXT restart may fire, given how
 *  many restarts have already happened CONSECUTIVELY (without an intervening healthy poll). Doubles
 *  (default multiplier) per strike, capped at `capMs` so it can't grow unbounded. `consecutiveRestarts <= 0`
 *  (the first restart of a fresh storm) is just the base debounce. */
export function nextDebounceMs(baseMs, consecutiveRestartsArg, multiplier = BACKOFF_MULTIPLIER, capMs = MAX_DEBOUNCE_MS) {
  const strikes = Math.max(0, consecutiveRestartsArg || 0);
  const scaled = baseMs * multiplier ** strikes;
  return Math.min(scaled, capMs);
}

/** Pure alert-threshold verdict (WI-3630): true once consecutive restarts reach `alertAfter` — fired well
 *  before the hard MAX_RESTARTS_PER_HR circuit breaker so a developing storm is visible early. */
export function shouldAlert(consecutiveRestartsArg, alertAfter = ALERT_AFTER_RESTARTS) {
  return (consecutiveRestartsArg || 0) >= alertAfter;
}

/**
 * Best-effort, fail-soft broadcast to every running agent (WI-3630) — the durable log file (LOG_FILE) is
 * journald-independent but nobody actively tails it (the EI-2434 precedent: a real freeze-storm sat
 * invisible for 44h). Writes DIRECTLY into `harness_shared.coord_event_log` — the same table
 * `coord:send`/`severe-event-broadcast.ts` write (verified shape: surface='messages', body is the
 * CoordEnvelope JSON `sendMessage` builds) — so it surfaces in every agent's `coord:inbox` on their next
 * turn via the EXISTING `coord_event_log_notify_trg` pg_notify wake rail, with zero new infrastructure.
 * Uses psql `-v` bind-variables (never raw string interpolation) so the JSON payload is always safely
 * quoted. Never throws — a broadcast failure must not affect the restart decision it accompanies.
 */
export async function alertFleet(summary, deps = {}) {
  const { sh: shImpl = sh, log: logImpl = log } = deps;
  try {
    // `dbUrl` is only used when the CALLER explicitly passes the key (even as null/'') — tests inject a
    // fixed value (including null, to exercise the "unresolvable" path) without touching the real
    // systemctl/psql resolution; production calls (no `deps`) always fall back to resolveDbUrlAsync().
    const url = Object.prototype.hasOwnProperty.call(deps, 'dbUrl') ? deps.dbUrl : await resolveDbUrlAsync();
    if (!url) {
      logImpl('alertFleet SKIPPED (no DB url resolvable)');
      return false;
    }
    const msgId = `bghost-watchdog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = JSON.stringify({
      ts: new Date().toISOString(),
      msg_id: msgId,
      from: 'system-watchdog',
      to: ['*'],
      kind: 'message',
      summary,
      category: 'severe-event',
    });
    const sql =
      "INSERT INTO harness_shared.coord_event_log (id, workspace_id, surface, writer_key, msg_id, body) " +
      "VALUES (nextval('harness_shared.coord_event_log_id_seq'), 'default', 'messages', 'bghost-watchdog', :'msgid', :'jsonbody'::jsonb)";
    const r = await shImpl('psql', [url, '-v', `msgid=${msgId}`, '-v', `jsonbody=${body}`, '-c', sql]);
    if (r.err) {
      logImpl(`alertFleet FAILED (non-fatal): ${r.err.message}`);
      return false;
    }
    return true;
  } catch (e) {
    logImpl(`alertFleet FAILED (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
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
  // WI-3630: the debounce before the NEXT restart backs off exponentially with each consecutive strike
  // (never killed on the same fixed 5min clock through a slower-than-anticipated boot).
  const debounceMs = nextDebounceMs(DEBOUNCE_MS, consecutiveRestarts);
  if (now - lastRestart < debounceMs) {
    log(`SUPPRESS (backoff ${Math.round((debounceMs - (now - lastRestart)) / 1000)}s left, consecutive strike #${consecutiveRestarts}): ${reason}`);
    return;
  }
  while (restartTimes.length && now - restartTimes[0] > 3_600_000) restartTimes.shift();
  if (restartTimes.length >= MAX_RESTARTS_PER_HR) {
    const msg = circuitOpenMessage(reason, restartTimes.length, MAX_RESTARTS_PER_HR);
    log(msg);
    void alertFleet(`⚠ ${UNIT} watchdog CIRCUIT OPEN — ${restartTimes.length} restarts in the last hour, capped. ${msg}`);
    return;
  }
  lastRestart = now;
  restartTimes.push(now);
  consecutiveRestarts += 1;
  const nextBackoffS = Math.round(nextDebounceMs(DEBOUNCE_MS, consecutiveRestarts) / 1000);
  log(`FROZEN -> restarting ${UNIT} (consecutive strike #${consecutiveRestarts}, next backoff ${nextBackoffS}s): ${reason}`);
  if (shouldAlert(consecutiveRestarts)) {
    void alertFleet(
      `⚠ ${UNIT} restarted ${consecutiveRestarts}x in a row (possible restart-storm) — ${reason}. ` +
        `Next restart backed off ${nextBackoffS}s; hard circuit breaker at ${MAX_RESTARTS_PER_HR}/hr. Investigate before it trips.`,
    );
  }
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
    // BOOT GRACE (EI-8901): the staleness signal SPANS restarts (it's the last tick's age, from PG) — a
    // freshly-restarted unit that hasn't ticked yet still reads as frozen. Check this FIRST, before the
    // saturation corroboration below, because right after a restart BOTH signals (routine fires AND the
    // routinesTick scheduler) are still stale from the previous generation — corroborating wouldn't help;
    // only the passage of boot time does.
    const activeForSec = await unitActiveForSec();
    if (withinBootGrace(activeForSec)) {
      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now;
        log(`within boot grace (unit active ${Math.round(activeForSec)}s < ${Math.round(BOOT_GRACE_MS / 1000)}s) — routine staleness (${idleSec}s) spans the restart, not a fresh freeze. NOT restarting.`);
      }
      return;
    }
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
  // Healthy. WI-3630: a genuinely fresh fire means any prior storm is OVER — reset the consecutive-strike
  // counter so a LATER, unrelated freeze starts its backoff from the base debounce, not wherever a past
  // storm left off.
  if (consecutiveRestarts > 0) {
    log(`ticker recovered (fired ${idleSec}s ago) — clearing consecutive-restart strike count (was ${consecutiveRestarts})`);
    consecutiveRestarts = 0;
  }
  // Emit a throttled heartbeat so the durable log shows the watchdog is actively monitoring.
  const now = Date.now();
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    log(`ticker healthy — newest routine fired ${idleSec}s ago (<= ${FREEZE_SILENCE_S}s)`);
  }
}

/** Mirrors build-info.ts's resolveBuildInfo() sha resolution (see watchdog.mjs's twin helper). */
function resolveTreeSha() {
  const envSha = process.env.PAPERCUSP_BUILD_SHA?.trim();
  if (envSha) return envSha;
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Best-effort boot self-report into the deploys:vintage ledger (P-008) — never throws/blocks. */
async function reportVintage(unit) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3_000);
    await fetch(VINTAGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        unit,
        host: hostname(),
        treeSha: resolveTreeSha(),
        buildTime: new Date().toISOString(),
        pid: process.pid,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    log(`[runtime-vintage] boot self-report failed (non-fatal): ${e.message}`);
  }
}

function start() {
  log(
    `up — unit ${UNIT}, poll ${POLL_MS}ms, freeze-silence ${FREEZE_SILENCE_S}s, debounce ${DEBOUNCE_MS}ms (backoff x${BACKOFF_MULTIPLIER}, cap ${MAX_DEBOUNCE_MS}ms), ` +
      `boot-grace ${BOOT_GRACE_MS}ms, alert-after ${ALERT_AFTER_RESTARTS} consecutive restarts, circuit cap ${MAX_RESTARTS_PER_HR}/hr; ` +
      `signal=PG-routine-freshness (journald-independent); durable log ${LOG_FILE}`,
  );
  void reportVintage('bghost-watchdog');
  setInterval(() => void poll().catch((e) => log(`poll error: ${e.message}`)), POLL_MS);
}

// Auto-start as the systemd unit (`node bghost-watchdog.mjs`). Tests set PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART=1
// before importing to exercise the pure decision logic without the poll loop / network.
if (process.env.PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART !== '1') start();
