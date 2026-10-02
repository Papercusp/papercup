/**
 * WI-10005164 — createSubPassHealth keeps a fail-soft sub-pass failure set ACROSS
 * ticks until that sub-pass next succeeds, and turns it into the action's
 * `softError` (which both executors record as `last_error`).
 *
 * The cross-tick property is the point: task-reconcile ticks every 30 s while its
 * lifecycle sweep runs hourly. A failure reported only on the sweep's own tick
 * would be cleared by the next tick's clean return 30 s later.
 */
import { describe, expect, it } from 'vitest';
import { createSubPassHealth } from './system-actions';

const T0 = Date.parse('2026-10-01T00:02:00.000Z');

describe('createSubPassHealth', () => {
  it('returns undefined while every sub-pass is healthy', () => {
    const health = createSubPassHealth();
    expect(health.result()).toBeUndefined();
    health.record('task-lifecycle', null, T0);
    expect(health.result()).toBeUndefined();
  });

  it('keeps a failure set on later ticks that do not run the sub-pass', () => {
    const health = createSubPassHealth();
    health.record('task-lifecycle', new Error('column "assignee" does not exist'), T0);
    // Later 30 s ticks run only the kernel pass; nothing records task-lifecycle.
    const first = health.result();
    const later = health.result();
    expect(first?.softError).toBe(
      'task-lifecycle sub-pass failing (1x since 2026-10-01T00:02:00.000Z): column "assignee" does not exist',
    );
    expect(later).toEqual(first);
  });

  it('counts consecutive failures from the first failure time, and clears on success', () => {
    const health = createSubPassHealth();
    health.record('task-lifecycle', new Error('42703'), T0);
    health.record('task-lifecycle', new Error('42703 again'), T0 + 3_600_000);
    expect(health.failures()).toEqual([
      { name: 'task-lifecycle', message: '42703 again', since: '2026-10-01T00:02:00.000Z', consecutive: 2 },
    ]);
    health.record('task-lifecycle', null, T0 + 7_200_000);
    expect(health.result()).toBeUndefined();
    // A new streak starts from its own first failure.
    health.record('task-lifecycle', 'boom', T0 + 10_800_000);
    expect(health.failures()[0]).toMatchObject({ since: '2026-10-01T03:02:00.000Z', consecutive: 1 });
  });

  it('reports each failing sub-pass, and only the failing ones', () => {
    const health = createSubPassHealth();
    health.record('failed-task-unit-collector', new Error('a'), T0);
    health.record('task-lifecycle', new Error('b'), T0);
    health.record('a11y-bus-sweep', null, T0);
    const result = health.result();
    expect(result?.softError).toContain('failed-task-unit-collector sub-pass failing');
    expect(result?.softError).toContain('task-lifecycle sub-pass failing');
    expect(result?.softError).not.toContain('a11y-bus-sweep');
    expect((result?.diagnostics?.subPassFailures as unknown[]).length).toBe(2);
    health.record('failed-task-unit-collector', null, T0);
    expect(health.failures().map((f) => f.name)).toEqual(['task-lifecycle']);
  });

  it('bounds softError to the 600 characters the executors keep', () => {
    const health = createSubPassHealth();
    health.record('task-lifecycle', new Error('x'.repeat(2_000)), T0);
    expect(health.result()?.softError?.length).toBe(600);
  });
});
