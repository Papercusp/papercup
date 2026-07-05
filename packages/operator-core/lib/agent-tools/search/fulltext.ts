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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { runFullTextSearch } from '@papercusp/search';
import { SEARCH_SOURCES } from './sources';
import { rerankProseHits } from './rerank';
import { searchFilterArgs, resolveSearchFilters } from './filters';
import { resolveAgentIdentity } from '../coordination/identity';

const SCOPE_CHOICES = [
  'escalations', 'brainstorm', 'turns', 'decisions', 'work_item',
  'session_turn', 'coord_message', 'all',
] as const;

// + overwatch (overwatch-role-2026-06-15 B-01): the supervisor searches to ground nudges.
const ALL_ROLES = [...SU_ROLES, 'sentinel', 'overwatch'] as const;

export default defineTool({
  name: 'search:fulltext',
  // P-062 Phase 4: reads `operator_turns` (a non-workspace-scoped global table)
  // among its sources and scopes the ws-scoped sources by the explicit
  // workspaceId arg, not RLS. Must run on the admin (rolbypassrls) handle — a
  // workspace-scoped harness_app tx has no grant on operator_turns.
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'Search workspace prose (escalations, brainstorm notes, older operator turns, and — with scope:["work_item"] — bug/change/task issue titles+bodies) by keyword match (BM25-style). Ranked by relevance. Returns excerpts.',
  guidance: {
    when: 'User references prose past the chat history budget ("remember when we decided pricing", "the X discussion from last week"), or asks about content in escalations/brainstorm where the right SQL filter is not obvious. Returns ranked snippets. Also: BEFORE filing a new bug/change work-item, pass scope:["work_item"] to dedup-check against existing EI-* issues by title/body keyword — cheaper and more scalable than work_items:list + grep past ~500 items.',
    notWhen:
      'For STRUCTURED queries on harness state, features, tasks, or messages — use the dedicated tools (harness:status, tasks:list, etc). They are faster and more precise when the schema matches the query. For CODE recall, use `gitnexus:query`. For tasks/goals/projects text, use `search:query`. `scope:["work_item"]` only covers the ISSUE family (bug/change/task, engineer_issues) — feature-family (F-NNN) work-items are not in this corpus.',
    chaining:
      'Pair with `harness:escalation` or `harness:plan_reviews` to fetch the full row of a returned hit; pair `scope:["work_item"]` hits with `work_items:get { id }` for the full record. The result `excerpt` is just the first 200 chars for ranking display.',
    seeAlso: [
      'search:semantic (embedding-based recall)',
      'search:query (structured tasks / goals / projects rows)',
      'gitnexus:query (code recall)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 10 }, operator: { perRun: 100 } },
  args: z.object({
    query: z.string().min(1).max(500),
    scope: z.array(z.enum(SCOPE_CHOICES)).optional(),
    harness_slug: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
    ...searchFilterArgs,
  }),
  async handler(args, ctx) {
    const limit = args.limit ?? 5;
    // EI-6984: 'work_item' (and now the session/coord corpora) are opt-in only,
    // kept OUT of the historic no-scope default (unscoped callers keep the same
    // 4-source result shape they've always gotten) — but an EXPLICIT
    // scope:['all'] means "every source", so it expands to all seven.
    const scope =
      args.scope?.includes('all')
        ? SEARCH_SOURCES.map((s) => s.name)
        : !args.scope?.length
          ? ['escalations', 'brainstorm', 'turns', 'decisions']
          : args.scope;
    const sources = SEARCH_SOURCES.filter((s) => scope.includes(s.name));

    // P-002 filter bag: resolve 'self'/fleet sugars server-side (session:'self'
    // also live-tails the caller's own transcript — compaction recovery).
    const { filters } = await resolveSearchFilters(
      ctx.tx,
      args,
      resolveAgentIdentity(ctx).ownerId ?? '',
      { workspaceId: ctx.workspaceId ?? '' },
    );

    const { results, totalHits } = await runFullTextSearch(sources, {
      sql: ctx.tx,
      query: args.query,
      workspaceId: ctx.workspaceId ?? '',
      scopeFilter: args.harness_slug ?? null,
      limit,
      filters,
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
