import { describe, it, expect } from 'vitest';
import { partitionByPool, isAttemptable, filterAttemptableTasks, selectFrozenDevAnchor } from '../task-pools';

/**
 * Task-pool partitioning + filtering (P-007, D-013). Pools: train (drives the
 * proposer), frozen dev-anchor (fixed for the run → apples-to-apples champion +
 * circuit-breaker comparison), fresh monitor (per-cycle, overfitting alarm), probe,
 * real-anchor. Plus the "drop tasks the baseline can't even attempt" filter.
 */
type T = { taskId: string; pool: 'train' | 'dev-anchor' | 'monitor' | 'probe' | 'real-anchor' };
const tasks: T[] = [
  { taskId: 'a', pool: 'train' },
  { taskId: 'b', pool: 'train' },
  { taskId: 'c', pool: 'dev-anchor' },
  { taskId: 'd', pool: 'probe' },
  { taskId: 'e', pool: 'real-anchor' },
];

describe('partitionByPool', () => {
  it('groups tasks into the five pools', () => {
    const p = partitionByPool(tasks);
    expect(p.train.map((t) => t.taskId)).toEqual(['a', 'b']);
    expect(p['dev-anchor'].map((t) => t.taskId)).toEqual(['c']);
    expect(p.probe.map((t) => t.taskId)).toEqual(['d']);
    expect(p['real-anchor'].map((t) => t.taskId)).toEqual(['e']);
    expect(p.monitor).toEqual([]);
  });
});

describe('isAttemptable', () => {
  it('treats errored/timeout as un-attemptable; engaged outcomes as attemptable', () => {
    expect(isAttemptable('errored')).toBe(false);
    expect(isAttemptable('timeout')).toBe(false);
    expect(isAttemptable('passed')).toBe(true);
    expect(isAttemptable('failed')).toBe(true);
    expect(isAttemptable('escalated')).toBe(true);
  });
});

describe('filterAttemptableTasks', () => {
  it('drops tasks the baseline errored/timed-out on, and tasks with no baseline outcome', () => {
    const kept = filterAttemptableTasks(tasks, {
      a: 'passed',
      b: 'errored',
      c: 'failed',
      d: 'timeout',
      // e has no baseline outcome → dropped (unknown attemptability)
    });
    expect(kept.map((t) => t.taskId)).toEqual(['a', 'c']);
  });
});

describe('selectFrozenDevAnchor', () => {
  it('deterministically selects n tasks (sorted by id) so the anchor is reproducible', () => {
    const pool: T[] = [
      { taskId: 'z', pool: 'dev-anchor' },
      { taskId: 'm', pool: 'dev-anchor' },
      { taskId: 'a', pool: 'dev-anchor' },
    ];
    expect(selectFrozenDevAnchor(pool, 2).map((t) => t.taskId)).toEqual(['a', 'm']);
    // stable across calls
    expect(selectFrozenDevAnchor(pool, 2)).toEqual(selectFrozenDevAnchor(pool, 2));
  });

  it('returns all when n exceeds the pool size', () => {
    const pool: T[] = [{ taskId: 'a', pool: 'dev-anchor' }];
    expect(selectFrozenDevAnchor(pool, 5)).toHaveLength(1);
  });
});
