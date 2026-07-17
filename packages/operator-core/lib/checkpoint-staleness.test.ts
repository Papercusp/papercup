import { describe, it, expect } from 'vitest';
import {
  computeCheckpointStaleness,
  CHECKPOINT_RELATIVE_STALE_LAG_MS,
} from './checkpoint-staleness';

const MIN = 60_000;

describe('computeCheckpointStaleness (EI-15184 — relative checkpoint staleness)', () => {
  it('flags stale when the assignee was active materially AFTER the checkpoint (the WI-5013 case)', () => {
    // checkpoint written at T, assignee kept working to T+25m (the incident gap).
    const cp = 1_000_000_000_000;
    const r = computeCheckpointStaleness({
      checkpointUpdatedAtMs: cp,
      assigneeActiveAtMs: cp + 25 * MIN,
    });
    expect(r.stale).toBe(true);
    expect(r.lagMs).toBe(25 * MIN);
    expect(r.reason).toMatch(/after this checkpoint/i);
    expect(r.reason).toMatch(/verify ground truth/i);
    // the rounded lag is surfaced to the reader
    expect(r.reason).toContain('~25m');
  });

  it('does NOT flag when activity is within the lag threshold (normal checkpoint-then-a-few-calls cadence)', () => {
    const cp = 1_000_000_000_000;
    const r = computeCheckpointStaleness({
      checkpointUpdatedAtMs: cp,
      assigneeActiveAtMs: cp + 2 * MIN, // under the 5m default
    });
    expect(r.stale).toBe(false);
    expect(r.lagMs).toBe(2 * MIN);
    expect(r.reason).toBeUndefined();
  });

  it('does NOT flag when the assignee last acted BEFORE/at the checkpoint (checkpoint is the latest state)', () => {
    const cp = 1_000_000_000_000;
    const r = computeCheckpointStaleness({
      checkpointUpdatedAtMs: cp,
      assigneeActiveAtMs: cp - 10 * MIN,
    });
    expect(r.stale).toBe(false);
    expect(r.lagMs).toBe(-10 * MIN);
  });

  it('is warn-only: cannot prove a gap without BOTH timestamps → not stale, lagMs null', () => {
    const cp = 1_000_000_000_000;
    expect(
      computeCheckpointStaleness({ checkpointUpdatedAtMs: cp, assigneeActiveAtMs: null }),
    ).toEqual({ stale: false, lagMs: null });
    expect(
      computeCheckpointStaleness({ checkpointUpdatedAtMs: null, assigneeActiveAtMs: cp }),
    ).toEqual({ stale: false, lagMs: null });
    expect(
      computeCheckpointStaleness({ checkpointUpdatedAtMs: undefined, assigneeActiveAtMs: undefined }),
    ).toEqual({ stale: false, lagMs: null });
    // NaN is not a provable timestamp either
    expect(
      computeCheckpointStaleness({ checkpointUpdatedAtMs: NaN, assigneeActiveAtMs: cp }),
    ).toEqual({ stale: false, lagMs: null });
  });

  it('honours a custom lag threshold', () => {
    const cp = 1_000_000_000_000;
    // 3m lag: stale under a 1m threshold, not under the 5m default
    expect(
      computeCheckpointStaleness({
        checkpointUpdatedAtMs: cp,
        assigneeActiveAtMs: cp + 3 * MIN,
        lagThresholdMs: 1 * MIN,
      }).stale,
    ).toBe(true);
    expect(
      computeCheckpointStaleness({
        checkpointUpdatedAtMs: cp,
        assigneeActiveAtMs: cp + 3 * MIN,
      }).stale,
    ).toBe(false);
  });

  it('boundary: a lag exactly at the threshold is NOT stale (strict >)', () => {
    const cp = 1_000_000_000_000;
    const r = computeCheckpointStaleness({
      checkpointUpdatedAtMs: cp,
      assigneeActiveAtMs: cp + CHECKPOINT_RELATIVE_STALE_LAG_MS,
    });
    expect(r.stale).toBe(false);
  });
});
