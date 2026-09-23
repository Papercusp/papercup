/** P003: placement is a scoped member claim, never just a launch/leader/WIP receipt. */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';

const subject: typeof import('./goal-launch-settings') = process.env.PAPERCUSP_PLAN_PLACEMENT_PROBE
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_PLAN_PLACEMENT_PROBE).href)
  : await import('./goal-launch-settings');
const NOW = new Date('2026-09-23T11:00:00.000Z');
const lane = { itemId: 'P-001', ownerId: 'su-worker', fleetSlug: 'alpha-fleet', holderLive: true,
  expiresAt: '2026-09-23T11:05:00.000Z', workItemId: 'WI-fixture' };
const fleet = { slug: 'alpha-fleet', controlState: 'active', leaderOwnerId: 'su-leader', leaderLive: true,
  liveMembers: 2, target: 2, claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'alpha' } } },
  launchTransaction: { transactionId: 'tx-existing', state: 'verified' } };
function compile(source: Record<string, unknown> = {}) {
  return subject.compileGoalPlanPlacement({ plan: { harness: 'fixture', slug: 'alpha', ambiguousMatches: 1 },
    status: 'started', itemStatuses: ['wip'], actionableItemId: 'P-001', now: NOW,
    source: { claims: [lane], fleet, goalHolderOwnerIds: ['su-goal'], ...source } });
}

describe('actual delegated plan-member pickup', () => {
  it('recognizes a live member with matching work-item and TTL plan lease in a positively scoped independent fleet', () => {
    expect(compile()).toMatchObject({ state: 'working', reconciliation: { action: 'none', consistent: true } });
  });
  it('does not call a leader-only lease productive member pickup', () => {
    const row = compile({ claims: [{ ...lane, ownerId: fleet.leaderOwnerId }] });
    expect(row.state).not.toBe('working');
    expect(row.reconciliation.consistent).toBe(false);
    expect(row.reconciliation.toolCall).toBeNull();
  });
  it('does not accept a WIP label and plan lease without a matching work-item claim', () => {
    const row = compile({ claims: [{ ...lane, workItemId: null }] });
    expect(row.state).not.toBe('working');
    expect(row.reconciliation.consistent).toBe(false);
  });
  it('does not credit a claim made by a different fleet', () => {
    const row = compile({ claims: [{ ...lane, fleetSlug: 'other-fleet' }] });
    expect(row.state).not.toBe('working');
    expect(row.reconciliation.consistent).toBe(false);
  });
  it('rejects a goal steward masquerading as the independent leader', () => {
    const row = compile({ fleet: { ...fleet, leaderOwnerId: 'su-goal' } });
    expect(row.state).not.toBe('working');
    expect(row.reconciliation.consistent).toBe(false);
  });
  it.each([null, { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'different' } } }])(
    'does not credit an unmeasured or wrong positive plan filter', (claimSpec) => {
      const row = compile({ fleet: { ...fleet, claimSpec } });
      expect(row.state).not.toBe('working');
      expect(row.reconciliation.consistent).toBe(false);
    },
  );
  it('does not launch a duplicate fleet merely because an existing verified fleet has no member claim yet', () => {
    const row = compile({ claims: [] });
    expect(row).toMatchObject({ state: 'admitting', reconciliation: { consistent: false, toolCall: null } });
    expect(row.reconciliation.reason).toMatch(/claim/i);
  });
  it('does not credit a different plan-item lane or an expired member lease', () => {
    for (const claims of [[{ ...lane, itemId: 'P-999' }], [{ ...lane, expiresAt: '2026-09-23T10:59:00.000Z' }]]) {
      const row = compile({ claims });
      expect(row.state).not.toBe('working');
      expect(row.reconciliation.consistent).toBe(false);
    }
  });
});
