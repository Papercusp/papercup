/**
 * recipes:run — THE REUSE PATH (code-recipes-2026-06-21 Phase 2, P-005 / P-006 /
 * D-004 / D-012; bulk-standardized per bulk-endpoint-standardization-2026-06-21).
 *
 * Load one OR many saved code:run RECIPEs by id and execute each script — but
 * under the REUSER's role-scoped envelope, NOT the author's. A recipe is just a
 * script; no privilege travels with it. The facade is built from
 * `roleScopedToolNames(all, ctx.role, exclude code:run)` — the SAME role-scoped
 * allow-set code:run itself builds for the CALLER — so when agent B runs agent A's
 * recipe, the script can only touch tools B may already call (D-004, the tested
 * security invariant P-006). A recipe authored by an operator and run by a worker
 * is scoped to worker-allowed tools.
 *
 * On a successful, non-dry-run reuse, records a run with `reused: true` (the
 * distinct-from-authored signal Phase-3 graduation reads). Best-effort recording —
 * a failure there must not fail the run. Returns each script's summary like
 * code:run.
 *
 * Bulk by default (the house keyed-array contract): run ONE inline ({ id, dryRun?,
 * timeoutSec? }), MANY with the SAME dryRun/timeout (ids:[…] + dryRun?), or MANY
 * heterogeneous (items:[{ id, dryRun?, timeoutSec? }]) → { ok, results:[{ ok, id,
 * result? | error }], counts }. Each result self-describes its id; a recipe that
 * fails to run never fails the rest (top-level ok = "the batch ran",
 * counts.failed is the truth). Per-recipe exec semantics are preserved exactly.
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
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

interface RunItem {
  id: string;
  dryRun?: boolean;
  timeoutSec?: number;
}

export default defineTool({
  name: 'recipes:run',
  description:
    'Run one OR many saved code:run RECIPEs by id — the reuse path. Each recipe\'s script executes under YOUR ' +
    'role-scoped tool envelope (NOT the author\'s — no privilege travels with a recipe); returns ' +
    'only each script\'s summary. Use dryRun:true to preview write-effect mutations. Single: { id, dryRun?, ' +
    'timeoutSec? }. Many same options: { ids:[…], dryRun? }. Many heterogeneous: items:[{ id, dryRun?, timeoutSec? }]. ' +
    'Returns { ok, results:[{ ok, id, result? | error }], counts } — correlate by id, not by position; one recipe ' +
    'failing never fails the rest.',
  guidance: {
    when:
      'When a recipe already does what you need (found via recipes:search / recipes:list, or a ' +
      'code:run result\'s similarRecipes) — run it by id instead of re-authoring the same script. ' +
      'Run several at once via ids:[…] or items:[…]. Each runs under YOUR envelope, so you can only ' +
      'reuse recipes whose tools you may call.',
    notWhen:
      'When no existing recipe fits — author a fresh code:run (which also auto-captures + dedups). ' +
      'Preview a recipe\'s mutations with dryRun before a committing run.',
    chaining:
      'recipes:search { query } → recipes:get { ids:[…] } (inspect) → recipes:run { id, dryRun:true } → ' +
      'recipes:run { id }. Bulk: single | items[] (or ids) → { ok, results, counts }; correlate by id not position; one failure never fails the rest.',
  },
  // Same gate as code:run: as powerful as the shell capability (it can call any of
  // the REUSER's write tools), role-gated to SU_ROLES + bee. The role-scoped facade
  // is the privilege boundary — the recipe carries none.
  capability: 'capability:bash',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-run shorthand: the recipe id / kebab slug'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Preview: record effect:write tool calls without executing them (reads still run). Applies to the inline id / every id in `ids`.'),
      timeoutSec: z.number().int().min(1).max(120).optional().describe('Wall-clock budget (default 30s). Applies to the inline id / every id in `ids`.'),
      ids: z.array(z.string().min(1)).min(1).max(50).optional().describe('run MANY recipes with the same dryRun/timeoutSec (homogeneous)'),
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            dryRun: z.boolean().optional(),
            timeoutSec: z.number().int().min(1).max(120).optional(),
          }),
        )
        .min(1)
        .max(50)
        .optional()
        .describe('run many recipes at once — each { id, dryRun?, timeoutSec? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const sql = getOrgPg().sql;
    const list: RunItem[] = args.items?.length
      ? args.items.map((it) => ({ id: it.id, dryRun: it.dryRun ?? args.dryRun, timeoutSec: it.timeoutSec ?? args.timeoutSec }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, dryRun: args.dryRun, timeoutSec: args.timeoutSec }))
        : [{ id: args.id as string, dryRun: args.dryRun, timeoutSec: args.timeoutSec }];

    // Resolve the REUSER's identity ONCE (used by every per-recipe run-record).
    // Best-effort: a recipe run does not require an identity to execute.
    let ownerId: string | null = null;
    try {
      const { resolveAgentIdentity } = await import('../coordination/identity');
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      ownerId = null;
    }

    const all = listAllProjectedTools();
    // SECURITY INVARIANT (D-004 / P-006): scope to the REUSER's role (ctx.role) —
    // NEVER recipe.authorRole. A recipe carries no privilege; the facade only
    // contains tools the running agent may already call. Exclude code:run so a
    // recipe can't recursively nest code-mode. Computed ONCE — the same envelope
    // gates every recipe in the batch.
    const allowed = roleScopedToolNames(all, ctx.role, new Set(['code:run']));

    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const recipe = await getRecipe(sql, it.id);
        if (!recipe) {
          return { ok: false, id: it.id, error: 'not_found' };
        }
        const dryRun = it.dryRun ?? false;
        const result = await runToolOrchestration(recipe.script, {
          ctx,
          deps: PROJECTED_DEPS,
          tools: all,
          allowed,
          dryRun,
          timeoutMs: it.timeoutSec ? it.timeoutSec * 1000 : undefined,
        });

        // Record the REUSE (reused:true) on a successful, committing run — the
        // distinct-from-authored signal Phase-3 graduation reads. Best-effort: a
        // recording failure must not fail the run.
        if (result.ok && !dryRun) {
          try {
            const hiveSlug = ctx.harnessSlug
              ? await hiveHomeSlugForHarness(workspaceId, ctx.harnessSlug).catch(() => null)
              : null;
            await recordRecipeRun(sql, {
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

        // The script's own ok/error rides inside `result`; the item is "ok" in the
        // sense that the recipe RAN — mirror the result's ok so counts.failed
        // reflects scripts that failed, not just recipes that were absent.
        return { ok: Boolean(result.ok), id: it.id, result };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );

    return bulkContent(env);
  },
});
