/**
 * conflicts.test.ts — P-011's detector (D-087). PURE: no PG, no clock.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-facts/conflicts.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  CONFLICT_PAIRS_LIMIT,
  assumptionDetectabilityWarning,
  assumptionReferents,
  claimAssertion,
  claimSubject,
  detectAssumptionConflicts,
  explainZero,
  isAssumptionFact,
  isStructuralZero,
  normalizeClaimValue,
} from './conflicts';
import type { AgentFact, FactDependency } from './store';

let nextId = 1;

function fact(over: Partial<AgentFact> = {}): AgentFact {
  return {
    scope: 'owner',
    scopeRef: 'su-a',
    key: `k-${nextId}`,
    body: 'the prose a human reads',
    sourceRef: null,
    audienceScope: null,
    sourceProvenance: null,
    confidence: null,
    kind: 'assumption',
    dependsOn: [],
    claim: null,
    enforcement: null,
    createdBy: 'su-a',
    updatedAt: '2026-07-27T12:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    id: nextId++,
    ...over,
  };
}

/** The canonical example from D-019/D-020: the gate reds. */
function gateAssumption(owner: string, assertion: string, over: Partial<AgentFact> = {}): AgentFact {
  return fact({
    scope: 'owner',
    scopeRef: owner,
    createdBy: owner,
    key: `gate-reds-${owner}`,
    claim: { subject: 'cell:gate.greenCheckpoint.verdict', assertion },
    ...over,
  });
}

const dep = (cell: string, subject?: string): FactDependency => ({
  cell,
  ...(subject ? { subject } : {}),
  observedAt: '2026-07-27T11:00:00.000Z',
  digest: 'abc123',
});

describe('isAssumptionFact — D-087 R2, the legacy form counts', () => {
  it("accepts kind:'assumption'", () => {
    expect(isAssumptionFact({ kind: 'assumption', confidence: null })).toBe(true);
  });

  it("accepts the PRE-`kind` form: confidence:'suspected' with no kind (D-019's original definition)", () => {
    expect(isAssumptionFact({ kind: null, confidence: 'suspected' })).toBe(true);
  });

  it('a DECLARED kind wins over a hedged confidence — a suspected conclusion is not an assumption', () => {
    expect(isAssumptionFact({ kind: 'conclusion', confidence: 'suspected' })).toBe(false);
    expect(isAssumptionFact({ kind: 'convention', confidence: 'suspected' })).toBe(false);
  });

  it('rejects an undeclared, unhedged fact', () => {
    expect(isAssumptionFact({ kind: null, confidence: null })).toBe(false);
    expect(isAssumptionFact({ kind: null, confidence: 'verified' })).toBe(false);
  });
});

describe('normalizeClaimValue', () => {
  it('compares strings case- and whitespace-insensitively, and nothing more', () => {
    expect(normalizeClaimValue('  Unrelated   To My\nChange ')).toBe('unrelated to my change');
    expect(normalizeClaimValue('unrelated to my change')).toBe(normalizeClaimValue('UNRELATED TO MY CHANGE'));
  });

  it('treats blank and absent alike — both are "nothing to compare"', () => {
    expect(normalizeClaimValue('   ')).toBeNull();
    expect(normalizeClaimValue('')).toBeNull();
    expect(normalizeClaimValue(null)).toBeNull();
    expect(normalizeClaimValue(undefined)).toBeNull();
  });

  it('stringifies numbers and booleans so a typed non-string assertion is still comparable', () => {
    expect(normalizeClaimValue(3)).toBe('3');
    expect(normalizeClaimValue(false)).toBe('false');
    expect(normalizeClaimValue(Number.NaN)).toBeNull();
  });

  it('renders objects KEY-SORTED, so field order cannot fake a disagreement', () => {
    expect(normalizeClaimValue({ b: 1, a: 2 })).toBe(normalizeClaimValue({ a: 2, b: 1 }));
    expect(normalizeClaimValue({ a: 1 })).not.toBe(normalizeClaimValue({ a: 2 }));
  });

  it('does NOT stem, synonym-match or otherwise infer — near-synonyms are different values', () => {
    expect(normalizeClaimValue('unrelated')).not.toBe(normalizeClaimValue('unrelated-to-my-change'));
  });
});

