/**
 * queue-concurrency.test.ts — F-E3 (app-wide-load-traps § E): DBOS WorkflowQueue
 * concurrency must scale DOWN on small hosts and never exceed the big-box ceiling.
 */
import { describe, expect, it } from 'vitest';
import { clampQueueConcurrency, queueConcurrency } from './queue-concurrency';

describe('clampQueueConcurrency (pure)', () => {
  it('a small host (derived 1) drops every queue to 1', () => {
    expect(clampQueueConcurrency(8, 1)).toBe(1); // durable-spawn-fire
    expect(clampQueueConcurrency(4, 1)).toBe(1); // the four concurrency-4 queues
  });

  it('a big host (derived 32) keeps each queue at its big-box ceiling (never above)', () => {
    expect(clampQueueConcurrency(8, 32)).toBe(8);
    expect(clampQueueConcurrency(4, 32)).toBe(4);
  });

  it('the host value caps the ceiling when it sits between 1 and the literal', () => {
    expect(clampQueueConcurrency(8, 2)).toBe(2);
    expect(clampQueueConcurrency(8, 8)).toBe(8);
  });

  it('floors at 1 — a queue must always drain', () => {
    expect(clampQueueConcurrency(4, 0)).toBe(1);
    expect(clampQueueConcurrency(4, -5)).toBe(1);
  });

  it('never raises a queue above its big-box ceiling (no new server load)', () => {
    for (const ceiling of [4, 8]) {
      for (const host of [1, 2, 4, 8, 16, 32, 128]) {
        const got = clampQueueConcurrency(ceiling, host);
        expect(got).toBeLessThanOrEqual(ceiling);
        expect(got).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('queueConcurrency (wired to the live resource profile)', () => {
  it('stays within [1, ceiling] on whatever host runs the test', () => {
    for (const ceiling of [4, 8]) {
      const got = queueConcurrency(ceiling);
      expect(Number.isInteger(got)).toBe(true);
      expect(got).toBeGreaterThanOrEqual(1);
      expect(got).toBeLessThanOrEqual(ceiling);
    }
  });
});
