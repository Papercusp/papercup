/**
 * Plan 2B+C — semantic recall + hybrid (BM25 + embeddings via RRF).
 *
 * `search:semantic` queries the same prose surfaces as `search:fulltext`
 * but adds cosine similarity on pre-computed embeddings; `mode='hybrid'`
 * fuses both via Reciprocal Rank Fusion. The query engine + per-source
 * SQL + embedder cascade now live in `@papercusp/search` + `./sources` +
 * `./embedder` (extracted per papercusp-systems-abstraction-2026-05-29,
 * P-013/P-020); this file is just the `defineTool` projection.
 *
 * If pgvector isn't installed OR backfill hasn't populated embeddings,
 * mode='embeddings' returns empty and mode='hybrid' falls back to
 * BM25-only (silently — logged via ctx.log inside the engine).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { runHybridSearch } from '@papercusp/search';
import { SEARCH_SOURCES } from './sources';
import { buildQueryEmbedder } from './embedder';
import { rerankProseHits } from './rerank';

const SCOPE_CHOICES = ['escalations', 'brainstorm', 'turns', 'decisions', 'all'] as const;
const MODE_CHOICES = ['embeddings', 'hybrid'] as const;

// + overwatch (overwatch-role-2026-06-15 B-01): the supervisor searches to ground nudges.
const ALL_ROLES = [...SU_ROLES, 'sentinel', 'overwatch'] as const;

export default defineTool({
  name: 'search:semantic',
  // P-062 Phase 4: same as search:fulltext — reads the non-workspace-scoped
  // operator_turns source and scopes by the explicit workspaceId arg, so it
  // runs on the admin (rolbypassrls) handle, not a workspace-scoped RLS tx.
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'Semantic recall over workspace prose using embedding similarity. mode=hybrid combines with BM25 (search:fulltext) via Reciprocal Rank Fusion for best of both keyword and meaning. Falls back to BM25 if embeddings unavailable.',
  guidance: {
    when:
      'User asks about a concept by paraphrase rather than the exact keyword used in the recorded text. Examples: "when did we talk about authentication strategy" (could match "login flow", "auth approach", "JWT decision"). Prefer mode=hybrid for best recall.',
    notWhen:
      'When the user knows the exact keyword they want. `search:fulltext` is faster + cheaper there (no embedding API call). For structured queries (tasks/goals/projects rows by title), use `search:query`.',
    chaining:
      'Pair with `harness:escalation` or `harness:plan_reviews` to fetch the full row of a hit.',
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 8 }, operator: { perRun: 50 } },
  args: z.object({
    query: z.string().min(1).max(500),
    scope: z.array(z.enum(SCOPE_CHOICES)).optional(),
    harness_slug: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
    mode: z.enum(MODE_CHOICES).optional(),
  }),
  async handler(args, ctx) {
    const limit = args.limit ?? 5;
    const mode = args.mode ?? 'hybrid';
    const scope =
      args.scope?.includes('all') || !args.scope?.length
        ? ['escalations', 'brainstorm', 'turns', 'decisions']
        : args.scope;
    const sources = SEARCH_SOURCES.filter((s) => scope.includes(s.name));

    const embedder = await buildQueryEmbedder();
    const { results, totalHits, embedderAvailable } = await runHybridSearch(sources, {
      sql: ctx.tx,
      query: args.query,
      workspaceId: ctx.workspaceId ?? '',
      scopeFilter: args.harness_slug ?? null,
      limit,
      mode,
      embedder,
      log: ctx.log,
    });

    // Stage B: cross-encoder rerank the fused page. Fail-safe — no ZeroEntropy
    // key → the RRF order unchanged (see ./rerank).
    const reranked = await rerankProseHits(args.query, results, limit);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: args.query,
          mode,
          embedder_available: embedderAvailable,
          scope,
          total_hits: totalHits,
          // Map @papercusp/search's generic `scope` hit field back to the
          // operator's domain `harness_slug` for the agent-facing output.
          results: reranked.map(({ scope: hitScope, ...rest }) =>
            hitScope ? { ...rest, harness_slug: hitScope } : rest,
          ),
        }),
      }],
    };
  },
});
