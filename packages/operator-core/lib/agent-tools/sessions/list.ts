/**
 * sessions:list — unified session enumeration across every indexed client
 * (session-search-scope-2026-07-05 P-006): claude + omp + codex + harness
 * chats in ONE list (absorbs dev:claude_session op=list / omp:sessions
 * op=list, and adds codex — which had NO reader before this).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { sessionSearchEnabled, disabledResult, SESSION_SOURCE_KINDS, refreshLiveSessionsBeforeRead } from './_shared';
import { decodeSessionCursor, encodeSessionCursor, sessionCursorFingerprint } from './cursor';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

/**
 * The row shape this query returns. Declared as an interface and used to
 * ANNOTATE the `rows` const. EI-10968: the handler below is now typed
 * `ctx: PapercuspUnifiedToolContext` (`_tool-context.ts`), which gives `ctx.tx`
 * a real `Sql` type — `ctx.tx<Array<{…}>>` genuinely binds the row shape now
 * instead of silently discarding the type argument (see the fuller note on
 * sessions/digest.ts). The const annotation stays for readability/redundant safety.
 */
interface SessionListRow {
  source_kind: string;
  session_id: string;
  turns: number;
  prompt_count: number;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  first_ts: string | null;
  last_ts: string | null;
  response_count: number | null;
  tool_call_count: number | null;
  total_matching: number;
}

/**
 * The projected row the caller reads. Real (indexed) rows carry every field but
 * `active`; the synthetic live-session fallback row (EI-11403) sets `active:true`
 * so `owner:'self'` never reports a LIVE session as absent when its turns are
 * indexed under a different owner stamp — or not yet indexed at all.
 */
interface OutSession {
  source_kind: string;
  session_id: string;
  turns: number;
  prompt_count: number;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  first_ts: string | null;
  last_ts: string | null;
  response_count: number | null;
  tool_call_count: number | null;
  /** Only present (and true) on the injected live-session fallback row. */
  active?: boolean;
}

