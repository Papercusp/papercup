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
import { orchestrationCallerSurface } from '../orchestration/contract-preflight';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getRecipe } from '../../code-recipes-store';
import { mergeIds, runBulk, bulkContent } from '../_bulk';
import { deriveStoredRecipeAuthority, recipeRevisionDiagnostics, toRecipeAuthorityMetadata,
  resolveLiveBoundRefs, recipeAuthorityMatchesCurrentRefs, recipeAuthorityMatchesLiveContext,
  type RecipeAuthorityRefs } from '../../recipe-authority';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { validateRecipeBindings } from '../../recipe-contract';
import { activeWorkspaceId } from '../../workspace-registry';
import { getTxPool } from '../locks/su-lock-store';
import { readIdentity } from '../locks/identity';
import { deriveFleetMembership } from '../coordination/identity';
import { resolvePresenceFleet } from '../coordination/presence-fleet';

export default defineTool({
  name: 'recipes:get',
  description:
    'Fetch one OR many reusable code:run RECIPEs by id — including the full script — so you can inspect ' +
    'what they do before recipes:run-ning them, including entity bindings and the current revision. Pass `id` for one or `ids` for several. Returns ' +
    '{ ok, results:[{ ok, id, recipe? | error }], counts } — correlate by id, not by position; a ' +
    'missing id comes back as that item\'s { ok:false } without failing the rest. Read-only. Recipes are ' +
    'global/fleet-wide; pass optional `bindings` to resolve authority for that exact invocation. ' +
    'It does not accept a top-level `harness` argument.',
  guidance: {
    when:
      'When you have one or more recipe ids (from recipes:list / recipes:search / a code:run result\'s ' +
      'similarRecipes) and want to read their script + metadata before reusing. Recipes are global/fleet-wide; ' +
      'pass `id` or `ids` (not `harness`), with the same invocation bindings you will pass to recipes:run.',
    notWhen:
      'To EXECUTE the recipe — use recipes:run (it runs the script under YOUR role-scoped envelope). ' +
      'To discover recipes by intent — recipes:search.',
    chaining:
      'recipes:search / recipes:list → recipes:get { ids:[…] } (inspect) → recipes:run { id } (reuse). ' +
      'Recipes are global, so omit `harness`; for a bound template supply the same `bindings` to get and run. Bulk: single | ids[] → ' +
      '{ ok, results, counts }; correlate by id not position; one failure never fails the rest.',
    argRedirects: {
      harness: 'recipes:get is a global recipe read; omit `harness` and pass only `id` or `ids`.',
    },
    seeAlso: [
      'recipes:run (EXECUTE the recipe under your role-scoped envelope)',
      'recipes:search (discover recipes by intent)',
      'recipes:list (browse the recipe library)',
    ],
  },
  // Reading a reusable script is part of the same caller-scoped orchestration
  // flow as code:run. Its own execution still checks every nested tool.
  capability: 'agent_tools:read',
  requirePrincipal: false,
  // ALL ROLES (owner directive 2026-06-25) — in lockstep with code:run's audience.
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single recipe id / kebab slug (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('recipe ids to fetch (1–100)'),
      bindings: z.object({ values: z.record(z.string(), z.unknown()) }).strict().optional()
        .describe('Invocation bindings validated against each stored recipe contract before deriving its exact authority. Pass the same bindings to recipes:run; omission retains the generic authority descriptor.'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args, ctx) {
    const sql = getOrgPg().sql;
    const workspaceId = ctx.workspaceId ?? activeWorkspaceId();
    let identity: ReturnType<typeof readIdentity> | null = null;
    try { identity = readIdentity(ctx); } catch { /* Bound metadata fails closed below. */ }
    let liveRefs: Promise<RecipeAuthorityRefs> | undefined;
    let liveFleet: Promise<string | null> | undefined;
    const catalog = orchestrationCallerSurface(ctx).catalog;
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const recipe = await getRecipe(sql, id);
        if (!recipe) {
          return { ok: false as const, id, error: 'not_found' };
        }
        const bindings = args.bindings ? validateRecipeBindings({
          schema: recipe.bindingSchema ?? undefined, bindings: args.bindings, lifecycle: 'foreground',
        }) : undefined;
        if (bindings && !bindings.ok) {
          return { ok: false as const, id, error: bindings.error.code, diagnostic: bindings.error };
        }
        const authority = await deriveStoredRecipeAuthority({ ...recipe,
          ...(bindings?.ok ? { validatedInputs: bindings.value.inputs } : {}),
          context: { workspace: workspaceId, harness: resolveConcreteHarnessSlug(undefined, ctx), catalog } });
        if (!authority) return { ok: false as const, id, error: 'not_found' };
        if (authority.refs.fleets.length) {
          liveFleet ??= resolvePresenceFleet(identity?.ownerId, deriveFleetMembership())
            .then(value => value.fleetSlug).catch(() => null);
        }
        let liveAuthorityAllowed = recipeAuthorityMatchesLiveContext(authority, {
          workspace: workspaceId, harness: ctx.harnessSlug,
          fleet: liveFleet ? await liveFleet : null,
        });
        let authorityLiveError: string | undefined = !authority.unresolved && !liveAuthorityAllowed
          ? 'authority_entity_mismatch' : undefined;
        if (liveAuthorityAllowed && (authority.refs.plans.length || authority.refs.items.length || authority.refs.resources.length)) {
          if (!identity) {
            liveAuthorityAllowed = false;
            authorityLiveError = 'authority_live_context_unavailable';
          } else {
            try {
              liveRefs ??= resolveLiveBoundRefs(sql, getTxPool(), identity.ownerId, identity.coordinationDomain);
              liveAuthorityAllowed = await recipeAuthorityMatchesCurrentRefs({ sql, workspaceId,
                ownerId: identity.ownerId, script: recipe.script, descriptor: authority, liveRefs: await liveRefs });
              if (!liveAuthorityAllowed) authorityLiveError = 'authority_entity_mismatch';
            } catch {
              liveAuthorityAllowed = false;
              authorityLiveError = 'authority_live_context_unavailable';
            }
          }
        }
        const updatedAt = recipe.updatedAt ?? recipe.createdAt ?? '';
        const authorityDiagnostics = recipeRevisionDiagnostics({
          script: recipe.script,
          updatedAt,
          contract: recipe,
        });
        return {
          ok: true as const,
          id,
          recipe: {
            id: recipe.id,
            title: recipe.title,
            description: recipe.description,
            script: recipe.script,
            bindingSchema: recipe.bindingSchema,
            capabilityManifest: recipe.capabilityManifest,
            toolsUsed: recipe.toolsUsed,
            authorRole: recipe.authorRole,
            runCount: recipe.runCount,
            successCount: recipe.successCount,
            lastRunAt: recipe.lastRunAt,
            status: recipe.status,
            tags: recipe.tags,
            // WI-40896 / D-048: one projection, in recipe-authority.ts, so the
            // rendering cannot silently drop a field the descriptor carries.
            // It adds `refsMeasured` + `unresolvedCause`, without which an
            // authority that could not be MEASURED is indistinguishable from a
            // recipe that genuinely needs none.
            authority: toRecipeAuthorityMetadata(
              authority,
              authorityDiagnostics.computedRevision,
              liveAuthorityAllowed,
            ),
            ...(authorityLiveError ? { authorityLiveError } : {}),
            authorityDiagnostics,
          },
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
