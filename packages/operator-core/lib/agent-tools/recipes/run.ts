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
  AGENT_ROLES,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveLearningPotSlug } from '../../learning/pot-scope';
import { getRecipe, recordRecipeRun } from '../../code-recipes-store';
import { PROJECTED_DEPS } from '../../projected-tool-deps';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { DISPATCH_WRAPPER_METADATA_KEY } from '../sessions/automatic-tool-names';
import { dispatchWrapperMarkEnabled } from '../../telemetry-dispatch-wrapper';
import {
  recipeAuthorityContextFromRefs,
  recipeAuthorityMatchesLiveRefs,
  validateRecipeAuthorityProof,
  type RecipeAuthorityMetadata,
  type RecipeAuthorityRefs,
  type RecipeAuthorityProof,
} from '../../recipe-authority';
import { deriveFleetMembership } from '../coordination/identity';
import { resolvePresenceFleet } from '../coordination/presence-fleet';
import { getTxPool } from '../locks/su-lock-store';
import { readIdentity } from '../locks/identity';
import { validateRecipeScriptAgainstCatalog } from './recipe-schema-validation';
import { bindCurrentCallerDispatch } from '../orchestration/current-caller-dispatch';
import { normalizeExecutionTrace } from '../../orchestration-trace';

interface RunItem {
  id: string;
  dryRun?: boolean;
  timeoutSec?: number;
  authority?: RecipeAuthorityProof | RecipeAuthorityMetadata;
}

type LiveClaimRow = { plan_slug: string; harness_slug: string; item_id: string };
type LiveWorkItemRow = { harness_slug: string; item_id: string };
type LiveResourceRow = { resource: string };

async function resolveLiveBoundRefs(
  sql: ReturnType<typeof getOrgPg>['sql'],
  ownerId: string,
  coordinationDomain: string,
): Promise<RecipeAuthorityRefs> {
  const [claims, workItems, resources] = await Promise.all([
    sql<LiveClaimRow[]>`
      SELECT DISTINCT plan_slug, harness_slug, item_id
        FROM harness_shared.plan_item_claims
       WHERE owner = ${ownerId} AND expires_ts > clock_timestamp()`,
    sql<LiveWorkItemRow[]>`
      SELECT DISTINCT harness_slug, feature_id AS item_id
        FROM harness_shared.work_items
       WHERE taken_by = ${ownerId}
         AND status <> ALL(ARRAY['done','resolved','deprecated','closed']::text[])`,
    getTxPool()<LiveResourceRow[]>`
      SELECT DISTINCT resource
        FROM agent_resource_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND owner = ${ownerId}
         AND status = 'held'
         AND expires_ts > clock_timestamp()`,
  ]);
  const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))].sort();
  return {
    workspaces: [],
    fleets: [],
    plans: unique(claims.map((row) => row.plan_slug)),
    harnesses: unique([...claims, ...workItems].map((row) => row.harness_slug)),
    items: unique([...claims, ...workItems].map((row) => row.item_id)),
    resources: unique(resources.map((row) => row.resource)),
  };
}

const authorityContextSchema = z.object({
  workspace: z.string().min(1).optional(),
  fleet: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  items: z.array(z.string().min(1)).max(100).optional(),
  resources: z.array(z.string().min(1)).max(100).optional(),
}).strict();

const authorityProofSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  context: authorityContextSchema,
}).strict();

const authorityMetadataSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  refs: z.object({
    workspaces: z.array(z.string().min(1)),
    fleets: z.array(z.string().min(1)),
    plans: z.array(z.string().min(1)),
    harnesses: z.array(z.string().min(1)),
    items: z.array(z.string().min(1)),
    resources: z.array(z.string().min(1)),
  }).strict(),
  requiresContext: z.boolean(),
  runnable: z.boolean(),
}).strict();

const authorityInputSchema = z.union([authorityProofSchema, authorityMetadataSchema]);

function isAuthorityMetadata(
  authority: RecipeAuthorityProof | RecipeAuthorityMetadata,
): authority is RecipeAuthorityMetadata {
  return 'refs' in authority;
}

