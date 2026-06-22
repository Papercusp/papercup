/**
 * lenses — unit coverage for the forced-diversity engine (P-004 / D-004). Pure +
 * deterministic, so the anti-mode-collapse invariant (distinct lenses ⇒
 * pairwise-distinct system prompts; distinct distant domains ⇒ distinct prompts)
 * is pinned directly, alongside the digest flatten/render and pool rotation.
 */
import { describe, it, expect } from 'vitest';
import {
  buildIdeatorPrompt,
  flattenDigest,
  digestRefSet,
  renderDigest,
  assignDistantDomain,
  defaultLensRoster,
  LENS_REGISTRY,
  DISTANT_DOMAINS,
  DEFAULT_IDEATOR_MISSION,
  type DistantDomain,
} from './lenses';
import { CREATIVE_LENSES } from './types';
import type { CorpusDigest, MetaPattern } from './types';

const pat = (ref: string, summary = `pattern ${ref}`): MetaPattern => ({ ref, summary }) as MetaPattern;
const digest = (over: Partial<CorpusDigest> = {}): CorpusDigest =>
  ({ recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [], ...over }) as CorpusDigest;

describe('buildIdeatorPrompt — anti-mode-collapse + lens stance', () => {
  const d = digest({ recurringFriction: [pat('wi:1', 'spawn latency spikes')] });

  it('distinct lenses yield pairwise-distinct system prompts (no mode collapse)', () => {
    const systems = CREATIVE_LENSES.map((lens) => buildIdeatorPrompt({ lens, digest: d }).system);
    expect(new Set(systems).size).toBe(CREATIVE_LENSES.length); // all distinct
    for (const lens of CREATIVE_LENSES) {
      const s = buildIdeatorPrompt({ lens, digest: d }).system;
      expect(s).toContain(LENS_REGISTRY[lens].label);
      expect(s).toContain(LENS_REGISTRY[lens].stance);
    }
  });

  it('the analogical lens primes a distant domain; distinct domains yield distinct prompts', () => {
    const a = buildIdeatorPrompt({
      lens: 'analogical',
      digest: d,
      seedDomain: { key: 'immune-systems', prime: 'self vs non-self tagging' } as DistantDomain,
    }).system;
    const b = buildIdeatorPrompt({
      lens: 'analogical',
      digest: d,
      seedDomain: { key: 'jazz-ensembles', prime: 'turn-taking improvisation' } as DistantDomain,
    }).system;
    expect(a).toContain('immune-systems: self vs non-self tagging');
    expect(a).toContain('## Your primed distant domain');
    expect(a).toContain('"seedDomain"'); // the analogical-only JSON output field
    expect(a).not.toBe(b);
  });

  it('a non-distant-domain lens omits the distant-domain section + the seedDomain JSON field', () => {
    const s = buildIdeatorPrompt({ lens: 'first-principles', digest: d }).system;
    expect(s).not.toContain('primed distant domain');
    expect(s).not.toContain('seedDomain');
  });

  it('the analogical lens with no seedDomain falls back to the "no domain assigned" instruction', () => {
    expect(buildIdeatorPrompt({ lens: 'analogical', digest: d }).system).toContain('no domain assigned');
  });

  it('honors the mission override + maxIdeas + appends non-blank priming to the user prompt', () => {
    const r = buildIdeatorPrompt({ lens: 'reframing', digest: d, mission: 'CUSTOM MISSION', maxIdeas: 7, priming: '  prior elites here  ' });
    expect(r.system).toContain('CUSTOM MISSION');
    expect(r.system).not.toContain(DEFAULT_IDEATOR_MISSION);
    expect(r.system).toContain('at most 7 ideas');
    expect(r.user).toContain('prior elites here');
    expect(buildIdeatorPrompt({ lens: 'reframing', digest: d, priming: '   ' }).user).not.toContain('prior elites');
  });
});

describe('flattenDigest / digestRefSet / renderDigest', () => {
  const d = digest({
    headline: 'busy week',
    recurringFriction: [pat('wi:1', 'A')],
    capabilityGaps: [pat('gap:2', 'B')],
    rubricRatings: [pat('rub:3', 'C')],
  } as Partial<CorpusDigest>);

  it('flattenDigest collapses all lanes, stamping each pattern with its category lane', () => {
    const flat = flattenDigest(d);
    expect(flat.map((p) => p.ref).sort()).toEqual(['gap:2', 'rub:3', 'wi:1']);
    expect(flat.find((p) => p.ref === 'wi:1')!.category).toBe('recurring-friction');
    expect(flat.find((p) => p.ref === 'rub:3')!.category).toBe('rubric-rating');
  });

  it('flattenDigest tolerates missing lanes (?? [])', () => {
    expect(flattenDigest({ recurringFriction: [pat('wi:1')] } as CorpusDigest).map((p) => p.ref)).toEqual(['wi:1']);
  });

  it('digestRefSet is the set of every ref across the lanes', () => {
    expect([...digestRefSet(d)].sort()).toEqual(['gap:2', 'rub:3', 'wi:1']);
  });

  it('renderDigest shows the headline + a category-tagged line per pattern with its ref', () => {
    const out = renderDigest(d);
    expect(out).toContain('State of the Hive: busy week');
    expect(out).toContain('(ref: wi:1)');
    expect(out).toContain('[Recurring friction]');
    expect(out).toContain('[Rubric rating]');
  });

  it('renderDigest on an empty digest reports no patterns surfaced', () => {
    expect(renderDigest(digest())).toContain('(no meta-patterns surfaced this cycle)');
  });
});

describe('assignDistantDomain + defaultLensRoster', () => {
  it('rotates the distant-domain pool by index % length (intra-lens diversity)', () => {
    const order = [
      { key: 'a', prime: '1' },
      { key: 'b', prime: '2' },
      { key: 'c', prime: '3' },
    ] as DistantDomain[];
    expect(assignDistantDomain(0, order).key).toBe('a');
    expect(assignDistantDomain(1, order).key).toBe('b');
    expect(assignDistantDomain(3, order).key).toBe('a'); // wraps
    expect(assignDistantDomain(0).key).toBe(DISTANT_DOMAINS[0].key); // real non-empty pool → never throws
  });

  it('defaultLensRoster is one ideator per lens (distinct four-way divergence)', () => {
    expect([...defaultLensRoster()].sort()).toEqual([...CREATIVE_LENSES].sort());
    expect(new Set(defaultLensRoster()).size).toBe(defaultLensRoster().length);
  });
});
