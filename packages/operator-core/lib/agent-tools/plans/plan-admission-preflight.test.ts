import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanItem } from '@papercusp/plan-parser';
import type { FleetLaneHealth } from '../../fleet/lane-health';

const mocks = vi.hoisted(() => ({
  getPlanRow: vi.fn(),
  planItemsForRow: vi.fn(),
  listWorkItems: vi.fn(),
  readClaimSpecLaneHealth: vi.fn(),
  readPlanLineNodes: vi.fn(),
  readPlanLineWorkItemRefs: vi.fn(),
  sql: vi.fn(() => { throw new Error('unit SQL must be mocked at the reader seam'); }),
}));

vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: mocks.sql }),
}));

vi.mock('./source', () => ({
  getPlanRow: (...args: unknown[]) => mocks.getPlanRow(...args),
  planItemsForRow: (...args: unknown[]) => mocks.planItemsForRow(...args),
}));

vi.mock('./plan-line-graph', () => ({
  readPlanLineNodes: (...args: unknown[]) => mocks.readPlanLineNodes(...args),
  readPlanLineWorkItemRefs: (...args: unknown[]) => mocks.readPlanLineWorkItemRefs(...args),
}));

vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WORK_ITEMS_MAX_LIMIT: 2_000,
  listWorkItems: (...args: unknown[]) => mocks.listWorkItems(...args),
}));

vi.mock('../../fleet/lane-health', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readClaimSpecLaneHealth: (...args: unknown[]) => mocks.readClaimSpecLaneHealth(...args),
  // The real diagnosed reader calls the raw reader through a module-internal
  // binding the mock above cannot intercept, so route it through the same mock
  // with the real wrapper's contract: exact read → unavailable:null; null or a
  // thrown read → laneHealth as read plus a detail naming the cause.
  readClaimSpecLaneHealthDiagnosed: async (args: Record<string, unknown>) => {
    try {
      const laneHealth = (await mocks.readClaimSpecLaneHealth(args)) as FleetLaneHealth | null;
      if (laneHealth?.effective.claimable != null) return { laneHealth, unavailable: null };
      return { laneHealth, unavailable: { code: 'lane-health-unavailable', detail: 'no exact measurement' } };
    } catch (error) {
      return {
        laneHealth: null,
        unavailable: { code: 'lane-health-unavailable', detail: `Cause: ${(error as Error).message}` },
      };
    }
  },
}));

import {
  buildExactPlanClaimSpec,
  deriveExactPlanClaimKinds,
  evaluateExactPlanAdmission,
  liftMigrationParkedCoverage,
  preflightExactPlanLaneHealth,
  preflightExactPlanAdmission,
} from './plan-admission-preflight';
import { validateClaimSpec } from '../../scheduler/claim-spec';
import { stopTheLineExplanation } from '../../work-items-admission';
import { ISSUE_FAMILY_KINDS } from '../../work-items';

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

beforeEach(() => {
  mocks.readPlanLineWorkItemRefs.mockReset().mockImplementation(async (_tx, scope) =>
    scope.workItemIds.map((workItemId: string) => ({ workItemId, planSlug: null, planItemId: null })));
});

