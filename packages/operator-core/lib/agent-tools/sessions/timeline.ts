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
import { sessionSearchEnabled, disabledResult, refreshLiveSessionsBeforeRead } from './_shared';
import { decodeSessionCursor, encodeSessionCursor, sessionCursorFingerprint } from './cursor';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'kettle'] as const;
const AUTOMATIC_TOOL_NAMES = ['activity:report', 'coord:glance', 'coord:inbox'] as const;

export interface AutomaticCallAuditRow {
  total_tool_calls: number;
  automatic_calls: number;
  agent_calls: number;
}

export function buildAutomaticCallAuditSummary(row: AutomaticCallAuditRow) {
  return {
    total_tool_calls: row.total_tool_calls,
    automatic_calls: row.automatic_calls,
    agent_calls: row.agent_calls,
    automatic_share: row.total_tool_calls > 0
      ? Number((row.automatic_calls / row.total_tool_calls).toFixed(4))
      : 0,
    classification: {
      automatic_tools: [...AUTOMATIC_TOOL_NAMES],
      rule: 'automatic_calls match the known hook/status tool set; every other tool invocation is agent-authored',
    },
  };
}

export interface TimelineEntry {
  kind: 'turn' | 'tool' | 'coord';
  ts: string;
  ref: string;
  text: string;
  tool_name?: string | null;
  status?: string | null;
  auto?: boolean;
  repeat_count?: number;
  oldest_ts?: string;
}

/** Collapse identical entries in one bounded window while preserving newest-first order. */
export function groupRepeatedTimelineEntries(rows: TimelineEntry[]): TimelineEntry[] {
  const grouped = new Map<string, TimelineEntry>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.tool_name ?? ''}\u0000${row.status ?? ''}\u0000${row.text}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...row, repeat_count: 1, oldest_ts: row.ts });
      continue;
    }
    existing.repeat_count = (existing.repeat_count ?? 1) + 1;
    existing.oldest_ts = row.ts;
  }
  return [...grouped.values()];
}

