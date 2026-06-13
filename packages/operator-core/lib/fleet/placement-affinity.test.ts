import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AFFINITY_WEIGHTS,
  rankBeesForTask,
  scoreAffinity,
  scoreExplicitIntent,
  scoreFileOverlap,
  scoreQueueSimilarity,
  scoreRecentActivity,
  type PlacementBee,
  type PlacementTask,
} from './placement-affinity';

const NOW = 1_000_000_000_000;

function bee(over: Partial<PlacementBee> = {}): PlacementBee {
  return { ownerId: 's-bee', load: 0, alive: true, ...over };
}
function task(over: Partial<PlacementTask> = {}): PlacementTask {
  return { id: 'WI-1', harness: 'papercup', title: 'do a thing', ...over };
}

describe('placement-affinity — individual signals', () => {
  it('explicit-intent: same declared plan is the strongest', () => {
    expect(
      scoreExplicitIntent(task({ planSlug: 'plan-x' }), bee({ currentPlanSlug: 'plan-x' })),
    ).toBe(1);
  });

  it('explicit-intent: intent text naming the work-item id fires fully', () => {
    expect(scoreExplicitIntent(task({ id: 'WI-42' }), bee({ intent: 'working on WI-42 right now' }))).toBe(1);
  });

  it('explicit-intent: title keyword overlap is a weaker graded signal (<= 0.8)', () => {
    const s = scoreExplicitIntent(
      task({ title: 'refactor placement ranker engine' }),
      bee({ intent: 'placement ranker cleanup' }),
    );
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(0.8);
  });

  it('explicit-intent: unrelated intent scores 0', () => {
    expect(scoreExplicitIntent(task({ title: 'voice channels' }), bee({ intent: 'database migration' }))).toBe(0);
  });

  it('file-overlap: fraction of task files the bee already has open', () => {
    const t = task({ files: ['packages/x/a.ts', 'packages/x/b.ts'] });
    expect(scoreFileOverlap(t, bee({ currentFiles: ['packages/x/a.ts'] }))).toBe(0.5);
    expect(scoreFileOverlap(t, bee({ currentFiles: ['packages/x/a.ts', 'packages/x/b.ts'] }))).toBe(1);
    expect(scoreFileOverlap(t, bee({ currentFiles: ['packages/y/z.ts'] }))).toBe(0);
  });

  it('file-overlap: suffix match treats a basename as overlapping its full path', () => {
    const t = task({ files: ['a.ts'] });
    expect(scoreFileOverlap(t, bee({ currentFiles: ['packages/x/a.ts'] }))).toBe(1);
    // but not a spurious substring (xa.ts must not match a.ts)
    expect(scoreFileOverlap(t, bee({ currentFiles: ['packages/x/xa.ts'] }))).toBe(0);
  });

  it('file-overlap: no task files ⇒ 0', () => {
    expect(scoreFileOverlap(task({ files: [] }), bee({ currentFiles: ['a.ts'] }))).toBe(0);
  });

  it('recent-activity: fresh same-harness activity is 1, decays with age, 0 when unknown', () => {
    const t = task({ harness: 'papercup' });
    expect(scoreRecentActivity(t, bee({ harness: 'papercup', lastActiveMs: NOW - 30_000 }), NOW)).toBe(1);
    expect(scoreRecentActivity(t, bee({ harness: 'papercup', lastActiveMs: NOW - 60 * 60_000 }), NOW)).toBe(0);
    expect(scoreRecentActivity(t, bee({ harness: 'papercup', lastActiveMs: null }), NOW)).toBe(0);
    const mid = scoreRecentActivity(t, bee({ harness: 'papercup', lastActiveMs: NOW - 16 * 60_000 }), NOW);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('recent-activity: cross-harness activity is discounted', () => {
    const t = task({ harness: 'papercup' });
    const same = scoreRecentActivity(t, bee({ harness: 'papercup', lastActiveMs: NOW - 30_000 }), NOW);
    const other = scoreRecentActivity(t, bee({ harness: 'restart', lastActiveMs: NOW - 30_000 }), NOW);
    expect(other).toBeLessThan(same);
    expect(other).toBeCloseTo(0.4, 5);
  });

  it('queue-similarity: doing-harness match > queued-harness match > none', () => {
    const t = task({ harness: 'papercup' });
    expect(scoreQueueSimilarity(t, bee({ doingHarness: 'papercup' }))).toBe(1);
    expect(scoreQueueSimilarity(t, bee({ doingHarness: 'restart', queuedHarnesses: ['papercup'] }))).toBe(0.6);
    expect(scoreQueueSimilarity(t, bee({ doingHarness: 'restart', queuedHarnesses: ['other'] }))).toBe(0);
  });
});

describe('placement-affinity — weighted ordering (lexicographic)', () => {
  it('a fully-fired explicit-intent outranks every lower signal combined', () => {
    const t = task({ id: 'WI-7', planSlug: 'plan-a', harness: 'papercup', files: ['a.ts'] });
    const intentBee = bee({ ownerId: 's-intent', currentPlanSlug: 'plan-a' });
    const everythingElseBee = bee({
      ownerId: 's-rest',
      currentFiles: ['a.ts'], // file-overlap 1
      doingHarness: 'papercup', // queue-similarity 1
      lastActiveMs: NOW, // recent 1
      harness: 'papercup',
    });
    const si = scoreAffinity(t, intentBee, { now: NOW }).score;
    const se = scoreAffinity(t, everythingElseBee, { now: NOW }).score;
    expect(si).toBeGreaterThan(se);
  });

  it('file-overlap outranks recent-activity + queue-similarity combined', () => {
    const t = task({ harness: 'papercup', files: ['a.ts'] });
    const fileBee = bee({ ownerId: 's-file', currentFiles: ['a.ts'] });
    const lowerBee = bee({
      ownerId: 's-lower',
      doingHarness: 'papercup', // queue 1
      harness: 'papercup',
      lastActiveMs: NOW, // recent 1
    });
    expect(scoreAffinity(t, fileBee, { now: NOW }).score).toBeGreaterThan(
      scoreAffinity(t, lowerBee, { now: NOW }).score,
    );
  });

  it('weights are strictly decreasing in the documented order', () => {
    const w = DEFAULT_AFFINITY_WEIGHTS;
    expect(w.explicitIntent).toBeGreaterThan(w.fileOverlap + w.recentActivity + w.queueSimilarity);
    expect(w.fileOverlap).toBeGreaterThan(w.recentActivity + w.queueSimilarity);
    expect(w.recentActivity).toBeGreaterThan(w.queueSimilarity);
  });
});

describe('rankBeesForTask', () => {
  it('orders by affinity desc and excludes dead bees', () => {
    const t = task({ harness: 'papercup', planSlug: 'plan-a' });
    const bees = [
      bee({ ownerId: 's-cold', alive: true }),
      bee({ ownerId: 's-warm', currentPlanSlug: 'plan-a', alive: true }),
      bee({ ownerId: 's-dead', currentPlanSlug: 'plan-a', alive: false }),
    ];
    const ranked = rankBeesForTask(t, bees, { now: NOW });
    expect(ranked.map((r) => r.bee)).toEqual(['s-warm', 's-cold']);
  });

  it('ties break toward the less-loaded bee', () => {
    const t = task({ harness: 'papercup' });
    const bees = [
      bee({ ownerId: 's-busy', load: 3 }),
      bee({ ownerId: 's-free', load: 0 }),
    ];
    const ranked = rankBeesForTask(t, bees, { now: NOW });
    expect(ranked[0].bee).toBe('s-free');
  });
});
