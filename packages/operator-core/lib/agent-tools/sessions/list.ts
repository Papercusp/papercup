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

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

/**
 * The row shape this query returns. Declared as an interface and used to
 * ANNOTATE the `rows` const, because `ctx.tx`'s type argument does NOT type the
 * result: `ToolContext<Tx = any>` makes `tx` an `any`, so `ctx.tx<Array<{…}>>`
 * is a generic call on an `any` and TypeScript throws the argument away. The
 * annotation is what actually binds it — see the same note on sessions/digest.ts.
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
      '{ ok, count (rows HERE), total (rows MATCHING), hasMore, nextCursor?, truncated?, note, sessions: [{ source_kind, session_id, turns, prompt_count, owner, harness_slug, cwd, first_ts, last_ts, response_count, tool_call_count }] }. Timestamps are ISO-8601 with an explicit offset. Pass nextCursor back unchanged to continue the same filters.',
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
  async handler(args, ctx) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    const workspaceId = ctx.workspaceId ?? '';
    const limit = args.limit ?? 30;
    const owner = args.owner === 'self' ? (resolveAgentIdentity(ctx).ownerId ?? '') : (args.owner ?? null);
    const fingerprint = sessionCursorFingerprint({
      workspace_id: workspaceId,
      owner,
      source_kind: args.source_kind ?? null,
      cwd_contains: args.cwd_contains ?? null,
      since: args.since ?? null,
    });
    const cursor = decodeSessionCursor(args.cursor, 'sessions:list', fingerprint);
    if (!cursor.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...cursor }) }] };
    }
    const offset = cursor.offset;
    // Freeze the upper time boundary on page one and carry it in every cursor.
    // Without this, a newly-ingested live turn shifts OFFSET and page two can
    // repeat page one's session (the production recurrence that reopened P-009).
    const snapshotUntil = cursor.bounds.until ?? new Date().toISOString();

    // Read-time freshness applies to every owner filter and to the bounded set
    // of open Codex sessions on an unfiltered read, not only owner:'self'.
    await refreshLiveSessionsBeforeRead(ctx.tx, owner ? [owner] : null);

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
    const rows: SessionListRow[] = await ctx.tx<SessionListRow[]>`
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
    const total = rows[0]?.total_matching ?? offset;
    // Project explicitly rather than rest-spreading `total_matching` away: the
    // window-function column is a transport detail of THIS query, and an explicit
    // projection guarantees it can never leak into a row the caller reads as data.
    const sessions = rows.slice(0, limit).map((r) => ({
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
    const hasMore = total > offset + sessions.length;
    const nextCursor = hasMore
      ? encodeSessionCursor('sessions:list', offset + sessions.length, fingerprint, { until: snapshotUntil })
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
            'UNITS (EI-9970): `turns` = indexed TEXT turns only (excludes tool_use/tool_result/thinking content) — for cost/effort audits use prompt_count/response_count/tool_call_count instead (see this tool\'s description for exact definitions). response_count/tool_call_count are null for source_kind=agent_chat (no tool-call signal in that transcript shape).',
          sessions,
        }),
      }],
    };
  },
});
