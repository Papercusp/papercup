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
  ledger: { totalRecords: number | null; limit: number; complete: boolean; error?: string };
  toolIntervals?: readonly (readonly [number, number])[];
}) {
  const { source, rows, ledger } = input;
  const start = Date.parse(source.subject.windowStart), end = Date.parse(source.subject.windowEnd);
  const validScope = !!source.workspaceId.trim() && !!source.harnessSlug.trim() && !!source.subject.ref.trim() &&
    Number.isFinite(start) && Number.isFinite(end) && start < end && source.workItemIds.length > 0;
  const partitions = Object.fromEntries(STEP_PARTITIONS.map(key => [key, [] as Array<{
    rowId: string; requestKey: string | null; reason: string;
  }>])) as Record<WorkflowStepPartition, Array<{ rowId: string; requestKey: string | null; reason: string }>>;
  const place = (row: WorkflowStepUsageRow, bucket: WorkflowStepPartition, reason: string) =>
    partitions[bucket].push({ rowId: row.id, requestKey: row.usage_event_key, reason });
  const candidates = new Map<string, WorkflowStepUsageRow[]>();
  const selected: WorkflowStepUsageRow[] = [];
  for (const row of rows) {
    const provenance = row.usage_provenance ?? {};
    const native = row.session_id ?? row.run_id;
    const inNative = native !== null && native !== undefined && source.nativeSessionIds.includes(native);
    const inOwner = typeof provenance.sessionOwnerId === 'string' && source.ownerIds.includes(provenance.sessionOwnerId);
    let excluded = !validScope ? 'invalid-or-unresolved-subject' : row.workspace_id !== source.workspaceId ? 'foreign-workspace' :
      row.harness_slug !== source.harnessSlug ? 'foreign-or-missing-harness' : !inNative && !inOwner ? 'foreign-session' : null;
    const eventTime = stepNumber(row.event_ts);
    if (!excluded && eventTime !== null && (eventTime < start || eventTime >= end)) excluded = 'outside-event-window';
    if (excluded) { place(row, 'excluded', excluded); continue; }
    if (eventTime === null || !Number.isSafeInteger(eventTime) || provenance.grain !== 'request' || !row.usage_event_key) {
      place(row, 'missing-time-unknown-grain', 'Request identity, original event time and request grain are required.');
      continue;
    }
    const group = candidates.get(row.usage_event_key) ?? [];
    group.push(row); candidates.set(row.usage_event_key, group);
  }
  for (const group of candidates.values()) {
    const quantity = (row: WorkflowStepUsageRow) => stepHash({
      session: row.session_id, run: row.run_id ?? null, eventTime: row.event_ts === null ? null : Number(row.event_ts),
      input: row.input_tokens === null ? null : String(row.input_tokens),
      output: row.output_tokens === null ? null : String(row.output_tokens),
      cacheRead: row.cache_read_tokens === null ? null : String(row.cache_read_tokens),
      cacheWrite: row.cache_creation_tokens === null ? null : String(row.cache_creation_tokens),
      cost: row.cost_usd === null ? null : String(row.cost_usd), costSource: row.cost_source,
      costBound: row.usage_provenance?.costBound ?? null,
    });
    if (new Set(group.map(quantity)).size !== 1) {
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
    rows.length <= ledger.limit;
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
    source, observations: rows.map(row => stepEvidence(row)),
    inputFingerprint: stepHash({ source, rows, ledger, toolIntervals: input.toolIntervals ?? [] }),
    population: { expectedRequests: source.expectedRequests, expectedUniqueRequests: knownExpected?.length ?? null,
      observedRecords: rows.length, observedUniqueKeys: observedKeys.size, selectedUniqueRequests: selectedKeys.length,
      selectedRequestKeys: selectedKeys, missingExpectedRequestKeys: missingExpected,
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

/** Resolve canonical work/owner/native predicates and read one repeatable SQL
 * snapshot. There is deliberately no caller-supplied owner, request list, charge
 * completeness bit or per-step allocation. Missing history is an explicit gap. */
export async function readWorkflowStepMeasurement(input: {
  workspaceId: string; harnessSlug: string; subject: WorkflowStepSubject;
  sql?: ReturnType<typeof getOrgPg>['sql']; maxRows?: number;
}) {
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
  try {
    return await sql.begin('isolation level repeatable read read only', async tx => {
      const [clock] = await tx<Array<{ measured_at: string }>>`SELECT transaction_timestamp()::text AS measured_at`;
      const work = await tx<Array<{ feature_id: string }>>`
        SELECT feature_id FROM harness_shared.work_items
        WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
          AND lane IS DISTINCT FROM 'observation'
          AND (feature_id = ${input.subject.ref} OR
            (source_plan_slug = ${planItem?.[1] ?? null} AND ${planItem?.[2] ?? null} = ANY(source_plan_item_ids)))
        ORDER BY feature_id LIMIT ${limit + 1}`;
      source.workItemIds = work.slice(0, limit).map(row => row.feature_id);
      const calls = await tx<Array<{ id: string; coord_owner_id: string | null; invoked_at: Date;
        duration_ms: number | null; goal_ref: string; population_count: string }>>`
        SELECT id::text, coord_owner_id, invoked_at, duration_ms, goal_ref, count(*) OVER ()::text AS population_count
        FROM harness_shared.tool_invocations
        WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
          AND call_origin = 'agent' AND goal_ref = ANY(${source.workItemIds}::text[])
          AND invoked_at >= ${input.subject.windowStart}::timestamptz AND invoked_at < ${input.subject.windowEnd}::timestamptz
        ORDER BY id LIMIT ${limit + 1}`;
      source.ownerIds = [...new Set(calls.slice(0, limit).map(row => row.coord_owner_id).filter((id): id is string => !!id))].sort();
      const sessions = await tx<Array<{ session_id: string }>>`
        SELECT DISTINCT session_id FROM harness_shared.session_turn_parts
        WHERE workspace_id IN ('default', ${input.workspaceId}) AND owner = ANY(${source.ownerIds}::text[])
          AND ts >= ${input.subject.windowStart}::timestamptz AND ts < ${input.subject.windowEnd}::timestamptz
        ORDER BY session_id LIMIT ${limit + 1}`;
      source.nativeSessionIds = sessions.slice(0, limit).map(row => row.session_id);
      const sourceEvidence = { workItems: work, calls: calls.map(row => ({ ...row,
        invoked_at: new Date(row.invoked_at).toISOString() })), sessions };
      source.fingerprint = stepHash({ source, sourceEvidence });
      const rows = await tx<Array<WorkflowStepUsageRow & { population_count: string }>>`
        SELECT id::text, workspace_id, harness_slug, session_id, run_id, usage_event_key, event_ts::text,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_source, usage_provenance,
          count(*) OVER ()::text AS population_count
        FROM harness_shared.agent_usage_samples
        WHERE workspace_id = ${input.workspaceId} AND
          (session_id = ANY(${source.nativeSessionIds}::text[]) OR run_id = ANY(${source.nativeSessionIds}::text[])
           OR usage_provenance->>'sessionOwnerId' = ANY(${source.ownerIds}::text[]))
        ORDER BY id LIMIT ${limit + 1}`;
      const totalRecords = rows.length ? Number(rows[0].population_count) : 0;
      const complete = work.length <= limit && calls.length <= limit && sessions.length <= limit &&
        rows.length <= limit && rows.every(row => Number(row.population_count) === totalRecords);
      const toolIntervals = calls.slice(0, limit).flatMap(row => {
        const duration = stepNumber(row.duration_ms), at = new Date(row.invoked_at).getTime();
        return duration === null || !Number.isFinite(at) ? [] : [[at, Math.min(at + duration, Date.parse(input.subject.windowEnd))] as const];
      });
      const result = summarizeWorkflowStepUsage({ source, rows: rows.slice(0, limit),
        ledger: { totalRecords, limit, complete }, toolIntervals });
      return { ...result, measuredAt: new Date(clock.measured_at).toISOString(), runtime,
        provenance: 'platform-computed' as const, sourceEvidence,
        sourceReadLimits: { workItems: work.length, calls: calls.length, sessions: sessions.length, limit, complete } };
    });
  } catch (error) {
    source.fingerprint ||= stepHash(source);
    return { ...summarizeWorkflowStepUsage({ source, rows: [], ledger: {
      totalRecords: null, limit, complete: false, error: error instanceof Error ? error.message : String(error) } }),
      measuredAt: new Date().toISOString(), runtime, provenance: 'platform-computed' as const,
      sourceEvidence: null,
      sourceReadLimits: { workItems: null, calls: null, sessions: null, limit, complete: false } };
  }
}