describe('claimSubject / claimAssertion', () => {
  it('reads the two typed fields and ignores everything else in claim', () => {
    const f = fact({ claim: { subject: ' Gate.Verdict ', assertion: 'RED', extra: 'noise' } });
    expect(claimSubject(f)).toBe('gate.verdict');
    expect(claimAssertion(f)).toBe('red');
  });

  it('returns null for a fact with no claim, or a non-object claim', () => {
    expect(claimSubject(fact({ claim: null }))).toBeNull();
    expect(claimAssertion(fact({ claim: null }))).toBeNull();
    expect(claimSubject(fact({ claim: 'a string' as unknown as Record<string, unknown> }))).toBeNull();
  });
});

describe('assumptionReferents — the precedence in D-087 R1', () => {
  it('a typed subject WINS and dependsOn is not also emitted', () => {
    const r = assumptionReferents(fact({ claim: { subject: 'gate.verdict' }, dependsOn: [dep('git.head')] }));
    expect(r).toEqual([{ key: 'claim:gate.verdict', kind: 'claim-subject', label: 'gate.verdict' }]);
  });

  it('groups on the NORMALIZED subject but reports it AS FILED — a cell id must stay recognisable', () => {
    const a = assumptionReferents(fact({ claim: { subject: 'cell:gate.greenCheckpoint.verdict' } }));
    const b = assumptionReferents(fact({ claim: { subject: 'CELL:Gate.GreenCheckpoint.Verdict' } }));
    expect(a[0].label).toBe('cell:gate.greenCheckpoint.verdict');
    expect(a[0].key).toBe(b[0].key); // same referent despite the spelling
    expect(b[0].label).toBe('CELL:Gate.GreenCheckpoint.Verdict');
  });

  it('falls back to declared cells when no subject was filed', () => {
    const r = assumptionReferents(fact({ dependsOn: [dep('git.head'), dep('pipeline.myChange', 'a.ts')] }));
    expect(r.map((x) => x.key)).toEqual(['cell:git.head', 'cell:pipeline.myChange@a.ts']);
    expect(r.every((x) => x.kind === 'depends-on-cell')).toBe(true);
  });

  it('a cell read under two different subjects is two different referents', () => {
    const r = assumptionReferents(fact({ dependsOn: [dep('pipeline.x', 'a.ts'), dep('pipeline.x', 'b.ts')] }));
    expect(r).toHaveLength(2);
  });

  it('de-duplicates a repeated cell and skips a blank one', () => {
    const r = assumptionReferents(fact({ dependsOn: [dep('git.head'), dep('git.head'), dep('  ')] }));
    expect(r.map((x) => x.key)).toEqual(['cell:git.head']);
  });

  it('has no referent at all with neither subject nor dependencies', () => {
    expect(assumptionReferents(fact())).toEqual([]);
  });
});

