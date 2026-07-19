/**
 * hygiene unit tests (knowledge-pack-loop-integrity-2026-07-19 P-008) — the
 * cleanup tick against injected deps: age-gated re-review with the D-004
 * never-destroy-on-error posture, hand-authored items exempt, the
 * pristine-pack-vs-organic-only auto-resolution rule, and the dismissed prune.
 */
import { describe, expect, it, vi } from 'vitest';
import { runKnowledgeHygieneTick, type HygieneConflictPair, type HygieneDeps } from './hygiene';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-19T00:00:00Z');

const failLlm = vi.fn(async () => ({ text: '{"verdict":"fail","reason":"incident noise"}', costUsd: 0 }));
const passLlm = vi.fn(async () => ({
  text: '{"verdict":"pass","title":"T","lesson":"Still a good lesson."}',
  costUsd: 0,
}));

const pair = (over: Partial<HygieneConflictPair> = {}): HygieneConflictPair => ({
  hive: 'h1',
  aId: 'a',
  aText: 'A text',
  bId: 'b',
  bText: 'B text',
  summary: 'A contradicts B',
  aPristinePack: false,
  bPristinePack: false,
  ...over,
});

const deps = (over: Partial<HygieneDeps> = {}): HygieneDeps => ({
  listPackItems: async () => [],
  distiller: passLlm,
  retirePackItem: vi.fn(async () => {}),
  forgetPristinePoolRows: async () => 0,
  listHives: async () => [],
  sweepConflicts: async () => [],
  forgetRow: vi.fn(async () => {}),
  fileConflict: vi.fn(async () => {}),
  pruneDismissed: async () => 0,
  ...over,
});

const opts = { now: () => NOW };

describe('runKnowledgeHygieneTick — pack re-review', () => {
  it('retires an old item the judge fails and forgets its pristine pool rows; young + hand-authored items untouched', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const retire = vi.fn(async () => {});
    const d = deps({
      listPackItems: async () => [
        { itemId: 'old-noise', title: 'Old', text: 'log=6b29… stalled', adoptedAt: new Date(NOW - 40 * DAY).toISOString() },
        { itemId: 'young', title: 'Young', text: 'x', adoptedAt: new Date(NOW - 2 * DAY).toISOString() },
        { itemId: 'hand-authored', title: 'Hand', text: 'y', adoptedAt: null },
      ],
      distiller: failLlm,
      retirePackItem: retire,
      forgetPristinePoolRows: async () => 3,
    });
    const r = await runKnowledgeHygieneTick(opts, d);
    expect(r).toMatchObject({ itemsReviewed: 1, itemsRetired: 1, poolRowsForgotten: 3, reviewErrors: 0 });
    expect(retire).toHaveBeenCalledWith('old-noise', expect.stringContaining('incident noise'));
    log.mockRestore();
  });

  it('a judge ERROR never destroys anything (D-004)', async () => {
    const retire = vi.fn(async () => {});
    const d = deps({
      listPackItems: async () => [
        { itemId: 'old', title: 'Old', text: 'x', adoptedAt: new Date(NOW - 40 * DAY).toISOString() },
      ],
      distiller: vi.fn(async () => ({ text: '[]', costUsd: 0 })),
      retirePackItem: retire,
    });
    const r = await runKnowledgeHygieneTick(opts, d);
    expect(r).toMatchObject({ itemsReviewed: 1, itemsRetired: 0, reviewErrors: 1 });
    expect(retire).not.toHaveBeenCalled();
  });

  it('caps re-reviews per tick', async () => {
    const d = deps({
      listPackItems: async () =>
        Array.from({ length: 5 }, (_, i) => ({
          itemId: `i${i}`,
          title: `t${i}`,
          text: 'x',
          adoptedAt: new Date(NOW - 40 * DAY).toISOString(),
        })),
      distiller: passLlm,
    });
    const r = await runKnowledgeHygieneTick({ ...opts, maxReviewsPerTick: 2 }, d);
    expect(r.itemsReviewed).toBe(2);
  });
});

describe('runKnowledgeHygieneTick — conflict sweep', () => {
  it('auto-resolves ONLY a pristine-pack-vs-organic pair (forgets the pack side); everything else is filed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const forgetRow = vi.fn(async () => {});
    const fileConflict = vi.fn(async () => {});
    const d = deps({
      listHives: async () => ['h1'],
      sweepConflicts: async () => [
        pair({ aId: 'pack-row', aPristinePack: true }), // pack vs organic → auto
        pair({ aId: 'o1', bId: 'o2' }), // organic vs organic → filed
        pair({ aId: 'p1', bId: 'p2', aPristinePack: true, bPristinePack: true }), // pack vs pack → filed
      ],
      forgetRow,
      fileConflict,
    });
    const r = await runKnowledgeHygieneTick(opts, d);
    expect(r).toMatchObject({ hivesSwept: 1, conflictsAutoResolved: 1, conflictsFiled: 2 });
    expect(forgetRow).toHaveBeenCalledExactlyOnceWith('pack-row');
    expect(fileConflict).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('a failed forget degrades to filing, never silent loss', async () => {
    const fileConflict = vi.fn(async () => {});
    const d = deps({
      listHives: async () => ['h1'],
      sweepConflicts: async () => [pair({ aPristinePack: true })],
      forgetRow: vi.fn(async () => {
        throw new Error('backend down');
      }),
      fileConflict,
    });
    const r = await runKnowledgeHygieneTick(opts, d);
    expect(r.conflictsAutoResolved).toBe(0);
    expect(r.conflictsFiled).toBe(1);
    expect(fileConflict).toHaveBeenCalledOnce();
  });
});

describe('runKnowledgeHygieneTick — queue prune', () => {
  it('prunes dismissed candidates with the configured retention', async () => {
    const pruneDismissed = vi.fn(async (days: number) => {
      expect(days).toBe(45);
      return 7;
    });
    const r = await runKnowledgeHygieneTick({ ...opts, pruneDismissedDays: 45 }, deps({ pruneDismissed }));
    expect(r.dismissedPruned).toBe(7);
  });
});
