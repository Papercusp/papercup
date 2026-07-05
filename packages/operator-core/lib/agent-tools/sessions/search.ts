/**
 * sessions:search — the FUSED session-recall tool (session-search-scope-
 * 2026-07-05 P-005): ONE round trip = search the session corpora → hydrate a
 * ±context turn window around each top hit → return needle + surroundings +
 * a readMore pointer. Composes the primitives (search:* over the session_turn
 * corpus + sessions:read windows) — never forks them (D-001; the coord:orient
 * fusion precedent).
 *
 * The compaction-recovery path: session:'self' resolves the CALLER's live
 * transcript server-side AND force-tails it before searching (read-time
 * freshness, client-neutral across claude/omp/codex —
 * compaction-context-loss D-002). Pre-compaction turns survive on disk;
 * this is the one-call way back to them.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { runHybridSearch } from '@papercusp/search';
import { SEARCH_SOURCES } from '../search/sources';
import { buildQueryEmbedder } from '../search/embedder';
import { searchFilterArgs, resolveSearchFilters } from '../search/filters';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  sessionSearchEnabled, disabledResult, hydrateWindow, parseTurnRef, type WindowTurn,
} from './_shared';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

export default defineTool({
  name: 'sessions:search',
  crossWorkspace: true,
  capability: 'search:read',
  description:
    "Search agent session transcripts (claude/omp/codex + harness chats) and get each hit WITH its surrounding turns in one call. mode=verbatim finds exact quotes; mode=hybrid (default) finds by meaning. session:'self' searches YOUR OWN current session — including pre-compaction turns (they survive on disk and are re-indexed at read time).",
  guidance: {
    when:
      '"Which session did agent X say Y" / "we discussed this earlier — where?" / after a compaction, "I said something before the summary — recover it" (session:\'self\', mode:\'verbatim\'). Filters: owner/fleet/speaker/session/source_kind/since/until.',
    notWhen:
      'Recall over escalations/brainstorm/decisions/work-items — search:fulltext / search:semantic. Distilled facts — memory:search. Reading a known session sequentially — sessions:read.',
    chaining:
      'Each hit carries readMore args for sessions:read (a wider window). fleet:<slug> resolves EVER-members from the membership ledger — postmortem-safe.',
    seeAlso: ['sessions:read (window read)', 'sessions:list (enumerate sessions)', 'search:semantic (other corpora)'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.object({
    query: z.string().min(1).max(500),
    mode: z.enum(['hybrid', 'verbatim']).optional().describe('hybrid (default): BM25+embeddings by meaning. verbatim: exact case-insensitive substring — the quote finder.'),
    include_coord: z.boolean().optional().describe('Also search coord messages (what agents said TO EACH OTHER), not just session transcripts. Default false.'),
    harness_slug: z.string().optional(),
    limit: z.number().int().min(1).max(10).optional().describe('Max hits (default 5).'),
    context: z.number().int().min(0).max(5).optional().describe('Turns hydrated on EACH side of a hit (default 2).'),
    ...searchFilterArgs,
  }),
  async handler(args, ctx) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    const limit = args.limit ?? 5;
    const context = args.context ?? 2;
    const mode = args.mode ?? 'hybrid';
    const workspaceId = ctx.workspaceId ?? '';

    const { filters, selfSession } = await resolveSearchFilters(
      ctx.tx, args, resolveAgentIdentity(ctx).ownerId ?? '', { workspaceId },
    );

    interface RawHit {
      sourceKind: string; sessionId: string; turnIdx: number;
      speaker: string | null; owner: string | null; harness_slug: string | null;
      ts: string | null; excerpt: string; highlight?: string; score: number; source: string;
    }
    const hits: RawHit[] = [];

    if (mode === 'verbatim') {
      const f = filters ?? {};
      const owners = f.owners && f.owners.length ? f.owners : null;
      const rows = await ctx.tx<Array<{ source_kind: string; session_id: string; turn_idx: number; speaker: string; owner: string | null; harness_slug: string | null; ts: string | null; text: string }>>`
        SELECT source_kind, session_id, turn_idx, speaker, owner, harness_slug, ts::text AS ts,
               left(text, 700) AS text
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
           AND (${args.harness_slug ?? null}::text IS NULL OR harness_slug = ${args.harness_slug ?? null})
           AND (${owners}::text[] IS NULL OR owner = ANY(${owners}::text[]))
           AND (${f.speaker ?? null}::text IS NULL OR speaker = ${f.speaker ?? null})
           AND (${f.sessionId ?? null}::text IS NULL OR session_id = ${f.sessionId ?? null})
           AND (${f.sourceKind ?? null}::text IS NULL OR source_kind = ${f.sourceKind ?? null})
           AND (${f.since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${f.since ?? null}::timestamptz)
           AND (${f.until ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) < ${f.until ?? null}::timestamptz)
           AND text ILIKE '%' || ${args.query} || '%'
      ORDER BY COALESCE(ts, ingested_at) DESC
         LIMIT ${limit}
      `;
      for (const r of rows) {
        hits.push({
          sourceKind: r.source_kind, sessionId: r.session_id, turnIdx: r.turn_idx,
          speaker: r.speaker, owner: r.owner, harness_slug: r.harness_slug, ts: r.ts,
          excerpt: r.text, score: 1, source: 'session_turn',
        });
      }
    } else {
      const scopeNames = args.include_coord ? ['session_turn', 'coord_message'] : ['session_turn'];
      const sources = SEARCH_SOURCES.filter((s) => scopeNames.includes(s.name));
      const embedder = await buildQueryEmbedder();
      const { results } = await runHybridSearch(sources, {
        sql: ctx.tx,
        query: args.query,
        workspaceId,
        scopeFilter: args.harness_slug ?? null,
        limit,
        mode: 'hybrid',
        embedder,
        filters,
        log: ctx.log,
      });
      for (const r of results) {
        if (r.source === 'session_turn') {
          const ref = parseTurnRef(r.source_id);
          if (!ref) continue;
          hits.push({
            sourceKind: ref.sourceKind, sessionId: ref.sessionId, turnIdx: ref.turnIdx,
            speaker: null, owner: null, harness_slug: r.scope ?? null, ts: null,
            excerpt: r.excerpt, highlight: r.highlight, score: r.score, source: r.source,
          });
        } else {
          // coord_message hit — no window to hydrate; pass through as-is.
          hits.push({
            sourceKind: 'coord', sessionId: r.source_id, turnIdx: -1,
            speaker: null, owner: null, harness_slug: r.scope ?? null, ts: null,
            excerpt: r.excerpt, highlight: r.highlight, score: r.score, source: r.source,
          });
        }
      }
    }

    // Hydrate ±context windows for the session hits (top-k is already <= limit).
    const out = [];
    for (const h of hits) {
      let window: WindowTurn[] | undefined;
      if (h.source === 'session_turn' && context > 0) {
        try {
          window = await hydrateWindow(ctx.tx, workspaceId, h.sourceKind, h.sessionId, h.turnIdx, context);
        } catch { /* window is a bonus, never fail the search */ }
      }
      out.push({
        source: h.source,
        provenance: h.source === 'session_turn'
          ? { source_kind: h.sourceKind, session_id: h.sessionId, turn_idx: h.turnIdx,
              ...(h.speaker ? { speaker: h.speaker } : {}), ...(h.owner ? { owner: h.owner } : {}),
              ...(h.harness_slug ? { harness_slug: h.harness_slug } : {}), ...(h.ts ? { ts: h.ts } : {}) }
          : { msg_id: h.sessionId },
        excerpt: h.excerpt,
        ...(h.highlight ? { highlight: h.highlight } : {}),
        score: h.score,
        ...(window ? { window } : {}),
        ...(h.source === 'session_turn'
          ? { readMore: { tool: 'sessions:read', args: { session: h.sessionId, source_kind: h.sourceKind, around: h.turnIdx, context: 10 } } }
          : {}),
      });
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          query: args.query,
          mode,
          total_hits: hits.length,
          ...(selfSession ? { self_session: { source_kind: selfSession.sourceKind, session_id: selfSession.sessionId } } : {}),
          ...(args.session === 'self' && !selfSession
            ? { note: "session:'self' could not be pinned to a live transcript — degraded to an owner-filtered search." }
            : {}),
          results: out,
        }),
      }],
    };
  },
});
