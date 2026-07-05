/**
 * sessions:timeline — reconstruct what an agent DID across a time window
 * (session-search-scope-2026-07-05 P-006): its transcript turns
 * (session_turns) + tool calls (tool_invocations.coord_owner_id) + coord
 * messages it sent (coord_event_log body->>'from'), merged newest-first.
 * The postmortem / "what happened in that lane" read.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { sessionSearchEnabled, disabledResult } from './_shared';

const ALL_ROLES = [...SU_ROLES, 'sentinel', 'overwatch'] as const;

export default defineTool({
  name: 'sessions:timeline',
  crossWorkspace: true,
  capability: 'search:read',
  description:
    "Merged activity timeline for ONE agent: what it said (transcript turns), did (tool calls), and told peers (coord messages), newest-first over a time window. owner:'self' = the caller.",
  guidance: {
    when:
      '"What did agent X actually do yesterday" — a postmortem / handoff-archaeology read joining speech + tool calls + coord traffic by owner and time.',
    notWhen:
      'Searching for specific content — sessions:search. Live state — coord:presence / fleet:assignments (this is HISTORY).',
    chaining: 'turn entries carry session_id + turn_idx → sessions:read for the surrounding conversation.',
    seeAlso: ['sessions:search', 'dev:session_detail (one spawn drilldown)'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.object({
    owner: z.string().min(1).max(120).describe("Agent ownerId, or 'self'."),
    since: z.string().max(40).optional().describe('ISO lower bound (default: 24h ago).'),
    until: z.string().max(40).optional().describe('ISO upper bound (default: now).'),
    limit: z.number().int().min(1).max(300).optional().describe('Max merged entries (default 100).'),
  }),
  async handler(args, ctx) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    const workspaceId = ctx.workspaceId ?? '';
    const owner = args.owner === 'self' ? (resolveAgentIdentity(ctx).ownerId ?? '') : args.owner;
    const limit = args.limit ?? 100;
    const since = args.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const until = args.until ?? new Date().toISOString();

    const rows = await ctx.tx<Array<{ kind: string; ts: string; ref: string; text: string }>>`
      (
        SELECT 'turn' AS kind, COALESCE(ts, ingested_at)::text AS ts,
               source_kind || ':' || session_id || ':' || turn_idx AS ref,
               '[' || speaker || '] ' || left(text, 300) AS text
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
           AND owner = ${owner}
           AND COALESCE(ts, ingested_at) >= ${since}::timestamptz
           AND COALESCE(ts, ingested_at) < ${until}::timestamptz
         ORDER BY COALESCE(ts, ingested_at) DESC LIMIT ${limit}
      )
      UNION ALL
      (
        SELECT 'tool' AS kind, invoked_at::text AS ts, id::text AS ref,
               tool_name || ' (' || COALESCE(status, '?') || COALESCE(', ' || duration_ms || 'ms', '') || ')' AS text
          FROM harness_shared.tool_invocations
         WHERE coord_owner_id = ${owner}
           AND invoked_at >= ${since}::timestamptz AND invoked_at < ${until}::timestamptz
         ORDER BY invoked_at DESC LIMIT ${limit}
      )
      UNION ALL
      (
        SELECT 'coord' AS kind, ts::text AS ts, msg_id AS ref,
               left(COALESCE(body->>'summary', body->>'body', ''), 300) AS text
          FROM harness_shared.coord_event_log
         WHERE surface = 'messages' AND body->>'from' = ${owner}
           AND ts >= ${since}::timestamptz AND ts < ${until}::timestamptz
         ORDER BY ts DESC LIMIT ${limit}
      )
      ORDER BY ts DESC
      LIMIT ${limit}
    `;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, owner, since, until, count: rows.length, entries: rows }),
      }],
    };
  },
});
