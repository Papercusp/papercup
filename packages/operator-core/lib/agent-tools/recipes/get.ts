/**
 * recipes:get — fetch one OR many reusable code:run RECIPEs by id, including the
 * full script (code-recipes-2026-06-21 Phase 2, P-005; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21).
 *
 * The script is returned so an agent can INSPECT what the recipe does before
 * recipes:run-ning it (or adapt it into a new code:run). GLOBAL — recipes are a
 * fleet-wide capability (P-001). Read-only.
 *
 * Bulk by default (the house keyed-array contract): pass `id` for one or `ids`
 * for several → { ok, results:[{ ok, id, recipe? | error }], counts } — each
 * result self-describes its id, so a not-found id never poisons the rest and the
 * agent correlates by id (not array position).
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getRecipe } from '../../code-recipes-store';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'recipes:get',
  description:
    'Fetch one OR many reusable code:run RECIPEs by id — including the full script — so you can inspect ' +
    'what they do before recipes:run-ning them. Pass `id` for one or `ids` for several. Returns ' +
    '{ ok, results:[{ ok, id, recipe? | error }], counts } — correlate by id, not by position; a ' +
    'missing id comes back as that item\'s { ok:false } without failing the rest. Read-only.',
  guidance: {
    when:
      'When you have one or more recipe ids (from recipes:list / recipes:search / a code:run result\'s ' +
      'similarRecipes) and want to read their script + metadata before reusing. Pass every id at once via `ids`.',
    notWhen:
      'To EXECUTE the recipe — use recipes:run (it runs the script under YOUR role-scoped envelope). ' +
      'To discover recipes by intent — recipes:search.',
    chaining:
      'recipes:search / recipes:list → recipes:get { ids:[…] } (inspect) → recipes:run { id } (reuse). ' +
      'Bulk: single | ids[] → { ok, results, counts }; correlate by id not position; one failure never fails the rest.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single recipe id / kebab slug (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('recipe ids to fetch (1–100)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args) {
    const sql = getOrgPg().sql;
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const recipe = await getRecipe(sql, id);
        if (!recipe) {
          return { ok: false as const, id, error: 'not_found' };
        }
        return {
          ok: true as const,
          id,
          recipe: {
            id: recipe.id,
            title: recipe.title,
            description: recipe.description,
            script: recipe.script,
            toolsUsed: recipe.toolsUsed,
            authorRole: recipe.authorRole,
            runCount: recipe.runCount,
            successCount: recipe.successCount,
            lastRunAt: recipe.lastRunAt,
            status: recipe.status,
            tags: recipe.tags,
          },
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
