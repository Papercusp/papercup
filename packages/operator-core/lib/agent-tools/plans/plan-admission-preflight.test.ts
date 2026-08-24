import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanItem } from '@papercusp/plan-parser';
import type { FleetLaneHealth } from '../../fleet/lane-health';

const mocks = vi.hoisted(() => ({
  getPlanRow: vi.fn(),
  planItemsForRow: vi.fn(),
  listWorkItems: vi.fn(),
  readClaimSpecLaneHealth: vi.fn(),
}));

vi.mock('./source', () => ({
  getPlanRow: (...args: unknown[]) => mocks.getPlanRow(...args),
  planItemsForRow: (...args: unknown[]) => mocks.planItemsForRow(...args),
}));

vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WORK_ITEMS_MAX_LIMIT: 2_000,
  listWorkItems: (...args: unknown[]) => mocks.listWorkItems(...args),
}));

vi.mock('../../fleet/lane-health', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readClaimSpecLaneHealth: (...args: unknown[]) => mocks.readClaimSpecLaneHealth(...args),
}));

import {
  buildExactPlanClaimSpec,
  evaluateExactPlanAdmission,
  preflightExactPlanAdmission,
} from './plan-admission-preflight';
import { validateClaimSpec } from '../../scheduler/claim-spec';

const item = (
  id: string,
  storedStatus: PlanItem['storedStatus'] = 'todo',
  blockedBy: string[] = [],
): PlanItem => ({
  id,
  text: id,
  storedStatus,
  importance: 'normal',
  blockedBy,
  decisionRefs: [],
  phase: null,
  lineNumber: 1,
  rawLine: `- **${id}** \`${storedStatus}\` ${id}`,
});

const lane = (args: {
  issue?: number;
  issueMatchedByFilter?: number;
  issueExcluded?: Record<string, number>;
  feature?: number | null;
  issueReachable?: boolean;
  featureReachable?: boolean;
}): FleetLaneHealth => {
  const issueReachable = args.issueReachable ?? true;
  const featureReachable = args.featureReachable ?? true;
  const issue = issueReachable ? (args.issue ?? 0) : 0;
  const issueMatchedByFilter = args.issueMatchedByFilter ?? issue;
  const issueExcluded = args.issueExcluded ?? {};
  const feature = featureReachable ? (args.feature ?? 0) : null;
  const mixed = issueReachable && featureReachable;
  return {
    claimable: issue,
    matchedByFilter: issueMatchedByFilter,
    excluded: issueExcluded,
    issueFamily: { claimable: issue, matchedByFilter: issueMatchedByFilter, excluded: issueExcluded },
    featureFamily: featureReachable
      ? { claimable: feature, matchedByFilter: null, excluded: null }
      : null,
    effective: mixed
      ? {
          claimable: feature == null ? null : issue + feature,
          matchedByFilter: null,
          excluded: null,
          basis: 'issue+feature-family',
        }
      : featureReachable
        ? { claimable: feature, matchedByFilter: null, excluded: null, basis: 'feature-family' }
        : issueReachable
          ? {
              claimable: issue,
              matchedByFilter: issueMatchedByFilter,
              excluded: issueExcluded,
              basis: 'issue-family',
            }
          : { claimable: 0, matchedByFilter: 0, excluded: {}, basis: 'no-family' },
    familyReachability: { issue: issueReachable, feature: featureReachable },
    spec: {
      ref: 'exact-plan@1',
      specId: 'exact-plan',
      revision: 1,
      matchedBy: 'test',
      harness: 'papercusp',
      assigneeScoped: 'su-test',
    },
  };
};

