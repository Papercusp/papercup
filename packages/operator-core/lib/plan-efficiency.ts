/**
 * plan-efficiency.ts — the per-plan efficiency read.
 *
 * review-system-rework-reduction-2026-09-23 P-032 (report improvement 26). One read answers, for
 * one plan: where its agents' MCP calls went (by purpose), how many calls went to items that ended
 * dropped, how many calls failed and by which class, how often an item changed hands, and how the
 * agents who worked it split their wall-clock between active, idle and away. Surfaced through
 * `plans:get { efficiency: true }` — an extension of the existing read, not a bespoke tool — so the
 * same numbers the audit hand-derived with SQL (docs/evidence/review-system-time-audit-2026-09-23.md,
 * "Sources") are one call for the next plan's before/after.
 *
 * POPULATION. `harness_shared.tool_invocations` rows with `call_origin = 'agent'` whose `goal_ref`
 * is one of the plan's work items (`work_items.source_plan_slug` = the plan, observation lane
 * excluded). Every count is a FLOOR, and the payload says so: native client tools (Edit / Read /
 * Bash) write no tool_invocations row, and a call made without a goal stamp is attributed to no
 * plan at all.
 *
 * WALL-CLOCK is measured over the agents' transcript parts (`session_turn_parts`, corpus workspace
 * `default`) between the plan's first and last attributed call. An agent working two plans in that
 * window counts toward both, so it is labelled `holders-across-plan-window`, never "time on plan".
 */
import { getOrgPg } from '@papercusp/db-org';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { getBuildInfo } from './build-info';

export const PLAN_EFFICIENCY_CATEGORIES = [
  'generic-exec',
  'coordination-carry',
  'read-orient',
  'acceptance-ceremony',
  'gate-pipeline',
  'implementation-test',
  'other',
] as const;
export type PlanEfficiencyCategory = (typeof PLAN_EFFICIENCY_CATEGORIES)[number];

/** Gaps between consecutive transcript parts shorter than this count as active time. */
export const ACTIVE_GAP_SEC = 120;
/** Gaps at least ACTIVE_GAP_SEC and shorter than this are idle; longer gaps are away. */
export const IDLE_GAP_SEC = 3600;

const EXACT_CATEGORY: Readonly<Record<string, PlanEfficiencyCategory>> = {
  'capability:bash': 'generic-exec',
  'capability:bash_output': 'generic-exec',
  'code:run': 'generic-exec',
  'tools:invoke': 'generic-exec',
  'recipes:run': 'generic-exec',
  'capability:edit': 'implementation-test',
  'capability:write': 'implementation-test',
  'plans:set-plan-status': 'acceptance-ceremony',
  'plans:audit': 'acceptance-ceremony',
  'plans:evaluate-spec-test-adequacy': 'acceptance-ceremony',
  'plans:bind-spec-evidence': 'acceptance-ceremony',
  'plans:get-spec-evidence': 'acceptance-ceremony',
  'dev:pipeline_position': 'gate-pipeline',
  'dev:restart': 'gate-pipeline',
  'work_items:checkpoint': 'coordination-carry',
  'work_items:claim': 'coordination-carry',
  'work_items:claim_next': 'coordination-carry',
  'work_items:release': 'coordination-carry',
  'work_items:comment': 'coordination-carry',
  'work_items:complete': 'coordination-carry',
  'work_items:set_state': 'coordination-carry',
  'scheduler:get_next': 'coordination-carry',
  'session:request-compaction': 'coordination-carry',
};

const PREFIX_CATEGORY: ReadonlyArray<readonly [string, PlanEfficiencyCategory]> = [
  ['coord:', 'coordination-carry'],
  ['loop:', 'coordination-carry'],
  ['locks:', 'coordination-carry'],
  ['events:', 'coordination-carry'],
  ['fleet:', 'coordination-carry'],
  ['facts:', 'coordination-carry'],
  ['orders:', 'coordination-carry'],
  ['mode:', 'coordination-carry'],
  ['rubrics:', 'acceptance-ceremony'],
  ['scorecards:', 'acceptance-ceremony'],
  ['release:', 'gate-pipeline'],
  ['git-sync:', 'gate-pipeline'],
  ['testing:', 'implementation-test'],
  ['build:', 'implementation-test'],
  ['lint:', 'implementation-test'],
  ['plans:', 'read-orient'],
  ['work_items:', 'read-orient'],
  ['issues:', 'read-orient'],
  ['dev:', 'read-orient'],
  ['docs:', 'read-orient'],
  ['search:', 'read-orient'],
  ['sessions:', 'read-orient'],
  ['memory:', 'read-orient'],
  ['state:', 'read-orient'],
  ['tools:', 'read-orient'],
  ['lsp:', 'read-orient'],
  ['graph:', 'read-orient'],
  ['gitnexus.', 'read-orient'],
];

/**
 * Collapse an MCP tool name (colon form) into the purpose it served. Exact names win over
 * prefixes, so e.g. `plans:set-plan-status` is acceptance ceremony while other `plans:*` verbs are
 * reads, and `work_items:checkpoint` is carry while `work_items:get` is a read.
 */
export function categorizePlanToolCall(toolName: string): PlanEfficiencyCategory {
  const name = toolName.trim().toLowerCase();
  const exact = EXACT_CATEGORY[name];
  if (exact) return exact;
  for (const [prefix, category] of PREFIX_CATEGORY) {
    if (name.startsWith(prefix)) return category;
  }
  return 'other';
}

/** Statuses that are NOT a failed call: a success, or an idempotent replay of one. */
const NON_FAILED_STATUSES = new Set(['ok', 'replayed']);

