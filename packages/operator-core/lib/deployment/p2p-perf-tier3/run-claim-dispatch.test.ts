/**
 * Unit coverage for `computeVerdict` — the pure P-013 verdict core
 * (decentralized-dispatch-scaling-2026-06-08). The live runs (local-parity +
 * Hetzner) feed it real Swarm results; this pins the verdict LOGIC against
 * synthetic completions so the no-starvation / exactly-once / reconcile /
 * determinism judgements are tested in isolation (no processes, no PG).
 */
import { describe, expect, it } from 'vitest';
import { computeVerdict } from './run-claim-dispatch';
import type { ClaimAgentResult, ClaimCompletion } from './claim-agent';

function completion(item: string, owner: string, pubkey: string, acquiredTs: string): ClaimCompletion {
  return {
    workItemId: item,
    claimId: `${owner}-${item}`,
    holderPubkey: pubkey,
    owner,
    acquiredTs,
    via: 'remote-authority',
    completedAtMs: Date.parse(acquiredTs),
  };
}

function result(swarmIndex: number, owner: string, completions: ClaimCompletion[], failOpen = 0): ClaimAgentResult {
  return {
    evt: 'result',
    swarmIndex,
    devicePubkey: `${swarmIndex}-pk`,
    owner,
    completions,
    stats: { sweeps: 1, localAuthority: 0, remoteAuthority: completions.length, failOpen, conflicts: 0 },
  };
}

const backlog = ['F-001', 'F-002', 'F-003', 'F-004'];

describe('computeVerdict', () => {
  it('exactly-once (disjoint completions): no starvation, no double-claim, deterministic', () => {
    const v = computeVerdict({
      swarmCount: 3,
      backlog,
      killedAuthority: null,
      results: [
        result(0, 'swarm-0', [completion('F-001', 'swarm-0', '0-pk', '2026-06-08T12:00:00.000Z')]),
        result(1, 'swarm-1', [completion('F-002', 'swarm-1', '1-pk', '2026-06-08T12:00:01.000Z')]),
        result(2, 'swarm-2', [
          completion('F-003', 'swarm-2', '2-pk', '2026-06-08T12:00:02.000Z'),
          completion('F-004', 'swarm-2', '2-pk', '2026-06-08T12:00:03.000Z'),
        ]),
      ],
    });
    expect(v.starvedItems).toEqual([]);
    expect(v.completedItems).toEqual(['F-001', 'F-002', 'F-003', 'F-004']);
    expect(v.rawDoubleClaimed).toEqual([]);
    expect(v.exactlyOnceObserved).toBe(true);
    expect(v.failOpenObserved).toBe(false);
    expect(v.doubleCompletedAfterReconcile).toEqual([]);
    expect(v.determinismHolds).toBe(true);
  });

  it('double-claimed (fail-open): reconcile yields one deterministic winner per item, none survive doubled', () => {
    const v = computeVerdict({
      swarmCount: 3,
      backlog,
      killedAuthority: { swarmIndex: 0, devicePubkey: '0-pk' },
      results: [
        // Both survivors completed F-003 and F-004 during the partition (tolerated waste).
        result(
          1,
          'swarm-1',
          [
            completion('F-001', 'swarm-1', 'pk-bbb', '2026-06-08T12:00:00.000Z'),
            completion('F-003', 'swarm-1', 'pk-bbb', '2026-06-08T12:00:05.000Z'), // earlier → wins F-003
            completion('F-004', 'swarm-1', 'pk-bbb', '2026-06-08T12:00:09.000Z'),
          ],
          2,
        ),
        result(
          2,
          'swarm-2',
          [
            completion('F-002', 'swarm-2', 'pk-ccc', '2026-06-08T12:00:01.000Z'),
            completion('F-003', 'swarm-2', 'pk-ccc', '2026-06-08T12:00:06.000Z'),
            completion('F-004', 'swarm-2', 'pk-ccc', '2026-06-08T12:00:08.000Z'), // earlier → wins F-004
          ],
          3,
        ),
      ],
    });
    // Whole backlog covered (no starvation) even with the authority dead.
    expect(v.starvedItems).toEqual([]);
    // F-003 + F-004 were each completed by both survivors — the tolerated double-claims.
    expect(v.rawDoubleClaimed).toEqual(['F-003', 'F-004']);
    expect(v.failOpenObserved).toBe(true);
    expect(v.exactlyOnceObserved).toBe(false);
    // Reconcile resolves every contested item to exactly one (earliest-acquire) winner.
    expect(v.doubleCompletedAfterReconcile).toEqual([]);
    expect(v.determinismHolds).toBe(true);
    const winnerOf = (item: string) => v.reconciliations.find((r) => r.workItemId === item)?.winner.owner;
    expect(winnerOf('F-003')).toBe('swarm-1'); // 12:00:05 < 12:00:06
    expect(winnerOf('F-004')).toBe('swarm-2'); // 12:00:08 < 12:00:09
  });

  it('starvation: an item no Swarm completed is reported', () => {
    const v = computeVerdict({
      swarmCount: 3,
      backlog,
      killedAuthority: { swarmIndex: 0, devicePubkey: '0-pk' },
      results: [
        result(1, 'swarm-1', [completion('F-001', 'swarm-1', 'pk-bbb', '2026-06-08T12:00:00.000Z')]),
        result(2, 'swarm-2', [completion('F-002', 'swarm-2', 'pk-ccc', '2026-06-08T12:00:01.000Z')]),
      ],
    });
    // F-003, F-004 were never completed (the dead authority held them, never reclaimed).
    expect(v.starvedItems).toEqual(['F-003', 'F-004']);
    expect(v.completedItems).toEqual(['F-001', 'F-002']);
  });
});
