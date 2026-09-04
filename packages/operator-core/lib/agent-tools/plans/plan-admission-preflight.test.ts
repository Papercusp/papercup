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

const item = (id: string, storedStatus: PlanItem['storedStatus'] = 'todo', blockedBy: string[] = []): PlanItem => ({
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
  featureMatchedByFilter?: number | null;
  featureExcluded?: Record<string, number> | null;
  issueReachable?: boolean;
  featureReachable?: boolean;
  assigneeScoped?: string | null;
}): FleetLaneHealth => {
  const issueReachable = args.issueReachable ?? true;
  const featureReachable = args.featureReachable ?? true;
  const issue = issueReachable ? (args.issue ?? 0) : 0;
  const issueMatchedByFilter = args.issueMatchedByFilter ?? issue;
  const issueExcluded = args.issueExcluded ?? {};
  const feature = featureReachable ? (args.feature ?? 0) : null;
  const featureMatchedByFilter = args.featureMatchedByFilter ?? null;
  const featureExcluded = args.featureExcluded ?? null;
  const mixed = issueReachable && featureReachable;
  return {
    claimable: issue,
    matchedByFilter: issueMatchedByFilter,
    excluded: issueExcluded,
    issueFamily: { claimable: issue, matchedByFilter: issueMatchedByFilter, excluded: issueExcluded },
    featureFamily: featureReachable
      ? { claimable: feature, matchedByFilter: featureMatchedByFilter, excluded: featureExcluded }
      : null,
    effective: mixed
      ? {
          claimable: feature == null ? null : issue + feature,
          matchedByFilter: featureMatchedByFilter == null ? null : issueMatchedByFilter + featureMatchedByFilter,
          excluded: featureExcluded == null ? null : { ...issueExcluded, ...featureExcluded },
          basis: 'issue+feature-family',
        }
      : featureReachable
        ? { claimable: feature, matchedByFilter: featureMatchedByFilter, excluded: featureExcluded, basis: 'feature-family' }
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
      assigneeScoped: args.assigneeScoped === undefined ? 'su-test' : args.assigneeScoped,
    },
  };
};

describe('evaluateExactPlanAdmission', () => {
  it('surfaces probable-mistake findings without changing an otherwise ready verdict', () => {
    const planItems = [
      item('P-001'),
      item('P-002', 'todo', ['P-001']),
      item('P-003', 'todo', ['P-002']),
    ];
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems,
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    });

    expect(verdict.status).toBe('ready');
    expect(verdict.findings).toContainEqual(expect.objectContaining({ code: 'narrow-or-deep-topology' }));
  });
  it('ignores terminal historical promotions when checking duplicate actionable coverage', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [
        {
          id: 'WI-live',
          family: 'issue',
          state: 'open',
          sourcePlanItemIds: ['P-001'],
          payload: null,
        },
        {
          id: 'WI-dropped',
          family: 'issue',
          state: 'dropped',
          sourcePlanItemIds: ['P-001'],
          payload: null,
        },
      ],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      promotion: {
        rows: 2,
        coveredActionable: 1,
        duplicateActionable: [],
      },
    });
  });

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
      workItems: [
        {
          id: 'WI-1',
          family: 'issue',
          sourcePlanItemIds: null,
          payload: { plan_item: { item_id: 'P-001' } },
        },
      ],
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

  it('D-055: refuses an actionable promoted feature without inventing a floor diagnosis', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 0, feature: 0 }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'floor-diagnostics-unavailable',
      planItems: { actionable: 1 },
      promotion: {
        byFamily: { feature: 1, issue: 0 },
        coveredActionable: 1,
      },
      lane: { effective: { claimable: 0 } },
    });
    expect(verdict.message).toContain('diagnostics do not expose matched-row or exclusion-floor counts');
    expect(verdict.message).toContain('cannot identify whether the filter matched rows or which claim floor excluded them');
    expect(verdict.message).not.toContain('every matched row is excluded by claim floors');
  });

  it('names the feature-family reservation floor when exact-plan diagnostics measure it', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issueReachable: false,
        feature: 0,
        featureMatchedByFilter: 2,
        featureExcluded: { claimFloors: 2, reservedPlanLane: 2 },
      }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'floor-gated',
      lane: { effective: { claimable: 0, matchedByFilter: 2, excluded: { claimFloors: 2, reservedPlanLane: 2 } } },
    });
    expect(verdict.message).toContain('claimFloors=2');
    expect(verdict.message).toContain('reservedPlanLane=2');
    expect(verdict.message).not.toContain('diagnostics do not expose');
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
    expect(verdict.message).toContain("claimant scope 'su-test'");
    expect(verdict.message).toContain('every matched row is excluded by claim floors');
    expect(verdict.message).not.toContain('INTERNAL INCONSISTENCY');
  });

  it('names the caller-neutral population when fleet-wide floors exclude every row', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 1,
        issueExcluded: { claimHold: 1 },
        featureReachable: false,
        assigneeScoped: null,
      }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain('the caller-neutral fleet population');
    expect(verdict.message).toContain('every matched row is excluded by claim floors');
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

  it('admits a capacity-satisfied seat request when the other promoted family is zero', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002')],
      workItems: [
        { id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-002'], payload: null },
      ],
      laneHealth: lane({ issue: 0, feature: 1 }),
      requestedSeats: 1,
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      requestedSeats: 1,
      executableWidth: 1,
      seatShortfall: 0,
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
      blockingRows: [
        {
          planItemId: 'P-002',
          workItemId: 'WI-2',
          holder: 'su-holder',
          takenAt: '2026-08-24T02:10:42.079Z',
        },
      ],
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

  it('admits plans:start when the caller already holds every actionable ready row', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [
        {
          id: 'WI-1',
          family: 'issue',
          sourcePlanItemIds: ['P-001'],
          payload: null,
          assignee: 'su-caller',
          takenAt: '2026-08-24T02:10:42.079Z',
        },
      ],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 1,
        issueExcluded: { taken: 1 },
        featureReachable: false,
      }),
      assignee: 'su-caller',
      allowCallerHeld: true,
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      executableWidth: 0,
      blockingRows: [
        {
          planItemId: 'P-001',
          workItemId: 'WI-1',
          holder: 'su-caller',
        },
      ],
    });
    expect(verdict.message).toContain('caller already holds all 1 actionable ready row(s)');
  });

  it('does not let plans:start bypass a row held by another caller', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [
        {
          id: 'WI-1',
          family: 'issue',
          sourcePlanItemIds: ['P-001'],
          payload: null,
          assignee: 'su-other',
          takenAt: '2026-08-24T02:10:42.079Z',
        },
      ],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 1,
        issueExcluded: { taken: 1 },
        featureReachable: false,
      }),
      assignee: 'su-caller',
      allowCallerHeld: true,
    });

    expect(verdict).toMatchObject({ ready: false, reason: 'floor-gated' });
  });
});

