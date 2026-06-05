/**
 * Full-text BM25-style recall over unstructured prose.
 *
 * Plan 2A — Postgres tsvector + GIN. The query engine + the per-source
 * SQL now live in `@papercusp/search` + `./sources` (extracted per
 * papercusp-systems-abstraction-2026-05-29, P-013/P-020); this file is
 * just the `defineTool` projection.
 *
 * Different from `search:query`: that one searches structured rows
 * (tasks/goals/projects/audit/messages) by title/summary. This one
 * targets free-text bodies for paraphrase recall.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runFullTextSearch } from '@papercusp/search';
import { SEARCH_SOURCES } from './sources';
import { rerankProseHits } from './rerank';

const SCOPE_CHOICES = ['escalations', 'brainstorm', 'turns', 'decisions', 'all'] as const;

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator',
  'reviewer', 'debugger', 'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'search:fulltext',
  // P-062 Phase 4: reads `operator_turns` (a non-workspace-scoped global table)
  // among its sources and scopes the ws-scoped sources by the explicit
  // workspaceId arg, not RLS. Must run on the admin (rolbypassrls) handle — a
  // workspace-scoped harness_app tx has no grant on operator_turns.
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'Search workspace prose (escalations, brainstorm notes, older operator turns) by keyword match (BM25-style). Ranked by relevance. Returns excerpts.',
  guidance: {
    when: 'User references prose past the chat history budget ("remember when we decided pricing", "the X discussion from last week"), or asks about content in escalations/brainstorm where the right SQL filter is not obvious. Returns ranked snippets.',
    notWhen:
      'For STRUCTURED queries on harness state, features, tasks, issues, or messages — use the dedicated tools (harness:status, tasks:list, etc). They are faster and more precise when the schema matches the query. For CODE recall, use `gitnexus:query`. For tasks/goals/projects text, use `search:query`.',
    chaining:
      'Pair with `harness:escalation` or `harness:plan_reviews` to fetch the full row of a returned hit. The result `excerpt` is just the first 200 chars for ranking display.',
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 10 }, operator: { perRun: 100 } },
  args: z.object({
    query: z.string().min(1).max(500),
    scope: z.array(z.enum(SCOPE_CHOICES)).optional(),
    harness_slug: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async handler(args, ctx) {
    const limit = args.limit ?? 5;
    const scope =
      args.scope?.includes('all') || !args.scope?.length
        ? ['escalations', 'brainstorm', 'turns', 'decisions']
        : args.scope;
    const sources = SEARCH_SOURCES.filter((s) => scope.includes(s.name));

    const { results, totalHits } = await runFullTextSearch(sources, {
      sql: ctx.tx,
      query: args.query,
      workspaceId: ctx.workspaceId ?? '',
      scopeFilter: args.harness_slug ?? null,
      limit,
      log: ctx.log,
    });

    // Stage B: cross-encoder rerank. Fail-safe — no ZeroEntropy key → the
    // BM25 order unchanged (see ./rerank).
    const reranked = await rerankProseHits(args.query, results, limit);

    // search:fulltext's output rows use `rank` (no score/rankers).
    const top = reranked.map((r) => ({
      source: r.source,
      source_id: r.source_id,
      ...(r.scope ? { harness_slug: r.scope } : {}),
      excerpt: r.excerpt,
      highlight: r.highlight,
      rank: r.score,
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: args.query,
          scope,
          total_hits: totalHits,
          results: top,
        }),
      }],
    };
  },
});
