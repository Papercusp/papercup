/**
 * P-018 — the conventions layer's pure half: the citation grammar, the D-016
 * enforcement rules, and the projection asymmetry between the two sources.
 *
 * The SQL halves (listConventionFacts / relevantPlanDecisions) are exercised by
 * the agent-facts integration suite; everything here runs without PG.
 */
import { describe, it, expect } from 'vitest';
import {
  validateConventionEnforcement,
  parseConventionEnforcement,
  factCitationRef,
  renderEnforcement,
  renderFactsFold,
  type AgentFact,
} from '../agent-facts/store';
import { classifyPremiseRef } from '../agent-tools/coordination/message-fields';
import { intentTokens, relevanceScore, conventionFromFact } from './registry';

const fact = (over: Partial<AgentFact>): AgentFact => ({
  scope: 'workspace',
  scopeRef: null,
  key: 'migrations-via-runner',
  body: 'Apply migrations via db:migrate, never a raw psql -f.',
  sourceRef: null,
  audienceScope: null,
  sourceProvenance: null,
  confidence: null,
  kind: 'convention',
  dependsOn: [],
  claim: null,
  enforcement: null,
  createdBy: 'su-me',
  updatedAt: '2026-07-27T10:00:00.000Z',
  expiresAt: '2026-08-03T10:00:00.000Z',
  ...over,
});

describe('validateConventionEnforcement — D-016 made mechanical (D-075 R3)', () => {
  it('accepts an absent declaration on any kind — untiered is always legal', () => {
    expect(validateConventionEnforcement('convention', null)).toBeNull();
    expect(validateConventionEnforcement('conclusion', undefined)).toBeNull();
    expect(validateConventionEnforcement(null, null)).toBeNull();
  });

  it("REFUSES a tier on a non-convention — a conclusion is not a norm", () => {
    expect(validateConventionEnforcement('conclusion', { tier: 'structural' })).toMatch(
      /only meaningful on kind:'convention'/,
    );
    expect(validateConventionEnforcement('assumption', { tier: 'structural' })).toMatch(/not one/);
    // kind unset is also a refusal, and says so without claiming a kind.
    expect(validateConventionEnforcement(null, { tier: 'structural' })).toMatch(/no kind/);
  });

  it('accepts structural with no floor and no review date', () => {
    expect(validateConventionEnforcement('convention', { tier: 'structural' })).toBeNull();
  });

  it('REFUSES a gate/detector without a floor or a review date', () => {
    expect(validateConventionEnforcement('convention', { tier: 'gate' })).toMatch(
      /requires floor and reviewBy/,
    );
    expect(
      validateConventionEnforcement('convention', { tier: 'detector', floor: 0.6 }),
    ).toMatch(/requires reviewBy/);
    expect(
      validateConventionEnforcement('convention', { tier: 'gate', reviewBy: '2026-09-01' }),
    ).toMatch(/requires floor/);
    // The refusal quotes D-016 so the reason travels with it.
    expect(validateConventionEnforcement('convention', { tier: 'detector' })).toMatch(
      /prose exhortation in a costume/,
    );
  });

  it('REFUSES a floor of 0 — a floor nothing can fall below is not a floor', () => {
    expect(
      validateConventionEnforcement('convention', {
        tier: 'detector',
        floor: 0,
        reviewBy: '2026-09-01',
      }),
    ).toMatch(/not a floor/);
    for (const bad of [-0.1, 1.5, Number.NaN]) {
      expect(
        validateConventionEnforcement('convention', {
          tier: 'gate',
          floor: bad,
          reviewBy: '2026-09-01',
        }),
      ).toMatch(/rate in \(0,1\]/);
    }
  });

  it('REFUSES an unparseable review date — it would never come due', () => {
    expect(
      validateConventionEnforcement('convention', {
        tier: 'gate',
        floor: 0.6,
        reviewBy: 'soon',
      }),
    ).toMatch(/not a parseable date/);
  });

  it('REFUSES a floor on structural — an uncomputable floor reads as FAILING at review', () => {
    expect(
      validateConventionEnforcement('convention', { tier: 'structural', floor: 0.9 }),
    ).toMatch(/takes no floor/);
    expect(
      validateConventionEnforcement('convention', {
        tier: 'structural',
        reviewBy: '2026-09-01',
      }),
    ).toMatch(/takes no reviewBy/);
  });

  it("REFUSES a 'prompt' tier and says why — D-016 rules the playbook out", () => {
    const err = validateConventionEnforcement('convention', {
      // deliberately out-of-contract: this is what a caller reaching for the
      // documentation "tier" would write.
      tier: 'prompt' as never,
    });
    expect(err).toMatch(/unknown enforcement tier 'prompt'/);
    expect(err).toMatch(/deliberately not a tier/);
  });

  it('accepts a well-formed measured tier', () => {
    expect(
      validateConventionEnforcement('convention', {
        tier: 'gate',
        floor: 0.6,
        reviewBy: '2026-09-01',
      }),
    ).toBeNull();
  });
});

describe('parseConventionEnforcement — read-side backstop', () => {
  it('parses both an object and raw jsonb text', () => {
    expect(parseConventionEnforcement({ tier: 'structural' })).toEqual({ tier: 'structural' });
    expect(parseConventionEnforcement('{"tier":"gate","floor":0.6,"reviewBy":"2026-09-01"}')).toEqual(
      { tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' },
    );
  });

  it('maps an unknown tier to null rather than propagating it', () => {
    expect(parseConventionEnforcement({ tier: 'prompt' })).toBeNull();
    expect(parseConventionEnforcement({ tier: 'vibes' })).toBeNull();
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, '', 'not json', [], 42, { nope: 1 }]) {
      expect(parseConventionEnforcement(junk)).toBeNull();
    }
  });
});

