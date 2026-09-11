import { describe, expect, it } from 'vitest';

import { resolveScenarioRerunScope } from './scenario-rerun-scope';

/**
 * SPEC-P006-FAILED-SCENARIO-RERUN@1, at the decision itself.
 *
 * `evidence.test.ts` exercises this through `finishTestEvidence` with a faked ledger, which
 * is the behaviour that ships. These cases pin the DECISION in isolation, where each arm is
 * one changed variable rather than a whole bound row — so a future edit that happens to
 * settle the right phase for the wrong reason still fails here.
 */
describe('resolveScenarioRerunScope', () => {
  const MATRIX = ['boot', 'retry', 'teardown', 'recover'];
  const current = { sourceFingerprint: 'src-1', testFingerprint: 'test-1' };
  const base = { scenarioIds: MATRIX, testNamePattern: 'recover', current };

  // --- the question does not arise -------------------------------------------------
  // These return null rather than a permissive verdict: nothing is being carried, so
  // there is nothing to refuse. Widening either would tax the ordinary cheap rerun.

  it('does not arise for an unfiltered run — it re-measures the matrix itself', () => {
    expect(resolveScenarioRerunScope({ ...base, testNamePattern: undefined })).toBeNull();
    expect(resolveScenarioRerunScope({ ...base, testNamePattern: null })).toBeNull();
    // Whitespace is not a filter; vitest would run everything.
    expect(resolveScenarioRerunScope({ ...base, testNamePattern: '   ' })).toBeNull();
  });

  it('does not arise for a binding with no remaining matrix', () => {
    expect(resolveScenarioRerunScope({ ...base, scenarioIds: ['only'] })).toBeNull();
    expect(resolveScenarioRerunScope({ ...base, scenarioIds: [] })).toBeNull();
    expect(resolveScenarioRerunScope({ ...base, scenarioIds: undefined })).toBeNull();
    // Blank ids are not members of a matrix.
    expect(resolveScenarioRerunScope({ ...base, scenarioIds: ['only', '  '] })).toBeNull();
  });

  // --- the two arms of the falsifier ------------------------------------------------

  it('ARM 1 — carries the remaining matrix while the sibling fingerprints are current', () => {
    expect(resolveScenarioRerunScope({ ...base, priorEvidence: { ...current } })).toEqual({
      scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: MATRIX, stale: [],
    });
  });

  it('ARM 2 — refuses the carry on a stale SOURCE fingerprint', () => {
    expect(resolveScenarioRerunScope({
      ...base, priorEvidence: { sourceFingerprint: 'src-0', testFingerprint: 'test-1' },
    })).toEqual({ scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: ['source'] });
  });

  it('ARM 2 — refuses the carry on a stale TEST fingerprint too', () => {
    // The tests themselves moving invalidates the siblings' proof just as the source does.
    expect(resolveScenarioRerunScope({
      ...base, priorEvidence: { sourceFingerprint: 'src-1', testFingerprint: 'test-0' },
    })).toEqual({ scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: ['test'] });
  });

  it('names every dimension that moved, not just the first', () => {
    expect(resolveScenarioRerunScope({
      ...base, priorEvidence: { sourceFingerprint: 'src-0', testFingerprint: 'test-0' },
    })!.stale).toEqual(['source', 'test']);
  });

  // --- absence is not currency -------------------------------------------------------

  it('refuses a carry when no sibling evidence was ever recorded', () => {
    for (const priorEvidence of [undefined, null, {}, { sourceFingerprint: '' }, { sourceFingerprint: null }]) {
      expect(resolveScenarioRerunScope({ ...base, priorEvidence })).toMatchObject({
        scope: 'full-matrix', reason: 'no-sibling-evidence', carried: [],
      });
    }
  });

  it('treats a one-sided missing test fingerprint as stale, never as comparable', () => {
    // Absent-on-one-side is the case a `!=` over two optionals silently forgives.
    expect(resolveScenarioRerunScope({
      ...base, priorEvidence: { sourceFingerprint: 'src-1' },
    })!.stale).toEqual(['test']);
    expect(resolveScenarioRerunScope({
      ...base, current: { sourceFingerprint: 'src-1' },
      priorEvidence: { sourceFingerprint: 'src-1', testFingerprint: 'test-1' },
    })!.stale).toEqual(['test']);
  });

  it('never reports carried ids alongside a refusal', () => {
    // `carried` is what the run leans on; a refusal leans on nothing. Keeping these
    // coupled stops a caller reading a refusal's id list as licence to carry them.
    const refusals = [
      resolveScenarioRerunScope({ ...base, priorEvidence: { sourceFingerprint: 'src-0' } }),
      resolveScenarioRerunScope({ ...base, priorEvidence: null }),
    ];
    for (const verdict of refusals) {
      expect(verdict!.scope).toBe('full-matrix');
      expect(verdict!.carried).toEqual([]);
    }
  });
});

