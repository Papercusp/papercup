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
import { buildQueryEmbedder, interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { searchFilterArgs, resolveSearchFilters } from '../search/filters';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  sessionSearchEnabled, disabledResult, hydrateWindow, parseTurnRef,
  formatSessionTurnRef,
  refreshLiveSessionsBeforeRead, type WindowTurn,
} from './_shared';
import { decodeSessionCursor, encodeSessionCursor, sessionCursorFingerprint } from './cursor';
import { resolveHitTurnOrigins, turnOriginKey, unknownTurnOrigin } from './turn-origin';
import { OWNER_CANDIDATE_TURN_VERDICTS } from '../../turn-provenance/turn-ref';
import { FILE_BACKED_SOURCE_KINDS } from '../../search/session-ingest';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

/**
 * Keep the serialized body below the baked result door (1500 tokens ≈ 6000
 * characters). This is deliberately a little lower than the door: the door
 * must see complete JSON, and callers commonly pipe this response to jq.
 */
export const SESSION_SEARCH_RESPONSE_BUDGET_CHARS = 4_800;
const SESSION_SEARCH_TEXT_CHARS = 320;
const SESSION_SEARCH_WINDOW_TURN_CHARS = 280;
const SEARCH_TRUNCATION_MARKER = '…[truncated]';

interface SearchOutput {
  source: string;
  ref?: string;
  provenance: Record<string, unknown>;
  excerpt: string;
  highlight?: string;
  score: number;
  window?: WindowTurn[];
  readMore?: { tool: string; args: Record<string, unknown> };
}

