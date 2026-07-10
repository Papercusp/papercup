/**
 * work_items:burn_down — leader-facing census over the unified work queue.
 *
 * This is a read-only rollup over existing surfaces: work_items:list row shape,
 * coord presence liveness, and the issue-family `_claimHold` payload marker. It
 * gives drain/fleet leaders one stable response instead of rejoining
 * work_items:list + coord:presence client-side on every wake.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { listPresence, PRESENCE_STALE_MS } from '../coordination/presence';
import {
  listWorkItems,
  type WorkItem,
  type WorkItemKind,
} from '../../work-items';

const TERMINAL_STATES = new Set(['done', 'passed', 'resolved', 'closed', 'deprecated', 'dropped']);
const PARKED_STATES = new Set(['blocked', 'needs-human', 'needs_human', 'cursed']);

type PresenceLike = { ownerId: string; heartbeatAt?: string | null; stale?: boolean | null };

export interface BurnDownRow {
  id: string;
  kind: string;
  family: string;
  harness: string | null;
  title: string;
  state: string;
  assignee: string | null;
  assigneeLive?: boolean;
  takenAt: string | null;
  lastProgressAt: string | null;
  updatedAt: string;
  severity: string | null;
  priority: number | null;
}

export interface BurnDownParkedRow extends BurnDownRow {
  reason: string;
  mechanism: 'claimHold' | 'blocked' | 'needs-human' | 'state';
  aliasedState?: string;
}

/** Lean itemized row for the `since`-bounded closed/opened lists — EI-8990. */
export interface BurnDownDeltaRow {
  id: string;
  kind: string;
  title: string;
  state: string;
  harness: string | null;
  ts: string;
}

/** Cap on itemized closedSince/openedSince rows (each list independently). */
const DELTA_ROW_CAP = 30;

export interface BurnDownResult {
  ok: true;
  harness: string;
  generatedAt: string;
  terminal: {
    total: number;
    done: number;
    passed: number;
    resolved: number;
    closed: number;
    deprecated: number;
    dropped: number;
    deltaSince: string | null;
    delta: number;
  };
  inFlight: BurnDownRow[];
  parked: BurnDownParkedRow[];
  unclaimed: BurnDownRow[];
  counts: {
    total: number;
    terminal: number;
    inFlight: number;
    parked: number;
    unclaimed: number;
  };
  /** EI-8990: itemized (not just counted) terminal transitions since `since` —
   *  omitted entirely when `since` is not passed. Capped at DELTA_ROW_CAP,
   *  newest first; `truncated` names the true total when capped. */
  closedSince?: { rows: BurnDownDeltaRow[]; total: number; truncated: boolean };
  /** EI-8990: work-items CREATED since `since` (any state) — the "opened" half
   *  of the burn-down delta a monitor loop otherwise has to re-derive by diffing
   *  two full work_items:list snapshots. Same capping as closedSince. */
  openedSince?: { rows: BurnDownDeltaRow[]; total: number; truncated: boolean };
}

function hasClaimHold(item: WorkItem): boolean {
  const payload = item.payload;
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>)._claimHold === true,
  );
}

function toRow(item: WorkItem, assigneeLive?: boolean): BurnDownRow {
  return {
    id: item.id,
    kind: item.kind,
    family: item.family,
    harness: item.harness,
    title: item.title,
    state: item.state,
    assignee: item.assignee,
    ...(item.assignee ? { assigneeLive: Boolean(assigneeLive) } : {}),
    takenAt: item.takenAt,
    lastProgressAt: item.lastProgressAt,
    updatedAt: item.updatedAt,
    severity: item.severity,
    priority: item.priority,
  };
}

export function liveOwnersFromPresence(
  presence: PresenceLike[],
  nowMs = Date.now(),
): Set<string> {
  const live = new Set<string>();
  for (const row of presence) {
    if (row.stale === true) continue;
    const heartbeatMs = row.heartbeatAt ? Date.parse(row.heartbeatAt) : NaN;
    if (!Number.isFinite(heartbeatMs)) continue;
    if (nowMs - heartbeatMs <= PRESENCE_STALE_MS) live.add(row.ownerId);
  }
  return live;
}

