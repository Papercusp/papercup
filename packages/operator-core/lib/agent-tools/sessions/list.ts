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
    'List indexed agent sessions across ALL clients (claude/omp/codex/harness chats) — newest first, with turn counts, owner, cwd, and time range. Filter by owner (self), source_kind, cwd substring, or time.',
  guidance: {
    when:
      '"What sessions has agent X had", "find my session from yesterday", or picking a session id for sessions:read. Covers the whole fleet, not one client.',
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

    const rows = await ctx.tx<Array<{
      source_kind: string; session_id: string; turns: number; owner: string | null;
      harness_slug: string | null; cwd: string | null; first_ts: string | null; last_ts: string | null;
    }>>`
      SELECT source_kind, session_id, count(*)::int AS turns,
             max(owner) AS owner, max(harness_slug) AS harness_slug, max(cwd) AS cwd,
             min(ts)::text AS first_ts, max(ts)::text AS last_ts
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND (${owner}::text IS NULL OR owner = ${owner})
         AND (${args.source_kind ?? null}::text IS NULL OR source_kind = ${args.source_kind ?? null})
         AND (${args.cwd_contains ?? null}::text IS NULL OR cwd ILIKE '%' || ${args.cwd_contains ?? null} || '%')
         AND (${args.since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${args.since ?? null}::timestamptz)
    GROUP BY source_kind, session_id
    ORDER BY max(COALESCE(ts, ingested_at)) DESC
       LIMIT ${limit}
    `;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          count: rows.length,
          note: 'Indexed sessions only (ingest window ~45d). Raw pre-window files: dev:claude_session / dev:omp_session.',
          sessions: rows,
        }),
      }],
    };
  },
});
