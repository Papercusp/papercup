/**
 * sessions:read — bounded window read over one indexed session
 * (session-search-scope-2026-07-05 P-006). The navigation half of the
 * search→read composition: sessions:search finds the needle, this reads
 * around it. Reads the INDEX (session_turns), never a raw file dump —
 * per-turn text is already truncated+redacted at ingest.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  sessionSearchEnabled,
  disabledResult,
  SESSION_SOURCE_KINDS,
  SESSION_TURN_REF_PREFIX,
  formatSessionTurnRef,
  parseSessionSelector,
  parseTurnRef,
  refreshTargetSessionBeforeRead,
} from './_shared';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

const readArgsSchema = z
  .object({
    ref: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Canonical session-turn reference from sessions:search/read: session_turn:<source-kind>:<full-session-id>:<turn-index>. Pass directly to retrieve that exact turn; add context for surrounding turns, and optionally use limit/order to choose a bounded side of that window.',
      ),
    session: z.string().min(1).max(200).optional().describe("Session id, '<source-kind>:<session-id>', or 'self' for the calling agent's current session."),
    source_kind: z.enum(SESSION_SOURCE_KINDS).optional().describe('Disambiguates when the same id exists under two sources; usually unnecessary.'),
    around: z.number().int().min(0).optional().describe('Center the window on this turn_idx.'),
    context: z.number().int().min(0).max(50).optional().describe('Turns each side of `around` or `ref` (around default 5; ref default 0 = exact turn).'),
    from_idx: z.number().int().min(0).optional(),
    to_idx: z.number().int().min(0).optional(),
    order: z
      .enum(['asc', 'desc'])
      .optional()
      .describe(
        "Which END of the range to return when it has more turns than `limit`: 'desc' (DEFAULT) = the TAIL (newest — where a session left off); 'asc' = the HEAD (from turn 0 — the kickoff prompt / launch context / loop goal, i.e. what the session was FOR). Output is chronological either way.",
      ),
    tail: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Shorthand for the newest N turns (`order:'desc', limit:N`). Cannot be combined with `order` or `limit`."),
    limit: z.number().int().min(1).max(200).optional().describe('Max turns (default 40 for a session read; exact ref reads default to 1, or 2×context+1).'),
  })
  // `mode` and `query` belong to sessions:search. Keep this navigation tool
  // closed at the source schema too, so stale callers fail with a useful
  // unrecognized-key error before reaching the handler (EI-212937).
  .strict()
  .superRefine((args, ctx) => {
    if (Boolean(args.ref) === Boolean(args.session)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass exactly one of `ref` or `session`' });
    }
    if (args.ref && !args.ref.startsWith(SESSION_TURN_REF_PREFIX)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ref'], message: `ref must start with ${SESSION_TURN_REF_PREFIX}` });
    }
    if (args.ref && (args.source_kind || args.around != null || args.from_idx != null || args.to_idx != null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: '`ref` already fixes source/session/turn; combine it only with `context`, `limit`/`order`, or the `tail` shorthand',
      });
    }
    if (args.tail != null && (args.order != null || args.limit != null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tail'],
        message: "`tail:N` already means `order:'desc', limit:N`; do not combine it with `order` or `limit`",
      });
    }
  });

export default defineTool({
  name: 'sessions:read',
  needsWorkspaceTx: true,
  crossWorkspace: true,
  capability: 'search:read',
  description:
    "Read a bounded window of turns from one indexed session transcript — pass a canonical `session_turn:…` ref directly, coordinates around a turn, a from/to range, or the tail. `tail:N` already means `order:'desc', limit:N`; do not combine `tail` with `order` or `limit`. session:'self' reads YOUR OWN current session (pre-compaction turns included). Search-only `query` and `mode` arguments belong to sessions:search and are rejected here. " +
    "NOTE ON `turn_count` (EI-9970): this is the number of rows in THIS response's window (bounded by `limit`, default 40) — NOT the session's total turn count. It is a DIFFERENT quantity from sessions:list's `turns` field (that session's full indexed-text-turn total) despite the similar name; do not compare them. For the session total, use sessions:list.",
  guidance: {
    when:
      "Following a sessions:search hit: pass its `ref` directly (plus optional `context`). To read where a session left off, use `tail:N` (or explicit order:'desc' + limit); use order:'asc' for the opening turns.",
    notWhen:
      'Finding WHERE something was said — sessions:search (which owns `query` and `mode`). Raw un-indexed files — dev:claude_session op=read (being absorbed here).',
    chaining: 'sessions:search result.ref → sessions:read { ref, context?, limit?, order? }.',
    // EI-10882: the RESPONSE shape, stated up front. Arg schemas were published
    // but return shapes were not, so the only way to learn the shape was to call
    // once and introspect — one guaranteed wasted round-trip per tool, per agent.
    returns:
      '{ ok, session_id, turn_count (SIZE OF THIS WINDOW, not the session total), turns: [{ ref, turn_idx, speaker, owner?, ts, text }] } — each ref is directly reusable with sessions:read. Turns are ALWAYS returned oldest→newest.',
    seeAlso: ['sessions:search', 'sessions:list', 'sessions:digest'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 100 } },
  args: readArgsSchema,
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
        ref: z.string(),
        turn_idx: z.number().int().nonnegative(),
        speaker: z.string(),
        owner: z.string().optional(),
        ts: z.string().optional(),
        text: z.string(),
      }),
    ),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const tx = ctx.tx!;
    if (!(await sessionSearchEnabled())) return disabledResult();
    const workspaceId = ctx.workspaceId ?? '';
    const parsedRef = args.ref ? parseTurnRef(args.ref) : null;
    if (args.ref && !parsedRef) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'invalid_session_turn_ref', ref: args.ref }) }],
        isError: true,
      };
    }
    const refContext = parsedRef ? (args.context ?? 0) : null;
    const limit = args.tail ?? args.limit ?? (parsedRef ? refContext! * 2 + 1 : 40);

    let sessionId = parsedRef?.sessionId ?? args.session!;
    let querySessionId: string | undefined = sessionId;
    let sourceKind = parsedRef?.sourceKind ?? args.source_kind;
    if (!parsedRef) {
      const selector = parseSessionSelector(sessionId, sourceKind);
      sessionId = selector.sessionId;
      sourceKind = selector.sourceKind;
    }
    let selfNote: string | undefined;
    const selfSession = sessionId === 'self';
    let ownerIds: string[] | undefined;
    if (selfSession) {
      // Keep `session:'self'` aligned with sessions:search: a cold carry-respawn
      // leaves the caller's turns across multiple native sessions, so the
      // current session id is only a response anchor, never the read filter.
      // resolveSearchFilters owns the caller/isolation-owner chain expansion
      // (including coord-id drift) and the current-transcript freshness tail.
      const callerOwnerId = resolveAgentIdentity(ctx).ownerId ?? '';
      const { resolveSearchFilters } = await import('../search/filters');
      const resolved = await resolveSearchFilters(
        tx,
        { session: 'self' },
        callerOwnerId,
        { workspaceId },
      );
      const self = resolved.selfSession;
      if (!self) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'self_session_unresolved', note: 'Could not pin your live transcript; use sessions:list { owner:"self" } to find your sessions.' }) }],
          isError: true,
        };
      }
      ownerIds = resolved.filters?.owners ?? [callerOwnerId];
      querySessionId = undefined;
      sessionId = self.sessionId;
      sourceKind = self.sourceKind;
      selfNote = `resolved self → ${self.sourceKind}:${self.sessionId}`;
    } else {
      // Keep the historical/indexed read and archive fall-through unchanged;
      // the helper refreshes only an active target found in adv_sessions.
      try {
        await refreshTargetSessionBeforeRead(tx, sourceKind, sessionId);
      } catch {
        /* target freshness is best-effort; never make an indexed read fail */
      }
    }

    let lo: number | null = null;
    let hi: number | null = null;
    if (parsedRef) {
      lo = Math.max(0, parsedRef.turnIdx - refContext!);
      hi = parsedRef.turnIdx + refContext!;
    } else if (typeof args.around === 'number') {
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
    const rows = await tx<Array<{ source_kind: string; session_id: string; turn_idx: number; speaker: string; owner: string | null; ts: string | null; text: string }>>`
      SELECT source_kind, session_id, turn_idx, speaker, owner, ts::text AS ts, left(text, 1500) AS text
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND (${querySessionId ?? null}::text IS NULL OR session_id = ${querySessionId ?? null})
         AND (${ownerIds ?? null}::text[] IS NULL OR owner = ANY(${ownerIds ?? null}::text[]))
         AND (${sourceKind ?? null}::text IS NULL OR source_kind = ${sourceKind ?? null})
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
    if (!rows.length && !selfSession) {
      try {
        const { readArchivedSessionTurns } = await import('../../session-archive-read');
        // WI-4301: the archive blob store is file-based and never covers
        // agent_chat (that source's sessions live in agent_chats_consolidated,
        // not a tailed file) — narrow it away rather than mistype it through;
        // undefined just means "try all archive-backed kinds", which is the
        // correct fallback when the caller asked for a kind the archive can't
        // serve anyway.
        const archiveSourceKind =
          sourceKind === 'claude' || sourceKind === 'omp' || sourceKind === 'codex'
            ? sourceKind
            : undefined;
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
              session_id: sessionId,
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
          turns: rows.map((r: { source_kind: string; session_id?: string; turn_idx: number; speaker: string; owner: string | null; ts: string | null; text: string }) => ({
            // The indexed query always returns session_id; retain the requested
            // session as a defensive fallback for archive/test-shaped rows.
            ref: formatSessionTurnRef(r.source_kind, r.session_id ?? sessionId, r.turn_idx),
            turn_idx: r.turn_idx, speaker: r.speaker,
            ...(r.owner ? { owner: r.owner } : {}), ...(r.ts ? { ts: r.ts } : {}),
            text: r.text,
          })),
        }),
      }],
    };
  },
});
