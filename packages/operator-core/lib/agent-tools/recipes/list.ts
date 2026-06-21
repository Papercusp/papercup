/**
 * recipes:list — the agent-facing read of reusable code:run RECIPES for the
 * caller's hive (code-recipes-2026-06-21 Phase 2, P-005).
 *
 * A recipe is a saved code:run script (captured on every successful run, D-012);
 * recipes share at the HIVE boundary (D-005). This lists the active recipes for
 * the caller's home hive, most-run first (the hot recipes surface), so an agent
 * can browse what's reusable before authoring a fresh code:run. Read-only.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { hiveHomeSlugForHarness } from '../../hive-federation';
import { listRecipes } from '../../code-recipes-store';

export default defineTool({
  name: 'recipes:list',
  description:
    'List reusable code:run RECIPES for your hive (most-run first). A recipe is a saved code:run ' +
    'script other agents authored; browse them to reuse instead of re-authoring. Read-only.',
  guidance: {
    when:
      'Before authoring a multi-step code:run, to see what reusable recipes already exist in your ' +
      'hive — the hot ones surface first. If one fits, recipes:run it instead of re-writing the script.',
    notWhen:
      'When you already know the recipe id (recipes:get), or to find a recipe by intent (recipes:search ' +
      'ranks by semantic + tool-set similarity). This is the plain most-run-first browse.',
    chaining:
      'recipes:list → recipes:get { id } to inspect the script → recipes:run { id } to reuse it.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    limit: z.number().int().min(1).max(100).optional().describe('Max recipes to return (default 25).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const hiveSlug = ctx.harnessSlug
      ? await hiveHomeSlugForHarness(workspaceId, ctx.harnessSlug).catch(() => null)
      : null;
    const limit = args.limit ?? 25;
    const all = await listRecipes(getOrgPg().sql, workspaceId, { hiveSlug });
    const recipes = all.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      toolsUsed: r.toolsUsed,
      runCount: r.runCount,
      successCount: r.successCount,
      lastRunAt: r.lastRunAt,
      status: r.status,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, hiveSlug, count: recipes.length, recipes }) }],
    };
  },
});