export default defineTool({
  name: 'sessions:timeline',
  crossWorkspace: true,
  capability: 'search:read',
  description:
    "Merged activity timeline for ONE agent: transcript turns + tool calls + coord messages, newest-first. owner:'self' = the caller. Audit filters can select kind/tool/status, hide automatic hook traffic (default), group repeats, continue with nextCursor, and report automatic-versus-agent tool-call counts.",
  guidance: {
    when:
      '"What did agent X actually do yesterday" — a postmortem / handoff-archaeology read joining speech + tool calls + coord traffic by owner and time.',
    notWhen:
      'Searching for specific content — sessions:search. Live state — coord:presence / fleet:assignments (this is HISTORY).',
    chaining: 'Filter failures with kinds:["tool"], status:"invalid-input" (or another exact status); turn refs carry session id + turn idx → sessions:read.',
    seeAlso: ['sessions:search', 'dev:session_detail (one spawn drilldown)'],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.object({
    owner: z.string().min(1).max(120).describe("Agent ownerId, or 'self'."),
    since: z.string().max(40).optional().describe('ISO lower bound (default: 24h ago).'),
    until: z.string().max(40).optional().describe('ISO upper bound (default: now).'),
    limit: z.number().int().min(1).max(300).optional().describe('Max merged entries, 1..300 (default 100).'),
    kinds: z.array(z.enum(['turn', 'tool', 'coord'])).max(3).optional().describe('Only these entry kinds.'),
    tool: z.string().min(1).max(160).optional().describe('Exact tool name; implies tool entries.'),
    status: z.string().min(1).max(80).optional().describe('Exact tool-invocation status, e.g. invalid-input, error, timeout, ok.'),
    include_auto: z.boolean().optional().describe('Include automatic hook/status traffic such as activity:report, coord:glance, coord:inbox, and auto:true coord messages. Default false.'),
    group_repeated: z.boolean().optional().describe('Collapse identical entries in the returned window and add repeat_count/oldest_ts. Default false.'),
    cursor: z.string().min(1).max(512).optional().describe('Opaque nextCursor from a prior sessions:timeline call with the same filters.'),
  }),
  async handler(args, ctx) {
    if (!(await sessionSearchEnabled())) return disabledResult();
    const workspaceId = ctx.workspaceId ?? '';
    const owner = args.owner === 'self' ? (resolveAgentIdentity(ctx).ownerId ?? '') : args.owner;
    const limit = args.limit ?? 100;
    const kinds = args.kinds?.length ? args.kinds : null;
    const includeAuto = args.include_auto ?? false;
    const fingerprintArgs = { ...args, cursor: undefined, limit: undefined };
    const fingerprint = sessionCursorFingerprint(fingerprintArgs);
    const cursor = decodeSessionCursor(args.cursor, 'sessions:timeline', fingerprint);
    if (!cursor.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...cursor }) }] };
    }
    const until = args.until ?? cursor.bounds.until ?? new Date().toISOString();
    const since = args.since ?? cursor.bounds.since ?? new Date(Date.parse(until) - 24 * 3600 * 1000).toISOString();
    const offset = cursor.offset;
    const fetchLimit = offset + limit + 1;
    await refreshLiveSessionsBeforeRead(ctx.tx, [owner]);

    const rows = await ctx.tx<TimelineEntry[]>`
      (
        SELECT 'turn' AS kind, COALESCE(ts, ingested_at)::text AS ts,
               source_kind || ':' || session_id || ':' || turn_idx AS ref,
               '[' || speaker || '] ' || left(text, 300) AS text,
               NULL::text AS tool_name, NULL::text AS status, false AS auto
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
           AND owner = ${owner}
           AND COALESCE(ts, ingested_at) >= ${since}::timestamptz
           AND COALESCE(ts, ingested_at) < ${until}::timestamptz
           AND (${kinds}::text[] IS NULL OR 'turn' = ANY(${kinds}::text[]))
           AND ${args.tool ?? null}::text IS NULL
           AND ${args.status ?? null}::text IS NULL
         ORDER BY COALESCE(ts, ingested_at) DESC LIMIT ${fetchLimit}
      )
      UNION ALL
      (
        SELECT 'tool' AS kind, invoked_at::text AS ts, id::text AS ref,
               tool_name || ' (' || COALESCE(NULLIF(metadata_json->>'effectiveStatus', ''), status, '?') || COALESCE(', ' || duration_ms || 'ms', '') || ')' AS text,
               tool_name, COALESCE(NULLIF(metadata_json->>'effectiveStatus', ''), status) AS status,
               tool_name = ANY(${[...AUTOMATIC_TOOL_NAMES]}::text[]) AS auto
          FROM harness_shared.tool_invocations
         WHERE coord_owner_id = ${owner}
           AND invoked_at >= ${since}::timestamptz AND invoked_at < ${until}::timestamptz
           AND (${kinds}::text[] IS NULL OR 'tool' = ANY(${kinds}::text[]))
           AND (${args.tool ?? null}::text IS NULL OR tool_name = ${args.tool ?? null})
           AND (${args.status ?? null}::text IS NULL OR COALESCE(NULLIF(metadata_json->>'effectiveStatus', ''), status) = ${args.status ?? null})
           AND (${includeAuto} OR tool_name <> ALL(${[...AUTOMATIC_TOOL_NAMES]}::text[]))
         ORDER BY invoked_at DESC LIMIT ${fetchLimit}
      )
      UNION ALL
      (
        SELECT 'coord' AS kind, ts::text AS ts, msg_id AS ref,
               left(COALESCE(body->>'summary', body->>'body', ''), 300) AS text,
               NULL::text AS tool_name, NULL::text AS status,
               COALESCE(body->>'auto', 'false') = 'true' AS auto
          FROM harness_shared.coord_event_log
         WHERE surface = 'messages' AND body->>'from' = ${owner}
           AND ts >= ${since}::timestamptz AND ts < ${until}::timestamptz
           AND (${kinds}::text[] IS NULL OR 'coord' = ANY(${kinds}::text[]))
           AND ${args.tool ?? null}::text IS NULL
           AND ${args.status ?? null}::text IS NULL
           AND (${includeAuto} OR COALESCE(body->>'auto', 'false') <> 'true')
         ORDER BY ts DESC LIMIT ${fetchLimit}
      )
      ORDER BY ts DESC
      LIMIT ${fetchLimit}
    `;

    const hasMore = rows.length > offset + limit;
    const pageRows = rows.slice(offset, offset + limit);
    const entries = args.group_repeated ? groupRepeatedTimelineEntries(pageRows) : pageRows;
    const nextCursor = hasMore
      ? encodeSessionCursor('sessions:timeline', offset + pageRows.length, fingerprint, { since, until })
      : undefined;
    const [auditRow = { total_tool_calls: 0, automatic_calls: 0, agent_calls: 0 }] = await ctx.tx<AutomaticCallAuditRow[]>`
      SELECT count(*)::int AS total_tool_calls,
             count(*) FILTER (WHERE tool_name = ANY(${[...AUTOMATIC_TOOL_NAMES]}::text[]))::int AS automatic_calls,
             count(*) FILTER (WHERE tool_name <> ALL(${[...AUTOMATIC_TOOL_NAMES]}::text[]))::int AS agent_calls
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ${owner}
         AND invoked_at >= ${since}::timestamptz AND invoked_at < ${until}::timestamptz
         AND (${args.tool ?? null}::text IS NULL OR tool_name = ${args.tool ?? null})
         AND (${args.status ?? null}::text IS NULL OR COALESCE(NULLIF(metadata_json->>'effectiveStatus', ''), status) = ${args.status ?? null})
    `;
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          owner,
          since,
          until,
          filters: {
            ...(kinds ? { kinds } : {}),
            ...(args.tool ? { tool: args.tool } : {}),
            ...(args.status ? { status: args.status } : {}),
            include_auto: includeAuto,
            group_repeated: args.group_repeated ?? false,
          },
          raw_count: pageRows.length,
          count: entries.length,
          hasMore,
          ...(nextCursor ? { nextCursor } : {}),
          audit_summary: buildAutomaticCallAuditSummary(auditRow),
          entries,
        }),
      }],
    };
  },
});
