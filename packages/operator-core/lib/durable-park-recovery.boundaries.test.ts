import { describe, expect, it } from 'vitest';
import { createParkRecoveryReceipt, expireParkRecovery, renewParkRecovery,
  type ParkProgressEvidence, type ParkRecoveryPolicy } from './durable-park-recovery';

const MINUTE = 60_000;
const START = 1_000_000;
const receiptFor = (policy: ParkRecoveryPolicy) => createParkRecoveryReceipt({
  workspaceId: 'boundary-workspace', harness: 'boundary-harness', workItemId: 'WI-boundary',
  condition: { condition: 'Retained inputs qualified', trigger: 'boundary:ready', owner: 'su-boundary' },
  generation: 1, dependencyRefs: ['WI-dependency'], admittedAtMs: START, policy,
});
const progressAt = (sequence: number, elapsedMs: number): ParkProgressEvidence => ({
  kind: 'checkpoint', subjectRef: 'WI-dependency', sequence,
  persistedAtMs: START + elapsedMs, evidenceRef: 'checkpoint:' + sequence,
});

describe('independent PARK-PROGRESS boundary oracles', () => {
  // Leave room for a third deadline so the absolute cap cannot mask a broken
  // extension-count check. The server's default policy is tested separately.
  const countPolicy = { initialMs: 30 * MINUTE, extensionMs: 30 * MINUTE,
    maxExtensions: 2, maxAgeMs: 120 * MINUTE };

  it('accepts the last permitted renewal before the absolute deadline', () => {
    const first = renewParkRecovery(receiptFor(countPolicy), progressAt(1, MINUTE), START + MINUTE);
    expect(first.accepted).toBe(true);
    const second = renewParkRecovery(first.receipt, progressAt(2, 2 * MINUTE), START + 2 * MINUTE);
    expect(second.accepted).toBe(true);
    expect(second.receipt).toMatchObject({ extensions: 2, deadlineMs: START + 90 * MINUTE,
      absoluteDeadlineMs: START + 120 * MINUTE });
    expect(first.receipt.extensions).toBe(1);
  });

  it('rejects renewal limit plus one before the absolute deadline', () => {
    const first = renewParkRecovery(receiptFor(countPolicy), progressAt(1, MINUTE), START + MINUTE).receipt;
    const second = renewParkRecovery(first, progressAt(2, 2 * MINUTE), START + 2 * MINUTE).receipt;
    expect(second.extensions).toBe(2);
    expect(second.deadlineMs + countPolicy.extensionMs).toBe(second.absoluteDeadlineMs);
    const third = renewParkRecovery(second, progressAt(3, 3 * MINUTE), START + 3 * MINUTE);
    expect(third).toEqual({ accepted: false, receipt: second });
    expect(third.receipt).toBe(second);
  });

  it.each([
    ['one millisecond before', -1, 'waiting'],
    ['exact', 0, 'recovery'],
    ['plus one', 1, 'recovery'],
  ] as const)('absolute deadline %s preserves the bounded recovery decision', (_label, offset, state) => {
    const receipt = receiptFor({ initialMs: 40 * MINUTE, extensionMs: 40 * MINUTE,
      maxExtensions: 10, maxAgeMs: 90 * MINUTE });
    const first = renewParkRecovery(receipt, progressAt(1, MINUTE), START + MINUTE).receipt;
    const second = renewParkRecovery(first, progressAt(2, 79 * MINUTE), START + 79 * MINUTE).receipt;
    expect(second).toMatchObject({ extensions: 2, deadlineMs: START + 90 * MINUTE,
      absoluteDeadlineMs: START + 90 * MINUTE });
    const now = START + 90 * MINUTE + offset;
    expect(expireParkRecovery(second, now)).toMatchObject({ state, id: receipt.id });
    expect(renewParkRecovery(second, progressAt(3, 90 * MINUTE + offset), now))
      .toEqual({ accepted: false, receipt: second });
  });
});