export interface PlanEfficiencyInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** postgres-js client; defaults to the org pool. Injected by the integration test. */
  sql?: ReturnType<typeof getOrgPg>['sql'];
  /** How many most-contested items to name. */
  topItems?: number;
}

export interface PlanEfficiency {
  planSlug: string;
  harnessSlug: string;
  workspaceId: string;
  population: {
    source: 'harness_shared.tool_invocations';
    callOrigin: 'agent';
    attribution: 'goal_ref in the plan work items (source_plan_slug; observation lane excluded)';
    floor: true;
    note: string;
  };
  items: { total: number; byStatus: Record<string, number> };
  calls: {
    total: number;
    agents: number;
    activeHours: number;
    firstAt: string | null;
    lastAt: string | null;
    byCategory: Record<PlanEfficiencyCategory, number>;
  };
  failed: { total: number; share: number; byClass: Record<string, number> };
  droppedEffort: { calls: number; items: number; itemIds: string[] };
  holders: {
    itemsWorked: number;
    itemsWithHolderChange: number;
    holderChanges: number;
    mostHandled: Array<{ itemId: string; holders: number }>;
  };
  wallClock: {
    scope: 'holders-across-plan-window';
    activeGapSec: number;
    idleGapSec: number;
    owners: number;
    activeSec: number;
    idleSec: number;
    awaySec: number;
    idleGaps: number;
  };
}

interface CallGroupRow {
  tool_name: string;
  status: string | null;
  error_code: string | null;
  on_dropped: boolean;
  n: number | string;
}

const toNumber = (value: number | string | null | undefined): number => (value == null ? 0 : Number(value));
const toIso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

function emptyCategories(): Record<PlanEfficiencyCategory, number> {
  return Object.fromEntries(PLAN_EFFICIENCY_CATEGORIES.map((category) => [category, 0])) as Record<
    PlanEfficiencyCategory,
    number
  >;
}

/** Fold the grouped call rows into category, failure and dropped-effort tallies. */
export function foldPlanCallGroups(rows: readonly CallGroupRow[]): {
  total: number;
  byCategory: Record<PlanEfficiencyCategory, number>;
  failedTotal: number;
  failedByClass: Record<string, number>;
  droppedCalls: number;
} {
  const byCategory = emptyCategories();
  const failedByClass: Record<string, number> = {};
  let total = 0;
  let failedTotal = 0;
  let droppedCalls = 0;
  for (const row of rows) {
    const n = toNumber(row.n);
    total += n;
    byCategory[categorizePlanToolCall(row.tool_name)] += n;
    if (row.on_dropped) droppedCalls += n;
    const status = row.status ?? 'unknown';
    if (!NON_FAILED_STATUSES.has(status)) {
      failedTotal += n;
      const cls = row.error_code?.trim() || status;
      failedByClass[cls] = (failedByClass[cls] ?? 0) + n;
    }
  }
  return { total, byCategory, failedTotal, failedByClass, droppedCalls };
}

