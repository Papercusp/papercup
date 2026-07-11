/**
 * noveltyPriorArt (su-ideate-learning-substrate-2026-07-10 P-008). Pins:
 *  - the priorArt shape {kind, ref, title, similarity, state?} — titles resolved
 *    back from the corpus, strongest match first;
 *  - already-DECIDED priors (dropped/shipped/…) are surfaced, never filtered —
 *    "already tried, failed" is the signal the report exists for;
 *  - the matcher knobs pass through (matchFloor / maxMatches bound the report);
 *  - nothing comparable ⇒ [] (no matches, no throw);
 *  - the default corpus is readNoveltyCorpus() (the P-008-extended shipped read).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CorpusEntry } from './critique-core';
import { readNoveltyCorpus } from './cycle-deps';
import { noveltyPriorArt } from './novelty-precheck';

// PG-free: the shipped corpus read is exercised only as the default-wiring seam.
vi.mock('./cycle-deps', () => ({ readNoveltyCorpus: vi.fn(async () => []) }));
const mockRead = vi.mocked(readNoveltyCorpus);

const CORPUS: CorpusEntry[] = [
  { ref: 'plan:alpha-beta-gamma', kind: 'plan', text: 'alpha beta gamma delta' },
  { ref: 'wi:EI-77', kind: 'idea', text: 'alpha beta gamma epsilon', state: 'dropped' },
  { ref: 'other-plan#D-002', kind: 'decision', text: 'zeta eta theta iota' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockRead.mockResolvedValue([]);
});

describe('noveltyPriorArt', () => {
  it('surfaces above-floor priors strongest-first with kind/ref/title/similarity, carrying decided state', async () => {
    const out = await noveltyPriorArt('alpha beta gamma delta', { corpus: CORPUS });
    expect(out.length).toBe(2);
    // Exact prior first (similarity 1), the near-miss dropped idea second.
    expect(out[0]).toEqual({
      kind: 'plan',
      ref: 'plan:alpha-beta-gamma',
      title: 'alpha beta gamma delta',
      similarity: 1,
    });
    expect(out[1].kind).toBe('idea');
    expect(out[1].ref).toBe('wi:EI-77');
    expect(out[1].title).toBe('alpha beta gamma epsilon');
    expect(out[1].similarity).toBeGreaterThanOrEqual(0.5);
    expect(out[1].similarity).toBeLessThan(1);
    // The already-tried ("failed") prior is INCLUDED, its lifecycle visible.
    expect(out[1].state).toBe('dropped');
    // The unrelated decision stays below the floor.
    expect(out.some((m) => m.kind === 'decision')).toBe(false);
  });

  it('respects the matcher knobs: a raised floor and a match cap bound the report', async () => {
    const floor = await noveltyPriorArt('alpha beta gamma delta', {
      corpus: CORPUS,
      novelty: { matchFloor: 0.99 },
    });
    expect(floor.map((m) => m.ref)).toEqual(['plan:alpha-beta-gamma']);

    const capped = await noveltyPriorArt('alpha beta gamma delta', {
      corpus: CORPUS,
      novelty: { matchFloor: 0.1, maxMatches: 1 },
    });
    expect(capped.length).toBe(1);
    expect(capped[0].ref).toBe('plan:alpha-beta-gamma');
  });

  it('returns [] when nothing collides or nothing is comparable', async () => {
    await expect(noveltyPriorArt('completely unrelated words here', { corpus: CORPUS })).resolves.toEqual([]);
    await expect(noveltyPriorArt('???', { corpus: CORPUS })).resolves.toEqual([]);
    await expect(noveltyPriorArt('alpha beta gamma delta', { corpus: [] })).resolves.toEqual([]);
  });

  it('defaults the corpus to the shipped readNoveltyCorpus() read', async () => {
    mockRead.mockResolvedValue([{ ref: 'wi:EI-9', kind: 'idea', text: 'kappa lambda mu nu', state: 'shipped' }]);
    const out = await noveltyPriorArt('kappa lambda mu nu');
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(out).toEqual([{ kind: 'idea', ref: 'wi:EI-9', title: 'kappa lambda mu nu', similarity: 1, state: 'shipped' }]);
    // An injected corpus suppresses the read.
    mockRead.mockClear();
    await noveltyPriorArt('kappa lambda mu nu', { corpus: CORPUS });
    expect(mockRead).not.toHaveBeenCalled();
  });
});
