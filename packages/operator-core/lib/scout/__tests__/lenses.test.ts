/**
 * Lens-registry tests (P-004, D-004) — the anti-mode-collapse invariant lives
 * here: distinct lenses (and distinct distant domains) must produce distinct,
 * grounded ideator prompts. Pure — no LLM.
 */
import { describe, it, expect } from 'vitest';
import type { CorpusDigest } from '../types';
import { CREATIVE_LENSES } from '../types';
import {
  DISTANT_DOMAINS,
  LENS_REGISTRY,
  assignDistantDomain,
  buildIdeatorPrompt,
  digestRefSet,
  flattenDigest,
  renderDigest,
} from '../lenses';

const digest: CorpusDigest = {
  headline: 'the fleet burns time on coordination',
  recurringFriction: [{ summary: 'lock contention on the shared tree', ref: 'wi:F-1' }],
  timeTokenSinks: [{ summary: 'agents re-explore the same code each session', ref: 'wi:F-2' }],
  chronicDeferrals: [{ summary: 'mem0 integration keeps being deferred', ref: 'plan:mem' }],
  capabilityGaps: [{ summary: 'no cross-Hive capability search', ref: 'wi:F-3' }],
};

describe('LENS_REGISTRY', () => {
  it('defines all four lenses', () => {
    for (const lens of CREATIVE_LENSES) {
      expect(LENS_REGISTRY[lens]).toBeDefined();
      expect(LENS_REGISTRY[lens].lens).toBe(lens);
      expect(LENS_REGISTRY[lens].stance.length).toBeGreaterThan(20);
    }
  });

  it('only the analogical lens uses a distant domain', () => {
    expect(LENS_REGISTRY.analogical.usesDistantDomain).toBe(true);
    expect(LENS_REGISTRY['first-principles'].usesDistantDomain).toBe(false);
    expect(LENS_REGISTRY.reframing.usesDistantDomain).toBe(false);
    expect(LENS_REGISTRY['constraint-removal'].usesDistantDomain).toBe(false);
  });
});

describe('DISTANT_DOMAINS', () => {
  it('includes the plan-named priming domains', () => {
    const keys = DISTANT_DOMAINS.map((d) => d.key);
    expect(keys).toContain('immune-systems');
    expect(keys).toContain('markets');
    expect(keys).toContain('ant-colony-stigmergy');
    expect(keys).toContain('cpu-schedulers');
  });

  it('every domain carries a non-trivial priming gloss', () => {
    for (const d of DISTANT_DOMAINS) expect(d.prime.length).toBeGreaterThan(20);
  });
});

describe('assignDistantDomain', () => {
  it('rotates through the pool by index', () => {
    expect(assignDistantDomain(0)).toEqual(DISTANT_DOMAINS[0]);
    expect(assignDistantDomain(1)).toEqual(DISTANT_DOMAINS[1]);
    expect(assignDistantDomain(DISTANT_DOMAINS.length)).toEqual(DISTANT_DOMAINS[0]); // wraps
  });

  it('honors a custom order', () => {
    const order = [
      { key: 'a', prime: 'aaaaaaaaaaaaaaaaaaaaaa' },
      { key: 'b', prime: 'bbbbbbbbbbbbbbbbbbbbbb' },
    ];
    expect(assignDistantDomain(0, order).key).toBe('a');
    expect(assignDistantDomain(3, order).key).toBe('b'); // 3 % 2 = 1
  });
});

describe('flattenDigest / digestRefSet', () => {
  it('flattens all four lanes and stamps the category', () => {
    const flat = flattenDigest(digest);
    expect(flat).toHaveLength(4);
    expect(flat.find((p) => p.ref === 'wi:F-1')?.category).toBe('recurring-friction');
    expect(flat.find((p) => p.ref === 'wi:F-2')?.category).toBe('time-token-sink');
    expect(flat.find((p) => p.ref === 'plan:mem')?.category).toBe('chronic-deferral');
    expect(flat.find((p) => p.ref === 'wi:F-3')?.category).toBe('capability-gap');
  });

  it('preserves an explicit category if a pattern already carries one', () => {
    const d: CorpusDigest = {
      recurringFriction: [{ summary: 'x', ref: 'r1', category: 'capability-gap' }],
      timeTokenSinks: [],
      chronicDeferrals: [],
      capabilityGaps: [],
    };
    expect(flattenDigest(d)[0].category).toBe('capability-gap');
  });

  it('collects all refs', () => {
    const set = digestRefSet(digest);
    expect([...set].sort()).toEqual(['plan:mem', 'wi:F-1', 'wi:F-2', 'wi:F-3']);
  });
});

describe('renderDigest', () => {
  it('lists every pattern with its ref and category, plus the headline', () => {
    const text = renderDigest(digest);
    expect(text).toContain('the fleet burns time on coordination');
    expect(text).toContain('(ref: wi:F-1)');
    expect(text).toContain('[Recurring friction]');
    expect(text).toContain('[Capability gap]');
  });

  it('handles an empty digest', () => {
    const empty: CorpusDigest = { recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [] };
    expect(renderDigest(empty)).toContain('no meta-patterns');
  });
});

describe('buildIdeatorPrompt — forced diversity (D-004)', () => {
  it('produces pairwise-distinct system prompts across the four lenses', () => {
    const systems = CREATIVE_LENSES.map(
      (lens) => buildIdeatorPrompt({ lens, digest, seedDomain: assignDistantDomain(0) }).system,
    );
    expect(new Set(systems).size).toBe(CREATIVE_LENSES.length);
  });

  it('analogical prompts diverge by primed distant domain', () => {
    const a = buildIdeatorPrompt({ lens: 'analogical', digest, seedDomain: DISTANT_DOMAINS[0] }).system;
    const b = buildIdeatorPrompt({ lens: 'analogical', digest, seedDomain: DISTANT_DOMAINS[1] }).system;
    expect(a).not.toBe(b);
    expect(a).toContain(DISTANT_DOMAINS[0].key);
    expect(a).toContain(DISTANT_DOMAINS[0].prime);
    expect(b).toContain(DISTANT_DOMAINS[1].key);
  });

  it('non-analogical lenses carry no distant-domain priming', () => {
    const sys = buildIdeatorPrompt({ lens: 'constraint-removal', digest }).system;
    expect(sys).not.toContain('primed distant domain');
    expect(sys).toContain('load-bearing'); // its stance keyword
  });

  it('every prompt enforces grounding + the strict JSON contract', () => {
    for (const lens of CREATIVE_LENSES) {
      const { system, user } = buildIdeatorPrompt({ lens, digest, seedDomain: assignDistantDomain(0) });
      expect(system).toContain('addressesPatternRefs');
      expect(system).toContain('"ideas"');
      expect(system).toMatch(/GROUND/i);
      // the user prompt carries the grounded substrate (the refs to cite)
      expect(user).toContain('wi:F-1');
    }
  });

  it('respects the maxIdeas cap in the contract', () => {
    const sys = buildIdeatorPrompt({ lens: 'reframing', digest, maxIdeas: 2 }).system;
    expect(sys).toContain('at most 2 ideas');
  });
});
