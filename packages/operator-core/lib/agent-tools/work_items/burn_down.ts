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
  getWorkItem,
  readWorkItemClaimHoldProvenance,
  type WorkItem,
  type WorkItemKind,
} from '../../work-items';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

// EI-18653071581558556 — derived from the canonical cross-family union rather
// than re-listed. This copy happened to be correct, but it was the third
// hand-maintained duplicate of the same set; placement-watchdog's copy had
// already drifted (missing `done`/`dropped`) and silently scored finished work
// as failed placements.
const TERMINAL_STATES = new Set(ANY_FAMILY_TERMINAL_STATES);
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
  mechanism: 'claimHold' | 'blocked' | 'needs-human' | 'external-blocker' | 'state';
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
  /** P-024: exact one-row-per-requested-ID completion-integrity audit. */
  cohortAudit?: CohortAuditResult;
}

export type CohortBucket = 'terminal' | 'parked' | 'in-flight' | 'unclaimed' | 'missing';
export type CohortEvidenceVerdict = 'verified' | 'incomplete' | 'missing' | 'not-applicable';

export interface CohortAuditRow {
  id: string;
  title: string | null;
  state: string | null;
  bucket: CohortBucket;
  /** Exact terminal lifecycle token (done/resolved/closed/…), null while open/missing. */
  closureKind: string | null;
  evidenceVerdict: CohortEvidenceVerdict;
  completionRef: string | null;
  terminalOwner: string | null;
  reopenRecommended: boolean;
  recommendation: string | null;
}

export interface CohortAuditResult {
  requested: number;
  found: number;
  missing: number;
  reopenRecommended: number;
  rows: CohortAuditRow[];
}

export function buildCohortAudit(requestedIds: readonly string[], items: readonly WorkItem[]): CohortAuditResult {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rows = requestedIds.map((id): CohortAuditRow => {
    const item = byId.get(id);
    if (!item) {
      return {
        id,
        title: null,
        state: null,
        bucket: 'missing',
        closureKind: null,
        evidenceVerdict: 'not-applicable',
        completionRef: null,
        terminalOwner: null,
        reopenRecommended: false,
        recommendation: 'investigate missing fixed-cohort id',
      };
    }
    const terminal = TERMINAL_STATES.has(item.state);
    const parked = hasClaimHold(item) || PARKED_STATES.has(item.state);
    const bucket: CohortBucket = terminal
      ? 'terminal'
      : parked
        ? 'parked'
        : item.assignee
          ? 'in-flight'
          : 'unclaimed';
    let evidenceVerdict: CohortEvidenceVerdict = 'not-applicable';
    let recommendation: string | null = null;
    let reopenRecommended = false;
    if (terminal) {
      const evidence = item.terminalCompletionEvidence;
      const hasEvidence = evidence != null && Object.keys(evidence).length > 0;
      const hasVerification = Boolean(
        evidence?.verifiedHow && (evidence.testsRun || evidence.testResult),
      );
      evidenceVerdict = !hasEvidence || !item.terminalCompletionRef
        ? 'missing'
        : hasVerification
          ? 'verified'
          : 'incomplete';
      reopenRecommended = evidenceVerdict !== 'verified';
      recommendation = reopenRecommended
        ? 'reopen and require structured verification evidence before counting terminal'
        : null;
    }
    return {
      id,
      title: item.title,
      state: item.state,
      bucket,
      closureKind: terminal ? item.state : null,
      evidenceVerdict,
      completionRef: item.terminalCompletionRef,
      terminalOwner: item.terminalOwner,
      reopenRecommended,
      recommendation,
    };
  });
  return {
    requested: requestedIds.length,
    found: rows.filter((row) => row.bucket !== 'missing').length,
    missing: rows.filter((row) => row.bucket === 'missing').length,
    reopenRecommended: rows.filter((row) => row.reopenRecommended).length,
    rows,
  };
}

function hasClaimHold(item: WorkItem): boolean {
  const payload = item.payload;
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>)._claimHold === true,
  );
}

/**
 * EI-18672701535825889: a claim-hold row has TWO mutually-invisible provenance
 * conventions (held_open_* lease vs claim_hold_* durable park — see
 * readWorkItemClaimHoldProvenance). Reporting the raw `payload._claimHold` marker
 * with no holder/reason is exactly what sent a leader auditing this census down the
 * wrong path (84 policy-gated holds read as "(no holder), (no reason)" stale
 * corruption, one force-cleared off a security gate before the mistake was caught).
 * Surface whichever convention(s) actually attributed the hold; only a row with
 * NEITHER is a genuine unattributed-hold triage candidate.
 */