export function buildBurnDownResult(
  items: WorkItem[],
  liveOwners: Set<string>,
  opts: { harness: string; generatedAt?: string; since?: string | null } ,
): BurnDownResult {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const hasSince = Number.isFinite(sinceMs);
  const terminal = {
    total: 0,
    done: 0,
    passed: 0,
    resolved: 0,
    closed: 0,
    deprecated: 0,
    dropped: 0,
    deltaSince: opts.since ?? null,
    delta: 0,
  };
  const inFlight: BurnDownRow[] = [];
  const parked: BurnDownParkedRow[] = [];
  const unclaimed: BurnDownRow[] = [];
  // EI-8990: itemized since-bounded deltas — only populated (and only cost
  // anything) when `since` is passed. Sorted newest-first before capping so a
  // truncated list still shows the most-recent transitions, not an arbitrary
  // prefix of listWorkItems's own ordering.
  const closedRows: BurnDownDeltaRow[] = [];
  const openedRows: BurnDownDeltaRow[] = [];

  for (const item of items) {
    const row = toRow(item, item.assignee ? liveOwners.has(item.assignee) : undefined);
    const state = item.state;
    if (hasSince && Date.parse(item.createdAt) > sinceMs) {
      openedRows.push({ id: item.id, kind: item.kind, title: item.title, state, harness: item.harness, ts: item.createdAt });
    }
    if (TERMINAL_STATES.has(state)) {
      terminal.total += 1;
      if (state in terminal && typeof terminal[state as keyof typeof terminal] === 'number') {
        (terminal[state as 'done' | 'passed' | 'resolved' | 'closed' | 'deprecated' | 'dropped']) += 1;
      }
      if (hasSince && Date.parse(item.updatedAt) > sinceMs) {
        terminal.delta += 1;
        closedRows.push({ id: item.id, kind: item.kind, title: item.title, state, harness: item.harness, ts: item.updatedAt });
      }
      continue;
    }

    if (hasClaimHold(item)) {
      parked.push({
        ...row,
        reason: 'excluded from self-select by payload._claimHold',
        mechanism: 'claimHold',
        aliasedState: state,
      });
      continue;
    }

    if (PARKED_STATES.has(state)) {
      const mechanism = state === 'blocked' ? 'blocked' : state === 'needs-human' || state === 'needs_human' ? 'needs-human' : 'state';
      parked.push({
        ...row,
        reason: `parked by lifecycle state ${state}`,
        mechanism,
      });
      continue;
    }

    if (item.assignee) {
      inFlight.push(row);
      continue;
    }
    unclaimed.push(row);
  }

  const sortNewestFirst = (a: BurnDownDeltaRow, b: BurnDownDeltaRow) => Date.parse(b.ts) - Date.parse(a.ts);
  const capDelta = (rows: BurnDownDeltaRow[]) => {
    const sorted = [...rows].sort(sortNewestFirst);
    return { rows: sorted.slice(0, DELTA_ROW_CAP), total: sorted.length, truncated: sorted.length > DELTA_ROW_CAP };
  };

  return {
    ok: true,
    harness: opts.harness,
    generatedAt,
    terminal,
    inFlight,
    parked,
    unclaimed,
    counts: {
      total: items.length,
      terminal: terminal.total,
      inFlight: inFlight.length,
      parked: parked.length,
      unclaimed: unclaimed.length,
    },
    ...(hasSince ? { closedSince: capDelta(closedRows), openedSince: capDelta(openedRows) } : {}),
  };
}

const rowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  family: z.string(),
  harness: z.string().nullable(),
  title: z.string(),
  state: z.string(),
  assignee: z.string().nullable(),
  assigneeLive: z.boolean().optional(),
  takenAt: z.string().nullable(),
  lastProgressAt: z.string().nullable(),
  updatedAt: z.string(),
  severity: z.string().nullable(),
  priority: z.number().nullable(),
});

export default defineTool({
  name: 'work_items:burn_down',
  profile: 'engineer',
  description:
    'One-call leader census for a harness work queue: terminal counts, in-flight rows with assignee liveness, parked rows (blocked/needs-human/claimHold), and unclaimed rows. Pass `since` to also get closedSince/openedSince — itemized (not just counted) terminal transitions and newly-created items, capped + newest-first. Replaces hand-joining work_items:list with coord:presence for drain/fleet leader wakes.',
  guidance: {
    when:
      'You are leading a drain/fleet/Queen pass and need to know what is done, actively held by a live or dead assignee, intentionally parked, and still unclaimed.',
    notWhen:
      'You need full per-item bodies/checkpoints/comments — use work_items:get for the specific ids after this census.',
    chaining:
      'work_items:burn_down → work_items:get for detail on a row → coord:send or work_items:claim/release/set_state as needed.',
    seeAlso: [
      'work_items:list (raw row listing)',
      'fleet:assignments (full live agent work-list and stalled/orphaned claim analysis)',
      'coord:presence (raw live roster)',
    ],
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1).max(80),
    kind: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('optional work-item kind filter'),
    since: z
      .string()
      .datetime()
      .optional()
      .describe('optional ISO timestamp; terminal.delta counts terminal items updated after it, and closedSince/openedSince are itemized around it'),
    includeChildren: z
      .boolean()
      .optional()
      .describe('include child/chunk rows in the census'),
    limit: z.number().int().positive().max(2000).optional(),
  }),
  result: z.object({
    ok: z.literal(true),
    harness: z.string(),
    generatedAt: z.string(),
    terminal: z.object({
      total: z.number(),
      done: z.number(),
      passed: z.number(),
      resolved: z.number(),
      closed: z.number(),
      deprecated: z.number(),
      dropped: z.number(),
      deltaSince: z.string().nullable(),
      delta: z.number(),
    }),
    inFlight: z.array(rowSchema),
    parked: z.array(rowSchema.extend({
      reason: z.string(),
      mechanism: z.enum(['claimHold', 'blocked', 'needs-human', 'state']),
      aliasedState: z.string().optional(),
    })),
    unclaimed: z.array(rowSchema),
    counts: z.object({
      total: z.number(),
      terminal: z.number(),
      inFlight: z.number(),
      parked: z.number(),
      unclaimed: z.number(),
    }),
    closedSince: z
      .object({
        rows: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            title: z.string(),
            state: z.string(),
            harness: z.string().nullable(),
            ts: z.string(),
          }),
        ),
        total: z.number(),
        truncated: z.boolean(),
      })
      .optional(),
    openedSince: z
      .object({
        rows: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            title: z.string(),
            state: z.string(),
            harness: z.string().nullable(),
            ts: z.string(),
          }),
        ),
        total: z.number(),
        truncated: z.boolean(),
      })
      .optional(),
  }),
  async handler(args, ctx) {
    const [items, presence] = await Promise.all([
      listWorkItems({
        harness: args.harness,
        kind: args.kind as WorkItemKind | undefined,
        includeChildren: args.includeChildren,
        limit: args.limit ?? 2000,
      }),
      listPresence({ workspaceId: (ctx as { workspaceId?: string | null }).workspaceId ?? undefined }).catch(() => []),
    ]);
    return {
      data: buildBurnDownResult(items, liveOwnersFromPresence(presence), {
        harness: args.harness,
        since: args.since ?? null,
      }),
    };
  },
});
