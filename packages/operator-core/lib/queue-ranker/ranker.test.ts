import { describe, it, expect, vi } from 'vitest';
import { describeFeatures, rankQueue, type FeatureValue, type QueueFeature } from './ranker';

interface Item {
  id: string;
}
interface Ctx {
  tag: string;
}

function feat(
  name: string,
  weight: number,
  values: Record<string, FeatureValue>,
): QueueFeature<Item, Ctx> {
  return {
    name,
    weight,
    description: `${name} test feature`,
    score: () => new Map(Object.entries(values)),
  };
}

const OPTS = { getKey: (i: Item) => i.id };

describe('rankQueue', () => {
  it('scores as the weighted sum and sorts descending, with the full per-feature breakdown on every item', async () => {
    const features = [
      feat('alpha', 2, { a: { value: 3, reasons: ['three alphas'] }, b: { value: 5 } }),
      feat('beta', 0.5, { a: { value: 10 } }),
    ];
    const ranked = await rankQueue([{ id: 'a' }, { id: 'b' }], { tag: 't' }, { ...OPTS, features });

    expect(ranked.map((r) => r.id)).toEqual(['a', 'b']); // a: 3×2 + 10×0.5 = 11 > b: 5×2 = 10
    expect(ranked[0].rank.score).toBe(11);
    expect(ranked[0].rank.features).toEqual([
      { feature: 'alpha', value: 3, weight: 2, contribution: 6, reasons: ['three alphas'] },
      { feature: 'beta', value: 10, weight: 0.5, contribution: 5, reasons: [] },
    ]);
    // A feature that saw nothing still appears — zero contribution, stable shape.
    expect(ranked[1].rank.features).toEqual([
      { feature: 'alpha', value: 5, weight: 2, contribution: 10, reasons: [] },
      { feature: 'beta', value: 0, weight: 0.5, contribution: 0, reasons: [] },
    ]);
  });

  it('supports negative values (a demoting signal)', async () => {
    const features = [
      feat('boost', 1, { a: { value: 4 }, b: { value: 4 } }),
      feat('demote', 1, { a: { value: -3 } }),
    ];
    const ranked = await rankQueue([{ id: 'a' }, { id: 'b' }], { tag: 't' }, { ...OPTS, features });
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a']);
    expect(ranked[1].rank.score).toBe(1);
  });

  it('breaks score ties with the tieBreak comparator, else keeps input order', async () => {
    const features = [feat('flat', 1, { a: { value: 2 }, b: { value: 2 }, c: { value: 2 } })];
    const inputOrder = await rankQueue([{ id: 'b' }, { id: 'c' }, { id: 'a' }], { tag: 't' }, { ...OPTS, features });
    expect(inputOrder.map((r) => r.id)).toEqual(['b', 'c', 'a']);

    const tied = await rankQueue([{ id: 'b' }, { id: 'c' }, { id: 'a' }], { tag: 't' }, {
      ...OPTS,
      features,
      tieBreak: (x, y) => x.id.localeCompare(y.id),
    });
    expect(tied.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('merges feature `attach` payloads onto the ranked item', async () => {
    const features = [
      feat('attacher', 1, { a: { value: 1, attach: { impact: { score: 1 } } } }),
    ];
    const ranked = await rankQueue([{ id: 'a' }], { tag: 't' }, { ...OPTS, features });
    expect((ranked[0] as { impact?: { score: number } }).impact).toEqual({ score: 1 });
    expect(ranked[0].id).toBe('a'); // original fields survive
  });

  it('degrades a throwing feature to zero contributions; the rest still rank', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const features: QueueFeature<Item, Ctx>[] = [
        {
          name: 'broken',
          weight: 9,
          description: 'always throws',
          score: () => Promise.reject(new Error('signal source down')),
        },
        feat('alive', 1, { a: { value: 1 }, b: { value: 2 } }),
      ];
      const ranked = await rankQueue([{ id: 'a' }, { id: 'b' }], { tag: 't' }, { ...OPTS, features });
      expect(ranked.map((r) => r.id)).toEqual(['b', 'a']);
      expect(ranked[0].rank.features[0]).toEqual({
        feature: 'broken',
        value: 0,
        weight: 9,
        contribution: 0,
        reasons: [],
      });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('passes the shared context to every feature and returns [] for an empty queue', async () => {
    const score = vi.fn(() => new Map<string, FeatureValue>());
    const features: QueueFeature<Item, Ctx>[] = [
      { name: 'ctx-spy', weight: 1, description: 'spies on ctx', score },
    ];
    expect(await rankQueue([], { tag: 'empty' }, { ...OPTS, features })).toEqual([]);
    expect(score).not.toHaveBeenCalled(); // empty queue short-circuits

    await rankQueue([{ id: 'a' }], { tag: 'full' }, { ...OPTS, features });
    expect(score).toHaveBeenCalledWith([{ id: 'a' }], { tag: 'full' });
  });
});

describe('describeFeatures', () => {
  it('returns the registry as inspectable data', () => {
    const features = [feat('alpha', 2, {}), feat('beta', 0.5, {})];
    expect(describeFeatures(features)).toEqual([
      { name: 'alpha', weight: 2, description: 'alpha test feature' },
      { name: 'beta', weight: 0.5, description: 'beta test feature' },
    ]);
  });
});
