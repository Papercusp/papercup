/**
 * `system:sweep-stalled-loops` — the registration seam for {@link sweepStalledLoops}
 * (WI-6639).
 *
 * Thin by design, matching `gc-dead-loops-action.ts`: the sweep logic lives in
 * `stalled-loops-guard.ts`; this file only puts it on a cadence.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `dry_run` — report matches without disarming or broadcasting.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sweepStalledLoops } from './stalled-loops-guard';

registerSystemAction('sweep-stalled-loops', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const result = await sweepStalledLoops({ workspaceId: ctx.workspaceId, dryRun: cfg.dry_run === true });
  if (result.paused > 0) {
    console.log(
      `[sweep-stalled-loops] ${result.dryRun ? 'would auto-disarm' : 'auto-disarmed'} ${result.paused}/` +
        `${result.checked} armed loop(s) with no turns produced despite repeated fires, e.g. ${result.sample.join(', ')}`,
    );
  }
  // EI-19362678179163398: a non-zero veto count is a LIVE signal that last_turn_at is
  // under-reporting again (the exact failure class this guard's own root-cause fix
  // closed once already) — surfaced loudly rather than silently swallowed, since the
  // guard's per-owner console.warn inside the sweep is easy to miss in a routine's log.
  if (result.vetoedByRecentTurn.length > 0) {
    console.warn(
      `[sweep-stalled-loops] VETOED ${result.vetoedByRecentTurn.length} owner(s) that read turnsStalled:true ` +
        `but had produced a real turn inside the floor — last_turn_at may be under-reporting again ` +
        `(EI-19362678179163398): ${result.vetoedByRecentTurn.join(', ')}`,
    );
  }
  // EI-19406534159939583: fire-starved loops are the INFRASTRUCTURE half of this sweep — live
  // agents that answered every fire and then stopped receiving them. Surfaced at warn level and
  // separately from the disarm line above, because the two findings blame opposite parties and
  // the sweep that conflated them took 5 of a 10-member fleet dark.
  if (result.reArmedFireStarved.length > 0) {
    console.warn(
      `[sweep-stalled-loops] FIRE-STARVED ${result.reArmedFireStarved.length}/${result.checked} loop(s) ` +
        `${result.dryRun ? 'would be re-armed' : 're-armed'} (NOT disarmed) — each answered its last fire ` +
        `and none has arrived since, so the loop-firing path stopped serving live agents ` +
        `(EI-19406534159939583): ${result.reArmedFireStarved.join(', ')}`,
    );
  }
});