describe('detectAssumptionConflicts — the seeded contradiction', () => {
  it('detects two agents in tension over the same typed subject', () => {
    const out = detectAssumptionConflicts([
      gateAssumption('su-a', 'unrelated to my change'),
      gateAssumption('su-b', 'caused by my change'),
    ]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.structuralZero).toBeNull();
    const [c] = out.conflicts;
    expect(c.referent).toBe('cell:gate.greenCheckpoint.verdict');
    expect(c.referentKind).toBe('claim-subject');
    expect(c.sameAuthor).toBe(false);
    expect([c.a.assertion, c.b.assertion].sort()).toEqual([
      'caused by my change',
      'unrelated to my change',
    ]);
    // Both sides carry enough to be judged without a second read.
    expect(c.a.body).toBe('the prose a human reads');
    expect(c.a.id).toBeTypeOf('number');
    expect(out.coverage).toMatchObject({
      liveAssumptions: 2,
      comparable: 2,
      sharedReferents: 1,
      comparedPairs: 1,
    });
  });

  it('flags ONE agent holding both sides as a self-contradiction', () => {
    const out = detectAssumptionConflicts([
      gateAssumption('su-a', 'unrelated', { key: 'first' }),
      gateAssumption('su-a', 'mine', { key: 'second' }),
    ]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0].sameAuthor).toBe(true);
  });

  it('detects tension via a SHARED dependsOn cell when neither filed a subject', () => {
    const base = { claim: { assertion: 'x' }, dependsOn: [dep('gate.verdict')] };
    const out = detectAssumptionConflicts([
      fact({ ...base, scopeRef: 'su-a', createdBy: 'su-a', claim: { assertion: 'flaky' } }),
      fact({ ...base, scopeRef: 'su-b', createdBy: 'su-b', claim: { assertion: 'real regression' } }),
    ]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0].referentKind).toBe('depends-on-cell');
    expect(out.conflicts[0].referent).toBe('gate.verdict');
  });
});

describe('detectAssumptionConflicts — what is deliberately NOT a conflict', () => {
  it('agreement: assertions that normalize equal are not tension', () => {
    const out = detectAssumptionConflicts([
      gateAssumption('su-a', 'Unrelated To My Change'),
      gateAssumption('su-b', 'unrelated   to my change'),
    ]);
    expect(out.conflicts).toHaveLength(0);
    expect(out.structuralZero).toBe('agreement');
    // The ONE zero that is real news — a caller must be able to tell it apart.
    expect(isStructuralZero('agreement')).toBe(false);
    expect(out.coverage.comparedPairs).toBe(1);
  });

  it('two rows of ONE identity are supersession, not tension (D-087 R3)', () => {
    const identity = { scope: 'owner' as const, scopeRef: 'su-a', key: 'gate-reds', createdBy: 'su-a' };
    const out = detectAssumptionConflicts([
      fact({ ...identity, claim: { subject: 'gate', assertion: 'unrelated' } }),
      fact({ ...identity, claim: { subject: 'gate', assertion: 'mine' } }),
    ]);
    expect(out.conflicts).toHaveLength(0);
    expect(out.coverage.comparedPairs).toBe(0);
    expect(out.structuralZero).toBe('no-shared-referents');
  });

  it('the same cell under DIFFERENT subjects is not the same referent — the obvious false positive', () => {
    const out = detectAssumptionConflicts([
      fact({ scopeRef: 'su-a', createdBy: 'su-a', claim: { subject: 'gate.reds', assertion: 'unrelated' } }),
      fact({ scopeRef: 'su-b', createdBy: 'su-b', claim: { subject: 'gate.duration', assertion: 'slow' } }),
    ]);
    expect(out.conflicts).toHaveLength(0);
    expect(out.coverage.comparable).toBe(2);
    expect(out.coverage.sharedReferents).toBe(0);
  });

  it('when only ONE side typed a subject the pair is incomparable, never guessed', () => {
    const out = detectAssumptionConflicts([
      fact({ scopeRef: 'su-a', createdBy: 'su-a', claim: { subject: 'gate.verdict', assertion: 'unrelated' } }),
      fact({
        scopeRef: 'su-b',
        createdBy: 'su-b',
        claim: { assertion: 'mine' },
        dependsOn: [dep('gate.verdict')],
      }),
    ]);
    expect(out.conflicts).toHaveLength(0);
    expect(out.coverage.sharedReferents).toBe(0);
  });

  it('ignores conclusions and conventions even when their claims contradict outright', () => {
    const out = detectAssumptionConflicts([
      fact({ kind: 'conclusion', scopeRef: 'su-a', claim: { subject: 'gate', assertion: 'unrelated' } }),
      fact({ kind: 'convention', scopeRef: 'su-b', claim: { subject: 'gate', assertion: 'mine' } }),
    ]);
    expect(out.conflicts).toHaveLength(0);
    expect(out.coverage).toMatchObject({ factsExamined: 2, liveAssumptions: 0 });
    expect(out.structuralZero).toBe('no-assumption-facts');
  });
});

