/**
 * sessions:list — unified session enumeration across every indexed client
 * (session-search-scope-2026-07-05 P-006): claude + omp + codex + harness
 * chats in ONE list (absorbs dev:claude_session op=list / omp:sessions
 * op=list, and adds codex — which had NO reader before this).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { sessionSearchEnabled, disabledResult, SESSION_SOURCE_KINDS } from './_shared';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;

export default defineTool({
  name: 'sessions:list',
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'List indexed agent sessions across ALL clients (claude/omp/codex/harness chats) — newest first, with size/effort counts, owner, cwd, and time range. Filter by owner (self), source_kind, cwd substring, or time. ' +
    'UNITS (EI-9970): `turns` = indexed TEXT-turn rows only (real user+assistant text; excludes tool_use/tool_result/thinking-only lines by design) — NOT a raw record count, NOT one row per model call; don\'t use it alone for cost/effort audits. Use `prompt_count` (real user prompts), `response_count` (distinct model-inference calls, deduped by request/message id — one call can span several raw lines), and `tool_call_count` (real tool invocations) instead; the latter two are null for source_kind=agent_chat (no tool-call signal in that shape).',
  guidance: {
    when:
      '"What sessions has agent X had", "find my session from yesterday", or picking a session id for sessions:read. Covers the whole fleet, not one client. For a COST/EFFORT audit, compare prompt_count/response_count/tool_call_count, not turns — see description.',
    notWhen:
      'Searching CONTENT — sessions:search. Live "who is on what" — coord:presence / fleet:assignments.',
    chaining: 'session_id → sessions:read / sessions:search { session }.',
    seeAlso: ['sessions:search', 'sessions:read', 'sessions:timeline'],
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
  }),
  async handler(args, ctx) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    const workspaceId = ctx.workspaceId ?? '';
    const limit = args.limit ?? 30;
    const owner = args.owner === 'self' ? (resolveAgentIdentity(ctx).ownerId ?? '') : (args.owner ?? null);

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
    const rows = await ctx.tx<Array<{
      source_kind: string; session_id: string; turns: number; prompt_count: number;
      owner: string | null; harness_slug: string | null; cwd: string | null;
      first_ts: string | null; last_ts: string | null;
      response_count: number | null; tool_call_count: number | null;
    }>>`
      WITH turns_agg AS (
        SELECT source_kind, session_id, count(*)::int AS turns,
               count(*) FILTER (WHERE speaker = 'user')::int AS prompt_count,
               max(owner) AS owner, max(harness_slug) AS harness_slug, max(cwd) AS cwd,
               min(ts)::text AS first_ts, max(ts)::text AS last_ts
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
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
      SELECT t.*, s.response_count, s.tool_call_count
        FROM turns_agg t
        LEFT JOIN state_agg s USING (source_kind, session_id)
       ORDER BY t.last_ts DESC NULLS LAST
       LIMIT ${limit}
    `;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          count: rows.length,
          note:
            'Indexed sessions only (ingest window ~45d). Raw pre-window files: dev:claude_session / dev:omp_session. ' +
            'UNITS (EI-9970): `turns` = indexed TEXT turns only (excludes tool_use/tool_result/thinking content) — for cost/effort audits use prompt_count/response_count/tool_call_count instead (see this tool\'s description for exact definitions). response_count/tool_call_count are null for source_kind=agent_chat (no tool-call signal in that transcript shape).',
          sessions: rows,
        }),
      }],
    };
  },
});