describe('evaluateExactPlanAdmission', () => {
  it('admits a feature-only exact-plan lane from feature-family truth', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issueReachable: false, feature: 1 }),
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      promotion: {
        rows: 1,
        byFamily: { feature: 1, issue: 0 },
        coveredActionable: 1,
      },
      lane: { effective: { claimable: 1, basis: 'feature-family' } },
    });
  });

  it('admits an issue-only lane and recognizes the legacy payload.plan_item provenance fallback', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{
        id: 'WI-1',
        family: 'issue',
        sourcePlanItemIds: null,
        payload: { plan_item: { item_id: 'P-001' } },
      }],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    });

    expect(verdict).toMatchObject({
      ready: true,
      reason: 'ready',
      promotion: { byFamily: { feature: 0, issue: 1 }, coveredActionable: 1 },
      lane: { effective: { claimable: 1, basis: 'issue-family' } },
    });
  });

  it('reports a fully blocked DAG with structural root classes instead of treating zero as drained', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001', 'wip'), item('P-002', 'todo', ['P-001'])],
      workItems: [],
      laneHealth: lane({ issue: 0, feature: 0 }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'blocked',
      reason: 'no-actionable-plan-items',
      planItems: {
        actionable: 0,
        rootClasses: { dependency: 1, 'non-actionable-status': 1 },
      },
    });
  });

  it('refuses promotion lag before interpreting the scheduler lane count', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [],
      laneHealth: lane({ issue: 1, feature: 1 }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'promotion-lag',
      promotion: { missingActionableItemIds: ['P-001'] },
    });
  });

  it('D-055: refuses an actionable promoted feature whose post-floor lane is zero', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 0, feature: 0 }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'floor-gated',
      planItems: { actionable: 1 },
      promotion: {
        byFamily: { feature: 1, issue: 0 },
        coveredActionable: 1,
      },
      lane: { effective: { claimable: 0 } },
    });
  });

  it('names the exact-plan filter when it matches no rows instead of blaming claim floors', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 0, featureReachable: false }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain("exact-plan filter (plan = 'plan-a') matches no rows");
    expect(verdict.message).toContain('no row reached the claim floors');
    expect(verdict.message).not.toContain('every row is excluded');
  });

  it('reports internally inconsistent zero-claimable counters instead of inventing a floor cause', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 3,
        issueExcluded: {},
        featureReachable: false,
      }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain('INTERNAL INCONSISTENCY');
    expect(verdict.message).toContain("filter (plan = 'plan-a') matched 3 row(s)");
    expect(verdict.message).toContain('every reported exclusion bucket is zero');
    expect(verdict.message).toContain('do not support a floor-gated diagnosis');
  });

  it('keeps the floor-gated diagnosis when a nonzero exclusion bucket explains the zero', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 3,
        issueExcluded: { claimHold: 3 },
        featureReachable: false,
      }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain('every matched row is excluded by claim floors');
    expect(verdict.message).not.toContain('INTERNAL INCONSISTENCY');
  });

  it('refuses when one actionable promoted family is zero while the other is claimable', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002')],
      workItems: [
        { id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-002'], payload: null },
      ],
      laneHealth: lane({ issue: 1, feature: 0 }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'family-disagreement',
      promotion: { byFamily: { feature: 1, issue: 1 } },
    });
  });

  it('refuses a seat request wider than the executable DAG frontier and names exact blockers', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002', 'todo', ['P-001']), item('P-003', 'todo', ['P-002'])],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 1, featureReachable: false }),
      requestedSeats: 3,
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'insufficient-executable-width',
      requestedSeats: 3,
      executableWidth: 1,
      seatShortfall: 2,
      parallelism: {
        readyWidth: 1,
        readyItemIds: ['P-001'],
        criticalPathDepth: 3,
      },
    });
    expect(verdict.message).toContain('P-002<-P-001(todo)');
    expect(verdict.message).toContain('P-003<-P-002(todo)');
  });

  it('emits held ready rows with their holder and claim time when the executable frontier is narrower', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002')],
      workItems: [
        { id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null },
        {
          id: 'WI-2',
          family: 'issue',
          sourcePlanItemIds: ['P-002'],
          payload: null,
          assignee: 'su-holder',
          takenAt: '2026-08-24T02:10:42.079Z',
        },
      ],
      laneHealth: lane({ issue: 1, featureReachable: false }),
      requestedSeats: 2,
    });

    expect(verdict).toMatchObject({
      ready: false,
      reason: 'insufficient-executable-width',
      parallelism: { readyWidth: 2, readyItemIds: ['P-001', 'P-002'] },
      executableWidth: 1,
      blockingRows: [{
        planItemId: 'P-002',
        workItemId: 'WI-2',
        holder: 'su-holder',
        takenAt: '2026-08-24T02:10:42.079Z',
      }],
    });
    expect(verdict.message).toContain(
      'Held ready rows: P-002->WI-2(holder=su-holder, takenAt=2026-08-24T02:10:42.079Z).',
    );
  });

  it('keeps seat diagnostics optional for existing callers', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    });

    expect(verdict).toMatchObject({
      ready: true,
      requestedSeats: null,
      executableWidth: 1,
      seatShortfall: null,
    });
  });
});

describe('preflightExactPlanAdmission IO wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlanRow.mockResolvedValue({ planSlug: 'plan-a' });
    mocks.planItemsForRow.mockReturnValue([item('P-001')]);
    mocks.listWorkItems.mockResolvedValue([{
      id: 'WI-1',
      family: 'issue',
      sourcePlanItemIds: undefined,
      payload: { planItem: { itemId: 'P-001' } },
    }]);
    mocks.readClaimSpecLaneHealth.mockResolvedValue(lane({ issue: 1, featureReachable: false }));
  });

  it('reads the exact plan census, validates the generated spec, and wires scope into lane health', async () => {
    const verdict = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      assignee: 'su-test',
      specId: 'plans-start-plan-a',
      fleetSlug: 'fleet-a',
      claimKinds: ['bug'],
      requestedSeats: 1,
    });

    expect(verdict).toMatchObject({ ready: true, reason: 'ready' });
    expect(mocks.getPlanRow).toHaveBeenCalledWith('plan-a', {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
    });
    expect(mocks.planItemsForRow).toHaveBeenCalledWith({ planSlug: 'plan-a' });
    expect(mocks.listWorkItems).toHaveBeenCalledWith({
      harness: 'papercusp',
      sourcePlanSlug: 'plan-a',
      includeChildren: true,
      limit: 2_000,
    });
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledWith(expect.objectContaining({
      fleet: 'fleet-a',
      harness: 'papercusp',
      workspaceId: 'ws-1',
      assignee: 'su-test',
      matchedBy: 'exact-plan-preflight',
      spec: expect.objectContaining({ specId: 'plans-start-plan-a', states: ['open'] }),
      record: expect.objectContaining({ fleetSlug: 'fleet-a', harnessSlug: 'papercusp' }),
    }));
    expect(verdict.requestedSeats).toBe(1);
  });

  it('builds a validator-clean plan-only claim spec', () => {
    const spec = buildExactPlanClaimSpec('exact-plan', 'plan-a');
    expect(validateClaimSpec(spec)).toMatchObject({ ok: true });
    expect(spec.view.filter).toEqual({ field: 'plan', op: '=', value: 'plan-a' });
  });
});
