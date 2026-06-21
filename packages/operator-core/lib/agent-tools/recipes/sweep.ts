/**
 * recipes:sweep — retire the stale long-tail of never-reused one-off code:run
 * RECIPES so the corpus doesn't accumulate dead weight (mirror
 * learning_packs:sweep; code-recipes-2026-06-21 Phase 4, P-010).
 *
 * Selects ACTIVE recipes whose last_run_at is older than `staleDays` AND whose
 * run_count is at or below `maxRunCount` (one-offs nobody reused), and flips them
 * to status='retired'. It NEVER touches a hot recipe (run_count over the cap), a
 * recipe run recently, or a promoted / merged / already-retired one (the
 * status='active' filter) — hygiene can't strand a graduated or consolidated
 * recipe. Reversible (a status flip).
 *
 * PREVIEW-FIRST: dryRun defaults to TRUE — the first call returns the candidates
 * WITHOUT changing anything; pass dryRun:false to actually retire them. A REVIEW
 * / curation action (not bee-authored) → SU_ROLES only.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { hiveHomeSlugForHarness } from '../../hive-federation';
import { sweepRecipes } from '../../code-recipes-store';

export default defineTool({
  name: 'recipes:sweep',
  description:
    'Retire the stale long-tail of never-reused one-off code:run RECIPES (active, last run older than ' +
    'staleDays AND run_count <= maxRunCount). NEVER retires a hot, recently-run, promoted, or merged ' +
    'recipe. dryRun (DEFAULT TRUE) previews the candidates without changing anything — pass ' +
    'dryRun:false to actually retire. Reversible (a status flip).',
  guidance: {
    when:
      'Periodic hygiene (a Queen idle-turn task) to clear the long tail of one-off recipes that were ' +
      'authored on a single run and never reused. ALWAYS run it once with the default dryRun:true to ' +
      'review the candidates, then dryRun:false to retire them.',
    notWhen:
      'To merge near-duplicates (recipes:merge) or to find promote candidates (recipes:candidates). ' +
      'Don\'t lower staleDays/raise maxRunCount aggressively — that risks retiring recipes still ' +
      'finding their audience; the conservative defaults (30 days, <=1 run) target only true one-offs.',
    chaining:
      'recipes:sweep { dryRun: true } (review the would-retire list) → recipes:sweep { dryRun: false } ' +
      '(commit). recipes:get { id } to inspect any candidate before committing.',
  },
  // Mutates the recipe corpus on a real run; dryRun is a preview WITHIN the write
  // tool (the same dryRun-on-a-write-capability shape recipes:run uses).
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    staleDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Retire recipes last run more than this many days ago (default 30).'),
    maxRunCount: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Only retire recipes run at most this many times — the one-off cap (default 1).'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview only — return the candidates without retiring them. DEFAULTS TO TRUE; pass false to commit.'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const hiveSlug = ctx.harnessSlug
      ? await hiveHomeSlugForHarness(workspaceId, ctx.harnessSlug).catch(() => null)
      : null;
    // Preview-first: default to dryRun unless the caller explicitly commits.
    const dryRun = args.dryRun ?? true;
    const { swept } = await sweepRecipes(getOrgPg().sql, {
      workspaceId,
      hiveSlug,
      staleDays: args.staleDays,
      maxRunCount: args.maxRunCount,
      dryRun,
    });

    // Live-update the /admin/recipes dashboard (P-009): a real sweep that retired
    // anything shifts the list + the candidate worklist. A dryRun mutates nothing,
    // so it never invalidates. Best-effort.
    if (!dryRun && swept.length > 0) {
      const { notifyRecipesChanged } = await import('../code/capture-recipe');
      await notifyRecipesChanged((msg) => ctx.log(msg));
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            dryRun,
            hiveSlug,
            count: swept.length,
            recipes: swept.map((r) => ({
              id: r.id,
              title: r.title,
              runCount: r.runCount,
              successCount: r.successCount,
              lastRunAt: r.lastRunAt,
              status: r.status,
            })),
          }),
        },
      ],
    };
  },
});
