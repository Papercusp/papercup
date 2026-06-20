/**
 * work_items:list — cross-kind list over the unified surface (unify-work-items,
 * D-007). Default = top-level items only; chunks surface under their parent (D-004,
 * pass `parent` or includeChildren). Filter by harness / kind / state.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { listWorkItems, WORK_ITEM_KINDS, type WorkItemKind } from '../../work-items';

/**
 * Output `data` schema (token-efficient-tool-result-formats P-011). The result
 * is the bare WorkItem array — the row count rides in TOON's self-describing
 * `[N]{…}:` header, so the old `{ ok, count, items }` wrapper is redundant. This
 * unlocks the compact format for a high-traffic list tool (≈ −32% tokens for
 * agents). `payload` is `unknown`, so the schema proves TOON-eligibility but not
 * CSV; rows that happen to have a null payload still serialize as CSV on an
 * explicit request via the serializer's runtime flatness check.
 */
const WORK_ITEM_ROW = z.object({
  id: z.string(),
  kind: z.string(),
  family: z.string(),
  harness: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  /** EI-1597: in list rows the summary is EXCERPTED (budget-aware) so a large backlog
   *  can't overflow the agent result cap; these flag a cut row. Full body via work_items:get. */
  summary_truncated: z.literal(true).optional(),
  summary_full_chars: z.number().optional(),
  state: z.string(),
  assignee: z.string().nullable(),
  assignedBy: z.string().nullable(),
  severity: z.string().nullable(),
  parent: z.string().nullable(),
  payload: z.unknown(),
  /** Shared backlog priority (feature_order) — LOWER = claimed sooner; null = unprioritized.
   *  Feature-family only (the Queen's steer lever, B7); issue-family is always null. */
  priority: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// EI-1597: bound each list row's summary so a large backlog can't overflow the agent
// result cap (work_items:list returns the full WorkItem array; a 40-item backlog hit
// 73KB of summaries on one line). Per-row cap = min(SUMMARY_ROW_CAP, floor(BUDGET/n))
// — the budget-aware bound coord:inbox (EI-1752) + plans:get (WI-274) use: total
// summary text stays <= BUDGET at ANY list size, while small lists keep most rows full.
// Full body is always available via work_items:get { id }.
export const SUMMARY_ROW_CAP = 240;
export const SUMMARIES_TOTAL_BUDGET = 16_000;

export function boundSummaries<T extends { summary?: string | null }>(
  rows: T[],
): Array<T | (T & { summary: string; summary_truncated: true; summary_full_chars: number })> {
  const n = rows.length;
  if (n === 0) return rows;
  const cap = Math.min(SUMMARY_ROW_CAP, Math.floor(SUMMARIES_TOTAL_BUDGET / n));
  return rows.map((r) => {
    const full = typeof r.summary === 'string' ? r.summary : '';
    if (full.length <= cap) return r;
    return {
      ...r,
      summary: full.slice(0, cap),
      summary_truncated: true as const,
      summary_full_chars: full.length,
    };
  });
}

export default defineTool({
  name: 'work_items:list',
  profile: 'engineer',
  description: 'List work-items across kinds (feature/research-task/chunk/bug/change). Default shows top-level items (chunks are hidden — pass parent or includeChildren). Filter by harness, kind, state. Returns the WorkItem array directly — each row\'s summary is EXCERPTED to keep the list bounded (a row carries summary_truncated + summary_full_chars when cut); use work_items:get { id } for a full body.',
  guidance: {
    when: 'You want the current work-items in a harness (or operator-wide). Default hides chunks; pass `parent` to see a parent\'s chunks. Each row carries `priority` (the shared backlog order, LOWER = claimed sooner) so the Queen can read the whole backlog\'s order in one call before steering it with work_items:set_priority.',
    chaining: 'work_items:list → work_items:get { id } for detail; work_items:claim to take one; work_items:set_priority to re-order the backlog.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(80).optional(),
    kind: z.enum([...WORK_ITEM_KINDS] as [string, ...string[]]).optional(),
    state: z.string().max(40).optional(),
    parent: z.string().max(80).optional().describe('list children (chunks) of this parent id'),
    includeChildren: z.boolean().optional().describe('include child items (chunks) in the list'),
    limit: z.number().int().positive().max(500).optional(),
  }),
  result: z.array(WORK_ITEM_ROW),
  async handler(args) {
    const items = await listWorkItems({
      harness: args.harness,
      kind: args.kind as WorkItemKind | undefined,
      state: args.state,
      parent: args.parent,
      includeChildren: args.includeChildren,
      limit: args.limit,
    });
    // EI-1597: excerpt per-row summaries so a large backlog can't overflow the agent
    // result cap. Full body via work_items:get { id }.
    return { data: boundSummaries(items) };
  },
});
