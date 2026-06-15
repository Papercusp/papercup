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
import { runIdleSessionReap, findIdleLiveSessions } from '../../idle-session-reaper';

registerSystemAction('idle-session-reaper', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;

  // Read-only D-007 saturation metric — the LIVE-but-idle cohort (the sessions
  // that actually hold the event loop). Slice 2 will terminate these (flag-gated);
  // for now we only surface the count + the target list so the cohort is visible.
  const idleLive = await findIdleLiveSessions();
  console.log(
    `[idle-session-reaper] live-but-idle sessions: ${idleLive.length}` +
      (idleLive.length
        ? ` (oldest idle ~${Math.round(Math.max(...idleLive.map((s) => s.idleMs)) / 3_600_000)}h) — ` +
          `slice-2 termination target [ids: ${idleLive.slice(0, 20).map((s) => s.advSessionId).join(',')}${idleLive.length > 20 ? ',…' : ''}]`
        : ''),
  );

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