describe('factCitationRef — D-075 R1: discovery and citation must agree', () => {
  it('emits a ref the message layer classifies as an INVALIDATABLE fact', () => {
    const ref = factCitationRef({ scope: 'workspace', scopeRef: null, key: 'k', id: 12 });
    expect(ref).toBe('fact:workspace:k@v12');
    const classified = classifyPremiseRef(ref);
    expect(classified.kind).toBe('fact');
    expect(classified.invalidatable).toBe(true);
  });

  it('matches the documented owner-scoped grammar', () => {
    expect(factCitationRef({ scope: 'owner', scopeRef: 'su-8d9a6', key: 'k', id: 3 })).toBe(
      'fact:owner:su-8d9a6:k@v3',
    );
  });

  it('degrades gracefully when the read did not select version identity', () => {
    const ref = factCitationRef({ scope: 'harness', scopeRef: 'papercusp', key: 'k' });
    expect(ref).toBe('fact:harness:papercusp:k');
    // Still classifies — D-026's degrade-never-exclude rule applied to our grammar.
    expect(classifyPremiseRef(ref).kind).toBe('fact');
  });

  it('a plan-decision convention id classifies too', () => {
    const c = classifyPremiseRef('unified-agent-state-plane-2026-07-27#D-075');
    expect(c.kind).toBe('plan-decision');
    expect(c.invalidatable).toBe(true);
  });
});

describe('renderFactsFold — the modality must be VISIBLE (P-033 (e) one layer down)', () => {
  it('badges a convention and gives it a citable ref inline', () => {
    const out = renderFactsFold([
      fact({ id: 12, enforcement: { tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' } }),
    ]);
    expect(out).toContain('⟦CONVENTION · gate ≥60% by 2026-09-01⟧');
    expect(out).toContain('cite fact:workspace:migrations-via-runner@v12');
  });

  it('leaves an undeclared modality UNBADGED — absent means not declared', () => {
    const out = renderFactsFold([fact({ kind: null })]);
    expect(out).not.toContain('⟦');
    expect(out).not.toContain('CONCLUSION');
  });

  it('distinguishes a convention from a conclusion carrying the same body', () => {
    const body = 'Apply migrations via db:migrate, never a raw psql -f.';
    const asConvention = renderFactsFold([fact({ kind: 'convention', body, id: 1 })]);
    const asConclusion = renderFactsFold([fact({ kind: 'conclusion', body, id: 1 })]);
    expect(asConvention).not.toEqual(asConclusion);
    expect(asConvention).toContain('CONVENTION');
    expect(asConclusion).toContain('CONCLUSION');
    // Only the convention carries a citation — it is the modality meant to be cited.
    expect(asConclusion).not.toContain('cite fact:');
  });

  it('badges a convention with no declared tier without inventing one', () => {
    const out = renderFactsFold([fact({ enforcement: null, id: 4 })]);
    expect(out).toContain('⟦CONVENTION⟧');
    expect(out).not.toContain('·');
  });
});

describe('renderEnforcement', () => {
  it('renders a measured tier as tier + floor + date', () => {
    expect(renderEnforcement({ tier: 'detector', floor: 0.45, reviewBy: '2026-09-01' })).toBe(
      'detector ≥45% by 2026-09-01',
    );
  });
  it('renders structural bare', () => {
    expect(renderEnforcement({ tier: 'structural' })).toBe('structural');
  });
  it('trims an ISO timestamp to its date', () => {
    expect(
      renderEnforcement({ tier: 'gate', floor: 1, reviewBy: '2026-09-01T12:00:00.000Z' }),
    ).toBe('gate ≥100% by 2026-09-01');
  });
});

describe('intentTokens — also the tsquery injection boundary', () => {
  it('drops stopwords and short words, dedupes, lowercases', () => {
    expect(intentTokens('I am about to edit the shared Interface')).toEqual([
      'edit',
      'shared',
      'interface',
    ]);
  });

  it('strips every non-alphanumeric character, so no tsquery operator survives', () => {
    const tokens = intentTokens("drop table; ' | ! & (foo:*) <-> bar");
    for (const t of tokens) expect(t).toMatch(/^[a-z0-9]+$/);
    expect(tokens).toContain('drop');
    expect(tokens).toContain('table');
    expect(tokens).not.toContain('foo:*');
  });

  it('returns nothing for an absent or contentless intent', () => {
    expect(intentTokens(null)).toEqual([]);
    expect(intentTokens('')).toEqual([]);
    expect(intentTokens('the and for with')).toEqual([]);
  });
});

describe('relevanceScore', () => {
  it('is the fraction of the caller terms present', () => {
    expect(relevanceScore(['migration', 'runner'], 'apply the migration via the runner')).toBe(1);
    expect(relevanceScore(['migration', 'runner'], 'apply the migration by hand')).toBe(0.5);
    expect(relevanceScore(['zzz'], 'nothing here')).toBe(0);
  });

  it('scores 0 when nothing was asked, rather than pretending everything matches', () => {
    expect(relevanceScore([], 'anything at all')).toBe(0);
  });
});

describe('conventionFromFact', () => {
  it('projects a declared convention with its enforcement carried through', () => {
    const c = conventionFromFact(
      fact({ id: 7, enforcement: { tier: 'structural' }, scope: 'harness', scopeRef: 'papercusp' }),
    );
    expect(c).toMatchObject({
      id: 'fact:harness:papercusp:migrations-via-runner@v7',
      source: 'fact',
      title: 'migrations-via-runner',
      enforcement: { tier: 'structural' },
      scope: 'harness:papercusp',
    });
  });
});