function clipSearchText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= SEARCH_TRUNCATION_MARKER.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - SEARCH_TRUNCATION_MARKER.length)}${SEARCH_TRUNCATION_MARKER}`;
}

function shapeSearchOutput(result: SearchOutput): SearchOutput {
  return {
    ...result,
    excerpt: clipSearchText(result.excerpt, SESSION_SEARCH_TEXT_CHARS),
    ...(result.highlight
      ? { highlight: clipSearchText(result.highlight, SESSION_SEARCH_TEXT_CHARS) }
      : {}),
    ...(result.window
      ? {
          window: result.window.map((turn) => ({
            ...turn,
            text: clipSearchText(turn.text, SESSION_SEARCH_WINDOW_TURN_CHARS),
          })),
        }
      : {}),
  };
}

/** Last-resort shape: preserve the coordinates/readMore pointer even if one
 * hit's surrounding window alone would consume the response budget. */
function minimizeSearchOutput(result: SearchOutput): SearchOutput {
  return {
    source: result.source,
    ...(result.ref ? { ref: result.ref } : {}),
    provenance: result.provenance,
    excerpt: '[result content omitted to keep the response valid JSON; use readMore]',
    score: result.score,
    ...(result.readMore ? { readMore: result.readMore } : {}),
  };
}

export default defineTool({
  name: 'sessions:search',
  crossWorkspace: true,
  capability: 'search:read',
  description:
    "Search agent session transcripts (claude/omp/codex + harness chats) and get each hit WITH its surrounding turns in one call. mode=verbatim finds exact quotes; mode=hybrid (default) finds by meaning. session:'self' searches YOUR OWN current session — including pre-compaction turns. Continue bounded results with nextCursor.",
  guidance: {
    when:
      '"Which session did agent X say Y" / "we discussed this earlier — where?" / after a compaction, "I said something before the summary — recover it" (session:\'self\', mode:\'verbatim\'). Filters: owner/fleet/speaker/session/source_kind/since/until.',
    notWhen:
      'Recall over escalations/brainstorm/decisions/work-items — search:fulltext / search:semantic. Distilled facts — memory:search. Reading a known session sequentially — sessions:read.',
    chaining:
      "Each hit carries readMore args for sessions:read (a wider window). fleet:<slug> resolves EVER-members from the membership ledger — postmortem-safe. VERIFYING AN OWNER DIRECTIVE: read the hit's provenance.turn_origin, not just that a hit came back — a speaker='user' hit is often a replayed loop goal (agent-authored); 'unknown' means undetermined, never fake.",
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
    limit: z.number().int().min(1).max(20).optional().describe('Max hits (default 5, max 20).'),
    context: z.number().int().min(0).max(5).optional().describe('Turns hydrated on EACH side of a hit (default 2).'),
    cursor: z.string().min(1).max(512).optional().describe('Opaque nextCursor from a prior sessions:search call with the same query and filters.'),
    ...searchFilterArgs,
  }),
  async handler(args, ctx) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    const limit = args.limit ?? 5;
    const context = args.context ?? 2;
    const mode = args.mode ?? 'hybrid';
    const workspaceId = ctx.workspaceId ?? '';
    const callerOwnerId = resolveAgentIdentity(ctx).ownerId ?? '';
    const selfSession = args.session === 'self'
      ? await (await import('../../search/self-session')).resolveSelfSession(callerOwnerId)
      : null;
    const fingerprint = sessionCursorFingerprint(
      { ...args, cursor: undefined, limit: undefined },
      {
        workspaceId,
        // Bind the syntactic `self` sugar to the authority that resolved it.
        // Otherwise another caller can replay the same opaque cursor against a
        // different owner/session result set while retaining the same literal
        // query fingerprint.
        selfOwnerId: args.owner === 'self' || args.session === 'self' ? callerOwnerId : undefined,
        selfSessionId: selfSession?.sessionId,
      },
    );
    const cursor = decodeSessionCursor(args.cursor, 'sessions:search', fingerprint);
    if (!cursor.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...cursor, ok: false }) }] };
    }
    const offset = cursor.offset;
    const snapshotUntil = args.until ?? cursor.bounds.until ?? new Date().toISOString();
    const effectiveArgs = { ...args, until: snapshotUntil };

    const { filters, selfSession: resolvedSelfSession } = await resolveSearchFilters(
      ctx.tx, effectiveArgs, callerOwnerId, { workspaceId },
    );
    await refreshLiveSessionsBeforeRead(ctx.tx, filters?.owners ?? null);

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
           AND (${f.turnOrigin ?? null}::text IS NULL OR turn_origin_verdict = ${f.turnOrigin ?? null})
           AND (${f.ownerOnly ?? null}::boolean IS NULL OR NOT ${f.ownerOnly ?? null} OR turn_origin_verdict IN ('owner-typed', 'owner-dialog'))
           AND (${f.ownerCandidates ?? null}::boolean IS NULL OR NOT ${f.ownerCandidates ?? null} OR turn_origin_verdict = ANY(${OWNER_CANDIDATE_TURN_VERDICTS as string[]}::text[]))
           AND (${f.sessionId ?? null}::text IS NULL OR session_id = ${f.sessionId ?? null})
           AND (${f.sourceKind ?? null}::text IS NULL OR source_kind = ${f.sourceKind ?? null})
           AND (${f.since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${f.since ?? null}::timestamptz)
           AND (${f.until ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) < ${f.until ?? null}::timestamptz)
           AND text ILIKE '%' || ${args.query} || '%'
      ORDER BY COALESCE(ts, ingested_at) DESC
         LIMIT ${limit + 1}
        OFFSET ${offset}
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
      const embedder = await buildQueryEmbedder({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() });
      // WI-3929 (same class as EI-9312): bound the ACTUAL per-query embed
      // call inside runHybridSearch, not just the acquisition above.
      const { results } = await runHybridSearch(sources, {
        sql: ctx.tx,
        query: args.query,
        workspaceId,
        scopeFilter: args.harness_slug ?? null,
        limit: offset + limit + 1,
        mode: 'hybrid',
        embedder,
        embedTimeoutMs: interactiveEmbedAcquireBudgetMs(),
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

    const sourceHasMore = mode === 'verbatim' ? hits.length > limit : hits.length > offset + limit;
    const pageHits = mode === 'verbatim' ? hits.slice(0, limit) : hits.slice(offset, offset + limit);

    // EI-18862790811651475: a 0-hit session:'self' search is CONFIDENCE-BUILDING —
    // it reads as "I checked and there is nothing", not "the query missed". When
    // the owner-scope (WI-5644/5681) spans MORE than the one resolved transcript —
    // i.e. this owner has other indexed session history in scope — say so, so the
    // caller knows a 0 here is "no match for this query", never "no history at
    // all". Best-effort only: never fail the search over this extra read.
    let zeroHitCaveat: string | undefined;

    // A PROVENANCE-FILTERED ZERO IS NOT A QUERY MISS, and must never be
    // rendered as one. `turn_origin:'owner-typed'` / `owner_only:true` filter
    // the PERSISTED verdict, which is strictly more conservative than the
    // verdict a hit DISPLAYS: for a file-backed CLI source, ingest rewrites the
    // `owner-typed` residual to `unenrolled-origin` rather than assert
    // authorship it cannot prove (`stampTurnProvenance`). So on a claude / omp /
    // codex session those filters match NOTHING — not rarely, but by
    // construction — while the same turns come back stamped `owner-typed` when
    // the filter is absent.
    //
    // That is the exact inverse of the failure `turn-origin.ts` was written to
    // kill. There, a loop-fire replay read as owner speech and manufactured a
    // directive; here, a real owner directive is unreachable and its absence
    // reads as proof it was never said. The module header names that inverse
    // (EI-13472 / WI-37419) as its own measured failure, and the generic
    // "QUERY-MATCH MISS ... retry with a different fragment" caveat below
    // actively steers into it — no fragment can ever match. Measured
    // 2026-08-24: 0 `owner-typed` rows across claude/omp/codex against 18,091
    // `unenrolled-origin` ones; `owner_only` reached 30 rows corpus-wide.
    const provenanceFiltered = filters?.turnOrigin != null || filters?.ownerOnly === true;
    if (pageHits.length === 0 && provenanceFiltered) {
      const kinds = [...FILE_BACKED_SOURCE_KINDS].sort().join('/');
      const which = filters?.ownerOnly === true
        ? "owner_only:true (persisted 'owner-typed' or 'owner-dialog')"
        : `turn_origin:'${filters?.turnOrigin}'`;
      zeroHitCaveat =
        `0 hits, but you filtered on PERSISTED provenance (${which}) — this is NOT evidence that no such turn ` +
        `exists, and retrying with a different query fragment will not help. Ingest cannot prove owner authorship ` +
        `for ${kinds} sessions (no enrolment envelope is possible), so it stores a typed owner directive as ` +
        `'unenrolled-origin'` +
        (filters?.ownerOnly === true
          ? ", which owner_only EXCLUDES. On a CLI session owner_only reaches only turn-stamped owner-dialog answers."
          : ".") +
        ` To ask whether the owner said something — including to establish that they did NOT — re-run with ` +
        `owner_candidates:true (proven owner turns PLUS 'unenrolled-origin', still excluding agent-injected and ` +
        `machine-surface replays). Reading THIS zero as "the owner never said it" is the documented ` +
        `EI-13472 / WI-37419 failure.`;
    }

    if (!zeroHitCaveat && args.session === 'self' && pageHits.length === 0 && filters?.owners?.length) {
      try {
        const [row] = await ctx.tx<Array<{ session_count: string; earliest: string | null }>>`
          SELECT COUNT(DISTINCT session_id)::text AS session_count,
                 MIN(COALESCE(ts, ingested_at))::text AS earliest
            FROM harness_shared.session_turns
           WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
             AND owner = ANY(${filters.owners}::text[])
        `;
        const sessionCount = row ? Number(row.session_count) : 0;
        if (sessionCount > 1) {
          zeroHitCaveat =
            `0 hits for this query, but session:'self' is owner-scoped across ${sessionCount} indexed ` +
            `sessions for this owner (earliest ${row?.earliest ?? 'unknown'}) — this is a QUERY-MATCH MISS, ` +
            "not \"no history\". Retry with mode:'hybrid', a shorter/different query fragment, or " +
            'sessions:list { owner: \'self\' } to see what is actually in scope before concluding nothing was said.';
        }
      } catch {
        /* best-effort caveat only — never fail the search over it */
      }
    }

    // EI-20034001963934568: resolve each session_turn hit's ORIGIN — is this
    // turn owner-typed, or the harness replaying an agent's own loop goal into
    // a `speaker='user'` turn? Without it, the verification the compaction
    // rules PRESCRIBE ("search your transcript for the directive") passes on
    // the agent's own words. Re-read from the corpus rather than classifying
    // `h.excerpt`: a hybrid excerpt is a mid-body snippet and the origin
    // envelope is head-anchored (see turn-origin.ts, property 1). One batched
    // round trip for the page; never fail the search over it.
    let turnOrigins = new Map<string, ReturnType<typeof unknownTurnOrigin>>();
    let turnOriginsResolved = true;
    const originKeys = pageHits
      .filter((h) => h.source === 'session_turn')
      .map((h) => ({ sourceKind: h.sourceKind, sessionId: h.sessionId, turnIdx: h.turnIdx }));
    if (originKeys.length) {
      try {
        turnOrigins = await resolveHitTurnOrigins(ctx.tx, workspaceId, originKeys);
      } catch {
        turnOriginsResolved = false; // every hit falls through to `unknown`
      }
    }

    // Hydrate ±context windows only for this page.
    const out: SearchOutput[] = [];
    for (const h of pageHits) {
      const turnOrigin = h.source === 'session_turn'
        ? turnOrigins.get(turnOriginKey({ sourceKind: h.sourceKind, sessionId: h.sessionId, turnIdx: h.turnIdx }))
          ?? unknownTurnOrigin(
            turnOriginsResolved
              ? 'this turn was not found in the corpus on re-read'
              : 'the origin lookup failed',
          )
        : undefined;
      let window: WindowTurn[] | undefined;
      if (h.source === 'session_turn' && context > 0) {
        try {
          window = await hydrateWindow(
            ctx.tx,
            workspaceId,
            h.sourceKind,
            h.sessionId,
            h.turnIdx,
            context,
            SESSION_SEARCH_WINDOW_TURN_CHARS,
          );
        } catch { /* window is a bonus, never fail the search */ }
      }
      out.push(shapeSearchOutput({
        source: h.source,
        ...(h.source === 'session_turn'
          ? { ref: formatSessionTurnRef(h.sourceKind, h.sessionId, h.turnIdx) }
          : {}),
        provenance: h.source === 'session_turn'
          ? { ref: formatSessionTurnRef(h.sourceKind, h.sessionId, h.turnIdx), source_kind: h.sourceKind, session_id: h.sessionId, turn_idx: h.turnIdx,
              ...(h.speaker ? { speaker: h.speaker } : {}), ...(h.owner ? { owner: h.owner } : {}),
              ...(h.harness_slug ? { harness_slug: h.harness_slug } : {}), ...(h.ts ? { ts: h.ts } : {}),
              ...(turnOrigin ? { turn_origin: turnOrigin } : {}) }
          : { msg_id: h.sessionId },
        excerpt: h.excerpt,
        ...(h.highlight ? { highlight: h.highlight } : {}),
        score: h.score,
        ...(window ? { window } : {}),
        ...(h.source === 'session_turn'
          ? { readMore: { tool: 'sessions:read', args: { ref: formatSessionTurnRef(h.sourceKind, h.sessionId, h.turnIdx), context: 10 } } }
          : {}),
      }));
    }

    const baseResponse: Record<string, unknown> = {
      ok: true,
      query: args.query,
      mode,
      window: { until: snapshotUntil },
      ...(resolvedSelfSession
        ? { self_session: { source_kind: resolvedSelfSession.sourceKind, session_id: resolvedSelfSession.sessionId } }
        : {}),
      ...(args.session === 'self' && !resolvedSelfSession
        ? { note: "session:'self' could not be pinned to a live transcript — degraded to an owner-filtered search." }
        : {}),
      // EI-18877285731929394: verbatim mode is exact-substring (ILIKE), so a
      // paraphrased/multi-word "what I remember" query — exactly what the
      // compaction-recovery doc's own example encourages — silently returns 0
      // hits even when the content exists, and a 0-hit result reads exactly
      // like "it never happened" rather than "your query wasn't a literal
      // quote". Surface the fallback right where the false negative occurs,
      // not just in prose docs an agent may not re-read mid-recovery.
      ...(mode === 'verbatim' && pageHits.length === 0
        ? {
            hint:
              "0 hits: verbatim mode matches only an exact, contiguous, case-insensitive substring — a paraphrase or multi-word description of what you remember will NOT match even if the content exists. Retry with mode:'hybrid' (meaning-based, the default) to search by concept, or narrow query to the exact short phrase you expect verbatim in the transcript. Do not read this 0 as \"it didn't happen\".",
          }
        : {}),
      ...(zeroHitCaveat ? { zeroHitCaveat } : {}),
    };

    const cursorFor = (resultCount: number, more: boolean): string | undefined => more
      ? encodeSessionCursor('sessions:search', offset + resultCount, fingerprint, { until: snapshotUntil })
      : undefined;
    const serializeResponse = (
      results: SearchOutput[],
      more: boolean,
      nextCursor: string | undefined,
      truncated: boolean,
    ): string => JSON.stringify({
      ...baseResponse,
      total_hits: results.length,
      hasMore: more,
      ...(nextCursor ? { nextCursor } : {}),
      ...(truncated
        ? {
            resultsTruncated: {
              requested: out.length,
              returned: results.length,
              reason: 'response_budget',
            },
          }
        : {}),
      results,
    });

    // The result door can only preserve a complete JSON body when the tool
    // shapes it before the door sees it. Return a prefix that fits and advance
    // the cursor by exactly that prefix, so omitted hits remain pageable.
    let responseText = serializeResponse(
      out,
      sourceHasMore,
      cursorFor(out.length, sourceHasMore),
      false,
    );
    let selected = false;
    for (let count = out.length; count >= 1; count -= 1) {
      const results = out.slice(0, count);
      const more = sourceHasMore || count < out.length;
      const candidate = serializeResponse(results, more, cursorFor(count, more), count < out.length);
      if (candidate.length <= SESSION_SEARCH_RESPONSE_BUDGET_CHARS) {
        responseText = candidate;
        selected = true;
        break;
      }
    }

    // A single hit can still carry unusually large identifiers or provenance.
    // Keep its session coordinate and readMore pointer, but never fall back to
    // an over-door, invalid JSON response.
    if (!selected && out.length > 0) {
      const results = [minimizeSearchOutput(out[0])];
      const more = sourceHasMore || out.length > 1;
      const candidate = serializeResponse(results, more, cursorFor(1, more), true);
      responseText = candidate.length <= SESSION_SEARCH_RESPONSE_BUDGET_CHARS
        ? candidate
        : serializeResponse([], true, cursorFor(0, true), true);
    }

    return {
      content: [{ type: 'text' as const, text: responseText }],
    };
  },
});
