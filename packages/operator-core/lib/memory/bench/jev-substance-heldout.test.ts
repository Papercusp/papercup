import { describe, expect, it } from 'vitest';

import { loadGoldSetFixture } from './gold-set';
import { buildAdversarialCorpus } from './jev-robustness';
import {
  HELDOUT_TRIGGER_CONCRETE,
  HELDOUT_TRIGGER_PROMOTERS,
  renderHeldoutMarkdown,
  summarizeHeldout,
  type HeldoutScored,
} from './jev-substance-heldout';

describe('held-out trigger set', () => {
  it('has 96 trigger-only promoters and 20 quote-plus-content memories, all with unique ids and texts', () => {
    expect(HELDOUT_TRIGGER_PROMOTERS).toHaveLength(96);
    expect(HELDOUT_TRIGGER_CONCRETE).toHaveLength(20);
    const all = [...HELDOUT_TRIGGER_PROMOTERS, ...HELDOUT_TRIGGER_CONCRETE];
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    expect(new Set(all.map((r) => r.text)).size).toBe(all.length);
  });

  it('is disjoint from the bench corpus: no shared text and no reuse of the bench topical template', () => {
    const bench = buildAdversarialCorpus(loadGoldSetFixture().queries);
    const benchTexts = new Set(bench.map((e) => e.text));
    for (const r of [...HELDOUT_TRIGGER_PROMOTERS, ...HELDOUT_TRIGGER_CONCRETE]) {
      expect(benchTexts.has(r.text)).toBe(false);
      expect(r.text).not.toMatch(/^Relevant memory: recall this whenever someone asks/);
    }
    // None of the four bench misses' quoted queries appears in the held-out set.
    const gold = loadGoldSetFixture().queries.filter((q) => ['lg-036', 'hn-026', 'lg-030', 'lg-011'].includes(q.id));
    expect(gold.length).toBe(4);
    for (const q of gold) {
      for (const r of HELDOUT_TRIGGER_PROMOTERS) expect(r.text.includes(q.query)).toBe(false);
    }
  });
});

describe('summarizeHeldout', () => {
  const scored = (id: string, population: HeldoutScored['population'], p: number | null): HeldoutScored => ({
    id,
    text: `text ${id}`,
    population,
    pConcrete: p,
  });

  it('counts a promoter caught below t and a concrete memory refused below t; failed calls count as neither', () => {
    const rows = [
      scored('p1', 'heldout-promoter', 0.1),
      scored('p2', 'heldout-promoter', 0.5),
      scored('p3', 'heldout-promoter', null),
      scored('c1', 'heldout-concrete', 0.9),
      scored('c2', 'heldout-concrete', 0.49),
      scored('c3', 'heldout-concrete', null),
    ];
    const s = summarizeHeldout(rows, 0.5);
    expect(s.promoters.answered).toBe(2);
    expect(s.promoters.caught).toBe(1);
    expect(s.promoters.saved.map((r) => r.id)).toEqual(['p2']);
    expect(s.concrete.answered).toBe(2);
    expect(s.concrete.refused.map((r) => r.id)).toEqual(['c2']);
    expect(s.failures).toBe(2);
  });

  it('renders every saved promoter and every refused concrete memory', () => {
    const md = renderHeldoutMarkdown(
      summarizeHeldout([scored('p2', 'heldout-promoter', 0.7), scored('c2', 'heldout-concrete', 0.2)], 0.5),
    );
    expect(md).toContain('trigger-only self-promoters caught: 0/1');
    expect(md).toContain('quote-plus-content memories refused: 1/1');
    expect(md).toContain('`p2` P=0.700');
    expect(md).toContain('`c2` P=0.200');
  });
});
