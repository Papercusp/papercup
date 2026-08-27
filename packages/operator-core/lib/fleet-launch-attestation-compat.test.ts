import { describe, expect, it } from 'vitest';
import {
  mergeFleetLaunchWorkerAttestations,
  type FleetLaunchTransaction,
} from './agent-fleets-store';
import type { FreshLaunchWorkerAttestation } from './agent-launch-core';

/**
 * P-014 rollback / compatibility proof for
 * fleet-worker-lifecycle-convergence-2026-08-26 (D-007).
 *
 * D-007 rules that rollback is a CODE REVERT, not a flag flip and not a data
 * repair, and that the compatibility window is open-ended because every
 * attestation field is optional. Both claims rest on one property that was
 * asserted nowhere: an absent attestation must read as NOT ATTESTED — never as
 * "failed", never as a manufactured empty array, and never as a silently
 * not-ready member.
 *
 * That property is what makes a revert safe: transactions written by the new
 * code are read by the old, and vice versa, without either side inventing a
 * verdict it did not observe. These tests pin it.
 */

function transaction(overrides: Partial<FleetLaunchTransaction> = {}): FleetLaunchTransaction {
  return {
    requestedMemberIds: ['owner-a', 'owner-b'],
    failed: [],
    waves: [],
    recovery: { retryOwnerIds: [], nextAction: 'none' },
    ...overrides,
  } as FleetLaunchTransaction;
}

function attestation(
  ownerId: string,
  ready: boolean,
): FreshLaunchWorkerAttestation {
  return {
    version: 1,
    ownerId,
    ready,
    stages: {
      agentCall: { status: ready ? 'satisfied' : 'missing', successfulCalls: ready ? 3 : 0 },
      durableWake: { status: ready ? 'satisfied' : 'missing', wakeSource: ready ? 'loop' : null },
      schedulerPull: { status: ready ? 'satisfied' : 'missing', calls: ready ? 1 : 0, successfulCalls: ready ? 1 : 0 },
      disposition: ready
        ? { status: 'satisfied', kind: 'claimed', workItemId: 'WI-1' }
        : { status: 'missing', kind: 'missing' },
    },
    failures: [],
  };
}

describe('fleet launch attestation compatibility (P-014 rollback proof)', () => {
  it('leaves a pre-attestation transaction untouched rather than manufacturing a verdict', () => {
    // The shape written by code BEFORE P-003, and the shape a revert produces.
    const tx = transaction();
    mergeFleetLaunchWorkerAttestations(tx, [
      { ownerId: 'owner-a', workerAttestation: undefined },
      { ownerId: 'owner-b', workerAttestation: undefined },
    ] as never);

    // Not attested — NOT an empty array, and NOT an empty ready list. A reader
    // must be able to tell "nobody attested" from "everybody attested as not ready".
    expect(tx.workerAttestations).toBeUndefined();
    expect(tx.workerReadyMemberIds).toBeUndefined();
  });

  it('does not erase a recorded attestation when a later pass observes nothing', () => {
    // A mixed-version fleet, or a probe that simply could not see the session:
    // silence must not retract evidence that was already observed.
    const tx = transaction({ workerAttestations: [attestation('owner-a', true)] });
    mergeFleetLaunchWorkerAttestations(tx, [
      { ownerId: 'owner-b', workerAttestation: undefined },
    ] as never);

    expect(tx.workerAttestations).toHaveLength(1);
    expect(tx.workerAttestations?.[0]?.ownerId).toBe('owner-a');
    expect(tx.workerReadyMemberIds).toEqual(['owner-a']);
  });

  it('counts only members whose attestation is actually ready', () => {
    const tx = transaction();
    mergeFleetLaunchWorkerAttestations(tx, [
      { ownerId: 'owner-a', workerAttestation: attestation('owner-a', true) },
      { ownerId: 'owner-b', workerAttestation: attestation('owner-b', false) },
    ] as never);

    expect(tx.workerReadyMemberIds).toEqual(['owner-a']);
    expect(tx.workerAttestations).toHaveLength(2);
    // The not-ready member is RECORDED, not dropped — its failing stages are the diagnosis.
    const b = tx.workerAttestations?.find((a) => a.ownerId === 'owner-b');
    expect(b?.ready).toBe(false);
    expect(b?.stages.disposition.status).toBe('missing');
  });

  it('orders attestations by requested member order and tolerates an unrequested owner', () => {
    const tx = transaction({ requestedMemberIds: ['owner-a', 'owner-b'] });
    mergeFleetLaunchWorkerAttestations(tx, [
      { ownerId: 'owner-z', workerAttestation: attestation('owner-z', true) },
      { ownerId: 'owner-b', workerAttestation: attestation('owner-b', true) },
      { ownerId: 'owner-a', workerAttestation: attestation('owner-a', true) },
    ] as never);

    expect(tx.workerAttestations?.map((a) => a.ownerId)).toEqual(['owner-a', 'owner-b', 'owner-z']);
    // An owner nobody requested cannot count toward readiness.
    expect(tx.workerReadyMemberIds).toEqual(['owner-a', 'owner-b']);
  });

  it('a later ready observation supersedes an earlier not-ready one for the same owner', () => {
    // Slow boot: the first pass sees nothing satisfied, a later pass sees a real worker.
    const tx = transaction({ workerAttestations: [attestation('owner-a', false)] });
    mergeFleetLaunchWorkerAttestations(tx, [
      { ownerId: 'owner-a', workerAttestation: attestation('owner-a', true) },
    ] as never);

    expect(tx.workerAttestations).toHaveLength(1);
    expect(tx.workerAttestations?.[0]?.ready).toBe(true);
    expect(tx.workerReadyMemberIds).toEqual(['owner-a']);
  });
});