export async function readPlanEfficiency(input: PlanEfficiencyInput): Promise<PlanEfficiency> {
  const sql = input.sql ?? getOrgPg().sql;
  const { workspaceId, harnessSlug, planSlug } = input;
  const topItems = input.topItems ?? 5;

  const itemRows = await sql<Array<{ feature_id: string; status: string }>>`
    SELECT feature_id, status
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND source_plan_slug = ${planSlug}
       AND lane IS DISTINCT FROM 'observation'`;
  const itemIds = itemRows.map((row) => row.feature_id);
  const droppedIds = itemRows.filter((row) => row.status === 'dropped').map((row) => row.feature_id);
  const byStatus: Record<string, number> = {};
  for (const row of itemRows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

  const groups = itemIds.length
    ? await sql<CallGroupRow[]>`
        SELECT tool_name, status, error_code,
               (goal_ref = ANY(${droppedIds}::text[])) AS on_dropped,
               count(*) AS n
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND call_origin = 'agent'
           AND goal_ref = ANY(${itemIds}::text[])
         GROUP BY 1, 2, 3, 4`
    : [];
  const folded = foldPlanCallGroups(groups);

  const [span] = itemIds.length
    ? await sql<Array<{ agents: number | string; hours: number | string; first_at: Date | null; last_at: Date | null }>>`
        SELECT count(DISTINCT coord_owner_id) AS agents,
               count(DISTINCT date_trunc('hour', invoked_at)) AS hours,
               min(invoked_at) AS first_at,
               max(invoked_at) AS last_at
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND call_origin = 'agent'
           AND goal_ref = ANY(${itemIds}::text[])`
    : [{ agents: 0, hours: 0, first_at: null, last_at: null }];

  const perItem = itemIds.length
    ? await sql<Array<{ goal_ref: string; holders: number | string }>>`
        SELECT goal_ref, count(DISTINCT coord_owner_id) AS holders
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND call_origin = 'agent'
           AND coord_owner_id IS NOT NULL
           AND goal_ref = ANY(${itemIds}::text[])
         GROUP BY goal_ref`
    : [];
  const handled = perItem
    .map((row) => ({ itemId: row.goal_ref, holders: toNumber(row.holders) }))
    .sort((a, b) => b.holders - a.holders || a.itemId.localeCompare(b.itemId));
  const droppedWorked = new Set(perItem.map((row) => row.goal_ref).filter((id) => droppedIds.includes(id)));

  const owners = itemIds.length
    ? (
        await sql<Array<{ coord_owner_id: string }>>`
          SELECT DISTINCT coord_owner_id
            FROM harness_shared.tool_invocations
           WHERE workspace_id = ${workspaceId}
             AND call_origin = 'agent'
             AND coord_owner_id IS NOT NULL
             AND goal_ref = ANY(${itemIds}::text[])`
      ).map((row) => row.coord_owner_id)
    : [];
  const firstAt = toIso(span?.first_at);
  const lastAt = toIso(span?.last_at);
  const [clock] =
    owners.length && firstAt && lastAt
      ? await sql<
          Array<{ owners: number | string; active: number | string; idle: number | string; away: number | string; idle_gaps: number | string }>
        >`
          SELECT count(DISTINCT owner) AS owners,
                 coalesce(sum(gap) FILTER (WHERE gap < ${ACTIVE_GAP_SEC}), 0) AS active,
                 coalesce(sum(gap) FILTER (WHERE gap >= ${ACTIVE_GAP_SEC} AND gap < ${IDLE_GAP_SEC}), 0) AS idle,
                 coalesce(sum(gap) FILTER (WHERE gap >= ${IDLE_GAP_SEC}), 0) AS away,
                 count(*) FILTER (WHERE gap >= ${ACTIVE_GAP_SEC} AND gap < ${IDLE_GAP_SEC}) AS idle_gaps
            FROM (
              SELECT owner,
                     extract(epoch FROM ts - lag(ts) OVER (PARTITION BY owner ORDER BY ts)) AS gap
                FROM harness_shared.session_turn_parts
               WHERE workspace_id = 'default'
                 AND owner = ANY(${owners}::text[])
                 AND ts BETWEEN ${firstAt}::timestamptz AND ${lastAt}::timestamptz
            ) gaps
           WHERE gap IS NOT NULL`
      : [{ owners: 0, active: 0, idle: 0, away: 0, idle_gaps: 0 }];

  return {
    planSlug,
    harnessSlug,
    workspaceId,
    population: {
      source: 'harness_shared.tool_invocations',
      callOrigin: 'agent',
      attribution: 'goal_ref in the plan work items (source_plan_slug; observation lane excluded)',
      floor: true,
      note: 'Floors: native client tools (Edit/Read/Bash) write no tool_invocations row, and a call without a goal stamp is attributed to no plan. Categories are by tool name, not by intent.',
    },
    items: { total: itemRows.length, byStatus },
    calls: {
      total: folded.total,
      agents: toNumber(span?.agents),
      activeHours: toNumber(span?.hours),
      firstAt,
      lastAt,
      byCategory: folded.byCategory,
    },
    failed: {
      total: folded.failedTotal,
      share: folded.total > 0 ? Math.round((folded.failedTotal / folded.total) * 1000) / 1000 : 0,
      byClass: folded.failedByClass,
    },
    droppedEffort: { calls: folded.droppedCalls, items: droppedWorked.size, itemIds: [...droppedWorked].sort() },
    holders: {
      itemsWorked: handled.length,
      itemsWithHolderChange: handled.filter((row) => row.holders > 1).length,
      holderChanges: handled.reduce((sum, row) => sum + Math.max(0, row.holders - 1), 0),
      mostHandled: handled.filter((row) => row.holders > 1).slice(0, topItems),
    },
    wallClock: {
      scope: 'holders-across-plan-window',
      activeGapSec: ACTIVE_GAP_SEC,
      idleGapSec: IDLE_GAP_SEC,
      owners: toNumber(clock?.owners),
      activeSec: Math.round(toNumber(clock?.active)),
      idleSec: Math.round(toNumber(clock?.idle)),
      awaySec: Math.round(toNumber(clock?.away)),
      idleGaps: toNumber(clock?.idle_gaps),
    },
  };
}

/** Selected-step observations extend the existing efficiency reader. Neither a
 * goal stamp nor ingest-time session context is a causal request-to-work binding.
 * Keep this distinction even when the selected SQL snapshot is exhaustive. */
export const WORKFLOW_STEP_MEASUREMENT_VERSION = 1;
export const WORKFLOW_STEP_MAX_ROWS = 10_000;
export interface WorkflowStepSubject {
  kind?: string;
  ref: string;
  windowStart: string;
  windowEnd: string;
}
export interface WorkflowStepSource {
  workspaceId: string;
  harnessSlug: string;
  subject: WorkflowStepSubject;
  workItemIds: string[];
  nativeSessionIds: string[];
  ownerIds: string[];
  sharedSessionIds: string[];
  predicate: string;
  fingerprint: string;
  /** Derived by a source reader, never from a grader's claimed request count. */
  expectedRequests: { state: 'known'; keys: string[]; sourceRef: string } |
    { state: 'unknown'; reason: string };
  complete: boolean;
}
export interface WorkflowStepUsageRow {
  id: string;
  workspace_id: string;
  harness_slug: string | null;
  session_id: string | null;
  run_id?: string | null;
  usage_event_key: string | null;
  event_ts: number | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_creation_tokens: number | string | null;
  cost_usd: number | string | null;
  cost_source: string | null;
  usage_provenance: Record<string, unknown> | null;
}
export type WorkflowStepPartition = 'included' | 'excluded' | 'unallocated-shared' |
  'duplicate' | 'conflicting' | 'missing-time-unknown-grain' | 'truncated-residue';
const STEP_PARTITIONS: WorkflowStepPartition[] = ['included', 'excluded', 'unallocated-shared',
  'duplicate', 'conflicting', 'missing-time-unknown-grain', 'truncated-residue'];
/** Malformed numeric observations still need retained evidence. JSON's usual
 * Infinity/NaN -> null conversion would erase the distinction from missing data. */
const stepEvidence = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry: unknown) =>
  typeof entry === 'number' && !Number.isFinite(entry) ? { nonFiniteNumber: String(entry) } : entry));