export default defineTool({
  name: 'recipes:run',
  description:
    'Run saved code:run recipes by id — reuse path. Each recipe\'s script executes under YOUR ' +
    'role-scoped tool envelope (NOT the author\'s — no privilege travels with a recipe); returns ' +
    'only each script\'s summary. Pass the exact runArgs from a recipes:search/code:run recommendation, or pass the ' +
    'authority metadata returned by recipes:get; both are revalidated against the stored revision and YOUR live lane. ' +
    'Use dryRun:true to preview write-effect mutations. Single: { id, authority?, dryRun?, ' +
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
      'Preview a recipe\'s mutations with dryRun before a committing run. On authority_unresolved, read `reason`.',
    chaining:
      'recipes:search { query } → recipes:get { ids:[…] } (inspect) → recipes:run { id, authority, dryRun:true } → ' +
      'recipes:run { id }. Bulk: single | items[] (or ids) → { ok, results, counts }; correlate by id not position; one failure never fails the rest.',
    seeAlso: [
      'recipes:get (inspect the recipe\'s script before running)',
      'recipes:search (find the right recipe to run)',
      'code:run (author a fresh script when no recipe fits)',
    ],
  },
  // Same gate as code:run: as powerful as the shell capability (it can call any of
  // the REUSER's write tools), open to ALL ROLES (owner directive 2026-06-25 — in lockstep
  // with code:run). The role-scoped facade is the privilege boundary — the recipe carries none.
  capability: 'capability:bash',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-run shorthand: the recipe id / kebab slug'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Preview: record effect:write tool calls without executing them (reads still run). Applies to the inline id / every id in `ids`.'),
      timeoutSec: z.number().int().min(1).max(120).optional().describe('Wall-clock budget (default 30s). Applies to the inline id / every id in `ids`.'),
      authority: authorityInputSchema.optional().describe('Exact proof from a recommendation\'s runArgs, or authority metadata from recipes:get; required for entity-bound recipes.'),
      ids: z.array(z.string().min(1)).min(1).max(50).optional().describe('run MANY recipes with the same dryRun/timeoutSec (homogeneous)'),
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            dryRun: z.boolean().optional(),
            timeoutSec: z.number().int().min(1).max(120).optional(),
            authority: authorityInputSchema.optional(),
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
      ? args.items.map((it) => ({
          id: it.id,
          dryRun: it.dryRun ?? args.dryRun,
          timeoutSec: it.timeoutSec ?? args.timeoutSec,
          authority: it.authority ?? args.authority,
        }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, dryRun: args.dryRun, timeoutSec: args.timeoutSec, authority: args.authority }))
        : [{ id: args.id as string, dryRun: args.dryRun, timeoutSec: args.timeoutSec, authority: args.authority }];

    // Resolve the REUSER's identity ONCE (used by every per-recipe run-record).
    // Best-effort: a recipe run does not require an identity to execute.
    let ownerId: string | null = null;
    let coordinationDomain: string | null = null;
    try {
      const identity = readIdentity(ctx);
      ownerId = identity.ownerId;
      coordinationDomain = identity.coordinationDomain;
    } catch {
      ownerId = null;
      coordinationDomain = null;
    }
    let liveFleet: string | null = null;
    try {
      liveFleet = (await resolvePresenceFleet(ownerId ?? undefined, deriveFleetMembership())).fleetSlug;
    } catch {
      liveFleet = null;
    }
    const liveAuthorityContext = {
      workspace: workspaceId,
      ...(liveFleet ? { fleet: liveFleet } : {}),
      ...(ctx.harnessSlug ? { harness: ctx.harnessSlug } : {}),
    };
    // P-012 (census double-count): aggregate inner dispatches across the whole batch —
    // each wrote its own telemetry row, so this row is wrapper overhead when > 0.
    let totalInnerDispatches = 0;
    let liveBoundRefsPromise: Promise<RecipeAuthorityRefs> | null = null;
    let runPotSlugPromise: Promise<string | null> | null = null;
    const runPotSlug = (): Promise<string | null> => {
      runPotSlugPromise ??= resolveLearningPotSlug({
        workspaceId,
        harnessSlug: ctx.harnessSlug ?? null,
      });
      return runPotSlugPromise;
    };
    const liveBoundRefs = (): Promise<RecipeAuthorityRefs> | null => {
      if (!ownerId || !coordinationDomain) return null;
      liveBoundRefsPromise ??= resolveLiveBoundRefs(sql, ownerId, coordinationDomain);
      return liveBoundRefsPromise;
    };

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
        // A recipe can outlive a tool-schema change. Validate the statically
        // provable calls against the CURRENT catalog before execution so a
        // removed enum/argument (e.g. checkpoint-run op:"status") fails with
        // an actionable stale-recipe result instead of a runtime surprise.
        const schemaValidation = await validateRecipeScriptAgainstCatalog(recipe.script, all);
        if (!schemaValidation.ok) {
          return {
            ok: false,
            id: it.id,
            error: 'recipe_schema_stale',
            schemaIssues: schemaValidation.issues,
          };
        }
        const authority = await validateRecipeAuthorityProof({
          script: recipe.script,
          updatedAt: recipe.updatedAt,
          proof: it.authority
            ? isAuthorityMetadata(it.authority)
              ? {
                  version: it.authority.version,
                  revision: it.authority.revision,
                  context: recipeAuthorityContextFromRefs(it.authority.refs),
                }
              : it.authority
            : undefined,
          liveContext: liveAuthorityContext,
        });
        if (!authority.ok) {
          // EI-12057: `reason` distinguishes a PERMANENT, by-design limitation
          // (authority_unresolved — the recipe embeds an opaque/unprovable call,
          // e.g. dev:pg_query; no proof, nested or top-level, can ever fix it) from
          // a FIXABLE one (authority_required — go get a proof), so a caller who
          // hit this via a nested `tools.recipes.run(...)` composition doesn't
          // mistake it for "nesting is broken" when the target recipe itself
          // simply can't be authority-verified.
          return { ok: false, id: it.id, error: authority.error, reason: authority.reason };
        }
        const needsLiveRefs =
          authority.descriptor.refs.plans.length > 0 ||
          authority.descriptor.refs.items.length > 0 ||
          authority.descriptor.refs.resources.length > 0;
        if (needsLiveRefs) {
          const pendingRefs = liveBoundRefs();
          if (!pendingRefs) return { ok: false, id: it.id, error: 'authority_live_context_unavailable' };
          let refs: RecipeAuthorityRefs;
          try {
            refs = await pendingRefs;
          } catch {
            return { ok: false, id: it.id, error: 'authority_live_context_unavailable' };
          }
          if (!recipeAuthorityMatchesLiveRefs(authority.descriptor, refs)) {
            return { ok: false, id: it.id, error: 'authority_entity_mismatch' };
          }
        }
        const dryRun = it.dryRun ?? false;
        const result = await runToolOrchestration(recipe.script, {
          // EI-20066912585022608: a recipe script consumes tool results as JS VALUES,
          // exactly like the code:run script it was captured FROM — so it has to be
          // told the same thing, or a handler that renders text for a model (and
          // structure for a script) hands a recipe replay the raw string. That would
          // silently change the shape of a script that was authored and verified under
          // code:run: `r.output` verified fine, then reads undefined on every replay.
          ctx: { ...ctx, codeMode: true },
          deps: PROJECTED_DEPS,
          tools: all,
          allowed,
          dryRun,
          timeoutMs: it.timeoutSec ? it.timeoutSec * 1000 : undefined,
          wrapDispatch: bindCurrentCallerDispatch,
        });
        // P-012: counted before any early return below — a failed item's dispatches
        // still wrote their own telemetry rows.
        totalInnerDispatches += result.dispatchCount ?? 0;
        const { callRecords, ...publicResult } = result;

        // EI-20224785432797349: code-mode tracks reads of fields that are absent from a
        // child tool result. Treat those misses as a failed recipe reuse, even when the
        // script itself returned normally with partial:false. Otherwise a saved recipe
        // can keep reporting ok:true while its compact summary is silently populated with
        // undefined values after a tool-schema change. The caller must update the recipe
        // script before it is eligible for a successful reuse record again.
        const fieldMisses = Array.isArray(result.fieldMisses) ? result.fieldMisses : [];
        const successfulReuse = Boolean(result.ok) && fieldMisses.length === 0;

        // P-013: every EXECUTED saved script gets one normalized trace row,
        // including failures and dry-run previews. Only a successful committing
        // reuse moves the parent recipe's popularity counters, preserving their
        // established meaning while making all execution evidence durable.
        try {
          const executionTrace = await normalizeExecutionTrace({
            script: recipe.script,
            backend: 'server',
            tools: all,
            allowed,
            callRecords,
          });
          await recordRecipeRun(sql, {
            recipeId: recipe.id,
            workspaceId,
            potSlug: await runPotSlug(),
            agentOwner: ownerId,
            agentRole: ctx.role ?? null,
            success: successfulReuse,
            reused: true,
            executionTrace,
            countTowardRecipe: successfulReuse && !dryRun,
          });
        } catch (err) {
          ctx.log(`recipes:run trace record failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
        }

        if (fieldMisses.length > 0) {
          return {
            ok: false,
            id: it.id,
            error: 'recipe_field_miss',
            fieldMisses,
            reason:
              'the saved recipe read fields absent from current tool results; update the recipe script before reusing it',
            result: publicResult,
          };
        }

        // The script's own ok/error rides inside `result`; the item is "ok" in the
        // sense that the recipe RAN — mirror the result's ok so counts.failed
        // reflects scripts that failed, not just recipes that were absent.
        return { ok: Boolean(result.ok), id: it.id, result: publicResult };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );

    // P-012: mark this row as a dispatch wrapper only when the batch actually
    // dispatched inner tools (a dry-run or not-found batch stays countable).
    if (totalInnerDispatches > 0 && (await dispatchWrapperMarkEnabled())) {
      ctx.metadata?.({
        [DISPATCH_WRAPPER_METADATA_KEY]: true,
        dispatchedToolCalls: totalInnerDispatches,
      });
    }

    return bulkContent(env);
  },
});
