/** P-005 uses the existing routine engine; no private timer or agent loop. */
import { registerSystemAction } from './system-actions';
import { sweepPlanItemAnchors } from '../../plan-items/anchor-freshness-sweep';
import { loadHarnessRegistry } from '../../harness-registry';
import { peekPushSnapshot } from '../../code-intelligence/push-snapshot';

export { PLAN_ANCHOR_FRESHNESS_CRON } from '../../plan-items/anchor-freshness-sweep';
registerSystemAction('plan-anchor-freshness', async ctx => {
  const root = (await loadHarnessRegistry(ctx.workspaceId)).projects.find(p => p.slug === ctx.installSlug)?.path;
  if (!root) throw new Error(`Plan-anchor freshness has no repository for ${ctx.installSlug}`);
  const result = await sweepPlanItemAnchors({ workspaceId: ctx.workspaceId, harnessSlug: ctx.installSlug, root,
    snapshot: peekPushSnapshot(ctx.installSlug), cap: typeof ctx.triggerConfig.cap === 'number' ? ctx.triggerConfig.cap : undefined });
  return { diagnostics: result };
});