function claimHoldReason(item: WorkItem): string {
  const { heldOpen, parked, attributed } = readWorkItemClaimHoldProvenance(item.payload);
  if (!attributed) {
    return 'excluded from self-select by payload._claimHold — UNATTRIBUTED (no held_open_by / claim_hold_by on the row)';
  }
  const parts: string[] = [];
  if (heldOpen) {
    parts.push(`held open by ${heldOpen.by}${heldOpen.reason ? `: ${heldOpen.reason}` : ''}`);
  }
  if (parked) {
    parts.push(`durably parked by ${parked.by}${parked.reason ? `: ${parked.reason}` : ''}`);
  }
  return parts.join('; ');
}

function hasNeedsHuman(item: WorkItem): boolean {
  const payload = item.payload;
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).needsHuman === true,
  );
}

function hasActiveExternalBlocker(item: WorkItem): boolean {
  if (item.externalBlockers?.some((blocker) => blocker.status === 'active')) return true;
  const payload = item.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const blockers = (payload as Record<string, unknown>).externalBlockers;
  return (
    Array.isArray(blockers) &&
    blockers.some(
      (blocker) =>
        blocker &&
        typeof blocker === 'object' &&
        !Array.isArray(blocker) &&
        (blocker as Record<string, unknown>).status === 'active',
    )
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
        reason: claimHoldReason(item),
        mechanism: 'claimHold',
        aliasedState: state,
      });
      continue;
    }

    // These are the same queue floors used by scheduler:get_next and
    // work_items:claim_next. They remain open/directly actionable, but are
    // parked rather than reported as unclaimed so leader census agrees with
    // scheduler admission (WI-4759).
    if (hasNeedsHuman(item)) {
      parked.push({
        ...row,
        reason: 'excluded from self-select by payload.needsHuman',
        mechanism: 'needs-human',
      });
      continue;
    }

    if (hasActiveExternalBlocker(item)) {
      parked.push({
        ...row,
        reason: 'excluded from self-select by active external blocker',
        mechanism: 'external-blocker',
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
    'One-call leader census for a harness work queue: terminal counts, in-flight rows with assignee liveness, parked rows (blocked/needs-human/claimHold), and unclaimed rows. Pass `ids` for an exact fixed-cohort census plus one audit row per requested ID: terminal bucket, closure kind, structured-evidence verdict, completion ref, and reopen recommendation. Pass `since` for itemized closed/opened deltas. Replaces hand-joining work_items:list with coord:presence for drain/fleet leader wakes.',
  guidance: {
    when:
      'You are leading a drain/fleet/Mug pass and need to know what is done, actively held by a live or dead assignee, intentionally parked, and still unclaimed.',
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
    ids: z
      .array(z.string().min(1).max(120))
      .min(1)
      .max(200)
      .optional()
      .describe('Exact fixed-cohort IDs. Narrows the census and adds cohortAudit with one row per requested ID, including missing IDs.'),
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
      mechanism: z.enum(['claimHold', 'blocked', 'needs-human', 'external-blocker', 'state']),
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
    cohortAudit: z
      .object({
        requested: z.number(),
        found: z.number(),
        missing: z.number(),
        reopenRecommended: z.number(),
        rows: z.array(z.object({
          id: z.string(),
          title: z.string().nullable(),
          state: z.string().nullable(),
          bucket: z.enum(['terminal', 'parked', 'in-flight', 'unclaimed', 'missing']),
          closureKind: z.string().nullable(),
          evidenceVerdict: z.enum(['verified', 'incomplete', 'missing', 'not-applicable']),
          completionRef: z.string().nullable(),
          terminalOwner: z.string().nullable(),
          reopenRecommended: z.boolean(),
          recommendation: z.string().nullable(),
        })),
      })
      .optional(),
  }),
  async handler(args, ctx) {
    const requestedIds = args.ids ? [...new Set(args.ids)] : null;
    const [items, presence] = await Promise.all([
      requestedIds
        ? Promise.all(requestedIds.map((id) => getWorkItem(id, args.harness))).then(
            (rows) => rows.filter((row): row is WorkItem => row != null),
          )
        : listWorkItems({
            harness: args.harness,
            kind: args.kind as WorkItemKind | undefined,
            includeChildren: args.includeChildren,
            limit: args.limit ?? 2000,
          }),
      listPresence({ workspaceId: (ctx as { workspaceId?: string | null }).workspaceId ?? undefined }).catch(() => []),
    ]);
    const result = buildBurnDownResult(items, liveOwnersFromPresence(presence), {
      harness: args.harness,
      since: args.since ?? null,
    });
    if (requestedIds) result.cohortAudit = buildCohortAudit(requestedIds, items);
    return {
      data: result,
    };
  },
});
