/** P006: causal controls for the remaining P001 placement assertions. */
import { describe, expect, it } from 'vitest';
import { compileGoalPlanPlacement } from './goal-launch-settings';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';

const NOW = new Date('2026-09-23T11:00:00.000Z');
const scenarios = ['holder-not-independent', 'independent-member-positive', 'existing-one-fleet'] as const;
type Scenario = typeof scenarios[number];
const control = process.env.PAPERCUSP_PLACEMENT_EXCLUSION_CONTROL;
if (control && !scenarios.includes(control as Scenario)) {
  throw new Error(`Unknown permanent placement exclusion control: ${control}`);
}

function placement(scenario: Scenario) {
  const source = {
    goalHolderOwnerIds: ['su-goal'],
    claims: scenario === 'existing-one-fleet' ? [] : [{
      itemId: 'P-001', ownerId: 'su-member', fleetSlug: 'alpha-fleet', holderLive: true,
      expiresAt: '2026-09-23T11:05:00.000Z', workItemId: 'WI-fixture',
    }],
    fleet: {
      slug: 'alpha-fleet', controlState: 'active',
      leaderOwnerId: scenario === 'holder-not-independent' ? 'su-goal' : 'su-leader',
      leaderLive: true, liveMembers: 2, target: 2,
      claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'alpha' } } },
      launchTransaction: { transactionId: 'tx-existing', state: 'verified' },
    },
  };
  // Intentional wrong adapters keep the literal oracle intact. They lose one
  // canonical input at a time; calibration bypasses every adapter below.
  const observed: typeof source | Omit<typeof source, 'fleet'> = source;
  if (control === scenario) {
    if (scenario === 'holder-not-independent') source.goalHolderOwnerIds = [];
    if (scenario === 'independent-member-positive') source.claims = [];
    if (scenario === 'existing-one-fleet') delete (observed as Partial<typeof source>).fleet;
  }
  return compileGoalPlanPlacement({
    plan: { harness: 'fixture', slug: 'alpha', ambiguousMatches: 1 },
    status: 'started', itemStatuses: ['wip'], actionableItemId: 'P-001', source: observed, now: NOW,
  });
}

describe('placement exclusion causal contracts (WI-1074216)', () => {
  it('exclusion calibration: unresolved identity refuses launch independently of the control', () => {
    expect(compileGoalPlanPlacement({
      plan: { harness: null, slug: 'alpha', ambiguousMatches: 1 },
      status: 'active', itemStatuses: ['todo'], actionableItemId: 'P-001', source: {}, now: NOW,
    })).toMatchObject({ state: 'blocked', reconciliation: { action: 'resolve-plan-identity', toolCall: null } });
  });
  it.each(scenarios)('repaired exclusion contract: %s', (scenario) => {
    const row = placement(scenario);
    if (scenario === 'holder-not-independent') {
      expect(row, `exclusion-contract:${scenario}`).toMatchObject({
        state: 'blocked', reconciliation: { action: 'reconcile-plan-lane-holder', consistent: false, toolCall: null },
      });
    } else if (scenario === 'independent-member-positive') {
      expect(row, `exclusion-contract:${scenario}`).toMatchObject({
        state: 'working', activeLane: { ownerId: 'su-member', workItemId: 'WI-fixture' },
        reconciliation: { action: 'none', consistent: true, toolCall: null },
      });
    } else {
      expect(row, `exclusion-contract:${scenario}`).toMatchObject({
        state: 'admitting', activeLane: null, fleet: { slug: 'alpha-fleet' },
        launchTransaction: { transactionId: 'tx-existing', state: 'verified' },
        reconciliation: { action: 'reconcile-plan-lane-holder', consistent: false, toolCall: null },
      });
    }
  });
});
