/**
 * run-full-loop.test.ts — unit coverage of the pure full-loop verdict
 * (shared-hive-loop-e2e-testing P-008/P-009/P-011; the orchestration itself is
 * proven by swarm-full-loop.integration.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { computeFullLoopVerdict, type LoopScenario } from './run-full-loop';
import type { LoopAgentResult, LoopCompletion } from './loop-agent';
import type { WorkItemClaim } from '../../work-item-claims';

function completion(over: Partial<LoopCompletion> & Pick<LoopCompletion, 'workItemId' | 'owner'>): LoopCompletion {
  return {
    claimId: `claim-${over.workItemId}-${over.owner}`,
    holderPubkey: `pk-${over.owner}`,
    acquiredTs: new Date(1_000_000).toISOString(),
    via: 'remote-authority',
    completedAtMs: 1_000_500,
    steerOrderIndex: 0,
    steerEpoch: 1,
    ...over,
  };
}

function result(over: Partial<LoopAgentResult> & Pick<LoopAgentResult, 'swarmIndex' | 'owner'>): LoopAgentResult {
  return {
    evt: 'result',
    devicePubkey: `pk-${over.owner}`,
    completions: [],
    stats: { sweeps: 1, localAuthority: 0, remoteAuthority: 1, failOpen: 0, conflicts: 0, refusedRevoked: 0 },
    sideEffects: [],
    refusals: [],
    abortSignals: [],
    stalledItem: null,
    lag: { count: 1, maxMs: 100, p95Ms: 100 },
    doneItemsVisible: 0,
    ...over,
  };
}

function claim(workItemId: string, claimId: string, holderPubkey: string, acquiredMs: number): WorkItemClaim {
  return {
    workspaceId: 'w',
    harnessSlug: 'h',
    workItemId,
    hiveSlug: 'hive',
    claimId,
    owner: 'o',
    ownerLabel: null,
    holderPubkey,
    intent: '',
    ttlSec: 60,
    acquiredTs: new Date(acquiredMs).toISOString(),
    expiresTs: new Date(acquiredMs + 60_000).toISOString(),
    lastActivityTs: new Date(acquiredMs).toISOString(),
    expired: false,
  };
}

const baseInput = {
  swarmCount: 3,
  backlog: ['F-001', 'F-002'],
  queenOwner: 'queen',
  killedAuthority: null,
  epoch1SeenByAll: true,
  authorityClaims: [] as WorkItemClaim[],
  convergence: { digestsEqual: true, doneVisibleEverywhere: true, fixpointAfterMs: 5_000 },
  revokeInfo: null,
};

describe('computeFullLoopVerdict', () => {
  it('happy path: exactly-once, steering followed, queen monotonicity holds', () => {
    const v = computeFullLoopVerdict({
      ...baseInput,
      scenario: { kind: 'happy' } satisfies LoopScenario,
      results: [
        result({
          swarmIndex: 1,
          owner: 'queen',
          completions: [completion({ workItemId: 'F-001', owner: 'queen', steerOrderIndex: 0, completedAtMs: 1 })],
        }),
        result({
          swarmIndex: 2,
          owner: 'bee',
          completions: [completion({ workItemId: 'F-002', owner: 'bee', steerOrderIndex: 1, completedAtMs: 2 })],
        }),
      ],
      queenTurn2SawDone: { 'F-001': ['queen'], 'F-002': ['bee'] },
    });
    expect(v.exactlyOnceObserved).toBe(true);
    expect(v.starvedItems).toEqual([]);
    expect(v.doubleCompletedAfterReconcile).toEqual([]);
    expect(v.steering.claimsFollowedSteering).toEqual([true, true]);
    expect(v.steering.queenSawAllRemoteCompletions).toBe(true);
    expect(v.adoption).toBeNull();
    expect(v.revoke).toBeNull();
  });

  it('flags a queen that MISSED a remote completion (monotonicity violation)', () => {
    const v = computeFullLoopVerdict({
      ...baseInput,
      scenario: { kind: 'happy' },
      results: [
        result({
          swarmIndex: 2,
          owner: 'bee',
          completions: [
            completion({ workItemId: 'F-001', owner: 'bee' }),
            completion({ workItemId: 'F-002', owner: 'bee' }),
          ],
        }),
      ],
      queenTurn2SawDone: { 'F-001': ['bee'] }, // F-002@bee never reached the queen
    });
    expect(v.steering.queenSawAllRemoteCompletions).toBe(false);
    expect(v.steering.queenMissedItems).toEqual(['F-002@bee']);
  });

  it('flags out-of-steer-order grants', () => {
    const v = computeFullLoopVerdict({
      ...baseInput,
      scenario: { kind: 'happy' },
      results: [
        result({
          swarmIndex: 2,
          owner: 'bee',
          completions: [
            completion({ workItemId: 'F-002', owner: 'bee', steerOrderIndex: 1, completedAtMs: 1 }),
            completion({ workItemId: 'F-001', owner: 'bee', steerOrderIndex: 0, completedAtMs: 2 }),
          ],
        }),
      ],
      queenTurn2SawDone: { 'F-001': ['bee'], 'F-002': ['bee'] },
    });
    expect(v.steering.claimsFollowedSteering).toEqual([false]);
  });

  it('lease-steal: adoption picks the lease-current (stealer) record; duplicate side effects detected', () => {
    const zombie = completion({
      workItemId: 'F-001',
      owner: 'zombie',
      claimId: 'c-old',
      acquiredTs: new Date(1_000).toISOString(),
      completedAtMs: 9_000,
    });
    const stealer = completion({
      workItemId: 'F-001',
      owner: 'stealer',
      claimId: 'c-new',
      acquiredTs: new Date(5_000).toISOString(),
      completedAtMs: 6_000,
    });
    const v = computeFullLoopVerdict({
      ...baseInput,
      backlog: ['F-001'],
      scenario: { kind: 'lease-steal', stallIndex: 2, stallMs: 1, ttlSec: 1 },
      results: [
        result({
          swarmIndex: 2,
          owner: 'zombie',
          completions: [zombie],
          stalledItem: 'F-001',
          abortSignals: [{ workItemId: 'F-001', claimId: 'c-old' }],
          sideEffects: [{ workItemId: 'F-001', claimId: 'c-old', atMs: 1_100 }],
        }),
        result({
          swarmIndex: 1,
          owner: 'stealer',
          completions: [stealer],
          sideEffects: [{ workItemId: 'F-001', claimId: 'c-new', atMs: 5_100 }],
        }),
      ],
      queenTurn2SawDone: { 'F-001': ['stealer', 'zombie'] },
      // The authority's CURRENT claim is the stealer's — the zombie's lapsed.
      authorityClaims: [claim('F-001', 'c-new', 'pk-stealer', 5_000)],
    });
    expect(v.adoption).not.toBeNull();
    expect(v.adoption!.stalledItem).toBe('F-001');
    expect(v.adoption!.stalledItemRule).toBe('lease-current');
    expect(v.adoption!.adoptedOwner).toBe('stealer');
    expect(v.adoption!.zombieOwner).toBe('zombie');
    expect(v.adoption!.zombieAbortSignaled).toBe(true);
    expect(v.adoption!.sideEffectsDuplicated).toBe(true);
    expect(v.rawDoubleClaimed).toEqual(['F-001']);
  });

  it('revoke: post-revocation grants in the authority store are flagged (EI-284 regression tripwire)', () => {
    const revokeInfo = { revokedPubkey: 'pk-bee', tAuthorityMs: 10_000 };
    const v = computeFullLoopVerdict({
      ...baseInput,
      scenario: { kind: 'revoke', revokeIndex: 2 },
      results: [
        result({
          swarmIndex: 2,
          owner: 'bee',
          completions: [completion({ workItemId: 'F-001', owner: 'bee', acquiredTs: new Date(5_000).toISOString() })],
          refusals: [{ workItemId: 'F-002', atMs: 11_000, reason: 'caller_revoked' }],
          stats: { sweeps: 2, localAuthority: 0, remoteAuthority: 2, failOpen: 0, conflicts: 0, refusedRevoked: 1 },
        }),
        result({
          swarmIndex: 1,
          owner: 'queen',
          completions: [completion({ workItemId: 'F-002', owner: 'queen' })],
        }),
      ],
      queenTurn2SawDone: { 'F-001': ['bee'], 'F-002': ['queen'] },
      // One legit pre-revocation grant, one ILLEGAL post-revocation grant.
      authorityClaims: [
        claim('F-001', 'c1', 'pk-bee', 5_000),
        claim('F-003', 'c3', 'pk-bee', 12_000),
      ],
      revokeInfo,
    });
    expect(v.revoke).not.toBeNull();
    expect(v.revoke!.refusedCount).toBe(1);
    expect(v.revoke!.postRevocationGrants).toEqual(['F-003']);
    expect(v.revoke!.postRevocationCompletions).toEqual([]);
  });
});