describe('detectAssumptionConflicts — coverage says WHICH zero it is (D-087 R4)', () => {
  it('empty input reports no-assumption-facts, not agreement', () => {
    const out = detectAssumptionConflicts([]);
    expect(out.structuralZero).toBe('no-assumption-facts');
    expect(isStructuralZero(out.structuralZero)).toBe(true);
    expect(explainZero('no-assumption-facts')).toMatch(/not "the fleet agrees"/);
  });

  it('assumptions with no typed claim report no-typed-claims — the state of the ledger on 2026-07-27', () => {
    const out = detectAssumptionConflicts([
      fact({ scopeRef: 'su-a', body: 'I assume the reds are unrelated' }),
      fact({ scopeRef: 'su-b', body: 'I assume the reds are mine' }),
    ]);
    expect(out.structuralZero).toBe('no-typed-claims');
    expect(out.coverage).toMatchObject({ liveAssumptions: 2, comparable: 0, comparedPairs: 0 });
    expect(isStructuralZero(out.structuralZero)).toBe(true);
  });

  it('every zero reason has a distinct explanation, so a result never explains the wrong zero', () => {
    const reasons = ['no-assumption-facts', 'no-typed-claims', 'no-shared-referents', 'agreement'] as const;
    const texts = reasons.map((r) => explainZero(r));
    expect(new Set(texts).size).toBe(reasons.length);
  });
});

describe('detectAssumptionConflicts — bounds', () => {
  it('caps the returned pairs but keeps the counts complete', () => {
    // N agents pairwise-distinct on one subject ⇒ N*(N-1)/2 pairs, all conflicting.
    const n = 12; // 66 pairs > the 50 cap
    const facts = Array.from({ length: n }, (_, i) => gateAssumption(`su-${i}`, `assertion-${i}`));
    const out = detectAssumptionConflicts(facts);
    expect(out.conflicts).toHaveLength(CONFLICT_PAIRS_LIMIT);
    expect(out.truncated).toBe(true);
    expect(out.coverage.comparedPairs).toBe((n * (n - 1)) / 2);
  });

  it('is deterministic — same input, same output', () => {
    const facts = [gateAssumption('su-a', 'x'), gateAssumption('su-b', 'y'), gateAssumption('su-c', 'z')];
    expect(detectAssumptionConflicts(facts)).toEqual(detectAssumptionConflicts(facts));
  });
});

describe('assumptionDetectabilityWarning — D-087 R5, honest not silent', () => {
  it('says nothing about a conclusion or a convention', () => {
    expect(assumptionDetectabilityWarning(fact({ kind: 'conclusion' }))).toBeUndefined();
    expect(assumptionDetectabilityWarning(fact({ kind: 'convention' }))).toBeUndefined();
  });

  it('says nothing when the assumption IS comparable', () => {
    expect(
      assumptionDetectabilityWarning(fact({ claim: { subject: 'gate', assertion: 'unrelated' } })),
    ).toBeUndefined();
  });

  it('names BOTH missing halves for a claimless assumption', () => {
    const w = assumptionDetectabilityWarning(fact());
    expect(w?.missing).toEqual(['claim.assertion', 'claim.subject (or a dependsOn cell)']);
    expect(w?.note).toMatch(/INVISIBLE to the conflicting-assumption detector/);
  });

  it('accepts a dependsOn cell in place of a subject, but still requires the assertion', () => {
    const w = assumptionDetectabilityWarning(fact({ dependsOn: [dep('gate.verdict')] }));
    expect(w?.missing).toEqual(['claim.assertion']);
  });

  it('warns on the legacy suspected form too', () => {
    expect(assumptionDetectabilityWarning(fact({ kind: null, confidence: 'suspected' }))).toBeDefined();
  });
});
