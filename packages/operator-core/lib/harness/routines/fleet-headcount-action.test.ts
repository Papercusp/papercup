import { describe, expect, it } from 'vitest';
import type { FleetLaunchTransaction } from '../../agent-fleets-store';
import {
  assessFleetHeadcountGovernor,
  computeHeadcountDeficit,
  FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT,
  governorVerdictForAssessment,
  nextHeadcountBackoff,
  resolveProductiveCapacityFloor,
  resolveFleetHeadcountLaunchRole,
  resolveFleetHeadcountProfile,
  supersedeLegacyHeadcountTransaction,
} from './fleet-headcount-action';

const workerAttestation = (ownerId: string, ready: boolean) => ({
  version: 1 as const,
  ownerId,
  ready,
  stages: {
    agentCall: { status: 'satisfied' as const, successfulCalls: 1 },
    durableWake: ready
      ? { status: 'satisfied' as const, wakeSource: 'loop' }
      : { status: 'missing' as const, wakeSource: null },
    schedulerPull: ready
      ? { status: 'satisfied' as const, calls: 1, successfulCalls: 1 }
      : { status: 'missing' as const, calls: 0, successfulCalls: 0 },
    disposition: ready
      ? { status: 'satisfied' as const, kind: 'no-claim' as const, reason: 'lane_drained' }
      : { status: 'missing' as const, kind: 'missing' as const },
  },
  failures: ready
    ? []
    : [{
        stage: 'durableWake' as const,
        code: 'durable-wake-missing' as const,
        detail: 'No durable wake.',
      }],
});

const transaction = (
  owners: string[],
  overrides: Partial<FleetLaunchTransaction> = {},
): FleetLaunchTransaction => ({
  version: 1,
  transactionId: 'tx-1',
  launcherOwnerId: 'su-leader',
  state: 'partial',
  requestedAt: 1_000,
  updatedAt: 1_000,
  requestedMemberIds: owners,
  openedMemberIds: owners,
  verifiedMemberIds: [],
  unconfirmedMemberIds: owners,
  failed: [],
  waves: [{ index: 0, ownerIds: owners, state: 'partial', openedOwnerIds: owners }],
  recovery: { retryOwnerIds: owners, nextAction: 'observe' },
  ...overrides,
});

describe('fleet headcount governor guards (WI-2479)', () => {
  it('opens only the missing member deficit and never a negative wave', () => {
    expect(computeHeadcountDeficit(5, 2)).toBe(3);
    expect(computeHeadcountDeficit(5, 5)).toBe(0);
    expect(computeHeadcountDeficit(5, 9)).toBe(0);
  });

  it('uses bounded exponential retry delays', () => {
    expect(nextHeadcountBackoff(0)).toBe(60_000);
    expect(nextHeadcountBackoff(60_000)).toBe(120_000);
    expect(nextHeadcountBackoff(60 * 60_000)).toBe(15 * 60_000);
  });

  it('defaults legacy profiles headless while preserving every explicit launch knob', () => {
    expect(resolveFleetHeadcountProfile({ plan: 'drain', harness: 'papercusp', agent: 'codex' }).headless).toBe(true);
    expect(resolveFleetHeadcountProfile({
      plan: 'drain',
      harness: 'papercusp',
      agent: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'max',
      account: 'default',
      carry: 'warm',
      contextSize: 'trimmed',
      compactionLimit: 825_000,
      headless: false,
      brief: 'drain bugs',
    })).toMatchObject({
      headless: false,
      effort: 'max',
      carry: 'warm',
      contextSize: 'trimmed',
      compactionLimit: 825_000,
      brief: 'drain bugs',
    });
  });

  describe('resolveFleetHeadcountLaunchRole (D-016)', () => {
    it('binds the declared drain fleet to the drain-fleet-member slot', () => {
      expect(resolveFleetHeadcountLaunchRole({
        goalId: 'goal-1',
        fleetSlug: 'goal-drain-goal-1',
        drainFleetSlug: 'goal-drain-goal-1',
      })).toBe('drain-fleet-member');
    });

    it('binds another fleet in the same goal to the plan-fleet-member slot', () => {
      expect(resolveFleetHeadcountLaunchRole({
        goalId: 'goal-1',
        fleetSlug: 'plan-fleet-1',
        drainFleetSlug: 'goal-drain-goal-1',
      })).toBe('plan-fleet-member');
    });

    it('leaves the role layer absent when the fleet has no goal context', () => {
      expect(resolveFleetHeadcountLaunchRole({
        goalId: null,
        fleetSlug: 'standalone-fleet',
        drainFleetSlug: null,
      })).toBeNull();
    });
  });
});

