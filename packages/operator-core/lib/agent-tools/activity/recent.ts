/**
 * activity:recent — read recent worker-activity rows from the cross-CLI activity
 * bridge sink (harness_shared.agent_activity).
 *
 * The pull-side companion to the /api/activity/stream SSE push (both read the same
 * table the per-CLI hooks write via activity:report). The curator reads this to
 * decide what matters; the fleet view seeds from it before subscribing to the
 * stream; tests assert against it.
 *
 * Filters are ANDed: `owner` (one worker's pane), `harness`, `agent` (claude/codex/
 * omp), `kind`. `since_id` returns only rows newer than a cursor (the stream-catch-up
 * shape); default returns the most-recent `limit` rows newest-first.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

// + overwatch (overwatch-role-2026-06-15 B-01): reads recent activity to sense drift.
const ALL_ROLES = [...SU_ROLES, 'sentinel', 'overwatch'] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface ActivityRow {
  id: string;
  owner_id: string;
  agent: string | null;
  session_id: string | null;
  harness_slug: string | null;
  kind: string;
  tool_name: string | null;
  phase: string | null;
  tool_use_id: string | null;
  summary: string | null;
  status: string | null;
  detail: unknown;
  cwd: string | null;
  created_at: string;
}

export default defineTool({
  name: 'activity:recent',
  description:
    "Read recent worker-activity rows (native tool calls / lifecycle / todos) from the cross-CLI activity bridge. Filter by owner (one worker's pane), harness, agent (claude/codex/omp), kind (tool/lifecycle/todos); since_id returns only rows newer than a cursor. The curator + fleet view read this; the live push is /api/activity/stream.",
  capability: 'activity:read',
  guidance: {
    when: 'You want to inspect what a worker (or the whole fleet) has been doing — the recent native tool-call stream, todo snapshots, or lifecycle transitions. Pass owner to scope to one pane, harness to scope to one project, since_id to page forward.',
    notWhen: 'For a LIVE feed subscribe to the /api/activity/stream SSE (the pui does this). To report activity (you almost never need to) use `activity:report`. For coord messages use `coord:inbox`.',
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    /** Scope to one worker's coordination id (PAPERCUSP_SID). */
    owner: z.string().max(256).optional(),
    /** Scope to one harness. */
    harness: z.string().max(256).optional(),
    /** Scope to one CLI: 'claude' | 'codex' | 'omp'. */
    agent: z.string().max(32).optional(),
    /** Scope to one kind. */
    kind: z.enum(['tool', 'lifecycle', 'todos']).optional(),
    /** Only rows with id > since_id (stream catch-up; returns oldest-first then). */
    since_id: z.union([z.number(), z.string()]).optional(),
    /** Max rows (default 50, max 500). */
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  }),
  // Freshness negotiation (agent-tool-delta-protocol-2026-06-22, P-015 — Lane F rollout,
  // mirrors the P-013 plans:attention exemplar). The repeated "what's recent" poll (no
  // since_id) is a stable, high-churn view: the diffable unit is the `activity` row set,
  // keyed by the BIGINT `id`. Rows are append-only/immutable (a content-hash revision means
  // a row is never `updated`; the window churns as new rows are `added` and old ones fall
  // out → `removed`). The framework folds the filter args (owner/harness/agent/kind/limit/
  // since_id) into the view fingerprint, so a since_id catch-up call gets its own cursor and
  // a changed window → full; `scope` adds the workspace dimension (the handler scopes the
  // feed to the active workspace). Dormant until the papercusp-tool-delta-protocol flag flips.
  delta: {
    rows: (data) => {
      const activity = (data as { activity?: unknown[] } | null | undefined)?.activity;
      return Array.isArray(activity) ? activity : null;
    },
    itemKey: (row) => (row as ActivityRow).id,
    itemKeyField: 'id',
    rowType: (row) => (row as ActivityRow).kind,
    orderKey: 'id',
    scope: (_args, ctx) => (ctx as { workspaceId?: string }).workspaceId ?? '',
    schemaVersion: 'activity-v1',
    // Periodic forced-full reconciliation (bounds incremental-merge drift), as the exemplar.
    maxDeltaAge: 5 * 60_000,
  },
  async handler(args) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const sinceId = args.since_id != null ? Number(args.since_id) : null;
    const { sql } = getOrgPg();
    // F-B5 (workspace-data-isolation-leaks): agent_activity has workspace_id but
    // RLS is off + getOrgPg() bypasses it, so scope the feed to the active
    // workspace explicitly (else B's activity:recent returns A's agent activity).
    const ws = activeWorkspaceId();

    // since_id present → forward-paging (oldest-first, the catch-up order a stream
    // consumer wants); absent → most-recent-first.
    const rows = sinceId != null
      ? await sql<ActivityRow[]>`
          SELECT id::text AS id, owner_id, agent, session_id, harness_slug, kind, tool_name,
                 phase, tool_use_id, summary, status, detail, cwd, created_at
          FROM harness_shared.agent_activity
          WHERE id > ${sinceId}
            AND workspace_id = ${ws}
            AND (${args.owner ?? null}::text IS NULL OR owner_id = ${args.owner ?? null})
            AND (${args.harness ?? null}::text IS NULL OR harness_slug = ${args.harness ?? null})
            AND (${args.agent ?? null}::text IS NULL OR agent = ${args.agent ?? null})
            AND (${args.kind ?? null}::text IS NULL OR kind = ${args.kind ?? null})
          -- Order by the BIGINT column, NOT the "id::text AS id" output alias in the
          -- SELECT: a bare ORDER BY id binds to that text alias and sorts
          -- lexicographically ("1000" < "999"), which silently froze this read at the
          -- last 3-digit id once the sequence crossed 999 to 1000. Keep the ::bigint cast.
          ORDER BY id::bigint ASC
          LIMIT ${limit}
        `
      : await sql<ActivityRow[]>`
          SELECT id::text AS id, owner_id, agent, session_id, harness_slug, kind, tool_name,
                 phase, tool_use_id, summary, status, detail, cwd, created_at
          FROM harness_shared.agent_activity
          WHERE workspace_id = ${ws}
            AND (${args.owner ?? null}::text IS NULL OR owner_id = ${args.owner ?? null})
            AND (${args.harness ?? null}::text IS NULL OR harness_slug = ${args.harness ?? null})
            AND (${args.agent ?? null}::text IS NULL OR agent = ${args.agent ?? null})
            AND (${args.kind ?? null}::text IS NULL OR kind = ${args.kind ?? null})
          -- ::bigint, not a bare ORDER BY id -- see the note on the since_id branch
          -- above (the text alias sorts lexicographically and froze this at id 999).
          ORDER BY id::bigint DESC
          LIMIT ${limit}
        `;

    return { content: [{ type: 'text', text: JSON.stringify({ activity: rows, count: rows.length }) }] };
  },
});
