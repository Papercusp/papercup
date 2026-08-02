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
});
