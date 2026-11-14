/**
 * `system:stuck-work-waiting-check` — the durable waiting check
 * (stuck-work-detection-and-honest-waits-2026-11-13 P-002, bar R-2).
 *
 * WIRING ONLY: the rule lives in `../../stuck-work/waiting-check.ts` (pure, unit-tested)
 * and the Postgres bindings in `../../stuck-work/waiting-check-adapters.ts`. Seeded as a
 * bespoke `tier:'ephemeral'` routine (600s) by `seed-stuck-work-waiting-check-routine.ts`:
 * the 4-hour rule needs no tighter cadence, and every count is re-read from the waits
 * table on each run, so a restart loses nothing.
 *
 * Notice switch (plan D-003): flag `papercusp-stuck-work-notices`. While it is OFF the
 * check runs silently and records each flagged group in the run diagnostics below, which
 * is the live per-day flag count P-010 reports before the switch goes on. An unreadable
 * flag is treated as OFF: a kill-switch must fail closed.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { registerSystemAction } from './system-actions';

/** Flagged groups kept in one run's diagnostics (the count is always exact). */
const FLAGGED_SAMPLE = 25;

registerSystemAction('stuck-work-waiting-check', async () => {
  const [{ activeWorkspaceId }, { runWaitingCheck }, { defaultWaitingCheckDeps }] = await Promise.all([
    import('../../workspace-registry'),
    import('../../stuck-work/waiting-check'),
    import('../../stuck-work/waiting-check-adapters'),
  ]);
  const workspaceId = activeWorkspaceId();
  const noticesEnabled = await getFlag(FLAGS.STUCK_WORK_NOTICES, 'system').catch(() => false);
  const lines: string[] = [];
  const result = await runWaitingCheck({
    ...defaultWaitingCheckDeps(workspaceId, (l) => lines.push(l)),
    noticesEnabled,
  });
  return {
    diagnostics: {
      workspaceId,
      silent: result.silent,
      flags: result.flags,
      firstNotices: result.firstNotices,
      repeatNotices: result.repeatNotices,
      flagged: result.flagged.slice(0, FLAGGED_SAMPLE).map((f) => ({
        groupKey: f.groupKey,
        itemId: f.item?.id ?? null,
        assigned: Boolean(f.item?.assignee),
        missedAlarms: f.missedAlarms,
        waiters: f.waiters.length,
        firstWaitAt: new Date(f.firstWaitAtMs).toISOString(),
      })),
      failures: lines.length,
      failureSample: lines.slice(0, 3),
    },
  };
});