describe('evaluateExactPlanAdmission', () => {
  it('counts a canonically adopted issue without legacy promotion stamps', () => {
    expect(evaluateExactPlanAdmission({ planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [{ id: 'EI-adopted', family: 'issue', sourcePlanItemIds: null, payload: {},
        canonicalPlanSlug: 'plan-a', canonicalPlanItemId: 'P-001' }],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    })).toMatchObject({ ready: true, actionableRows: [{ planItemId: 'P-001', workItemId: 'EI-adopted' }] });
  });

  it.each([
    ['different-plan', 'P-001'], ['plan-a', 'P-999'], ['plan-a', null], [null, 'P-001'],
  ])('rejects contradictory canonical coverage %s#%s despite matching legacy stamps', (plan, line) => {
    expect(evaluateExactPlanAdmission({ planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [{ id: 'EI-adopted', family: 'issue', sourcePlanItemIds: ['P-001'],
        payload: { plan_item: { plan_slug: 'plan-a', item_id: 'P-001' } },
        canonicalPlanSlug: plan, canonicalPlanItemId: line }],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    })).toMatchObject({ ready: false, reason: 'promotion-lag' });
  });
  it('replays the migrated P536 rows as one canonical execution lane on resume', () => {
    // Physical topology read from WI-6554700010037375 and WI-6554700010026007
    // on 2026-11-07. Only plan readiness/lane availability are simulated: this
    // unit replay does not reopen the real blocked P536 or admit its native run.
    const execution = { id: 'WI-6554700010026007', family: 'issue' as const,
      state: 'open', parent: 'WI-6554700010037375', sourcePlanItemIds: ['P-536'],
      payload: { plan_item: { item_id: 'P-536', plan_slug: 'p2p-public-release-endgame-2026-09-01', harness_slug: 'papercusp' } } };
    const shadow = { id: 'WI-6554700010037375', family: 'feature' as const,
      state: 'blocked', sourcePlanItemIds: ['P-536'],
      payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } };
    const replay = (workItems: Array<typeof execution | typeof shadow>) => evaluateExactPlanAdmission({
      planSlug: 'p2p-public-release-endgame-2026-09-01', planItems: [item('P-536')],
      workItems, laneHealth: lane({ issue: 1, feature: 0 }),
    });
    const canonical = [{ planItemId: 'P-536', workItemId: execution.id }];

    expect(replay([execution])).toMatchObject({ ready: true, actionableRows: canonical });
    expect(replay([shadow, execution])).toMatchObject({ ready: true,
      promotion: { rows: 2, duplicateActionable: [], missingActionableItemIds: [] }, actionableRows: canonical });
    expect(replay([shadow])).toMatchObject({ ready: false, reason: 'promotion-lag',
      promotion: { missingActionableItemIds: ['P-536'] } });
    // A real second execution row must still be rejected; migration metadata
    // exempts only the parked shadow, not arbitrary duplicate work.
    expect(replay([shadow, execution, { ...execution, id: 'WI-competing', parent: 'WI-unrelated' }]))
      .toMatchObject({ ready: false, reason: 'duplicate-coverage', promotion: {
        duplicateActionable: [{ planItemId: 'P-536', workItemIds: [execution.id, 'WI-competing'] }],
      } });
  });

  it('counts reconciled live parent and child coverage as one execution lane', () => {
    const result = evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [
        { id: 'WI-node', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-legacy', family: 'issue', state: 'open', parent: 'WI-node', sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ feature: 1, issue: 0 }),
    });
    expect(result).toMatchObject({ ready: true, promotion: { rows: 2, duplicateActionable: [] },
      actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-node' }] });
  });

  it('retains an unfinished child when its parent is settled', () => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [
        { id: 'WI-node', family: 'feature', state: 'done', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-residue', family: 'issue', state: 'open', parent: 'WI-node', sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ issue: 1 }),
    })).toMatchObject({ ready: true,
      actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-residue' }] });
  });

  it('still rejects unrelated competing rows even when one has a parent', () => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001'), item('P-002')],
      workItems: [
        { id: 'WI-node', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-other', family: 'feature', sourcePlanItemIds: ['P-002'], payload: null },
        { id: 'WI-competing', family: 'issue', parent: 'WI-other', sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ feature: 2, issue: 1 }),
    })).toMatchObject({ ready: false, reason: 'duplicate-coverage', promotion: {
      duplicateActionable: [{ planItemId: 'P-001', workItemIds: ['WI-node', 'WI-competing'] }],
    } });
  });

  it('checks only targeted coverage while resolving dependencies against the whole plan', () => {
    const args = {
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002'), item('P-003', 'todo', ['P-004']), item('P-004', 'done')],
      workItems: [
        { id: 'WI-1a', family: 'issue' as const, sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-1b', family: 'issue' as const, sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-3', family: 'issue' as const, sourcePlanItemIds: ['P-003'], payload: null },
      ],
      laneHealth: lane({ issue: 1, featureReachable: false }),
      requestedSeats: 1,
    };
    expect(evaluateExactPlanAdmission({ ...args, planItemIds: ['P-003'] })).toMatchObject({
      ready: true, promotion: { duplicateActionable: [], missingActionableItemIds: [] },
      parallelism: { readyWidth: 1, readyItemIds: ['P-003'] },
    });
    expect(evaluateExactPlanAdmission({ ...args, planItemIds: ['P-001'] })).toMatchObject({
      ready: false, reason: 'duplicate-coverage',
    });
    expect(evaluateExactPlanAdmission({ ...args, planItems: args.planItems.map((row) =>
      row.id === 'P-004' ? item('P-004', 'wip') : row), planItemIds: ['P-003'] })).toMatchObject({
      ready: false, reason: 'no-actionable-plan-items',
      parallelism: { nonReadyItems: [{ itemId: 'P-003', blockerIds: ['P-004'] }] },
    });
  });

  it('refuses unknown item targets and preserves whole-plan admission by default', () => {
    const args = { planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [], laneHealth: null };
    expect(evaluateExactPlanAdmission({ ...args, planItemIds: ['P-999'] })).toMatchObject({
      ready: false, reason: 'invalid-plan-item-scope',
    });
    expect(evaluateExactPlanAdmission(args)).toMatchObject({ ready: false, reason: 'promotion-lag' });
  });

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

  it.each([undefined, 'WI-shadow'])('ignores a parked migration node beside its execution row (parent=%s)', (parent) => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [
        { id: 'WI-shadow', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'],
          payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } },
        { id: 'WI-execution', family: 'issue', state: 'open', parent, sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ issue: 1, feature: 0 }),
    });

    expect(verdict).toMatchObject({ ready: true, reason: 'ready',
      promotion: { rows: 2, byFamily: { feature: 1, issue: 1 }, duplicateActionable: [] },
      actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-execution' }] });
    expect(verdict.claimKinds).toEqual([...ISSUE_FAMILY_KINDS]);
  });

  it.each([
    { _claimHold: false, claim_hold_by: 'migration:plan-line-work-item-nodes' },
    { _claimHold: true, claim_hold_by: 'su-reviewer' },
  ])('still rejects an actual competing row with hold metadata %j', (payload) => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [
        { id: 'WI-other', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'], payload },
        { id: 'WI-execution', family: 'issue', state: 'open', sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ issue: 1, feature: 0 }),
    })).toMatchObject({ ready: false, reason: 'duplicate-coverage', promotion: {
      duplicateActionable: [{ planItemId: 'P-001', workItemIds: ['WI-other', 'WI-execution'] }],
    } });
  });

  it('does not admit a plan whose only coverage is a parked migration node', () => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [{ id: 'WI-shadow', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'],
        payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } }],
      laneHealth: lane({ issue: 0, feature: 0, featureMatchedByFilter: 1, featureExcluded: { claimHold: 1 } }),
    })).toMatchObject({ ready: false, promotion: { rows: 1 } });
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

  it('derives a family lane only from active promoted rows and preserves mixed-family plans', () => {
    expect(
      deriveExactPlanClaimKinds([
        { family: 'issue', state: 'open' },
        { family: 'issue', state: 'done' },
      ]),
    ).toEqual(ISSUE_FAMILY_KINDS);
    expect(
      deriveExactPlanClaimKinds([
        { family: 'issue', state: 'open' },
        { family: 'feature', state: 'open' },
      ]),
    ).toBeUndefined();
    expect(deriveExactPlanClaimKinds([{ family: 'feature', state: 'done' }])).toBeUndefined();
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
    expect(verdict.actionableRows).toEqual([{ planItemId: 'P-001', workItemId: 'F-1' }]);
  });

  it('explains an all-match stop-the-line block and gives the by-ID plan-start route', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issueReachable: false,
        feature: 0,
        featureMatchedByFilter: 3,
        featureExcluded: { claimFloors: 3, reservedPlanLane: 0, stopTheLine: 3 },
      }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain('stopTheLine=3');
    expect(verdict.message).toContain(stopTheLineExplanation('papercusp'));
    expect(verdict.message).toContain('work_items:claim');
    expect(verdict.message).toContain('claim otherwise-ready rows by ID');
    expect(verdict.message).toContain('plans:start accepts rows already held by this caller');

    const partial = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issueReachable: false,
        feature: 0,
        featureMatchedByFilter: 3,
        featureExcluded: { claimFloors: 3, reservedPlanLane: 0, stopTheLine: 2 },
      }),
    });
    expect(partial.message).toContain('stopTheLine=2');
    expect(partial.message).not.toContain(stopTheLineExplanation('papercusp'));
  });

  it('keeps caller-held plan-start recovery out of a new-member fleet launch', () => {
    const common = {
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature' as const, sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issueReachable: false, feature: 0, featureMatchedByFilter: 1,
        featureExcluded: { claimFloors: 1, stopTheLine: 1 } }),
    };
    const launch = evaluateExactPlanAdmission({ ...common, requestedSeats: 1 });
    expect(launch).toMatchObject({ ready: false, reason: 'floor-gated' });
    expect(launch.message).toContain('Launching new fleet members requires rows those members can claim');
    expect(launch.message).toContain('Claiming a row for the leader does not satisfy this launch');
    expect(launch.message).not.toContain('then retry plans:start');

    const held = { ...common, assignee: 'leader', allowCallerHeld: true,
      workItems: [{ ...common.workItems[0], assignee: 'leader', state: 'open' as const }],
      laneHealth: lane({ issueReachable: false, feature: 0, featureMatchedByFilter: 1,
        featureExcluded: { claimFloors: 1, taken: 1 } }),
    };
    expect(evaluateExactPlanAdmission({ ...held, requestedSeats: 1 })).toMatchObject({
      ready: false, reason: 'floor-gated', executableWidth: 0,
    });
    expect(evaluateExactPlanAdmission(held)).toMatchObject({ ready: true });
  });

  it("WI-6554700010048902: admits plans:start when a live member of the caller's fleet holds the sole ready row", () => {
    const common = {
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature' as const, sourcePlanItemIds: ['P-001'], payload: null,
        assignee: 'member-1', state: 'open' as const }],
      laneHealth: lane({ issueReachable: false, feature: 0, featureMatchedByFilter: 1,
        featureExcluded: { claimFloors: 1, taken: 1, stopTheLine: 1 } }),
      assignee: 'leader', allowCallerHeld: true,
    };
    // Without the roster the leader sees the member's claim as a floor-gated lane (the observed refusal).
    expect(evaluateExactPlanAdmission(common)).toMatchObject({ ready: false, reason: 'floor-gated' });
    const teamed = evaluateExactPlanAdmission({ ...common, teamAssignees: ['member-1'] });
    expect(teamed).toMatchObject({ ready: true, reason: 'ready' });
    expect(teamed.message).toContain("live member(s) of the caller's fleet count as the caller's: member-1");
    // A holder outside the caller's fleet is still a competing claim.
    expect(evaluateExactPlanAdmission({ ...common, teamAssignees: ['someone-else'] }))
      .toMatchObject({ ready: false, reason: 'floor-gated' });
    // A seat-sized fleet launch still needs rows NEW members can claim.
    expect(evaluateExactPlanAdmission({ ...common, teamAssignees: ['member-1'], requestedSeats: 1 }))
      .toMatchObject({ ready: false });
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

  it('counts assigned WIP lanes as occupied width for a wider target request', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [
        item('P-028'),
        item('P-029', 'wip'),
        item('P-030', 'wip'),
        item('P-037', 'wip'),
        item('P-038'),
        item('P-039'),
      ],
      workItems: [
        { id: 'WI-028', family: 'issue', sourcePlanItemIds: ['P-028'], payload: null },
        {
          id: 'WI-029',
          family: 'issue',
          sourcePlanItemIds: ['P-029'],
          payload: null,
          assignee: 'su-live-1',
        },
        {
          id: 'WI-030',
          family: 'issue',
          sourcePlanItemIds: ['P-030'],
          payload: null,
          assignee: 'su-live-2',
        },
        {
          id: 'WI-037',
          family: 'issue',
          sourcePlanItemIds: ['P-037'],
          payload: null,
          assignee: 'su-live-3',
        },
        { id: 'WI-038', family: 'issue', sourcePlanItemIds: ['P-038'], payload: null },
        { id: 'WI-039', family: 'issue', sourcePlanItemIds: ['P-039'], payload: null },
      ],
      laneHealth: lane({ issue: 3, featureReachable: false }),
      requestedSeats: 4,
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      requestedSeats: 4,
      occupiedWidth: 3,
      executableWidth: 6,
      seatShortfall: 0,
    });
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

  it.each(['open', 'wip'])('admits an unstamped held %s direct child without changing parent coverage or inputs', (state) => {
    const parent = { id: 'WI-direct-parent', family: 'feature' as const, state: 'open',
      assignee: null, sourcePlanItemIds: ['P-001'],
      payload: { plan_item: { plan_slug: 'plan-a', item_id: 'P-001' } } };
    const child = { id: 'WI-unstamped-child', family: 'issue' as const, state,
      assignee: 'su-caller', parent: parent.id, sourcePlanItemIds: undefined, payload: {} };
    const workItems = [parent, child];
    const before = JSON.stringify(workItems);

    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001')], workItems,
      laneHealth: lane({ issue: 0, feature: 0, issueMatchedByFilter: 0,
        featureMatchedByFilter: 1, featureExcluded: { stopTheLine: 1 } }),
      assignee: 'su-caller', allowCallerHeld: true,
    });

    expect(JSON.stringify(workItems)).toBe(before);
    expect(child.sourcePlanItemIds).toBeUndefined();
    expect(child.payload).toEqual({});
    expect(verdict).toMatchObject({ ready: true, reason: 'ready', executableWidth: 0,
      promotion: { rows: 1, coveredActionable: 1, duplicateActionable: [] },
      actionableRows: [{ planItemId: 'P-001', workItemId: parent.id }] });
  });

  it.each([
    { label: 'missing child', missingChild: true },
    { label: 'foreign custody', child: { assignee: 'su-other' } },
    { label: 'unclaimed child', child: { assignee: null } },
    { label: 'unrelated child', child: { parent: 'WI-unrelated' } },
    { label: 'settled child', child: { state: 'done' } },
    { label: 'blocked child', child: { state: 'blocked' } },
    { label: 'parked child', child: { payload: { _claimHold: true } } },
    { label: 'human-action child', child: { payload: { needsHuman: true } } },
    { label: 'active external human blocker', child: { payload: { externalBlockers: [{ kind: 'human',
      ref: 'approval', summary: 'Needs approval', status: 'active', createdBy: 'owner',
      createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z' }] } } },
    { label: 'malformed active blocker', child: { payload: { externalBlockers: [{ status: 'active' }] } } },
    { label: 'stamped child', child: { sourcePlanItemIds: ['P-002'] } },
    { label: 'legacy stamped child', child: { payload: { planItem: {} } } },
    { label: 'foreign source child', child: { sourcePlanSlug: 'plan-other' } },
    { label: 'foreign harness child', child: { harness: 'other' } },
    { label: 'missing parent', missingParent: true },
    { label: 'wrong-plan parent', parent: { sourcePlanSlug: 'plan-other' } },
    { label: 'foreign-held parent', parent: { assignee: 'su-other' } },
    { label: 'parked parent', parent: { payload: { _claimHold: true } } },
    { label: 'settled parent', parent: { state: 'done' } },
    { label: 'unknown parent state', parent: { state: undefined } },
    { label: 'cyclic ancestry', parent: { parent: 'WI-unstamped-child' } },
    { label: 'incomplete ancestry', parent: { parent: 'WI-unknown-ancestor' } },
    { label: 'invalid target scope', planItemIds: ['P-404'] },
    { label: 'blocked DAG', blockedDag: true, planItemIds: ['P-001'] },
    { label: 'incomplete plan census', sourceCapExhausted: true },
    { label: 'new fleet seats', requestedSeats: 1 },
    { label: 'caller-neutral launch', allowCallerHeld: false },
  ] as Array<{ label: string; child?: Record<string, unknown>; parent?: Record<string, unknown>;
    missingChild?: boolean; missingParent?: boolean; planItemIds?: string[]; blockedDag?: boolean;
    sourceCapExhausted?: boolean; requestedSeats?: number; allowCallerHeld?: boolean }>)
  ('refuses child-based admission for $label without changing custody', (control) => {
    const parent = { id: 'WI-direct-parent', family: 'feature' as const, state: 'open',
      assignee: null, harness: 'papercusp', sourcePlanItemIds: ['P-001'], payload: null, ...control.parent };
    const child = { id: 'WI-unstamped-child', family: 'issue' as const, state: 'open',
      assignee: 'su-caller', harness: 'papercusp', parent: parent.id,
      sourcePlanItemIds: undefined, payload: {}, ...control.child };
    const workItems = [...(control.missingParent ? [] : [parent]), ...(control.missingChild ? [] : [child])];
    const before = JSON.stringify(workItems);
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: control.blockedDag
        ? [item('P-001', 'todo', ['P-002']), item('P-002')] : [item('P-001')],
      workItems, laneHealth: lane({ issue: 0, feature: 0, featureMatchedByFilter: 1,
        featureExcluded: { stopTheLine: 1 } }), assignee: 'su-caller',
      allowCallerHeld: control.allowCallerHeld ?? true, requestedSeats: control.requestedSeats,
      sourceCapExhausted: control.sourceCapExhausted, planItemIds: control.planItemIds,
    });
    expect(verdict.ready).toBe(false);
    expect(JSON.stringify(workItems)).toBe(before);
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

  it.each([
    { label: 'sole unfinished lane', planItems: [item('P-001', 'wip')] },
    { label: 'lane beside a blocked successor', planItems: [item('P-001', 'wip'), item('P-002', 'todo', ['P-001'])] },
  ])('admits plans:start for the caller-owned WIP $label', ({ planItems }) => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems,
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'],
        payload: null, assignee: 'su-caller', state: 'wip' }],
      laneHealth: lane({ issue: 0, issueMatchedByFilter: 1,
        issueExcluded: { taken: 1 }, featureReachable: false }),
      assignee: 'su-caller',
      allowCallerHeld: true,
    });

    expect(verdict).toMatchObject({ ready: true, reason: 'ready', planItems: { actionable: 0 } });
    expect(verdict.message).toContain('caller already owns 1 active non-final lane(s)');
  });

  it.each([
    { label: 'unclaimed WIP', holder: undefined, allowCallerHeld: true, requestedSeats: undefined },
    { label: 'foreign WIP', holder: 'su-other', allowCallerHeld: true, requestedSeats: undefined },
    { label: 'caller-neutral fleet', holder: 'su-caller', allowCallerHeld: false, requestedSeats: undefined },
    { label: 'new fleet seat', holder: 'su-caller', allowCallerHeld: true, requestedSeats: 1 },
  ])('does not admit a new lane from $label', ({ holder, allowCallerHeld, requestedSeats }) => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001', 'wip')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'],
        payload: null, assignee: holder, state: 'wip' }],
      laneHealth: lane({ issue: 0, issueMatchedByFilter: 1, featureReachable: false }),
      assignee: 'su-caller',
      allowCallerHeld,
      requestedSeats,
    })).toMatchObject({ ready: false, reason: 'no-actionable-plan-items' });
  });

  it('admits plans:start when the caller owns active non-final lanes beside a blocked frontier', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001', 'wip'), item('P-002', 'wip'), item('P-003')],
      workItems: [
        {
          id: 'WI-1',
          family: 'issue',
          sourcePlanItemIds: ['P-001'],
          payload: null,
          assignee: 'su-caller',
        },
        {
          id: 'WI-2',
          family: 'issue',
          sourcePlanItemIds: ['P-002'],
          payload: null,
          assignee: 'su-caller',
        },
        {
          id: 'WI-3',
          family: 'issue',
          sourcePlanItemIds: ['P-003'],
          payload: null,
          assignee: 'su-other',
        },
      ],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 3,
        issueExcluded: { planLaneReserved: 2, stopTheLine: 1 },
        featureReachable: false,
      }),
      assignee: 'su-caller',
      allowCallerHeld: true,
    });

    expect(verdict).toMatchObject({ ready: true, status: 'ready', reason: 'ready' });
    expect(verdict.message).toContain('caller already owns 2 active non-final lane(s)');
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

  it('joins canonical-only adopted coverage and preserves the existing caller-held admission rule', async () => {
    const adopted = { id: 'EI-adopted', family: 'issue', state: 'open', assignee: 'su-test',
      sourcePlanSlug: null, sourcePlanItemIds: null, payload: {} };
    mocks.listWorkItems.mockImplementation(async filter => filter.ids ? [adopted] : []);
    mocks.readPlanLineWorkItemRefs.mockResolvedValue([
      { workItemId: adopted.id, planSlug: 'plan-a', planItemId: 'P-001' },
    ]);
    mocks.readClaimSpecLaneHealth.mockResolvedValue(lane({ issue: 0, featureReachable: false }));
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-test', claimant: 'su-test', specId: 'canonical-adoption', allowCallerHeld: true,
    })).toMatchObject({ ready: true, actionableRows: [{ planItemId: 'P-001', workItemId: adopted.id }] });
    expect(mocks.listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ ids: [adopted.id] }));
    expect(adopted.payload).toEqual({});
    expect(adopted.sourcePlanSlug).toBeNull();
  });

  it('does not let legacy census rows cover a plan after canonical rehoming', async () => {
    mocks.readPlanLineWorkItemRefs.mockResolvedValue([
      { workItemId: 'WI-1', planSlug: 'different-plan', planItemId: 'P-001' },
    ]);
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-test', specId: 'canonical-rehome',
    })).toMatchObject({ ready: false, reason: 'promotion-lag' });
    expect(mocks.readClaimSpecLaneHealth).not.toHaveBeenCalled();
  });

  it('reads independent exact-plan and caller-owned populations for an unstamped held child', async () => {
    const parent = { id: 'WI-parent', family: 'feature', state: 'open', assignee: null,
      sourcePlanItemIds: ['P-001'], payload: null };
    const child = { id: 'WI-child', family: 'issue', state: 'open', assignee: 'su-caller',
      parent: parent.id, sourcePlanItemIds: null, payload: {} };
    const before = JSON.stringify([parent, child]);
    mocks.listWorkItems.mockImplementation(async (filter) => {
      if (filter.sourcePlanSlug === 'plan-a') return [parent];
      if (filter.assignee === 'su-caller') return [child, { ...child }, parent];
      throw new Error('Unexpected unscoped census');
    });
    mocks.readClaimSpecLaneHealth.mockResolvedValue(lane({ issue: 0, feature: 0,
      featureMatchedByFilter: 1, featureExcluded: { stopTheLine: 1 } }));
    const verdict = await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-caller', claimant: 'su-caller', specId: 'child-start', allowCallerHeld: true });
    expect(verdict).toMatchObject({ ready: true, reason: 'ready', promotion: { rows: 1, duplicateActionable: [] },
      actionableRows: [{ planItemId: 'P-001', workItemId: parent.id }] });
    expect(mocks.listWorkItems.mock.calls.map(([filter]) => filter)).toEqual([
      { harness: 'papercusp', sourcePlanSlug: 'plan-a', includeChildren: true, limit: 2_000 },
      { harness: 'papercusp', assignee: 'su-caller', states: ['open', 'wip'], includeChildren: true, limit: 2_000 },
    ]);
    expect(JSON.stringify([parent, child])).toBe(before);
    expect(child.payload).toEqual({});
  });

  it.each(['failed', 'capped', 'unknown'])('refuses an incomplete caller-owned child census: %s', async (condition) => {
    const parent = { id: 'WI-parent', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'], payload: null };
    mocks.listWorkItems.mockImplementation(async (filter) => {
      if (filter.sourcePlanSlug === 'plan-a') return [parent];
      if (condition === 'failed') throw new Error('Independent caller census unavailable');
      return condition === 'capped' ? Array(2_000).fill(parent) : null;
    });
    const verdict = await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-caller', claimant: 'su-caller', specId: 'child-start', allowCallerHeld: true });
    expect(verdict).toMatchObject({ ready: false, reason: 'lane-unknown' });
    expect(verdict.message).toContain('caller-owned child census');
    expect(mocks.readClaimSpecLaneHealth).not.toHaveBeenCalled();
  });

  it.each([
    { allowCallerHeld: false, requestedSeats: undefined },
    { allowCallerHeld: true, requestedSeats: 1 },
  ])('keeps the caller census out of fleet-width admission: %j', async (control) => {
    mocks.readClaimSpecLaneHealth.mockResolvedValue(lane({ issue: 0, featureReachable: false }));
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-test', claimant: 'su-test', specId: 'fleet', ...control }))
      .toMatchObject({ ready: false });
    expect(mocks.listWorkItems).toHaveBeenCalledOnce();
  });

  it('reads lane health before admitting a caller whose only unfinished item is WIP', async () => {
    mocks.planItemsForRow.mockReturnValue([item('P-001', 'done'), item('P-002', 'wip')]);
    mocks.listWorkItems.mockResolvedValue([{ id: 'WI-2', family: 'issue', state: 'wip',
      sourcePlanItemIds: ['P-002'], payload: null, assignee: 'su-test' }]);
    mocks.readClaimSpecLaneHealth.mockResolvedValue(lane({ issue: 0,
      issueMatchedByFilter: 1, issueExcluded: { taken: 1 }, featureReachable: false }));
    const args = { workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'plan-a',
      actor: 'su-test', claimant: 'su-test', specId: 'plans-start-plan-a', allowCallerHeld: true };

    expect(await preflightExactPlanAdmission(args)).toMatchObject({ ready: true, reason: 'ready' });
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledOnce();

    mocks.readClaimSpecLaneHealth.mockResolvedValue(null);
    expect(await preflightExactPlanAdmission(args)).toMatchObject({ ready: false, reason: 'lane-unknown' });
  });

  it('does not read plan claim floors or promotions for an explicit lanes-only scope', async () => {
    mocks.listWorkItems.mockRejectedValue(new Error('unrelated promotion census unavailable'));
    mocks.readClaimSpecLaneHealth.mockRejectedValue(new Error('unrelated floor measurement unavailable'));
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-test', specId: 'lane-only', planItemIds: [], requestedSeats: 4,
    })).toMatchObject({ ready: true, reason: 'ready', planItems: { total: 0 }, lane: null });
    expect(mocks.listWorkItems).not.toHaveBeenCalled();
    expect(mocks.readClaimSpecLaneHealth).not.toHaveBeenCalled();
    mocks.getPlanRow.mockResolvedValue(null);
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'missing', actor: 'su-test', specId: 'lane-only', planItemIds: [],
    })).toMatchObject({ ready: false, reason: 'plan-not-found' });
  });

  it('uses the normalized execution tree for the scheduler family filter too', async () => {
    mocks.planItemsForRow.mockReturnValue([item('P-001')]);
    mocks.listWorkItems.mockResolvedValue([
      { id: 'WI-node', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'], payload: null },
      { id: 'WI-legacy', family: 'issue', state: 'open', parent: 'WI-node', sourcePlanItemIds: ['P-001'], payload: null },
    ]);
    mocks.readClaimSpecLaneHealth.mockResolvedValueOnce(lane({ feature: 1, issue: 0 }));
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-test', specId: 'canonical-line',
    })).toMatchObject({ ready: true, claimKinds: ['feature'] });
    expect(mocks.readClaimSpecLaneHealth.mock.calls.at(-1)?.[0].spec.view.filter).toEqual({ all: [
      { field: 'plan', op: '=', value: 'plan-a' },
      { field: 'kind', op: 'in', value: ['feature'] },
    ] });
  });

  it('narrows both coverage and the scheduler floor read to exactly the targeted items', async () => {
    mocks.planItemsForRow.mockReturnValue([item('P-001'), item('P-002')]);
    mocks.listWorkItems.mockResolvedValue([
      { id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null },
      { id: 'F-2a', family: 'feature', sourcePlanItemIds: ['P-002'], payload: null },
      { id: 'F-2b', family: 'feature', sourcePlanItemIds: ['P-002'], payload: null },
    ]);
    mocks.readClaimSpecLaneHealth.mockImplementationOnce(async ({ spec }) => {
      expect(spec.view.filter).toEqual({ all: [
        { field: 'plan', op: '=', value: 'plan-a' },
        { field: 'plan_item', op: 'in', value: ['P-001'] },
        { field: 'kind', op: 'in', value: [...ISSUE_FAMILY_KINDS] },
      ] });
      expect(validateClaimSpec(spec)).toMatchObject({ ok: true });
      return lane({ issue: 0, issueMatchedByFilter: 1, issueExcluded: { stopTheLine: 1 },
        featureReachable: false });
    });
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-test', specId: 'scoped', planItemIds: ['P-001'],
    })).toMatchObject({ ready: false, reason: 'floor-gated', claimKinds: [...ISSUE_FAMILY_KINDS],
      promotion: { duplicateActionable: [] }, actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-1' }] });
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

  it('narrows a single-family plan census but leaves mixed-family plans broad', async () => {
    const issueOnly = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a',
    });

    expect(issueOnly).toMatchObject({ claimKinds: [...ISSUE_FAMILY_KINDS] });
    expect(mocks.readClaimSpecLaneHealth.mock.calls.at(-1)?.[0].spec.view.filter).toEqual({
      all: [
        { field: 'plan', op: '=', value: 'plan-a' },
        { field: 'kind', op: 'in', value: [...ISSUE_FAMILY_KINDS] },
      ],
    });

    mocks.planItemsForRow.mockReturnValue([item('P-001'), item('P-002')]);
    mocks.listWorkItems.mockResolvedValue([
      { id: 'WI-1', family: 'issue', state: 'open', sourcePlanItemIds: ['P-001'], payload: null },
      { id: 'F-1', family: 'feature', state: 'open', sourcePlanItemIds: ['P-002'], payload: null },
    ]);
    mocks.readClaimSpecLaneHealth.mockResolvedValueOnce(lane({ issue: 1, feature: 1 }));

    const mixed = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a',
    });

    expect(mixed).toMatchObject({ ready: true, claimKinds: null });
    expect(mocks.readClaimSpecLaneHealth.mock.calls.at(-1)?.[0].spec.view.filter).toEqual({
      field: 'plan',
      op: '=',
      value: 'plan-a',
    });
  });

  it('builds a validator-clean plan-only claim spec', () => {
    const spec = buildExactPlanClaimSpec('exact-plan', 'plan-a');
    expect(validateClaimSpec(spec)).toMatchObject({ ok: true });
    expect(spec.view.filter).toEqual({ field: 'plan', op: '=', value: 'plan-a' });
  });
});