describe('preflightExactPlanAdmission IO wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlanRow.mockResolvedValue({ planSlug: 'plan-a' });
    mocks.planItemsForRow.mockReturnValue([item('P-001')]);
    mocks.listWorkItems.mockResolvedValue([
      {
        id: 'WI-1',
        family: 'issue',
        sourcePlanItemIds: undefined,
        payload: { planItem: { itemId: 'P-001' } },
      },
    ]);
    mocks.readClaimSpecLaneHealth.mockResolvedValue(lane({ issue: 1, featureReachable: false }));
  });

  it('reads the exact plan census, validates the generated spec, and wires scope into lane health', async () => {
    const verdict = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
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
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        fleet: 'fleet-a',
        harness: 'papercusp',
        workspaceId: 'ws-1',
        assignee: 'su-test',
        matchedBy: 'exact-plan-preflight',
        spec: expect.objectContaining({ specId: 'plans-start-plan-a', states: ['open'] }),
        record: expect.objectContaining({ fleetSlug: 'fleet-a', harnessSlug: 'papercusp' }),
      }),
    );
    expect(verdict.requestedSeats).toBe(1);
  });

  it('keeps a released ready row launchable by omitting the leader from the fleet population read', async () => {
    mocks.readClaimSpecLaneHealth.mockImplementationOnce(async (args: { assignee?: string }) =>
      args.assignee
        ? lane({ issue: 0, issueMatchedByFilter: 1, issueExcluded: { cooldown: 1 }, featureReachable: false })
        : lane({ issue: 1, issueMatchedByFilter: 1, featureReachable: false, assigneeScoped: null }),
    );

    const verdict = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-leader',
      specId: 'fleet-launch-fleet-a-plan',
      fleetSlug: 'fleet-a',
      requestedSeats: 1,
    });

    expect(verdict).toMatchObject({ ready: true, reason: 'ready', executableWidth: 1 });
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledWith(
      expect.objectContaining({ assignee: undefined, fleet: 'fleet-a' }),
    );
    expect(mocks.readClaimSpecLaneHealth.mock.calls[0][0].record).toEqual(
      expect.objectContaining({ updatedBy: 'su-leader' }),
    );
  });

  it('builds a validator-clean plan-only claim spec', () => {
    const spec = buildExactPlanClaimSpec('exact-plan', 'plan-a');
    expect(validateClaimSpec(spec)).toMatchObject({ ok: true });
    expect(spec.view.filter).toEqual({ field: 'plan', op: '=', value: 'plan-a' });
  });
});
