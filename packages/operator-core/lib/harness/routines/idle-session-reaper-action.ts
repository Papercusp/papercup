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
import { runIdleSessionReap } from '../../idle-session-reaper';

registerSystemAction('idle-session-reaper', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;
  const r = await runIdleSessionReap({ dryRun });
  if (!r.enabled) {
    console.log('[idle-session-reaper] flag off (papercusp-idle-session-reaper) — no-op');
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