describe('preflightExactPlanLaneHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listWorkItems.mockReset().mockResolvedValue([
      { id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null },
    ]);
    mocks.readClaimSpecLaneHealth.mockReset().mockResolvedValue(lane({ issue: 0, feature: 0 }));
  });

  const startArgs = { workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'plan-a',
    actor: 'su-test', specId: 'plans-start-plan-a', planItems: [item('P-001')] };
  const parked = { id: 'WI-parked', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'],
    payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } };

  it('refuses parked-only coverage before reading a claim lane, preserving the hold', async () => {
    mocks.listWorkItems.mockResolvedValue([parked]);
    const before = structuredClone(parked);
    await expect(preflightExactPlanLaneHealth(startArgs)).rejects.toMatchObject({
      name: 'PlanPromotionParkError', rows: [{ planItemId: 'P-001', workItemId: 'WI-parked' }],
      message: expect.stringContaining('plans:start lifts these migration parks'),
    });
    expect(parked).toEqual(before);
    expect(mocks.readClaimSpecLaneHealth).not.toHaveBeenCalled();
  });

  it('does not refuse parked-only coverage in plans:start lift-at-promotion mode', async () => {
    mocks.listWorkItems.mockResolvedValue([parked]);
    await expect(preflightExactPlanLaneHealth({ ...startArgs, migrationParks: 'lift-at-promotion' }))
      .resolves.toMatchObject({ effective: { claimable: 0 } });
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledOnce();
  });

  it.each(['first-start', 'execution-child', 'released-park', 'settled-park', 'blocked-item'])(
    'allows %s through the pre-promotion check', async kind => {
      const rows = kind === 'first-start' ? []
        : kind === 'execution-child' ? [parked, { ...parked, id: 'WI-child', parent: parked.id, payload: null }]
        : kind === 'released-park' ? [{ ...parked, payload: { ...parked.payload, _claimHold: false } }]
        : kind === 'settled-park' ? [{ ...parked, state: 'done' }]
        : [parked];
      mocks.listWorkItems.mockResolvedValue(rows);
      await expect(preflightExactPlanLaneHealth({ ...startArgs,
        ...(kind === 'blocked-item' ? { planItems: [item('P-001', 'blocked')] } : {}),
      })).resolves.toMatchObject({ effective: { claimable: 0 } });
      expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledOnce();
    },
  );

  it('does not infer the absence of a migration hold from an incomplete census', async () => {
    mocks.listWorkItems.mockResolvedValue(Array(2000).fill(parked));
    await expect(preflightExactPlanLaneHealth(startArgs)).rejects.toThrow('source cap');
    expect(mocks.readClaimSpecLaneHealth).not.toHaveBeenCalled();
  });

  describe('liftMigrationParkedCoverage (EI-28724198520380406)', () => {
  const parked = { id: 'WI-parked', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'],
    payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } };
  const liftArgs = { workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'plan-a', actor: 'su-test',
    planItems: [item('P-001')] };
  function fakePark(outcome = 'cleared') {
    return {
      readDurableParkControlRow: vi.fn(async ({ id }: { id: string }) =>
        ({ id, state: 'open', takenBy: null,
          payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } })),
      durableParkFingerprint: vi.fn((row: { payload: unknown }) => `fp:${JSON.stringify(row.payload)}`),
      runWorkItemDurableParkReconciliation: vi.fn(async (opts: { decisions: Array<{ id: string }>; runId?: string }) => ({
        runId: opts.runId, artifactPath: 'audit/x.json',
        rows: opts.decisions.map(d => ({ id: d.id, outcome })),
      })),
    };
  }
  beforeEach(() => { vi.clearAllMocks(); });

  it('lifts the park on an actionable line through the reconcile with CAS fingerprint + evidence', async () => {
    mocks.listWorkItems.mockReset().mockResolvedValue([parked]);
    const park = fakePark();
    const res = await liftMigrationParkedCoverage({ ...liftArgs, deps: { durablePark: park as never } });
    expect(park.runWorkItemDurableParkReconciliation).toHaveBeenCalledOnce();
    const call = park.runWorkItemDurableParkReconciliation.mock.calls[0]![0] as unknown as {
      actor: string; runId: string; decisions: Array<Record<string, string>> };
    expect(call.actor).toBe('su-test');
    expect(call.runId).toMatch(/^work-item-durable-park-audit:plans-start:[0-9a-f]{32}$/);
    expect(call.decisions).toEqual([{ id: 'WI-parked',
      expectedParkFingerprint: 'fp:{"_claimHold":true,"claim_hold_by":"migration:plan-line-work-item-nodes"}',
      reasonCode: 'condition-satisfied', evidence: expect.stringContaining('P-001') }]);
    expect(res).toMatchObject({ rows: [{ workItemId: 'WI-parked', planItemIds: ['P-001'], outcome: 'cleared' }],
      unsettled: [], artifactPath: 'audit/x.json' });
  });

  it('keeps blocked / non-actionable lines parked (no reconcile at all)', async () => {
    mocks.listWorkItems.mockReset().mockResolvedValue([parked]);
    const park = fakePark();
    const res = await liftMigrationParkedCoverage({ ...liftArgs, planItems: [item('P-001', 'blocked')],
      deps: { durablePark: park as never } });
    expect(park.readDurableParkControlRow).not.toHaveBeenCalled();
    expect(park.runWorkItemDurableParkReconciliation).not.toHaveBeenCalled();
    expect(res).toEqual({ rows: [], unsettled: [], runId: null, artifactPath: null });
  });

  describe('completed dependency with a generated lane gate (WI9366)', () => {
    const gate = { kind: 'gate', ref: 'plan-lane:plan-a#P-002', status: 'active',
      capability: 'live-dependency', capabilitySource: 'explicit',
      createdBy: 'system:plan-item-lane-sync', summary: 'Dependency gate',
      createdAt: '2026-11-15T08:00:00Z', updatedAt: '2026-11-15T08:00:00Z' };
    const planItems = () => [item('P-001', 'done'), item('P-002', 'blocked', ['P-001'])];
    const dependencyPark = () => ({ id: 'WI-dependent', family: 'issue', state: 'blocked',
      sourcePlanSlug: 'plan-a', sourcePlanItemIds: ['P-002'], assignee: 'su-test' as string | null,
      payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes',
        planLaneParkedFrom: 'open', externalBlockers: [gate] } as Record<string, unknown> });
    const nodes = () => [
      { id: 'P-001', featureId: 'WI-prerequisite', planSlug: 'plan-a', status: 'done', blockedBy: [] },
      { id: 'P-002', featureId: 'WI-dependent', planSlug: 'plan-a', status: 'blocked', blockedBy: ['P-001'] },
    ];
    beforeEach(() => { mocks.readPlanLineNodes.mockReset().mockResolvedValue(nodes()); });

    it.each(['su-test', null])('reconciles the exact dependency-derived node held by %s without clearing its sticky status', async assignee => {
      const current = { ...dependencyPark(), assignee };
      const before = structuredClone(current);
      mocks.listWorkItems.mockReset().mockResolvedValue([current]);
      const park = { ...fakePark(), readDurableParkControlRow: vi.fn(async () =>
        ({ id: current.id, state: current.state, takenBy: assignee, payload: current.payload })) };

      const result = await liftMigrationParkedCoverage({ ...liftArgs, planItems: planItems(),
        deps: { durablePark: park as never } });

      expect(result).toMatchObject({ rows: [{ workItemId: current.id, planItemIds: ['P-002'], outcome: 'cleared' }],
        unsettled: [] });
      expect(park.runWorkItemDurableParkReconciliation).toHaveBeenCalledWith(expect.objectContaining({
        actor: 'su-test', decisions: [expect.objectContaining({ id: current.id, reasonCode: 'condition-satisfied' })],
      }));
      expect(mocks.readPlanLineNodes).toHaveBeenCalledWith(mocks.sql,
        { workspaceId: 'ws-1', harnessSlug: 'papercusp', slug: 'plan-a' });
      expect(current).toEqual(before);
      expect(planItems()[1].storedStatus).toBe('blocked');
    });

    it.each(['pending prerequisite', 'missing prerequisite', 'cycle', 'duplicate plan id',
      'independent park', 'peer claim', 'peer lease', 'missing provenance', 'foreign gate',
      'ambiguous gates', 'independent gate', 'malformed blockers', 'missing node',
      'wrong node', 'ambiguous nodes', 'owner gate', 'changed canonical dependency'])(
      'preserves %s instead of treating promotion as release authority', async scenario => {
        const current = dependencyPark();
        const graph = planItems();
        const canonical = nodes();
        if (scenario === 'pending prerequisite') graph[0].storedStatus = 'wip';
        if (scenario === 'missing prerequisite') graph.splice(0, 1);
        if (scenario === 'cycle') graph[0].blockedBy = ['P-002'];
        if (scenario === 'duplicate plan id') graph.push({ ...graph[1] });
        if (scenario === 'independent park') current.payload.claim_hold_by = 'su-owner';
        if (scenario === 'peer claim') current.assignee = 'su-other';
        if (scenario === 'peer lease') current.payload.held_open_by = 'su-other';
        if (scenario === 'missing provenance') delete current.payload.planLaneParkedFrom;
        if (scenario === 'foreign gate') current.payload.externalBlockers = [{ ...gate, createdBy: 'su-other' }];
        if (scenario === 'ambiguous gates') current.payload.externalBlockers = [gate, gate];
        if (scenario === 'independent gate') current.payload.externalBlockers = [gate, { ...gate, ref: 'external:owner' }];
        if (scenario === 'malformed blockers') current.payload.externalBlockers = [gate, { invalid: true }];
        if (scenario === 'missing node') canonical.splice(1, 1);
        if (scenario === 'wrong node') canonical[1].featureId = 'WI-other';
        if (scenario === 'ambiguous nodes') canonical.push({ ...canonical[1] });
        if (scenario === 'owner gate') Object.assign(canonical[1], { ownerGateMarker: 'owner approval' });
        if (scenario === 'changed canonical dependency') canonical[1].blockedBy = [];
        mocks.listWorkItems.mockReset().mockResolvedValue([current]);
        mocks.readPlanLineNodes.mockResolvedValue(canonical);
        const park = fakePark();

        const result = await liftMigrationParkedCoverage({ ...liftArgs, planItems: graph,
          deps: { durablePark: park as never } });

        expect(park.runWorkItemDurableParkReconciliation).not.toHaveBeenCalled();
        expect(result.rows).toEqual([]);
      },
    );
  });

  it('reports a park the reconcile did not clear as unsettled instead of claiming success', async () => {
    mocks.listWorkItems.mockReset().mockResolvedValue([parked]);
    const res = await liftMigrationParkedCoverage({ ...liftArgs, deps: { durablePark: fakePark('stale-fingerprint') as never } });
    expect(res.unsettled).toEqual([{ workItemId: 'WI-parked', planItemIds: ['P-001'], outcome: 'stale-fingerprint' }]);
  });

  it('preserves an owner park installed after the migration coverage census', async () => {
    mocks.listWorkItems.mockReset().mockResolvedValue([parked]);
    const park = { ...fakePark(), readDurableParkControlRow: vi.fn(async () => ({
      id: parked.id, state: 'open', takenBy: null,
      payload: { _claimHold: true, claim_hold_by: 'su-owner', claim_hold_reason: 'owner decision pending' },
    })) };
    const result = await liftMigrationParkedCoverage({ ...liftArgs, deps: { durablePark: park as never } });
    expect(park.runWorkItemDurableParkReconciliation).not.toHaveBeenCalled();
    expect(result.unsettled).toEqual([{ workItemId: parked.id, planItemIds: ['P-001'], outcome: 'condition-changed' }]);
  });

  it('sends one decision per node even when the node covers several actionable lines', async () => {
    mocks.listWorkItems.mockReset().mockResolvedValue([{ ...parked, sourcePlanItemIds: ['P-001', 'P-002'] }]);
    const park = fakePark();
    const res = await liftMigrationParkedCoverage({ ...liftArgs, planItems: [item('P-001'), item('P-002')],
      deps: { durablePark: park as never } });
    const call = park.runWorkItemDurableParkReconciliation.mock.calls[0]![0] as unknown as { decisions: unknown[] };
    expect(call.decisions).toHaveLength(1);
    expect(res.rows).toEqual([{ workItemId: 'WI-parked', planItemIds: ['P-001', 'P-002'], outcome: 'cleared' }]);
  });

  it('reports a node the control read cannot find as missing, without reconciling it', async () => {
    mocks.listWorkItems.mockReset().mockResolvedValue([parked]);
    const park = { ...fakePark(), readDurableParkControlRow: vi.fn(async () => null) };
    const res = await liftMigrationParkedCoverage({ ...liftArgs, deps: { durablePark: park as never } });
    expect(park.runWorkItemDurableParkReconciliation).not.toHaveBeenCalled();
    expect(res.unsettled).toEqual([{ workItemId: 'WI-parked', planItemIds: ['P-001'], outcome: 'missing' }]);
  });
  });

  it('reads the broad exact-plan lane without requiring promoted-row coverage', async () => {
    const laneHealth = await preflightExactPlanLaneHealth({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a-lane-health',
      fleetSlug: 'exact-plan:plan-a',
    });

    expect(laneHealth).toMatchObject({ effective: { claimable: 0 } });
    expect(mocks.getPlanRow).not.toHaveBeenCalled();
    expect(mocks.listWorkItems).not.toHaveBeenCalled();
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        fleet: 'exact-plan:plan-a',
        harness: 'papercusp',
        workspaceId: 'ws-1',
        assignee: 'su-test',
        matchedBy: 'exact-plan-lane-health-preflight',
        spec: expect.objectContaining({
          specId: 'plans-start-plan-a-lane-health',
          view: { filter: { field: 'plan', op: '=', value: 'plan-a' } },
        }),
      }),
    );
  });

  it('preserves the original diagnostic error in the pre-promotion lane read', async () => {
    const failure = new Error('issue-family aggregate timed out');
    mocks.readClaimSpecLaneHealth.mockImplementationOnce(async (args: { throwOnError?: boolean }) => {
      if (args.throwOnError) throw failure;
      return null;
    });

    await expect(preflightExactPlanLaneHealth({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a-lane-health',
    })).rejects.toBe(failure);
  });

  it('names the lane-read failure cause in the lane-unknown refusal (WI-10004851)', async () => {
    mocks.readClaimSpecLaneHealth.mockRejectedValueOnce(new Error('issue-family aggregate timed out'));
    const verdict = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a',
      claimKinds: ['bug'],
    });
    expect(verdict).toMatchObject({ ready: false, reason: 'lane-unknown' });
    expect(verdict.message).toContain('could not be read completely');
    expect(verdict.message).toContain('issue-family aggregate timed out');
  });

  it('keeps the lane-unknown message unchanged when no cause is known', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: undefined, payload: { planItem: { itemId: 'P-001' } } }],
      laneHealth: null,
    } as Parameters<typeof evaluateExactPlanAdmission>[0]);
    expect(verdict).toMatchObject({ reason: 'lane-unknown' });
    expect(verdict.message).toBe('The exact-plan claim lane could not be read completely.');
  });

  it('preserves UNKNOWN instead of converting an unavailable lane read to zero', async () => {
    mocks.readClaimSpecLaneHealth.mockResolvedValue(null);

    await expect(
      preflightExactPlanLaneHealth({
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        planSlug: 'plan-a',
        actor: 'su-test',
        specId: 'plans-start-plan-a-lane-health',
      }),
    ).resolves.toBeNull();
  });
});