describe('fleet headcount governor typed attestation policy (P-004)', () => {
  it('opens one canary below the productive floor and a bounded wave after the floor is evidenced', () => {
    expect(resolveProductiveCapacityFloor(5, 2)).toBe(2);
    const canary = assessFleetHeadcountGovernor({
      target: 5,
      productiveCapacityFloor: 2,
      liveMemberIds: [],
      transaction: null,
      now: 10_000,
    });
    expect(canary).toMatchObject({ action: 'spawn', spawnCount: 1, workerReadyMemberIds: [] });

    const ready = transaction(['su-a', 'su-b'], {
      state: 'verified',
      verifiedMemberIds: ['su-a', 'su-b'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: ['su-a', 'su-b'],
      workerAttestations: [workerAttestation('su-a', true), workerAttestation('su-b', true)],
    });
    const bulk = assessFleetHeadcountGovernor({
      target: 5,
      productiveCapacityFloor: 2,
      liveMemberIds: ['su-a', 'su-b'],
      transaction: ready,
      now: 10_000,
    });
    expect(bulk).toMatchObject({ action: 'spawn', spawnCount: 3, workerReadyMemberIds: ['su-a', 'su-b'] });
  });

  it('waits on an unverified late boot, then cancels replay when that exact member proves ready', () => {
    const slow = transaction(['su-slow']);
    const before = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: [],
      transaction: slow,
      now: 2_000,
    });
    expect(before).toMatchObject({
      action: 'wait',
      spawnCount: 0,
      pendingOpenedMemberIds: ['su-slow'],
    });

    slow.verifiedMemberIds = ['su-slow'];
    slow.unconfirmedMemberIds = [];
    slow.workerReadyMemberIds = ['su-slow'];
    slow.workerAttestations = [workerAttestation('su-slow', true)];
    const after = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-slow'],
      transaction: slow,
      now: 3_000,
    });
    expect(after).toMatchObject({ action: 'none', spawnCount: 0, workerReadyMemberIds: ['su-slow'] });
  });

  it('never prunes a live member whose typed readiness is absent', () => {
    const legacy = transaction(['su-legacy'], {
      openedMemberIds: [],
      unconfirmedMemberIds: [],
      workerAttestations: undefined,
      workerReadyMemberIds: undefined,
    });
    const result = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-legacy'],
      transaction: legacy,
      now: 20_000,
    });
    expect(result).toMatchObject({
      action: 'wait',
      pruneCandidateIds: [],
      unverifiedMemberIds: ['su-legacy'],
    });
  });

  it('supersedes a legacy launch transaction without fabricating correlation or replaying live members', () => {
    const legacy = transaction(['su-live-ready', 'su-live-unknown', 'su-gone'], {
      launcherOwnerId: undefined,
      verifiedMemberIds: ['su-live-ready', 'su-gone'],
      workerReadyMemberIds: ['su-live-ready', 'su-gone'],
      workerAttestations: [
        workerAttestation('su-live-ready', true),
        workerAttestation('su-gone', true),
      ],
      governor: {
        version: 1,
        probeOwnerIds: ['su-live-ready', 'su-live-unknown', 'su-gone'],
        attestationAttempts: { 'su-gone': 2 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });

    const normalized = supersedeLegacyHeadcountTransaction({
      transaction: legacy,
      liveMemberIds: ['su-live-ready', 'su-live-unknown'],
      launcherOwnerId: 'su-current-leader',
      now: 30_000,
    });

    expect(normalized).toMatchObject({
      previousTransactionId: 'tx-1',
      launcherOwnerId: 'su-current-leader',
      requestedAt: 30_000,
      requestedMemberIds: ['su-live-ready', 'su-live-unknown'],
      openedMemberIds: [],
      verifiedMemberIds: ['su-live-ready'],
      workerReadyMemberIds: ['su-live-ready'],
      unconfirmedMemberIds: [],
      recovery: { retryOwnerIds: [] },
      governor: { probeOwnerIds: [], attestationAttempts: {} },
    });
    expect(normalized.transactionId).not.toBe('tx-1');
    expect(normalized.workerAttestations?.map((item) => item.ownerId)).toEqual(['su-live-ready']);
    expect(normalized.governor?.history.at(-1)?.reason).toMatch(/superseded legacy launch transaction/);

    // The two observed live members are never replayed. A target of three opens
    // exactly the one real deficit, with the preserved typed-ready member still
    // satisfying the productive-capacity floor.
    expect(assessFleetHeadcountGovernor({
      target: 3,
      productiveCapacityFloor: 1,
      liveMemberIds: ['su-live-ready', 'su-live-unknown'],
      transaction: normalized,
      now: 30_000,
    })).toMatchObject({ action: 'spawn', spawnCount: 1, pendingOpenedMemberIds: [] });
  });

  it('prunes only after bounded repeated non-ready evidence plus verified agent start', () => {
    const member = transaction(['su-dark'], {
      verifiedMemberIds: ['su-dark'],
      unconfirmedMemberIds: [],
      workerAttestations: [workerAttestation('su-dark', false)],
      governor: {
        version: 1,
        probeOwnerIds: ['su-dark'],
        attestationAttempts: { 'su-dark': FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT - 1 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });
    const retry = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-dark'],
      transaction: member,
      now: 20_000,
    });
    expect(retry).toMatchObject({ action: 'retry', pruneCandidateIds: [] });

    member.governor!.attestationAttempts['su-dark'] = FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT;
    const prune = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-dark'],
      transaction: member,
      now: 20_000,
    });
    expect(prune).toMatchObject({
      action: 'prune',
      actionOwnerId: 'su-dark',
      pruneCandidateIds: ['su-dark'],
    });
  });

  it('refuses a prune even at the retry cap when start/failure proof is still unknown', () => {
    const member = transaction(['su-unknown'], {
      workerAttestations: [workerAttestation('su-unknown', false)],
      governor: {
        version: 1,
        probeOwnerIds: ['su-unknown'],
        attestationAttempts: { 'su-unknown': FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });
    const result = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-unknown'],
      transaction: member,
      now: 20_000,
    });
    expect(result).toMatchObject({ action: 'wait', pruneCandidateIds: [] });
  });

  it('emits a distinct accountable terminal verdict without rewriting liveness or progress', () => {
    const assessment = assessFleetHeadcountGovernor({
      target: 2,
      productiveCapacityFloor: 1,
      liveMemberIds: [],
      transaction: null,
      now: 20_000,
    });
    expect(governorVerdictForAssessment(assessment, 20_000)).toEqual({
      version: 1,
      outcome: 'repairing',
      decidedAt: 20_000,
      target: 2,
      productiveCapacityFloor: 1,
      liveMemberIds: [],
      workerReadyMemberIds: [],
      unreadyMemberIds: [],
      unverifiedMemberIds: [],
      action: 'spawn',
      reason: 'productive-capacity floor is not yet evidenced; open one canary only',
    });
  });
});