/**
 * MUTATION CONTROL — SPEC-P006-FAILED-SCENARIO-RERUN@1 carries `mutationRequired: true`.
 *
 * The subject is a module this suite IMPORTS, and for that class the repo's falsifiability
 * tiers forbid mutating production code at all (CLAUDE.md § "Proving a guard is falsifiable":
 * git-sync sweeps the whole tree every few minutes, so a probe that holds a tracked file
 * mutated for the length of a run can have the mutant committed even when nothing goes wrong
 * and no handler fails — a race no trap can close). The prescribed tier for an imported module
 * is a deliberately wrong implementation kept PERMANENTLY beside the real one. That is this.
 *
 * It is also re-runnable by anyone, forever, which a one-off probe is not: a probe's only
 * artifact is a /tmp log no reviewer can reproduce (EI-22622809413886561 filed exactly that
 * against spec-evidence counterexample bindings).
 *
 * Each mutant below is a plausible wrong implementation of this decision. The control asserts
 * the CONTRACT kills every one — and, the half that keeps it honest, that the REAL resolver
 * passes every case. Without that calibration a contract that rejected everything would "kill"
 * all five mutants while proving nothing whatsoever.
 */
describe('resolveScenarioRerunScope — mutation control', () => {
  type Scope = ReturnType<typeof resolveScenarioRerunScope>;
  type Input = Parameters<typeof resolveScenarioRerunScope>[0];

  const MATRIX = ['boot', 'retry', 'teardown', 'recover'];
  const CURRENT = { sourceFingerprint: 'src-1', testFingerprint: 'test-1' };
  const STALE_SOURCE = { sourceFingerprint: 'src-2', testFingerprint: 'test-1' };
  const STALE_TEST = { sourceFingerprint: 'src-1', testFingerprint: 'test-2' };
  const narrowed = { scenarioIds: MATRIX, testNamePattern: 'recover', current: CURRENT };

  const CONTRACT: Array<{ name: string; input: Input; expected: Scope }> = [
    // The two cases that pin the guard to the NARROWING rather than to staleness alone.
    { name: 'an unfiltered run carries nothing, even against a stale row',
      input: { ...narrowed, testNamePattern: undefined, priorEvidence: STALE_SOURCE }, expected: null },
    { name: 'a single-scenario binding has no remaining matrix, even against a stale row',
      input: { ...narrowed, scenarioIds: ['recover'], priorEvidence: STALE_SOURCE }, expected: null },
    { name: 'current sibling fingerprints let a narrowed run carry the matrix',
      input: { ...narrowed, priorEvidence: { ...CURRENT } },
      expected: { scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: MATRIX, stale: [] } },
    { name: 'a moved SOURCE fingerprint refuses the carry',
      input: { ...narrowed, priorEvidence: STALE_SOURCE },
      expected: { scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: ['source'] } },
    { name: 'a moved TEST fingerprint refuses the carry',
      input: { ...narrowed, priorEvidence: STALE_TEST },
      expected: { scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: ['test'] } },
    { name: 'absent sibling evidence is not currency',
      input: { ...narrowed, priorEvidence: null },
      expected: { scope: 'full-matrix', reason: 'no-sibling-evidence', carried: [], stale: [] } },
  ];

  const agrees = (actual: Scope, expected: Scope) =>
    actual === null || expected === null
      ? actual === expected
      : actual.scope === expected.scope && actual.reason === expected.reason
        && actual.carried.join('|') === expected.carried.join('|')
        && actual.stale.join('|') === expected.stale.join('|');

  /** Which contract cases an implementation violates — empty means it is indistinguishable. */
  const violations = (candidate: (opts: Input) => Scope) =>
    CONTRACT.filter(c => !agrees(candidate(c.input), c.expected)).map(c => c.name);

  /** The shared preamble every honest implementation gets right; mutants differ AFTER it. */
  function arises(o: Input): string[] | null {
    const pattern = typeof o.testNamePattern === 'string' ? o.testNamePattern.trim() : '';
    if (pattern.length === 0) return null;
    const ids = (o.scenarioIds ?? []).filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0,
    );
    return ids.length < 2 ? null : ids;
  }

  function staleDims(prior: Input['priorEvidence'], current: Input['current']): Array<'source' | 'test'> {
    const dims: Array<'source' | 'test'> = [];
    if ((prior?.sourceFingerprint ?? null) !== (current.sourceFingerprint ?? null)) dims.push('source');
    if ((prior?.testFingerprint ?? null) !== (current.testFingerprint ?? null)) dims.push('test');
    return dims;
  }

  const MUTANTS: Array<{ name: string; impl: (opts: Input) => Scope }> = [
    {
      // The behaviour BEFORE this guard existed: a name-filtered rerun settled the binding's
      // whole matrix off whatever a previous run recorded, with no currency check at all.
      name: 'carries the remaining matrix unconditionally (the pre-guard behaviour)',
      impl: o => {
        const ids = arises(o);
        if (!ids) return null;
        return { scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: ids, stale: [] };
      },
    },
    {
      // Over-firing. Correct on BOTH falsifier arms, and wrong anyway: it taxes every ordinary
      // cheap rerun, which is the saving R-8 exists to produce. Only the calibration cases
      // above can tell this apart from the real thing.
      name: 'refuses every narrowed rerun regardless of currency',
      impl: o => {
        const ids = arises(o);
        if (!ids) return null;
        return { scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: ['source'] };
      },
    },
    {
      // The empty-grep error: nothing recorded read as nothing wrong.
      name: 'reads absent sibling evidence as currency',
      impl: o => {
        const ids = arises(o);
        if (!ids) return null;
        const dims = staleDims(o.priorEvidence, o.current);
        return dims.length > 0 && o.priorEvidence
          ? { scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: dims }
          : { scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: ids, stale: [] };
      },
    },
    {
      // Checks the source and forgets the test file — an edited TEST invalidates the siblings'
      // proof exactly as an edited source does.
      name: 'compares only the source fingerprint',
      impl: o => {
        const ids = arises(o);
        if (!ids) return null;
        const priorSource = typeof o.priorEvidence?.sourceFingerprint === 'string' ? o.priorEvidence.sourceFingerprint : '';
        if (priorSource.length === 0) return { scope: 'full-matrix', reason: 'no-sibling-evidence', carried: [], stale: [] };
        return priorSource !== (o.current.sourceFingerprint ?? null)
          ? { scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: ['source'] }
          : { scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: ids, stale: [] };
      },
    },
    {
      // Fires on staleness alone, ignoring whether anything is actually being CARRIED. Refuses
      // unfiltered and single-scenario reruns that measured everything they claim.
      name: 'ignores the narrowing and fires on a stale row alone',
      impl: o => {
        const dims = staleDims(o.priorEvidence, o.current);
        if (!o.priorEvidence) return { scope: 'full-matrix', reason: 'no-sibling-evidence', carried: [], stale: [] };
        return dims.length > 0
          ? { scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale: dims }
          : { scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: o.scenarioIds as string[], stale: [] };
      },
    },
  ];

  // CALIBRATION — this must pass before any kill below means anything.
  it('the real resolver satisfies every contract case', () => {
    expect(violations(resolveScenarioRerunScope)).toEqual([]);
  });

  it.each(MUTANTS)('kills the mutant that $name', ({ impl }) => {
    expect(violations(impl).length).toBeGreaterThan(0);
  });
});
