/**
 * issues:list — the READ side of the issue surface
 * (`harness_shared.engineer_issues`), plan sql-escape-tool-routing-2026-08-12
 * P-006.
 *
 * Until now only the WRITE side had a verb (`improvements:capture`) plus two
 * opinionated views (`improvements:digest` builds an ideation digest,
 * `improvements:triage` a triage queue). Neither is a plain list, so agents
 * hand-wrote SQL: classified over the 14-day corpus, GENUINE reads of this
 * relation are 686 calls across 83 AGENTS — the largest agent population in
 * the whole audit. (The item's headline "628 calls" was inflated by one
 * agent's 371-call `pg_stat_activity` probe that merely MENTIONS the table
 * inside a filter string; classifying first, rather than ranking by count,
 * is what separated 83 real readers from 8 perf investigators.)
 *
 * Measured predicate demand among those genuine reads:
 *   aggregate / GROUP BY   47 agents   <- the largest, hence `rollup`
 *   state                  35
 *   scope                  32
 *   kind                   21
 *   payload->observation   18
 *
 * REUSE: this adds no SQL. `listIssues` / `countIssues` / `countIssuesByState`
 * / `countObservationsByKind` already exist in issues-engineer.ts with a rich,
 * heavily-documented filter; the gap was purely that none of it was reachable
 * as a tool. `improvements:digest` could NOT absorb this — it takes only
 * { state, limit, harnessSlug }, with no scope, kind, or aggregate mode.
 *
 * TWO TRAPS THIS VIEW DOCUMENTS, both made unrepresentable here:
 *  1. `scope` on the VIEW is 'harness:<slug>' | 'operator', and has NO
 *     counterpart on the underlying work_items TABLE (which scopes by
 *     harness_slug + workspace_id). A predicate moved between the two matches
 *     ZERO rows instead of erroring. `scope` here accepts a bare slug and
 *     normalises it, so the prefix cannot be forgotten.
 *  2. `severity` is a REAL COLUMN on the view; `payload->'_ei'->>'severity'`
 *     is NULL for EVERY row (measured: 0 via that path vs 34,566 via the
 *     column) — a confident wrong answer rather than an error. Callers get the
 *     column, so the bad path is unreachable.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  listIssues,
  countIssues,
  countIssuesByState,
  countObservationsByKind,
  ISSUE_SEVERITIES,
  ISSUE_STATES,
  type ListIssuesFilter,
} from '../../issues-engineer';

const DEFAULT_LIMIT = 30;

/**
 * The view's scope is 'operator' or 'harness:<slug>'. Agents reach for the
 * bare harness slug (it is what every other tool takes), and a bare slug
 * silently matches nothing here — so normalise rather than refuse.
 */
export function normalizeScope(scope: string): string {
  const s = scope.trim();
  if (s === 'operator' || s.includes(':')) return s;
  return `harness:${s}`;
}

