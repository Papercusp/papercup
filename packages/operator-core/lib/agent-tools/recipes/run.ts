/**
 * recipes:run — THE REUSE PATH (code-recipes-2026-06-21 Phase 2, P-005 / P-006 /
 * D-004 / D-012).
 *
 * Load a saved code:run RECIPE by id and execute its script — but under the
 * REUSER's role-scoped envelope, NOT the author's. A recipe is just a script;
 * no privilege travels with it. The facade is built from
 * `roleScopedToolNames(all, ctx.role, exclude code:run)` — the SAME role-scoped
 * allow-set code:run itself builds for the CALLER — so when agent B runs agent A's
 * recipe, the script can only touch tools B may already call (D-004, the tested
 * security invariant P-006). A recipe authored by an operator and run by a worker
 * is scoped to worker-allowed tools.
 *
 * On a successful, non-dry-run reuse, records a run with `reused: true` (the
 * distinct-from-authored signal Phase-3 graduation reads). Best-effort recording —
 * a failure there must not fail the run. Returns the script's summary like code:run.
 *
 * Server-only.
 */
import { z } from 'zod';
import {
  defineTool,
  listAllProjectedTools,
  runToolOrchestration,
  roleScopedToolNames,
  SU_ROLES,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { hiveHomeSlugForHarness } from '../../hive-federation';
import { getRecipe, recordRecipeRun } from '../../code-recipes-store';
import { PROJECTED_DEPS } from '../../projected-tool-deps';

export default defineTool({
  name: 'recipes:run',
  description:
    'Run a saved code:run RECIPE by id — the reuse path. The recipe\'s script executes under YOUR ' +
    'role-scoped tool envelope (NOT the author\'s — no privilege travels with a recipe); returns ' +
    'only the script\'s summary. Use dryRun:true to preview write-effect mutations.',
  guidance: {
    when:
      'When a recipe already does what you need (found via recipes:search / recipes:list, or a ' +
      'code:run result\'s similarRecipes) — run it by id instead of re-authoring the same script. ' +
      'It runs under YOUR envelope, so you can only reuse recipes whose tools you may call.',
    notWhen:
      'When no existing recipe fits — author a fresh code:run (which also auto-captures + dedups). ' +
      'Preview the recipe\'s mutations with dryRun before a committing run.',
    chaining:
      'recipes:search { query } → recipes:get { id } (inspect) → recipes:run { id, dryRun:true } → ' +
      'recipes:run { id }.',
  },
  // Same gate as code:run: as powerful as the shell capability (it can call any of
  // the REUSER's write tools), role-gated to SU_ROLES + bee. The role-scoped facade
  // is the privilege boundary — the recipe carries none.
  capability: 'capability:bash',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    id: z.string().min(1).describe('The recipe id (kebab slug) to run.'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview: record effect:write tool calls without executing them (reads still run).'),
    timeoutSec: z.number().int().min(1).max(120).optional().describe('Wall-clock budget (default 30s).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const recipe = await getRecipe(getOrgPg().sql, workspaceId, args.id);
    if (!recipe) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_found', id: args.id }) }] };
    }

    const all = listAllProjectedTools();
    // SECURITY INVARIANT (D-004 / P-006): scope to the REUSER's role (ctx.role) —
    // NEVER recipe.authorRole. A recipe carries no privilege; the facade only
    // contains tools the running agent may already call. Exclude code:run so a
    // recipe can't recursively nest code-mode.
    const allowed = roleScopedToolNames(all, ctx.role, new Set(['code:run']));

    const result = await runToolOrchestration(recipe.script, {
      ctx,
      deps: PROJECTED_DEPS,
      tools: all,
      allowed,
      dryRun: args.dryRun ?? false,
      timeoutMs: args.timeoutSec ? args.timeoutSec * 1000 : undefined,
    });

    // Record the REUSE (reused:true) on a successful, committing run — the
    // distinct-from-authored signal Phase-3 graduation reads. Best-effort: a
    // recording failure must not fail the run.
    if (result.ok && !(args.dryRun ?? false)) {
      try {
        const hiveSlug = ctx.harnessSlug
          ? await hiveHomeSlugForHarness(workspaceId, ctx.harnessSlug).catch(() => null)
          : recipe.hiveSlug;
        let ownerId: string | null = null;
        try {
          const { resolveAgentIdentity } = await import('../coordination/identity');
          ownerId = resolveAgentIdentity(ctx).ownerId;
        } catch {
          ownerId = null;
        }
        await recordRecipeRun(getOrgPg().sql, {
          recipeId: recipe.id,
          workspaceId,
          hiveSlug,
          agentOwner: ownerId,
          agentRole: ctx.role ?? null,
          success: true,
          reused: true,
        });
      } catch (err) {
        ctx.log(`recipes:run record failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
      }
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
