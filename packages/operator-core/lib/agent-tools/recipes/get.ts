/**
 * recipes:get — fetch one reusable code:run RECIPE by id, including its full
 * script (code-recipes-2026-06-21 Phase 2, P-005).
 *
 * The script is returned so an agent can INSPECT what the recipe does before
 * recipes:run-ning it (or adapt it into a new code:run). Workspace-scoped — a
 * recipe in another workspace is invisible. Read-only.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { getRecipe } from '../../code-recipes-store';

export default defineTool({
  name: 'recipes:get',
  description:
    'Fetch one reusable code:run RECIPE by id — including its full script — so you can inspect ' +
    'what it does before recipes:run-ning it. Read-only.',
  guidance: {
    when:
      'When you have a recipe id (from recipes:list / recipes:search / a code:run result\'s ' +
      'similarRecipes) and want to read its script + metadata before reusing it.',
    notWhen:
      'To EXECUTE the recipe — use recipes:run (it runs the script under YOUR role-scoped envelope). ' +
      'To discover recipes by intent — recipes:search.',
    chaining:
      'recipes:search / recipes:list → recipes:get { id } (inspect) → recipes:run { id } (reuse).',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    id: z.string().min(1).describe('The recipe id (kebab slug).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const recipe = await getRecipe(getOrgPg().sql, workspaceId, args.id);
    if (!recipe) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_found', id: args.id }) }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
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
              hiveSlug: recipe.hiveSlug,
              tags: recipe.tags,
            },
          }),
        },
      ],
    };
  },
});