export default defineTool({
  name: 'sessions:list',
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'List indexed agent sessions across ALL clients (claude/omp/codex/harness chats) — newest first, with size/effort counts, owner, cwd, and time range. Filter by owner (self), source_kind, cwd substring, or time; continue a bounded result with nextCursor. ' +
    'UNITS (EI-9970): `turns` = indexed TEXT-turn rows only (real user+assistant text; excludes tool_use/tool_result/thinking-only lines by design) — NOT a raw record count, NOT one row per model call; don\'t use it alone for cost/effort audits. Use `prompt_count` (real user prompts), `response_count` (distinct model-inference calls, deduped by request/message id — one call can span several raw lines), and `tool_call_count` (real tool invocations) instead; the latter two are null for source_kind=agent_chat (no tool-call signal in that shape).',
  guidance: {
    when:
      '"What sessions has agent X had", "find my session from yesterday", or picking a session id for sessions:read. Covers the whole fleet, not one client. For a COST/EFFORT audit, compare prompt_count/response_count/tool_call_count, not turns — see description.',
    notWhen:
      'Searching CONTENT — sessions:search. Live "who is on what" — coord:presence / fleet:assignments.',
    chaining: 'session_id → sessions:read / sessions:search { session } / sessions:digest { session }.',
    // EI-10882: publish the RESPONSE shape. Arg schemas were published but return
    // shapes were not, so writing any code:run batch over this tool required calling
    // it once just to learn the field names — a guaranteed wasted round-trip per tool.
    returns:
      '{ ok, count (rows HERE), total (rows MATCHING), hasMore, nextCursor?, truncated?, note, sessions: [{ source_kind, session_id, turns, prompt_count, owner, harness_slug, cwd, first_ts, last_ts, response_count, tool_call_count, active? }] }. `active:true` (owner:\'self\', page one) marks your LIVE session surfaced even if its turns are not yet indexed under `self` (EI-11403). Timestamps are ISO-8601 with an explicit offset. Pass nextCursor back unchanged to continue the same filters.',
    seeAlso: ['sessions:search', 'sessions:read', 'sessions:digest', 'sessions:timeline'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 100 } },
  args: z.object({
    owner: z.string().max(120).optional().describe("Filter to one agent ownerId ('self' = the caller)."),
    source_kind: z.enum(SESSION_SOURCE_KINDS).optional(),
    cwd_contains: z.string().max(200).optional().describe('Substring match on the session cwd.'),
    since: z.string().max(40).optional().describe('Only sessions active after this ISO timestamp.'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
    cursor: z.string().min(1).max(512).optional().describe('Opaque nextCursor from a prior sessions:list call with the same filters.'),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    // Non-null: `tx` is optional on PapercuspUnifiedToolContext (must match the
    // framework's own optional `ctx.tx` for defineTool's overload resolution to
    // accept this handler — see _tool-context.ts) but is always bound for an
    // authenticated tool call. Destructured once so every ctx.tx<T> below is
    // actually typed instead of a decorative type argument on `any` (EI-10968).
    const tx = ctx.tx!;
    const workspaceId = ctx.workspaceId ?? '';
    const limit = args.limit ?? 30;
    const owner = args.owner === 'self' ? (resolveAgentIdentity(ctx).ownerId ?? '') : (args.owner ?? null);
    const fingerprint = sessionCursorFingerprint({
      owner: args.owner ?? null,
      source_kind: args.source_kind ?? null,
      cwd_contains: args.cwd_contains ?? null,
      since: args.since ?? null,
    }, {
      workspaceId,
      selfOwnerId: args.owner === 'self' ? owner ?? undefined : undefined,
    });
    const cursor = decodeSessionCursor(args.cursor, 'sessions:list', fingerprint);
    if (!cursor.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...cursor, ok: false }) }] };
    }
    const offset = cursor.offset;
    // Freeze the upper time boundary on page one and carry it in every cursor.
    // Without this, a newly-ingested live turn shifts OFFSET and page two can
    // repeat page one's session (the production recurrence that reopened P-009).
    const snapshotUntil = cursor.bounds.until ?? new Date().toISOString();

    // Read-time freshness applies to every owner filter and to the bounded set
    // of open Codex sessions on an unfiltered read, not only owner:'self'.
    await refreshLiveSessionsBeforeRead(tx, owner ? [owner] : null);

    // EI-9970: `turns` (session_turns row count) and the real prompt/
    // response/tool-call counts (session_ingest_state, accumulated at
    // ingest time over EVERY raw line — a superset of session_turns'
    // TEXT-TURNS-ONLY scope) are aggregated SEPARATELY, each grouped down
    // to one row per (source_kind, session_id) BEFORE being joined — a
    // direct join of the two raw tables would fan out session_turns' rows
    // by however many session_ingest_state rows share that session_id
    // (rare but possible — a rotated/split log file) and silently inflate
    // `turns` itself, which is exactly the kind of miscount this fix
    // exists to stop reintroducing.
    // EI-10891 (timestamps): emit ISO-8601 WITH an explicit offset — to_json() on a
    // timestamptz yields e.g. 2026-07-12T00:46:02.236-04:00 — instead of Postgres'
    // bare "2026-07-12 00:46:02.236-04" text cast. `since` is parsed as UTC, so
    // returning a bare local-offset string on the way OUT made the two ends of the
    // SAME tool speak different clocks: an auditing agent compared a 00:46 row
    // against an 04:43Z cutoff and nearly reported the filter as broken (it was
    // correct — 00:46-04 IS 04:46Z). Ordering still uses the raw timestamptz, never
    // the rendered text, so a mixed-offset corpus cannot mis-sort.
    //
    // NOTE: keep backticks out of the SQL template below — it is a JS template
    // literal, and a stray backtick in a comment silently terminates the string.
    const rows: SessionListRow[] = await tx<SessionListRow[]>`
      WITH turns_agg AS (
        SELECT source_kind, session_id, count(*)::int AS turns,
               count(*) FILTER (WHERE speaker = 'user')::int AS prompt_count,
               max(owner) AS owner, max(harness_slug) AS harness_slug, max(cwd) AS cwd,
               min(ts) AS first_ts_raw, max(ts) AS last_ts_raw
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
           AND COALESCE(ts, ingested_at) < ${snapshotUntil}::timestamptz
           AND (${owner}::text IS NULL OR owner = ${owner})
           AND (${args.source_kind ?? null}::text IS NULL OR source_kind = ${args.source_kind ?? null})
           AND (${args.cwd_contains ?? null}::text IS NULL OR cwd ILIKE '%' || ${args.cwd_contains ?? null} || '%')
           AND (${args.since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${args.since ?? null}::timestamptz)
         GROUP BY source_kind, session_id
      ),
      state_agg AS (
        SELECT source_kind, session_id,
               sum(response_count)::int AS response_count,
               sum(tool_call_count)::int AS tool_call_count
          FROM harness_shared.session_ingest_state
         WHERE session_id IS NOT NULL
         GROUP BY source_kind, session_id
      )
      SELECT t.source_kind, t.session_id, t.turns, t.prompt_count,
             t.owner, t.harness_slug, t.cwd,
             -- EI-10891: ISO-8601 with an explicit offset (see the note above).
             to_json(t.first_ts_raw) #>> '{}' AS first_ts,
             to_json(t.last_ts_raw)  #>> '{}' AS last_ts,
             s.response_count, s.tool_call_count,
             -- EI-10886: the true match count BEFORE the limit. A window function is
             -- evaluated ahead of LIMIT, so this is the unbounded total in one pass.
             count(*) OVER ()::int AS total_matching
        FROM turns_agg t
        LEFT JOIN state_agg s USING (source_kind, session_id)
       ORDER BY t.last_ts_raw DESC NULLS LAST
       LIMIT ${limit + 1}
      OFFSET ${offset}
    `;

    // EI-10886: `count` used to equal `limit` on a truncated read with nothing to
    // distinguish it from an exhaustive one — a caller could not tell whether the
    // window held 100 sessions or 500, and the max limit (100) made the ambiguity
    // permanent. Report the real total and say plainly whether more remain.
    let total = rows[0]?.total_matching ?? offset;
    // Project explicitly rather than rest-spreading `total_matching` away: the
    // window-function column is a transport detail of THIS query, and an explicit
    // projection guarantees it can never leak into a row the caller reads as data.
    const sessions: OutSession[] = rows.slice(0, limit).map((r) => ({
      source_kind: r.source_kind,
      session_id: r.session_id,
      turns: r.turns,
      prompt_count: r.prompt_count,
      owner: r.owner,
      harness_slug: r.harness_slug,
      cwd: r.cwd,
      first_ts: r.first_ts,
      last_ts: r.last_ts,
      response_count: r.response_count,
      tool_call_count: r.tool_call_count,
    }));
    // Pagination advances over the OWNER-matched rows only; the synthetic
    // fallback below is prepended OUTSIDE that offset stream, so it must never
    // shift the real-row window.
    const realPageCount = sessions.length;

    // EI-11403: sessions:list { owner:'self' } returned 0 for a LIVE Codex session
    // that sessions:search { session:'self' } and sessions:timeline { owner:'self' }
    // could both read. Root cause: those two resolve the session by session_id,
    // while list filters session_turns by `owner` — and a managed-Codex-home /
    // history.jsonl live session's turns are indexed under a different owner stamp
    // (or not yet indexed at all) than the coord ownerId `self` resolves to, so the
    // owner filter misses them. Merge an explicit active-session row (the issue's
    // recommended fix) so list AGREES the session exists. Owner-INDEPENDENT counts
    // (by session_id, the same lens search/timeline use) make the row match what
    // those tools see even when the owner stamp diverges. Page one only (the row is
    // not part of the offset stream); fail-soft (the fallback is a bonus, never
    // breaks the list).
    // WI-37867 GENERALISES the EI-11403 fallback from owner:'self' to ANY named
    // owner. The HUD conversation popup resolves an ARBITRARY agent's ownerId
    // through this tool, and a session that has produced ZERO turns is absent
    // from session_turns entirely — so the popup received null, built no stream
    // URL, and rendered a silently blank window (no banner: the fetch resolved
    // rather than threw). That is precisely the moment a human opens a chat: the
    // session is newest. adv_sessions carries session_id from the instant of
    // launch, so it can answer "which session is this agent running RIGHT NOW"
    // when the transcript index structurally cannot.
    if (offset === 0 && owner) {
      try {
        const { resolveSelfSession } = await import('../../search/self-session');
        // Discovery-record lens first — it is what EI-11403 needed, because a
        // managed-Codex live session's turns can be stamped under a different
        // owner. Then the adv_sessions lens, which covers the zero-turn case the
        // discovery record cannot (and does not depend on a pty record existing).
        const self = await resolveSelfSession(owner);
        let live: { sourceKind: string; sessionId: string } | null =
          self ? { sourceKind: self.sourceKind, sessionId: self.sessionId } : null;
        if (!live) {
          const advRows = await tx<Array<{ agent: string | null; session_id: string }>>`
            SELECT agent, session_id
              FROM harness_shared.adv_sessions
             WHERE coord_owner_id = ${owner}
               AND ended_at IS NULL
               AND session_id IS NOT NULL
               AND (workspace_id = ${workspaceId} OR workspace_id = 'default')
             ORDER BY started_at DESC
             LIMIT 5`;
          // Filter in JS against SESSION_SOURCE_KINDS so that constant stays the
          // single source of truth (an agent value outside it has no lens here).
          const adv = advRows.find((r) => r.agent != null
            && (SESSION_SOURCE_KINDS as readonly string[]).includes(r.agent));
          if (adv?.agent) live = { sourceKind: adv.agent, sessionId: adv.session_id };
        }
        // Bind to a const so the null-check narrows inside the closure below.
        const liveSession = live;
        if (liveSession && !sessions.some((s) => s.source_kind === liveSession.sourceKind && s.session_id === liveSession.sessionId)) {
          const liveRows = await tx<Array<{
            turns: number; prompt_count: number;
            harness_slug: string | null; cwd: string | null;
            first_ts: string | null; last_ts: string | null;
          }>>`
            SELECT count(*)::int AS turns,
                   count(*) FILTER (WHERE speaker = 'user')::int AS prompt_count,
                   max(harness_slug) AS harness_slug, max(cwd) AS cwd,
                   to_json(min(ts)) #>> '{}' AS first_ts,
                   to_json(max(ts))  #>> '{}' AS last_ts
              FROM harness_shared.session_turns
             WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
               AND source_kind = ${liveSession.sourceKind} AND session_id = ${liveSession.sessionId}
               AND COALESCE(ts, ingested_at) < ${snapshotUntil}::timestamptz
               AND (${args.since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${args.since ?? null}::timestamptz)
          `;
          const lr = liveRows[0];
          sessions.unshift({
            source_kind: liveSession.sourceKind,
            session_id: liveSession.sessionId,
            turns: lr?.turns ?? 0,
            prompt_count: lr?.prompt_count ?? 0,
            owner,
            harness_slug: lr?.harness_slug ?? null,
            cwd: lr?.cwd ?? null,
            first_ts: lr?.first_ts ?? null,
            last_ts: lr?.last_ts ?? null,
            response_count: null,
            tool_call_count: null,
            active: true,
          });
          total += 1;
        }
      } catch { /* fail-soft: the active-session fallback never breaks the list */ }
    }

    // hasMore/nextCursor track the REAL owner-matched rows (offset stream); the
    // synthetic active row lives on page one only and is excluded from the math.
    const realTotal = total - (sessions.length - realPageCount);
    const hasMore = realTotal > offset + realPageCount;
    const nextCursor = hasMore
      ? encodeSessionCursor('sessions:list', offset + realPageCount, fingerprint, { until: snapshotUntil })
      : undefined;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          count: sessions.length,
          total,
          hasMore,
          window: { until: snapshotUntil },
          ...(nextCursor ? { nextCursor } : {}),
          ...(hasMore
            ? {
                truncated: `Showing ${sessions.length} matching sessions at offset ${offset} of ${total} (newest first). Continue with nextCursor or narrow with owner / source_kind / cwd_contains / since.`,
              }
            : {}),
          note:
            'Indexed sessions only (ingest window ~45d). Raw pre-window files: dev:claude_session / dev:omp_session. ' +
            'Timestamps are ISO-8601 with an explicit offset; `since` is parsed as UTC. ' +
            'UNITS (EI-9970): `turns` = indexed TEXT turns only (excludes tool_use/tool_result/thinking content) — for cost/effort audits use prompt_count/response_count/tool_call_count instead (see this tool\'s description for exact definitions). response_count/tool_call_count are null for source_kind=agent_chat (no tool-call signal in that transcript shape). ' +
            'EI-11403/WI-37867: a row with `active:true` is that owner\'s LIVE session surfaced even when it has produced NO indexed turns yet (or they are stamped under another owner) — such a row reads turns:0 and is NOT evidence the session is idle; sessions:search { session } reads its full content.',
          sessions,
        }),
      }],
    };
  },
});