export default defineTool({
  name: 'issues:list',
  description:
    'List issue-family work items (bug/change) from harness_shared.engineer_issues: filter by state, scope, kind, severity, assignee, lane, or free text. `rollup:"state"|"observationKind"` returns counts instead of rows. `scope` accepts a bare harness slug and is normalised to the view\'s "harness:<slug>" form. Excludes `task` items unless you ask for them. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'Read filed issues/observations — what is open in a scope, how many by state, or find one by text — instead of hand-writing SELECT over harness_shared.engineer_issues.',
    notWhen:
      'To FILE one use improvements:capture. For what is CLAIMABLE right now use work_items:claimable (a status=open query is not claimability). For the deduped ideation digest use improvements:digest; for the triage queue use improvements:triage. For observations specifically, pass lane:"observation" here.',
    chaining:
      'rollup:"state" to size the backlog → rows with the interesting state → work_items:get for the full record, or improvements:resolve to close one.',
    // Response docs live in `returns` — description/when are prompt-weight
    // budgeted (the guard refused the P-002 edit on routines:list).
    returns: [
      'Rows: { id, kind, scope, title, severity, state, assignee, createdAt, updatedAt, closedAt } plus `body` only when includeBody:true. (`lane` is a FILTER here, not a returned field.)',
      'For anything time-of-close read `closedAt`, not `updatedAt` — updatedAt moves on any write.',
      '`count` = rows returned; `total` = rows MATCHING the filter independent of `limit`; `truncatedByLimit` says whether they differ, so a capped list is never read as a total.',
      'rollup:"state" → { open, wip, done, … } counts. rollup:"observationKind" → counts by payload->observation->>kind. Both are computed over the whole filtered set, not the page.',
      'body is OMITTED by default: it is 76% of this read\'s bytes (measured 1607kB → 389kB with it dropped). Ask for it explicitly when you need it.',
      'Only bug|change are returned by default — `task` items are a work_item kind that the issues surface deliberately excludes; pass kinds to include them.',
      'severity is a real column here (critical|major|minor|nit). Do NOT reach for payload->\'_ei\'->>\'severity\' against this view — it is NULL for every row.',
    ].join(' '),
    seeAlso: [
      'improvements:capture (file one)',
      'work_items:claimable (what is claimable NOW — not a status=open query)',
      'improvements:digest (deduped ideation digest)',
      'improvements:triage (the triage queue)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    state: z.enum(ISSUE_STATES as unknown as [string, ...string[]]).optional().describe('Lifecycle state.'),
    scope: z
      .string()
      .max(120)
      .optional()
      .describe('Issue scope — a bare harness slug ("papercusp") is normalised to "harness:papercusp"; "operator" is also valid.'),
    kinds: z
      .array(z.enum(['bug', 'change', 'task']))
      .min(1)
      .optional()
      .describe('Kinds to include. Default bug+change; pass explicitly to include `task`.'),
    severity: z.enum(ISSUE_SEVERITIES as unknown as [string, ...string[]]).optional(),
    assignee: z.string().max(120).optional().describe('Filter to one assignee ownerId.'),
    lane: z
      .string()
      .max(60)
      .optional()
      .describe('Row lane — lane:"observation" is the canonical way to select the observation population (prefer this over the topic form, which is lossy both ways).'),
    q: z.string().max(200).optional().describe('Case-insensitive substring matched against title + body.'),
    topic: z.string().max(120).optional().describe('Issues tagged with this topic.'),
    includeBody: z.boolean().optional().describe('Include the body column (omitted by default — it is 76% of the bytes).'),
    rollup: z
      .enum(['state', 'observationKind'])
      .optional()
      .describe('Return counts instead of rows, over the whole filtered set.'),
    limit: z.number().int().min(1).max(200).optional().describe(`Max rows (default ${DEFAULT_LIMIT}).`),
  }),
  async handler(args: {
    state?: string;
    scope?: string;
    kinds?: Array<'bug' | 'change' | 'task'>;
    severity?: string;
    assignee?: string;
    lane?: string;
    q?: string;
    topic?: string;
    includeBody?: boolean;
    rollup?: 'state' | 'observationKind';
    limit?: number;
  }) {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const filter = {
      ...(args.state ? { state: args.state } : {}),
      ...(args.scope ? { scope: normalizeScope(args.scope) } : {}),
      ...(args.kinds ? { kinds: args.kinds } : {}),
      ...(args.severity ? { severity: args.severity } : {}),
      ...(args.assignee ? { assignee: args.assignee } : {}),
      ...(args.lane ? { lane: args.lane } : {}),
      ...(args.q ? { q: args.q } : {}),
      ...(args.topic ? { topic: args.topic } : {}),
    } as ListIssuesFilter;

    if (args.rollup === 'state') {
      const counts = await countIssuesByState(filter);
      return { data: { rollup: 'state', counts, total: Object.values(counts).reduce((a, b) => a + b, 0) } };
    }
    if (args.rollup === 'observationKind') {
      const counts = await countObservationsByKind(filter);
      return {
        data: { rollup: 'observationKind', counts, total: Object.values(counts).reduce((a, b) => a + b, 0) },
      };
    }

    // `total` comes from countIssues over the SAME filter, never from the page
    // length — a count derived from a limited fetch restates `limit` as if it
    // were a measurement.
    const [rows, total] = await Promise.all([
      listIssues({ ...filter, limit, includeBody: args.includeBody === true }),
      countIssues(filter),
    ]);

    return {
      data: {
        count: rows.length,
        total,
        truncatedByLimit: total > rows.length,
        issues: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          scope: r.scope,
          title: r.title,
          severity: r.severity,
          state: r.state,
          assignee: r.assignee ?? null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          // Documented on EngineerIssue: read this, not updatedAt, for
          // time-of-close — updatedAt moves on any write.
          closedAt: r.closedAt,
          ...(args.includeBody === true ? { body: r.body } : {}),
        })),
      },
    };
  },
});
