/** Shared exact-plan admission gate for plans:start and fleet:launch-on-plan. */
import { resolveEffectiveStatusForItems, type PlanItem } from '@papercusp/plan-parser';
import { DEFAULT_CLAIM_SPEC, validateClaimSpec, type ClaimSpec } from '../../scheduler/claim-spec';
import type { ClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { readClaimSpecLaneHealth, type FleetLaneHealth } from '../../fleet/lane-health';
import { listWorkItems, WORK_ITEMS_MAX_LIMIT, type WorkItem } from '../../work-items';
import { getPlanRow, planItemsForRow } from './source';

const ISSUE_KINDS = new Set(['bug', 'change', 'task']);

export function claimableStatesForKinds(kinds: readonly string[]): string[] | undefined {
  return kinds.some((kind) => ISSUE_KINDS.has(kind)) ? ['open'] : undefined;
}

export function buildExactPlanClaimSpec(
  specId: string,
  planSlug: string,
  kinds?: readonly string[],
): ClaimSpec {
  const plan = { field: 'plan' as const, op: '=' as const, value: planSlug };
  const filter = kinds?.length
    ? { all: [plan, { field: 'kind' as const, op: 'in' as const, value: [...kinds] }] }
    : plan;
  const states = kinds?.length ? claimableStatesForKinds(kinds) : undefined;
  return {
    specVersion: '1.0', specId, revision: 1, view: { filter },
    rank: DEFAULT_CLAIM_SPEC.rank, limits: DEFAULT_CLAIM_SPEC.limits,
    ...(states ? { states } : {}),
  };
}

type AdmissionWorkItem = Pick<WorkItem, 'id' | 'family' | 'sourcePlanItemIds' | 'payload'>;
type RootClass = 'dependency' | 'sticky' | 'cycle' | 'dangling' | 'needs-human' | 'non-actionable-status';
export type ExactPlanAdmissionReason =
  | 'ready' | 'plan-not-found' | 'no-actionable-plan-items' | 'promotion-lag'
  | 'duplicate-coverage' | 'lane-unknown' | 'floor-gated' | 'family-disagreement';

export interface ExactPlanAdmission {
  ready: boolean;
  status: 'ready' | 'blocked' | 'refused';
  reason: ExactPlanAdmissionReason;
  plan: string;
  planItems: {
    total: number; actionable: number; actionableIds: string[];
    rootClasses: Record<RootClass, number>;
  };
  promotion: {
    rows: number; byFamily: { feature: number; issue: number };
    coveredActionable: number; missingActionableItemIds: string[];
    duplicateActionable: Array<{ planItemId: string; workItemIds: string[] }>;
    sourceCap: number; sourceCapExhausted: boolean;
  };
  lane: FleetLaneHealth | null;
  message: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function provenanceIds(item: AdmissionWorkItem): string[] {
  if (item.sourcePlanItemIds?.length) return item.sourcePlanItemIds;
  const payload = record(item.payload);
  const stamp = record(payload.plan_item ?? payload.planItem);
  const one = stamp.item_id ?? stamp.itemId ?? stamp.item;
  return typeof one === 'string' && one ? [one] : [];
}

function rootsFor(items: ReturnType<typeof resolveEffectiveStatusForItems>): Record<RootClass, number> {
  const roots: Record<RootClass, number> = {
    dependency: 0, sticky: 0, cycle: 0, dangling: 0, 'needs-human': 0, 'non-actionable-status': 0,
  };
  const cycles = new Set(items.cycleMembers);
  const dangling = new Set(items.missingRefs.map((entry) => entry.itemId));
  for (const item of items.items) {
    if (item.effectiveStatus === 'todo' && item.unresolvedBlockers.length === 0 && !item.needsHuman) continue;
    if (cycles.has(item.id)) roots.cycle++;
    else if (dangling.has(item.id)) roots.dangling++;
    else if (item.needsHuman) roots['needs-human']++;
    else if (item.staleBlockedHint) roots.sticky++;
    else if (item.unresolvedBlockers.length) roots.dependency++;
    else roots['non-actionable-status']++;
  }
  return roots;
}

function finish(
  base: Omit<ExactPlanAdmission, 'ready' | 'status' | 'reason' | 'message'>,
  status: ExactPlanAdmission['status'],
  reason: ExactPlanAdmissionReason,
  message: string,
): ExactPlanAdmission {
  return { ...base, ready: status === 'ready', status, reason, message };
}

/** PURE verdict over one exact plan snapshot, its promoted rows, and lane oracle. */
export function evaluateExactPlanAdmission(args: {
  planSlug: string; planItems: PlanItem[]; workItems: AdmissionWorkItem[];
  laneHealth: FleetLaneHealth | null; sourceCapExhausted?: boolean;
}): ExactPlanAdmission {
  const resolved = resolveEffectiveStatusForItems(args.planItems);
  const actionable = resolved.items.filter(
    (item) => item.effectiveStatus === 'todo' && item.unresolvedBlockers.length === 0 && !item.needsHuman,
  );
  const planIds = new Set(args.planItems.map((item) => item.id));
  const coverage = new Map<string, string[]>();
  const promotedRows = args.workItems.filter((item) => {
    const ids = provenanceIds(item).filter((id) => planIds.has(id));
    for (const id of ids) coverage.set(id, [...(coverage.get(id) ?? []), item.id]);
    return ids.length > 0;
  });
  const missing = actionable.filter((item) => !(coverage.get(item.id)?.length)).map((item) => item.id);
  const duplicate = actionable.flatMap((item) => {
    const ids = coverage.get(item.id) ?? [];
    return ids.length > 1 ? [{ planItemId: item.id, workItemIds: ids }] : [];
  });
  const base = {
    plan: args.planSlug,
    planItems: {
      total: resolved.items.length, actionable: actionable.length,
      actionableIds: actionable.map((item) => item.id), rootClasses: rootsFor(resolved),
    },
    promotion: {
      rows: promotedRows.length,
      byFamily: {
        feature: promotedRows.filter((item) => item.family === 'feature').length,
        issue: promotedRows.filter((item) => item.family === 'issue').length,
      },
      coveredActionable: actionable.length - missing.length,
      missingActionableItemIds: missing,
      duplicateActionable: duplicate,
      sourceCap: WORK_ITEMS_MAX_LIMIT,
      sourceCapExhausted: args.sourceCapExhausted === true,
    },
    lane: args.laneHealth,
  };

  if (!actionable.length) return finish(base, 'blocked', 'no-actionable-plan-items', 'No exact-plan item is actionable; rootClasses explains the blocked DAG.');
  if (args.sourceCapExhausted) return finish(base, 'refused', 'lane-unknown', 'The promoted-row census hit its source cap; exact coverage is unknown.');
  if (missing.length) return finish(base, 'refused', 'promotion-lag', `Actionable plan items lack a promoted row: ${missing.join(', ')}.`);
  if (duplicate.length) return finish(base, 'refused', 'duplicate-coverage', `Actionable plan items have duplicate promoted rows: ${duplicate.map((entry) => entry.planItemId).join(', ')}.`);
  if (!args.laneHealth || args.laneHealth.effective.claimable == null) return finish(base, 'refused', 'lane-unknown', 'The exact-plan claim lane could not be read completely.');

  const needed = new Set(promotedRows.filter((row) => provenanceIds(row).some((id) => actionable.some((item) => item.id === id))).map((row) => row.family));
  const unreachable = (needed.has('feature') && !args.laneHealth.familyReachability.feature)
    || (needed.has('issue') && !args.laneHealth.familyReachability.issue);
  const unknownFamily = (needed.has('feature') && args.laneHealth.featureFamily?.claimable == null);
  if (unknownFamily) return finish(base, 'refused', 'lane-unknown', 'A required claim family returned an unknown count.');
  const featureZero = needed.has('feature') && args.laneHealth.featureFamily?.claimable === 0;
  const issueZero = needed.has('issue') && args.laneHealth.issueFamily.claimable === 0;
  const somePositive = (args.laneHealth.featureFamily?.claimable ?? 0) > 0 || args.laneHealth.issueFamily.claimable > 0;
  if (unreachable || ((featureZero || issueZero) && somePositive)) {
    return finish(base, 'refused', 'family-disagreement', 'Actionable promoted families disagree with the exact-plan lane reachability/counts.');
  }
  if (args.laneHealth.effective.claimable === 0) return finish(base, 'refused', 'floor-gated', 'The exact-plan lane is structurally reachable but every row is excluded by claim floors.');
  return finish(base, 'ready', 'ready', `Exact-plan admission is ready with ${args.laneHealth.effective.claimable} claimable row(s).`);
}

export async function preflightExactPlanAdmission(args: {
  workspaceId: string; harnessSlug: string; planSlug: string; assignee: string;
  specId: string; fleetSlug?: string; claimKinds?: readonly string[];
}): Promise<ExactPlanAdmission> {
  const row = await getPlanRow(args.planSlug, { workspaceId: args.workspaceId, harnessSlug: args.harnessSlug });
  if (!row) {
    const empty = evaluateExactPlanAdmission({ planSlug: args.planSlug, planItems: [], workItems: [], laneHealth: null });
    return { ...empty, reason: 'plan-not-found', status: 'refused', message: `Plan '${args.planSlug}' was not found.` };
  }
  const built = buildExactPlanClaimSpec(args.specId, args.planSlug, args.claimKinds);
  const validation = validateClaimSpec(built);
  if (!validation.ok || !validation.spec) throw new Error(`invalid exact-plan claim spec: ${validation.errors.join('; ')}`);
  const spec = validation.spec;
  const record: ClaimSpecRecord = {
    source: 'fleet', spec, revision: spec.revision, updatedBy: args.assignee, updatedAt: null,
    harnessSlug: args.harnessSlug, fleetSlug: args.fleetSlug ?? `exact-plan:${args.planSlug}`,
  };
  const workItems = await listWorkItems({
    harness: args.harnessSlug, sourcePlanSlug: args.planSlug,
    includeChildren: true, limit: WORK_ITEMS_MAX_LIMIT,
  });
  const laneHealth = await readClaimSpecLaneHealth({
    spec, record, fleet: record.fleetSlug!, harness: args.harnessSlug,
    workspaceId: args.workspaceId, assignee: args.assignee, matchedBy: 'exact-plan-preflight',
  });
  return evaluateExactPlanAdmission({
    planSlug: args.planSlug, planItems: planItemsForRow(row), workItems, laneHealth,
    sourceCapExhausted: workItems.length >= WORK_ITEMS_MAX_LIMIT,
  });
}