const stepHash = (value: unknown): string => createHash('sha256').update(canonicalJson(stepEvidence(value))).digest('hex');
const stepNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || !['number', 'string'].includes(typeof value) ||
      typeof value === 'string' && !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const stepTokens = (value: unknown): number | null => {
  const n = stepNumber(value);
  return n !== null && Number.isSafeInteger(n) ? n : null;
};
const stepRowOrder = (a: WorkflowStepUsageRow, b: WorkflowStepUsageRow): number => {
  if (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)) {
    const left = BigInt(a.id), right = BigInt(b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
const stepObservationIdentity = (row: WorkflowStepUsageRow) => stepHash({
  session: row.session_id, run: row.run_id ?? null,
  eventTime: row.event_ts === null ? null : stepNumber(row.event_ts) ?? row.event_ts,
  input: row.input_tokens === null ? null : String(row.input_tokens),
  output: row.output_tokens === null ? null : String(row.output_tokens),
  cacheRead: row.cache_read_tokens === null ? null : String(row.cache_read_tokens),
  cacheWrite: row.cache_creation_tokens === null ? null : String(row.cache_creation_tokens),
  cost: row.cost_usd === null ? null : String(row.cost_usd), costSource: row.cost_source,
  provenance: row.usage_provenance,
});

/** Observed tool spans overlap. Their union is not active LLM effort, queueing,
 * owner pauses, or elapsed time attributable to this step. */
export function unionWorkflowStepIntervals(intervals: readonly (readonly [number, number])[]): number | null {
  if (!intervals.length) return null;
  if (intervals.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || b < a)) return null;
  const sorted = intervals.map(([a, b]) => [a, b]).sort((a, b) => a[0] - b[0]);
  let total = 0, start = sorted[0][0], end = sorted[0][1];
  for (const [a, b] of sorted.slice(1)) {
    if (a > end) { total += end - start; start = a; }
    end = Math.max(end, b);
  }
  return total + end - start;
}

/** PURE population reconciliation. Record counts and unique request counts are
 * separate denominators. Conflicting observations remove the WHOLE key from
 * additive facts; duplicate ordering must never choose the preferred quantity. */
export function summarizeWorkflowStepUsage(input: {
  source: WorkflowStepSource;
  rows: readonly WorkflowStepUsageRow[];
  ledger: { totalRecords: number | null; limit: number; complete: boolean; pages?: number; error?: string };
  toolIntervals?: readonly (readonly [number, number])[];
}) {
  const { source, ledger } = input;
  const rows = [...input.rows].sort(stepRowOrder);
  const start = Date.parse(source.subject.windowStart), end = Date.parse(source.subject.windowEnd);
  const validScope = !!source.workspaceId.trim() && !!source.harnessSlug.trim() && !!source.subject.ref.trim() &&
    Number.isFinite(start) && Number.isFinite(end) && start < end && source.workItemIds.length > 0;
  const partitions = Object.fromEntries(STEP_PARTITIONS.map(key => [key, [] as Array<{
    rowId: string; requestKey: string | null; reason: string;
  }>])) as Record<WorkflowStepPartition, Array<{ rowId: string; requestKey: string | null; reason: string }>>;
  const place = (row: WorkflowStepUsageRow, bucket: WorkflowStepPartition, reason: string) =>
    partitions[bucket].push({ rowId: row.id, requestKey: row.usage_event_key, reason });
  const candidates = new Map<string, WorkflowStepUsageRow[]>();
  const allGroups = new Map<string, Map<string, number>>();
  const observationIdentities = new Map<WorkflowStepUsageRow, string>();
  for (const row of rows) {
    const identity = stepObservationIdentity(row);
    observationIdentities.set(row, identity);
    if (!row.usage_event_key) continue;
    const group = allGroups.get(row.usage_event_key) ?? new Map<string, number>();
    group.set(identity, (group.get(identity) ?? 0) + 1); allGroups.set(row.usage_event_key, group);
  }
  const diagnostics: Array<{ rowId: string; requestKey: string | null; flags: string[] }> = [];
  const selected: WorkflowStepUsageRow[] = [];
  for (const row of rows) {
    const provenance = row.usage_provenance ?? {};
    const native = row.session_id ?? row.run_id;
    const inNative = native !== null && native !== undefined && source.nativeSessionIds.includes(native);
    const inOwner = typeof provenance.sessionOwnerId === 'string' && source.ownerIds.includes(provenance.sessionOwnerId);
    const eventTime = stepNumber(row.event_ts);
    const flags = [
      ...(!validScope ? ['invalid-or-unresolved-subject'] : []),
      ...(row.workspace_id !== source.workspaceId ? ['foreign-workspace'] : []),
      ...(row.harness_slug !== source.harnessSlug ? ['foreign-or-missing-harness'] : []),
      ...(!inNative && !inOwner ? ['foreign-session'] : []),
      ...(eventTime !== null && (eventTime < start || eventTime >= end) ? ['outside-event-window'] : []),
      ...(eventTime === null || !Number.isSafeInteger(eventTime) ? ['missing-original-event-time'] : []),
      ...(!row.usage_event_key ? ['missing-request-identity'] : []),
      ...(provenance.grain !== 'request' ? ['non-request-or-unknown-grain'] : []),
    ];
    const observationGroup = allGroups.get(row.usage_event_key ?? '');
    if ((observationGroup?.get(observationIdentities.get(row)!) ?? 0) > 1) flags.push('duplicate-observation');
    if (observationGroup && observationGroup.size > 1) flags.push('conflicting-request-observations');
    if (source.sharedSessionIds.includes(native ?? '')) flags.push('shared-native-context');
    flags.push('causal-request-to-step-binding-unavailable');
    diagnostics.push({ rowId: row.id, requestKey: row.usage_event_key, flags });
    const excluded = flags.find(flag => ['invalid-or-unresolved-subject', 'foreign-workspace',
      'foreign-or-missing-harness', 'foreign-session', 'outside-event-window'].includes(flag));
    if (excluded) { place(row, 'excluded', excluded); continue; }
    if (eventTime === null || !Number.isSafeInteger(eventTime) || provenance.grain !== 'request' || !row.usage_event_key) {
      place(row, 'missing-time-unknown-grain', 'Request identity, original event time and request grain are required.');
      continue;
    }
    const group = candidates.get(row.usage_event_key) ?? [];
    group.push(row); candidates.set(row.usage_event_key, group);
  }
  for (const group of candidates.values()) {
    if (new Set(group.map(row => observationIdentities.get(row))).size !== 1) {
      group.forEach(row => place(row, 'conflicting', 'Same request identity has incompatible observations.'));
      continue;
    }
    const [first, ...copies] = group;
    const shared = source.sharedSessionIds.includes(first.session_id ?? first.run_id ?? '');
    place(first, 'unallocated-shared', shared ? 'shared-native-context' : 'causal-request-to-step-binding-unavailable');
    selected.push(first);
    copies.forEach(row => place(row, 'duplicate', `Exact observation already represented by ${first.id}.`));
  }
  const subtotal = (values: Array<number | null>, integer = false) => {
    const known = values.filter((value): value is number => value !== null);
    const total = known.reduce((sum, value) => sum + value, 0);
    return { value: known.length && Number.isFinite(total) && (!integer || Number.isSafeInteger(total)) ? total : null,
      observedRecords: known.length, missingRecords: values.length - known.length };
  };
  const costRows = (kind: string) => selected.filter(row => row.cost_source === kind);
  const cost = (kind: string) => subtotal(costRows(kind).map(row => stepNumber(row.cost_usd)));
  const knownExpected = source.expectedRequests.state === 'known' ? [...new Set(source.expectedRequests.keys)].sort() : null;
  const selectedKeys = selected.map(row => row.usage_event_key!).sort();
  const observedKeys = new Set(rows.map(row => row.usage_event_key).filter((key): key is string => !!key));
  const missingExpected = knownExpected?.filter(key => !selectedKeys.includes(key)) ?? [];
  const totalRecords = stepTokens(ledger.totalRecords);
  const snapshotComplete = validScope && ledger.complete && !ledger.error && totalRecords === rows.length &&
    rows.length <= ledger.limit * (ledger.pages ?? 1);
  const residue = totalRecords === null ? null : Math.max(0, totalRecords - rows.length);
  const tokenFields = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'] as const;
  const quantityInvalid = selected.some(row => tokenFields.some(field => row[field] !== null && stepTokens(row[field]) === null) ||
    row.cost_usd !== null && stepNumber(row.cost_usd) === null);
  const quantityOverflow = tokenFields.some(field => !Number.isSafeInteger(
    selected.reduce((sum, row) => sum + (stepTokens(row[field]) ?? 0), 0)));
  const gaps = [
    ...(!validScope ? ['subject-unresolved'] : []),
    ...(!source.complete ? ['source-population-incomplete'] : []),
    ...(source.expectedRequests.state === 'unknown' ? ['expected-request-denominator-unknown'] : []),
    ...(!snapshotComplete ? ['ledger-read-incomplete'] : []),
    ...(ledger.error ? ['ledger-read-failed'] : []),
    ...(missingExpected.length ? ['expected-requests-missing-or-unusable'] : []),
    ...(partitions.conflicting.length ? ['conflicting-request-observations'] : []),
    ...(partitions['missing-time-unknown-grain'].length ? ['unusable-request-observations'] : []),
    ...(quantityInvalid ? ['invalid-quantity-observations'] : []),
    ...(quantityOverflow ? ['token-sum-overflow'] : []),
    'causal-request-to-step-binding-unavailable', 'complete-provider-charge-census-unavailable',
  ];
  return {
    resolverVersion: WORKFLOW_STEP_MEASUREMENT_VERSION,
    source, observations: rows.map(row => stepEvidence(row)), diagnostics,
    inputFingerprint: stepHash({ source, rows, ledger, toolIntervals: input.toolIntervals ?? [] }),
    population: { expectedRequests: source.expectedRequests, expectedUniqueRequests: knownExpected?.length ?? null,
      observedRecords: rows.length, observedUniqueKeys: observedKeys.size, selectedUniqueRequests: selectedKeys.length,
      selectedRequestKeys: selectedKeys, missingExpectedRequestKeys: missingExpected,
      missingLedgerRequestKeys: knownExpected?.filter(key => !observedKeys.has(key)) ?? [],
      unusableExpectedRequestKeys: missingExpected.filter(key => observedKeys.has(key)),
      query: { ...ledger, complete: snapshotComplete }, truncatedResidueRecords: residue },
    partitions,
    totals: { scope: 'observed-selected-native-or-owner-window' as const,
      inputTokens: subtotal(selected.map(row => stepTokens(row.input_tokens)), true),
      outputTokens: subtotal(selected.map(row => stepTokens(row.output_tokens)), true),
      cacheReadTokens: subtotal(selected.map(row => stepTokens(row.cache_read_tokens)), true),
      cacheCreationTokens: subtotal(selected.map(row => stepTokens(row.cache_creation_tokens)), true),
      providerReportedUsd: cost('provider'), estimatedListUsd: cost('estimated'),
      unknownCostSourceRecords: selected.filter(row => !['provider', 'estimated'].includes(row.cost_source ?? '')).length,
      lowerBoundCostRecords: selected.filter(row => row.usage_provenance?.costBound === 'lower').length,
      failedRequestRecords: selected.filter(row => ['failed', 'error', 'interrupted'].includes(String(row.usage_provenance?.outcome))).length },
    time: { windowElapsedMs: validScope ? end - start : null,
      observedToolIntervalUnionMs: unionWorkflowStepIntervals(input.toolIntervals ?? []),
      activeEffortMs: null, queueingMs: null, ownerPauseMs: null, attributableElapsedMs: null },
    exactStepSpendUsd: null, exactStepSpendKnown: false as const,
    efficiency: 'unknown' as const, intrinsicStepValue: 'not-inferred' as const, gaps,
  };
}

const STEP_STAGES = ['workItems', 'calls', 'sessions', 'usage'] as const;
type StepStage = (typeof STEP_STAGES)[number];
type StepCall = { id: string; coord_owner_id: string | null; invoked_at: string;
  duration_ms: number | null; goal_ref: string };
type StepEvidence = { workItems: Array<{ feature_id: string }>; calls: StepCall[];
  sessions: Array<{ session_id: string }>; usage: WorkflowStepUsageRow[] };
type StepCensus = { count: number; highWater: string | null; checksum: string[] };
/** Retained results are recovery hints; SQL revalidates their exact prefix. */
export interface WorkflowStepRecoveryState {
  version: 1; scopeFingerprint: string; generation: string; pageLimit: number;
  census: Record<StepStage, StepCensus>;
  lastKeys: Record<StepStage, string | null>;
  evidence: StepEvidence;
}
export interface WorkflowStepMeasurementInput {
  workspaceId: string; harnessSlug: string; subject: WorkflowStepSubject;
  sql?: ReturnType<typeof getOrgPg>['sql']; maxRows?: number;
  resume?: WorkflowStepRecoveryState;
}
/** Separate finite retention budget; reaching it preserves an incomplete reading. */
const STEP_EVIDENCE_ROW_BUDGET = 100_000;
const stepKey = (stage: StepStage, row: Record<string, unknown>): string =>
  String(row[stage === 'workItems' ? 'feature_id' : stage === 'sessions' ? 'session_id' : 'id']);
const stepKeyOrder = (stage: StepStage, a: string, b: string) =>
  stage === 'calls' || stage === 'usage' ? (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
    : Buffer.compare(Buffer.from(a), Buffer.from(b));

/** One bounded keyset page per stage, with a frozen generation and validated
 * accumulated evidence. Canonical SQL joins resolve the full dependency set;
 * first-page owners/items never silently restrict a later stage's population.
 * Persist recovery.state in the existing result snapshot, then supply it on
 * restart. Changed or unreconstructable sources require explicit resync. */
export async function readWorkflowStepMeasurement(input: WorkflowStepMeasurementInput) {
  const sql = input.sql ?? getOrgPg().sql;
  const limit = input.maxRows ?? WORKFLOW_STEP_MAX_ROWS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKFLOW_STEP_MAX_ROWS ||
      !input.workspaceId.trim() || !input.harnessSlug.trim() || !input.subject.ref.trim() ||
      !Number.isFinite(Date.parse(input.subject.windowStart)) || !Number.isFinite(Date.parse(input.subject.windowEnd)) ||
      Date.parse(input.subject.windowStart) >= Date.parse(input.subject.windowEnd)) throw new Error('invalid workflow step scope');
  const planItem = /^([^:]+):(P-\d+)(?::|$)/.exec(input.subject.ref);
  const source: WorkflowStepSource = { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
    subject: { ...input.subject }, workItemIds: [], nativeSessionIds: [], ownerIds: [], sharedSessionIds: [],
    predicate: 'workspace+harness canonical work item(s) -> event-window goal-stamped agent calls -> owner/native context -> usage snapshot; no causal allocation',
    fingerprint: '', expectedRequests: { state: 'unknown', reason: 'Complete native request history and ingestion frontier are not established by goal-stamped tool calls.' },
    complete: false };
  const runtime = { build: getBuildInfo(), node: process.version };
  const scopeFingerprint = stepHash({ workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
    subject: input.subject, resolverVersion: WORKFLOW_STEP_MEASUREMENT_VERSION });
  let state: WorkflowStepRecoveryState | null = null;
  const finish = (measuredAt: string, status: 'complete' | 'continue' | 'resync-required' | 'incomplete', reason?: string) => {
    // Keep the rejected cursor for diagnosis, but never relabel its unverified
    // observations as a new platform measurement (even a partial one).
    const evidence = (status === 'resync-required' ? null : state?.evidence) ??
      { workItems: [], calls: [], sessions: [], usage: [] };
    source.workItemIds = evidence.workItems.map(row => row.feature_id);
    source.ownerIds = [...new Set(evidence.calls.map(row => row.coord_owner_id).filter((id): id is string => !!id))].sort();
    source.nativeSessionIds = evidence.sessions.map(row => row.session_id);
    source.complete = status === 'complete';
    const sourceEvidence = { workItems: evidence.workItems, calls: evidence.calls, sessions: evidence.sessions };
    source.fingerprint = stepHash({ scopeFingerprint, generation: state?.generation, sourceEvidence });
    const intervals = evidence.calls.flatMap(row => {
      const duration = stepNumber(row.duration_ms), at = Date.parse(row.invoked_at);
      return duration === null || !Number.isFinite(at) ? [] :
        [[at, Math.min(at + duration, Date.parse(input.subject.windowEnd))] as const];
    });
    const result = summarizeWorkflowStepUsage({ source, rows: evidence.usage,
      ledger: { totalRecords: status === 'resync-required' ? null : state?.census.usage.count ?? null, limit, complete: source.complete,
        pages: Math.max(1, Math.ceil(evidence.usage.length / limit)), ...(reason ? { error: reason } : {}) },
      toolIntervals: intervals });
    return { ...result, measuredAt, runtime, provenance: 'platform-computed' as const, sourceEvidence,
      sourceReadLimits: { workItems: evidence.workItems.length, calls: evidence.calls.length,
        sessions: evidence.sessions.length, limit, complete: source.complete },
      recovery: { status, ...(reason ? { reason } : {}), state,
        stages: state ? Object.fromEntries(STEP_STAGES.map(stage => [stage, {
          highWater: state!.census[stage].highWater, lastKey: state!.lastKeys[stage],
          processed: state!.evidence[stage].length, total: state!.census[stage].count,
          complete: (status === 'complete' || status === 'continue') &&
            state!.evidence[stage].length === state!.census[stage].count &&
            state!.lastKeys[stage] === state!.census[stage].highWater,
        }])) : null } };
  };
  try {
    return await sql.begin('isolation level repeatable read read only', async tx => {
      const [clock] = await tx<Array<{ measured_at: string }>>`SELECT transaction_timestamp()::text AS measured_at`;
      const measuredAt = new Date(clock.measured_at).toISOString();
      if (input.resume) {
        const saved = input.resume;
        if (saved.version !== 1 || saved.scopeFingerprint !== scopeFingerprint || saved.pageLimit !== limit ||
            !saved.evidence || !saved.lastKeys || !saved.census ||
            !STEP_STAGES.every(stage => {
              const census = saved.census[stage], key = saved.lastKeys[stage];
              return census && Number.isSafeInteger(census.count) && census.count >= 0 &&
                (census.highWater === null || typeof census.highWater === 'string') &&
                Array.isArray(census.checksum) && census.checksum.length === 2 &&
                census.checksum.every(value => typeof value === 'string') &&
                (key === null || typeof key === 'string') && Array.isArray(saved.evidence[stage]) &&
                saved.evidence[stage].every(row => row && typeof row === 'object');
            }) ||
            STEP_STAGES.reduce((sum, stage) => sum + saved.evidence[stage].length, 0) > STEP_EVIDENCE_ROW_BUDGET) {
          return finish(measuredAt, 'resync-required', 'invalid-recovery-scope-or-budget');
        }
        state = JSON.parse(JSON.stringify(saved)) as WorkflowStepRecoveryState;
        for (const stage of STEP_STAGES) {
          const keys = state.evidence[stage].map(row => stepKey(stage, row as unknown as Record<string, unknown>));
          if (keys.some((key, i) => !key || (stage === 'calls' || stage === 'usage') && !/^\d+$/.test(key) ||
              i > 0 && stepKeyOrder(stage, keys[i - 1], key) >= 0) ||
              state.lastKeys[stage] !== (keys.at(-1) ?? null)) {
            state = null;
            return finish(measuredAt, 'resync-required', 'invalid-recovery-keyset');
          }
        }
      }
      // Census every selected observation, including unconsumed tails. Two
      // independent 64-bit checksum sums plus count avoid unbounded string_agg.
      const observations = tx`WITH work AS (
        SELECT feature_id FROM harness_shared.work_items
        WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
          AND lane IS DISTINCT FROM 'observation'
          AND (feature_id = ${input.subject.ref} OR
            (source_plan_slug = ${planItem?.[1] ?? null} AND ${planItem?.[2] ?? null} = ANY(source_plan_item_ids)))
      ), calls AS (
        SELECT id, coord_owner_id, invoked_at, duration_ms, goal_ref
        FROM harness_shared.tool_invocations
        WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
          AND call_origin = 'agent' AND goal_ref IN (SELECT feature_id FROM work)
          AND invoked_at >= ${input.subject.windowStart}::timestamptz AND invoked_at < ${input.subject.windowEnd}::timestamptz
      ), sessions AS (
        SELECT DISTINCT session_id FROM harness_shared.session_turn_parts
        WHERE workspace_id IN ('default', ${input.workspaceId}) AND owner IN (SELECT coord_owner_id FROM calls)
          AND ts >= ${input.subject.windowStart}::timestamptz AND ts < ${input.subject.windowEnd}::timestamptz
          AND session_id IS NOT NULL
      ), usage AS (
        SELECT id::text, workspace_id, harness_slug, session_id, run_id, usage_event_key, event_ts::text,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_source, usage_provenance
        FROM harness_shared.agent_usage_samples
        WHERE workspace_id = ${input.workspaceId} AND
          (session_id IN (SELECT session_id FROM sessions) OR run_id IN (SELECT session_id FROM sessions)
           OR usage_provenance->>'sessionOwnerId' IN (SELECT coord_owner_id FROM calls))
      ), observations AS (
        SELECT 'workItems'::text AS stage, feature_id AS key, NULL::bigint AS numeric_key, to_jsonb(work) AS value FROM work
        UNION ALL SELECT 'calls', id::text, id, jsonb_build_object('id', id::text,
          'coord_owner_id', coord_owner_id, 'invoked_at', to_char(invoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'duration_ms', duration_ms, 'goal_ref', goal_ref) FROM calls
        UNION ALL SELECT 'sessions', session_id, NULL::bigint, to_jsonb(sessions) FROM sessions
        UNION ALL SELECT 'usage', id, id::bigint, to_jsonb(usage) FROM usage
      )`;
      const lastKeys = state?.lastKeys ?? { workItems: null, calls: null, sessions: null, usage: null };
      const boundaries = STEP_STAGES.map(stage => ({ stage, last_key: lastKeys[stage] }));
      const censusRows = await tx<Array<{ stage: StepStage; count: string; high_water: string | null;
        a: string; b: string; prefix_count: string }>>`${observations}
        SELECT o.stage, count(*)::text AS count,
          CASE WHEN max(numeric_key) IS NOT NULL THEN max(numeric_key)::text ELSE max(key COLLATE "C") END AS high_water,
          sum(('x' || substr(md5(value::text), 1, 16))::bit(64)::bigint)::text AS a,
          sum(('x' || substr(md5(value::text), 17, 16))::bit(64)::bigint)::text AS b,
          count(*) FILTER (WHERE b.last_key IS NOT NULL AND CASE WHEN numeric_key IS NOT NULL
            THEN numeric_key <= b.last_key::bigint ELSE key COLLATE "C" <= b.last_key COLLATE "C" END)::text AS prefix_count
        FROM observations o LEFT JOIN jsonb_to_recordset(${JSON.stringify(boundaries)}::jsonb) AS b(stage text, last_key text)
          ON b.stage = o.stage GROUP BY o.stage`;
      const census = Object.fromEntries(STEP_STAGES.map(stage => {
        const row = censusRows.find(row => row.stage === stage);
        return [stage, { count: Number(row?.count ?? 0), highWater: row?.high_water ?? null,
          checksum: [row?.a ?? '0', row?.b ?? '0'] }];
      })) as Record<StepStage, StepCensus>;
      if (STEP_STAGES.some(stage => !Number.isSafeInteger(census[stage].count))) throw new Error('unsafe-source-population-count');
      const generation = stepHash({ scopeFingerprint, census });
      if (state) {
        if (state.generation !== generation || stepHash(state.census) !== stepHash(census)) {
          return finish(measuredAt, 'resync-required', 'source-generation-changed');
        }
        const retained = STEP_STAGES.flatMap(stage => state!.evidence[stage].map(value => ({
          stage, key: stepKey(stage, value as unknown as Record<string, unknown>), value,
        })));
        const [validation] = await tx<Array<{ errors: string }>>`${observations}
          SELECT count(*)::text AS errors FROM jsonb_to_recordset(${JSON.stringify(retained)}::jsonb) AS r(stage text, key text, value jsonb)
          LEFT JOIN observations o ON o.stage = r.stage AND o.key = r.key
          WHERE o.key IS NULL OR o.value IS DISTINCT FROM r.value`;
        if (Number(validation.errors) !== 0 || STEP_STAGES.some(stage =>
            state!.evidence[stage].length !== Number(censusRows.find(row => row.stage === stage)?.prefix_count ?? 0))) {
          state = null;
          return finish(measuredAt, 'resync-required', 'retained-prefix-does-not-match-source');
        }
      } else {
        state = { version: 1, scopeFingerprint, generation, pageLimit: limit, census,
          lastKeys: { ...lastKeys }, evidence: { workItems: [], calls: [], sessions: [], usage: [] } };
      }
      for (const stage of STEP_STAGES) {
        if (state.evidence[stage].length === census[stage].count) continue;
        const remaining = STEP_EVIDENCE_ROW_BUDGET - STEP_STAGES.reduce((sum, key) => sum + state!.evidence[key].length, 0);
        if (remaining === 0) return finish(measuredAt, 'incomplete', 'evidence-row-budget-exhausted');
        const pageLimit = Math.min(limit, remaining), last = state.lastKeys[stage];
        // Choose the typed predicate before SQL planning: a CASE containing a
        // constant text-key::bigint can fail during constant folding even when
        // its numeric branch would never be selected at execution time.
        const after = last === null ? tx`TRUE` : stage === 'calls' || stage === 'usage'
          ? tx`numeric_key > ${last}::bigint` : tx`key COLLATE "C" > ${last}::text COLLATE "C"`;
        const page = await tx<Array<{ key: string; value: Record<string, unknown> }>>`${observations}
          SELECT key, value FROM observations WHERE stage = ${stage} AND ${after}
          ORDER BY numeric_key, key COLLATE "C" LIMIT ${pageLimit + 1}`;
        const accepted = page.slice(0, pageLimit);
        if (!accepted.length) return finish(measuredAt, 'resync-required', 'keyset-ended-before-census');
        (state.evidence[stage] as unknown[]).push(...accepted.map(row => row.value));
        state.lastKeys[stage] = accepted.at(-1)!.key;
        // Finish dependency identities before exposing downstream observations;
        // an unread canonical tail session is not a foreign usage session.
        if (state.evidence[stage].length < census[stage].count) break;
      }
      const complete = STEP_STAGES.every(stage => state!.evidence[stage].length === census[stage].count &&
        state!.lastKeys[stage] === census[stage].highWater);
      return finish(measuredAt, complete ? 'complete' : 'continue');
    });
  } catch (error) {
    return finish(new Date().toISOString(), input.resume ? 'resync-required' : 'incomplete',
      error instanceof Error ? error.message : String(error));
  }
}
