/**
 * `system:idle-session-reaper` — the P-011 (D-007) idle-session reaper.
 *
 * Marks DEAD-process open `adv_sessions` rows ended (owner dropped out of the
 * liveness set past the grace window), reclaiming the live roster + unblocking
 * `session-dir-gc` (which protects every `ended_at IS NULL` row). Design +
 * safety model live in `idle-session-reaper.ts`.
 *
 * DOUBLE-GATED + safe: flag-gated DEFAULT-OFF (FLAGS.IDLE_SESSION_REAPER → a
 * no-op until armed) AND the routine is seeded INACTIVE. This slice only ever
 * touches sessions whose process is already dead — it never terminates a live
 * session (that's the follow-on slice; see the plan).
 *
 * trigger_config (optional): `dry_run` — plan + log, mark nothing.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import {
  runIdleSessionReap,
  findIdleLiveSessions,
  terminateIdleLiveSessions,
  reapZombieResumeProcs,
} from '../../idle-session-reaper';

registerSystemAction('idle-session-reaper', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;

  // Slice 3 (EI-1873) FIRST — the dominant fleet leak: ZOMBIE `claude --resume`
  // procs whose adv_session is ENDED but the process never exited (32 of them
  // wedged the box on 2026-06-20). Deterministic (ended session + live proc) and
  // starvation-independent — unlike the presence-based slices below, it does not
  // depend on the supervisor heartbeat the overload starves. DOUBLE-GATED.
  const zomb = await reapZombieResumeProcs({ dryRun });
  if (zomb.enabled) {
    console.log(
      `[idle-session-reaper] zombie-proc reap: scanned ${zomb.scannedProcs} resume-proc(s) → ` +
        `${zomb.dryRun ? 'WOULD kill' : 'killed'} ${zomb.zombies} zombie(s)` +
        (zomb.killedPids.length
          ? ` [pids: ${zomb.killedPids.slice(0, 20).join(',')}${zomb.killedPids.length > 20 ? ',…' : ''}]`
          : ''),
    );
  }

  // Read-only D-007 saturation metric — the LIVE-but-idle cohort (the sessions
  // that actually hold the event loop). Slice 2 terminates these (double-gated);
  // surfacing the count + the target list keeps the cohort visible even when the
  // terminate flag is off.
  const idleLive = await findIdleLiveSessions();
  console.log(
    `[idle-session-reaper] live-but-idle sessions: ${idleLive.length}` +
      (idleLive.length
        ? ` (oldest idle ~${Math.round(Math.max(...idleLive.map((s) => s.idleMs)) / 3_600_000)}h) — ` +
          `slice-2 termination target [ids: ${idleLive.slice(0, 20).map((s) => s.advSessionId).join(',')}${idleLive.length > 20 ? ',…' : ''}]`
        : ''),
  );

  // Live-but-idle TERMINATION (slice 2 / WI-152) — DOUBLE-GATED DEFAULT-OFF
  // (a no-op unless BOTH IDLE_SESSION_REAPER and IDLE_SESSION_REAPER_TERMINATE
  // are on). Ctrl-C → SIGKILL → mark ended; busy owners already excluded.
  const term = await terminateIdleLiveSessions({ dryRun });
  if (term.enabled) {
    console.log(
      `[idle-session-reaper] live-idle terminate: targeted ${term.targeted} → ` +
        `${term.dryRun ? 'WOULD terminate' : 'terminated'} ${term.terminated}, failed ${term.failed}` +
        (term.terminatedIds.length
          ? ` [ids: ${term.terminatedIds.slice(0, 20).join(',')}${term.terminatedIds.length > 20 ? ',…' : ''}]`
          : ''),
    );
  } else {
    console.log(
      '[idle-session-reaper] terminate flags off (need papercusp-idle-session-reaper + papercusp-idle-session-reaper-terminate) — live-idle termination skipped',
    );
  }

  // Dead-process ghost reap (slice 1) — flag-gated DEFAULT-OFF.
  const r = await runIdleSessionReap({ dryRun });
  if (!r.enabled) {
    console.log('[idle-session-reaper] reap flag off (papercusp-idle-session-reaper) — ghost reap skipped');
    return;
  }
  console.log(
    `[idle-session-reaper] scanned ${r.scanned} open session(s) → ` +
      `${r.dryRun ? 'WOULD end' : 'ended'} ${r.reaped} dead-process ghost(s), ` +
      `kept ${r.keptLive} live` +
      (r.reapedIds.length
        ? ` [ids: ${r.reapedIds.slice(0, 20).join(',')}${r.reapedIds.length > 20 ? ',…' : ''}]`
        : ''),
  );
});
