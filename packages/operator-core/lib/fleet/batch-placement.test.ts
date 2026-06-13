import { describe, it, expect } from 'vitest';
import { planBatchPlacement, type BatchPlacementInput } from './batch-placement';
import type { PlacementBee, PlacementTask } from './placement-affinity';

const NOW = 1_000_000_000_000;

function task(id: string, over: Partial<PlacementTask> = {}): PlacementTask {
  return { id, harness: 'papercup', title: `task ${id}`, ...over };
}
function bee(ownerId: string, over: Partial<PlacementBee> = {}): PlacementBee {
  return { ownerId, load: 0, alive: true, ...over };
}
function plan(over: Partial<BatchPlacementInput>): BatchPlacementInput {
  return { tasks: [], bees: [], headroom: 0, now: NOW, ...over };
}

describe('planBatchPlacement', () => {
  it('with no bees and N slots, spawns min(N, tasks) fresh and queues the rest', () => {
    const tasks = [task('WI-1'), task('WI-2'), task('WI-3')];
    const out = planBatchPlacement(plan({ tasks, bees: [], headroom: 2 }));
    expect(out.spawnCount).toBe(2);
    expect(out.unplacedCount).toBe(1);
    expect(out.injectCount).toBe(0);
    expect(out.decisions.map((d) => d.disposition)).toEqual(['spawn', 'spawn', 'unplaced']);
    expect(out.remainingHeadroom).toBe(0);
  });

  it('warm-injects onto a high-affinity bee instead of consuming a slot', () => {
    const tasks = [task('WI-1', { planSlug: 'plan-a' })];
    const bees = [bee('s-warm', { currentPlanSlug: 'plan-a', load: 0 })];
    const out = planBatchPlacement(plan({ tasks, bees, headroom: 5 }));
    expect(out.injectCount).toBe(1);
    expect(out.spawnCount).toBe(0);
    expect(out.remainingHeadroom).toBe(5); // a warm-inject does NOT consume a spawn slot
    const d = out.decisions[0];
    expect(d.disposition).toBe('warm-inject');
    expect(d.bee).toBe('s-warm');
    expect(d.rank).toBe(0);
    expect(out.projectedLoad['s-warm']).toBe(1);
  });

  it('falls back to a fresh spawn when no bee clears the affinity floor', () => {
    const tasks = [task('WI-1', { title: 'unrelated work', harness: 'papercup' })];
    // A live bee with only a weak cross-harness recency signal — below minInjectAffinity.
    const bees = [bee('s-cold', { harness: 'restart', lastActiveMs: NOW - 60 * 60_000 })];
    const out = planBatchPlacement(plan({ tasks, bees, headroom: 1 }));
    expect(out.spawnCount).toBe(1);
    expect(out.injectCount).toBe(0);
  });

  it('respects the per-bee inject cap (overflow spawns / queues)', () => {
    const tasks = [task('WI-1', { planSlug: 'plan-a' }), task('WI-2', { planSlug: 'plan-a' }), task('WI-3', { planSlug: 'plan-a' })];
    const bees = [bee('s-warm', { currentPlanSlug: 'plan-a', load: 0 })];
    const out = planBatchPlacement(plan({ tasks, bees, headroom: 1, maxInjectPerBee: 2 }));
    expect(out.injectCount).toBe(2); // capped at 2 onto the one warm bee
    expect(out.spawnCount).toBe(1); // third overflows to the free slot
    expect(out.projectedLoad['s-warm']).toBe(2);
    // injects land at consecutive head-of-line ranks 0,1
    const injects = out.decisions.filter((d) => d.disposition === 'warm-inject');
    expect(injects.map((d) => d.rank)).toEqual([0, 1]);
  });

  it('respects the load threshold (a near-full bee is not a warm target)', () => {
    const tasks = [task('WI-1', { planSlug: 'plan-a' })];
    const bees = [bee('s-loaded', { currentPlanSlug: 'plan-a', load: 3 })]; // >= default threshold 3
    const out = planBatchPlacement(plan({ tasks, bees, headroom: 1 }));
    expect(out.injectCount).toBe(0);
    expect(out.spawnCount).toBe(1);
  });

  it('honors the max cap across the whole batch', () => {
    const tasks = [task('WI-1'), task('WI-2'), task('WI-3')];
    const out = planBatchPlacement(plan({ tasks, bees: [], headroom: 5, max: 1 }));
    expect(out.spawnCount).toBe(1);
    expect(out.unplacedCount).toBe(2);
    expect(out.decisions[2].reason).toMatch(/batch cap/);
  });

  it('queues everything when there is no headroom and no warm bee', () => {
    const tasks = [task('WI-1'), task('WI-2')];
    const out = planBatchPlacement(plan({ tasks, bees: [], headroom: 0 }));
    expect(out.unplacedCount).toBe(2);
    expect(out.spawnCount).toBe(0);
  });

  it('prefers warm-inject for the affined task and spawns the orthogonal one', () => {
    const tasks = [
      task('WI-affined', { planSlug: 'plan-a', harness: 'papercup' }),
      task('WI-orthogonal', { harness: 'restart', title: 'totally different' }),
    ];
    const bees = [bee('s-warm', { currentPlanSlug: 'plan-a', harness: 'papercup', load: 0 })];
    const out = planBatchPlacement(plan({ tasks, bees, headroom: 1 }));
    expect(out.injectCount).toBe(1);
    expect(out.spawnCount).toBe(1);
    const inject = out.decisions.find((d) => d.disposition === 'warm-inject');
    expect(inject?.task.id).toBe('WI-affined');
  });
});
