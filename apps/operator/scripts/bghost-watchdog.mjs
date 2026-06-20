#!/usr/bin/env node
/**
 * bg-host (DBOS routines / git-sync / substrate) ticker watchdog — 2026-06-20.
 *
 * `papercup-bg-host`'s event loop gets STARVED under heavy box load (many concurrent agents), freezing the
 * routines + git-sync ticker: the process stays `active` (so systemd Restart=always NEVER fires) but the
 * journal goes SILENT and git-sync stops committing — so ALL fleet work stops persisting to origin/staging
 * (the recurring 2026-06-20 overnight freeze; restarted manually 2x). This polls the unit's journal; the
 * ticker normally logs routine/git-sync activity every ~30s, so if it's been SILENT while `active` for
 * FREEZE_SILENCE_S, the ticker is frozen → restart the unit to revive it (su-f9722's documented-safe fix:
 * Restart=always, working tree kopia-backed, separate from the user-facing :3070).
 *
 * SAFE FOR UNATTENDED OPERATION: a restart debounce + a circuit breaker (MAX_RESTARTS_PER_HR per rolling
 * hour, then it STOPS and only logs) so a misfire can't restart-loop the ticker. journalctl failures are
 * treated as "unknown" (skipped), never as "frozen", to avoid false restarts.
 *
 * Env (all optional): PAPERCUSP_BGHOST_WATCHDOG_{UNIT,POLL_MS,SILENCE_S,DEBOUNCE_MS,MAX_RESTARTS_HR}.
 */
import { execFile } from 'node:child_process';

const UNIT = process.env.PAPERCUSP_BGHOST_WATCHDOG_UNIT || 'papercup-bg-host';
const POLL_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_POLL_MS) || 30_000;
const FREEZE_SILENCE_S = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_SILENCE_S) || 100; // silent this long while active = frozen
const DEBOUNCE_MS = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_DEBOUNCE_MS) || 5 * 60_000;
const MAX_RESTARTS_PER_HR = Number(process.env.PAPERCUSP_BGHOST_WATCHDOG_MAX_RESTARTS_HR) || 8;

let lastRestart = 0;
const restartTimes = []; // epoch ms, rolling 1h, for the circuit breaker
const log = (m) => console.log(`[bghost-watchdog ${new Date().toISOString()}] ${m}`);

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => resolve({ err, stdout: stdout || '' }));
  });
}

function restart(reason) {
  const now = Date.now();
  if (now - lastRestart < DEBOUNCE_MS) {
    log(`SUPPRESS (debounce ${Math.round((DEBOUNCE_MS - (now - lastRestart)) / 1000)}s left): ${reason}`);
    return;
  }
  while (restartTimes.length && now - restartTimes[0] > 3_600_000) restartTimes.shift();
  if (restartTimes.length >= MAX_RESTARTS_PER_HR) {
    log(`CIRCUIT OPEN: ${restartTimes.length} restarts in the last hour >= cap ${MAX_RESTARTS_PER_HR} — NOT restarting (${reason}). The box is thrashing; needs human attention (reduce load).`);
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
  const j = await sh('journalctl', ['--user', '-u', UNIT, '--since', `-${FREEZE_SILENCE_S} sec`, '--no-pager', '-q']);
  if (j.err) {
    log(`journalctl failed (${j.err.message}) — skipping this poll (not concluding frozen)`);
    return;
  }
  const lines = j.stdout.split('\n').filter((l) => l.trim().length > 0).length;
  if (lines === 0) {
    restart(`${UNIT} journal SILENT ${FREEZE_SILENCE_S}s while active — ticker frozen (no routine/git-sync activity)`);
  }
}

log(`up — unit ${UNIT}, poll ${POLL_MS}ms, freeze-silence ${FREEZE_SILENCE_S}s, debounce ${DEBOUNCE_MS}ms, cap ${MAX_RESTARTS_PER_HR}/hr`);
setInterval(() => void poll().catch((e) => log(`poll error: ${e.message}`)), POLL_MS);
