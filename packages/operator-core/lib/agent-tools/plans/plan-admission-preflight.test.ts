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
  feature?: number | null;
  issueReachable?: boolean;
  featureReachable?: boolean;
}): FleetLaneHealth => {
  const issueReachable = args.issueReachable ?? true;
  const featureReachable = args.featureReachable ?? true;
  const issue = issueReachable ? (args.issue ?? 0) : 0;
  const feature = featureReachable ? (args.feature ?? 0) : null;
  const mixed = issueReachable && featureReachable;
  return {
    claimable: issue,
    matchedByFilter: issue,
    excluded: {},
    issueFamily: { claimable: issue, matchedByFilter: issue, excluded: {} },
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
          ? { claimable: issue, matchedByFilter: issue, excluded: {}, basis: 'issue-family' }
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
  });

  it('builds a validator-clean plan-only claim spec', () => {
    const spec = buildExactPlanClaimSpec('exact-plan', 'plan-a');
    expect(validateClaimSpec(spec)).toMatchObject({ ok: true });
    expect(spec.view.filter).toEqual({ field: 'plan', op: '=', value: 'plan-a' });
  });
});
