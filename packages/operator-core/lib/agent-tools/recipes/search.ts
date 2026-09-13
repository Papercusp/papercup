/**
 * recipes:search — rank reusable code:run RECIPES by similarity to a query
 * (code-recipes-2026-06-21 Phase 2, P-005), so an agent can dedup-check BEFORE
 * authoring a fresh code:run.
 *
 * Rides the SAME hybrid engine the on-run dedup uses (searchSimilarRecipes,
 * D-009): BM25 over title+description (title_tsv) + pgvector cosine over the
 * embedding, fused via RRF, then blended with a structural tool-set-overlap
 * (Jaccard) signal. Hive-scoped (D-005). Read-only ranked read.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { searchSimilarRecipes } from '../../code-recipes-search';
import { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { resolveProseProfileSelection } from '../../search/prose-vector-dims';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { resolvePresenceFleet } from '../coordination/presence-fleet';
import { stripCallerOperatorScope } from '../_harness-scope';

export default defineTool({
  name: 'recipes:search',
  description:
    'Search reusable code:run RECIPES by intent (hybrid BM25 + embedding + tool-set overlap). Use ' +
    'BEFORE authoring a multi-step code:run to find a recipe that already does it. Entity-bound ' +
    'recipes are returned only when fleet/plan/harness/item/resource context matches; use each hit\'s runArgs unchanged. Read-only.',
  guidance: {
    when:
      'BEFORE writing a multi-step code:run — describe what you want to do and this ranks the ' +
      'recipes in your hive that already do something similar (semantic + tool-set match). If a ' +
      'high-similarity recipe fits, call recipes:run with the hit\'s exact runArgs so its revision ' +
      'and entity authority are revalidated before execution.',
    notWhen:
      'To browse all recipes most-run-first (recipes:list), or when you already hold the id ' +
      '(recipes:get / recipes:run). code:run still auto-surfaces similarRecipes after the fact — ' +
      'this is the BEFORE-you-author check.',
    chaining:
      'recipes:search { query } → recipes:get { id } (inspect the top hit) → recipes:run { id } (reuse).',
    seeAlso: [
      'recipes:list (browse all recipes most-run-first)',
      'recipes:get (full detail on a hit)',
      'recipes:run (execute the matched recipe)',
    ],
  },
  capability: 'recipes:read',
  requirePrincipal: false,
  // EI-20226779878046151: recipe search owns its read path and never reads
  // ctx.tx. The orient awareness fold must not pin an org-app slot during the
  // hybrid search/embedder work.
  skipWorkspaceTx: true,
  // ALL ROLES (owner directive 2026-06-25) — in lockstep with code:run's audience.
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    query: z.string().min(1).max(500).describe('What you want to do — title/description text, free-form.'),
    limit: z.number().int().min(1).max(50).optional().describe('Top-N to return (default 5).'),
    context: z
      .object({
        fleet: z.string().min(1).optional(),
        plan: z.string().min(1).optional(),
        harness: z.string().min(1).optional(),
        items: z.array(z.string().min(1)).max(100).optional(),
        resources: z.array(z.string().min(1)).max(100).optional(),
      })
      .strict()
      .optional()
      .describe('Current entity context. Bound recipes fail closed unless every embedded identity matches.'),
  }),
  async handler(args, ctx) {
    // Bound the acquisition — .catch handles a rejection but NOT a cold-pipeline
    // HANG (the EI-9143 ~5% 60s-timeout class); on timeout → null → BM25 (WI-3922).
    const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() }).catch(() => null);
    const embeddingProfile = resolved
      ? resolveProseProfileSelection(resolved.mode, resolved.profile)
      : null;
    const embedder = resolved && embeddingProfile ? resolved.embed : null;
    // The query carries no separate description / tool-set — feed it as the title
    // and let the lexical + cosine legs do the work (toolsUsed empty ⇒ the
    // structural leg contributes 0, so ranking is purely text similarity here).
    let liveFleet: string | null = null;
    try {
      const ownerId = resolveAgentIdentity(ctx).ownerId;
      liveFleet = (await resolvePresenceFleet(ownerId ?? undefined, deriveFleetMembership())).fleetSlug;
    } catch {
      liveFleet = null;
    }
    const recipes = await searchSimilarRecipes(
      getOrgPg().sql,
      {
        title: args.query,
        description: '',
        toolsUsed: [],
        embedding: null,
        limit: args.limit ?? 5,
        recommendationContext: {
          // EI-20186804943808838: the operator-scope `'*'` sentinel now SATISFIES a
          // concrete harness binding, so it must only ever be asserted by the SESSION,
          // never by the caller. The three server-derived values below already win over
          // `args.context`; this additionally drops a caller-supplied sentinel so it
          // cannot survive in the gap where ctx carries no harness. A caller may still
          // pass a CONCRETE harness, exactly as before.
          ...stripCallerOperatorScope(args.context),
          ...(ctx.workspaceId ? { workspace: ctx.workspaceId } : {}),
          ...(liveFleet ? { fleet: liveFleet } : {}),
          ...(ctx.harnessSlug ? { harness: ctx.harnessSlug } : {}),
        },
      },
      { embedder, log: (msg) => ctx.log(msg) },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, query: args.query, recipes }) }],
    };
  },
});
