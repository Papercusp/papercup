/**
 * sessions:read — bounded window read over one indexed session
 * (session-search-scope-2026-07-05 P-006). The navigation half of the
 * search→read composition: sessions:search finds the needle, this reads
 * around it. Reads the INDEX (session_turns), never a raw file dump —
 * per-turn text is already truncated+redacted at ingest.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { sessionSearchEnabled, disabledResult, SESSION_SOURCE_KINDS } from './_shared';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

export default defineTool({
  name: 'sessions:read',
  crossWorkspace: true,
  capability: 'search:read',
  description:
    "Read a bounded window of turns from one indexed session transcript — around a turn (a sessions:search hit's readMore), a from/to range, or the tail. session:'self' reads YOUR OWN current session (pre-compaction turns included). " +
    "NOTE ON `turn_count` (EI-9970): this is the number of rows in THIS response's window (bounded by `limit`, default 40) — NOT the session's total turn count. It is a DIFFERENT quantity from sessions:list's `turns` field (that session's full indexed-text-turn total) despite the similar name; do not compare them. For the session total, use sessions:list.",
  guidance: {
    when:
      "Following a sessions:search hit for more context, or reading where a session left off. Pass around=<turn_idx> (from the hit's provenance), order:'asc' for the session's OPENING turns, or nothing for the tail.",
    notWhen:
      'Finding WHERE something was said — sessions:search. Raw un-indexed files — dev:claude_session op=read (being absorbed here).',
    chaining: 'provenance.turn_idx from sessions:search hits → around.',
    // EI-10882: the RESPONSE shape, stated up front. Arg schemas were published
    // but return shapes were not, so the only way to learn the shape was to call
    // once and introspect — one guaranteed wasted round-trip per tool, per agent.
    returns:
      '{ ok, session_id, turn_count (SIZE OF THIS WINDOW, not the session total), turns: [{ turn_idx, speaker, owner?, ts, text }] } — turns are ALWAYS returned in chronological order (oldest→newest) regardless of `order`; `order` selects WHICH END of the range you get, not the sort of the output.',
    seeAlso: ['sessions:search', 'sessions:list', 'sessions:digest'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 100 } },
  args: z.object({
    session: z.string().min(1).max(200).describe("Session id, or 'self' for the calling agent's current session."),
    source_kind: z.enum(SESSION_SOURCE_KINDS).optional().describe('Disambiguates when the same id exists under two sources; usually unnecessary.'),
    around: z.number().int().min(0).optional().describe('Center the window on this turn_idx.'),
    context: z.number().int().min(1).max(50).optional().describe('Turns each side of `around` (default 5).'),
    from_idx: z.number().int().min(0).optional(),
    to_idx: z.number().int().min(0).optional(),
    // EI-10887: the HEAD of a session was unreachable. `from_idx: 0` did NOT get
    // you the opening turns — the query always ordered `turn_idx DESC LIMIT n`, so
    // any range still returned its LAST `limit` rows. That made turn 0 (the kickoff
    // prompt / launch context / loop goal — the single turn that answers "what was
    // this session FOR") reachable only by guessing a `to_idx` bound. `order:'asc'`
    // makes it one call.
    order: z
      .enum(['asc', 'desc'])
      .optional()
      .describe(
        "Which END of the range to return when it has more turns than `limit`: 'desc' (DEFAULT) = the TAIL (newest — where a session left off); 'asc' = the HEAD (from turn 0 — the kickoff prompt / launch context / loop goal, i.e. what the session was FOR). Output is chronological either way.",
      ),
    limit: z.number().int().min(1).max(200).optional().describe('Max turns (default 40). No range args = the session TAIL (or HEAD with order:"asc").'),
  }),
  // Keep the lossless object available as MCP structuredContent for programmatic
  // callers (ptool / MCP clients that request `_meta.structured`). The text body
  // still goes through the ordinary result door for model-facing calls, but a
  // door-truncated JSON string is not a valid machine-readable response.
  result: z.object({
    ok: z.boolean(),
    session_id: z.string(),
    note: z.string().optional(),
    turn_count: z.number().int().nonnegative(),
    turns: z.array(
      z.object({
        turn_idx: z.number().int().nonnegative(),
        speaker: z.string(),
        owner: z.string().optional(),
        ts: z.string().optional(),
        text: z.string(),
      }),
    ),
  }),
  async handler(args, ctx) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    const workspaceId = ctx.workspaceId ?? '';
    const limit = args.limit ?? 40;

    let sessionId = args.session;
    let selfNote: string | undefined;
    if (args.session === 'self') {
      const { resolveSelfSession } = await import('../../search/self-session');
      const self = await resolveSelfSession(resolveAgentIdentity(ctx).ownerId ?? '');
      if (!self) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'self_session_unresolved', note: 'Could not pin your live transcript; use sessions:list { owner:"self" } to find your sessions.' }) }],
          isError: true,
        };
      }
      sessionId = self.sessionId;
      try {
        const { ingestFileNow } = await import('../../search/session-ingest');
        await ingestFileNow(self.filePath); // read-time freshness (D-002)
      } catch { /* the 2-min tick covers it */ }
      selfNote = `resolved self → ${self.sourceKind}:${self.sessionId}`;
    }

    let lo: number | null = null;
    let hi: number | null = null;
    if (typeof args.around === 'number') {
      const c = args.context ?? 5;
      lo = Math.max(0, args.around - c);
      hi = args.around + c;
    } else if (typeof args.from_idx === 'number' || typeof args.to_idx === 'number') {
      lo = args.from_idx ?? 0;
      hi = args.to_idx ?? null;
    }

    // EI-10887: `order` selects WHICH END of the range survives `limit`.
    //   desc (default) → the TAIL  (newest turns — where the session left off)
    //   asc            → the HEAD  (turn 0 onward — the kickoff prompt / loop goal)
    // The CASE keeps this a SINGLE parameterized query: when asc, the first sort
    // key is turn_idx (ASC) and the second is a constant; when desc, the first key
    // is a constant (all rows tie) and the second is turn_idx (DESC). Output is
    // ALWAYS re-normalised to chronological below, so `order` never changes the
    // shape the caller reads — only which slice of a too-large range they get.
    const asc = args.order === 'asc';
    const rows = await ctx.tx<Array<{ source_kind: string; turn_idx: number; speaker: string; owner: string | null; ts: string | null; text: string }>>`
      SELECT source_kind, turn_idx, speaker, owner, ts::text AS ts, left(text, 1500) AS text
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND session_id = ${sessionId}
         AND (${args.source_kind ?? null}::text IS NULL OR source_kind = ${args.source_kind ?? null})
         AND (${lo}::int IS NULL OR turn_idx >= ${lo})
         AND (${hi}::int IS NULL OR turn_idx <= ${hi})
    ORDER BY CASE WHEN ${asc} THEN turn_idx END ASC NULLS LAST,
             CASE WHEN ${asc} THEN NULL::int ELSE turn_idx END DESC NULLS LAST
       LIMIT ${limit}
    `;
    // A desc (tail) fetch comes back newest-first; flip it so every response is
    // chronological. An asc (head) fetch is already chronological.
    if (!asc) rows.reverse();

    // Archive fall-through (session-db-archive-retire-dirs P-009): the index
    // prunes at 45d, but the session_archives blob store is permanent. A
    // session with NO index rows may still be readable — decompress, re-parse
    // with the ingest parsers, re-apply the ingest cap+redaction, and window
    // in JS. sessions:search stays index-bounded by design (D-001).
    let archiveNote: string | undefined;
    if (!rows.length && args.session !== 'self') {
      try {
        const { readArchivedSessionTurns } = await import('../../session-archive-read');
        // WI-4301: the archive blob store is file-based and never covers
        // agent_chat (that source's sessions live in agent_chats_consolidated,
        // not a tailed file) — narrow it away rather than mistype it through;
        // undefined just means "try all archive-backed kinds", which is the
        // correct fallback when the caller asked for a kind the archive can't
        // serve anyway.
        const archiveSourceKind = args.source_kind === 'agent_chat' ? undefined : args.source_kind;
        const arch = await readArchivedSessionTurns(sessionId, archiveSourceKind);
        if (arch) {
          let t = arch.turns;
          if (lo !== null || hi !== null) {
            t = t.filter((x) => (lo === null || x.turn_idx >= lo) && (hi === null || x.turn_idx <= hi));
          }
          // EI-10887: honour `order` on the archive path too, or a head read would
          // silently fall back to the tail for any session old enough to be pruned
          // from the index — exactly the sessions whose opening turns you most need.
          t = asc ? t.slice(0, limit) : t.slice(-limit);
          rows.push(
            ...t.map((x) => ({
              source_kind: x.source_kind,
              turn_idx: x.turn_idx,
              speaker: x.speaker,
              owner: x.owner,
              ts: x.ts,
              text: x.text.slice(0, 1500),
            })),
          );
          archiveNote = `served from the permanent archive (index pruned/absent); source=${arch.sourceKind}`;
        }
      } catch (e) {
        console.warn(`[sessions:read] archive fall-through failed: ${(e as Error)?.message ?? e}`);
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          session_id: sessionId,
          ...(selfNote ? { note: selfNote } : {}),
          ...(archiveNote ? { note: archiveNote } : {}),
          // EI-9970: this is the WINDOW size (rows returned here, capped by
          // `limit`), NOT the session's total turn count — see the tool
          // description. sessions:list's `turns` is the total; do not conflate.
          turn_count: rows.length,
          turns: rows.map((r: { source_kind: string; turn_idx: number; speaker: string; owner: string | null; ts: string | null; text: string }) => ({
            turn_idx: r.turn_idx, speaker: r.speaker,
            ...(r.owner ? { owner: r.owner } : {}), ...(r.ts ? { ts: r.ts } : {}),
            text: r.text,
          })),
        }),
      }],
    };
  },
});
