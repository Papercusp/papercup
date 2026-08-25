/**
 * Unit tests for P-038's judge-agreement core (WI-37638).
 *
 * The judge itself is an LLM and cannot be asserted on here — what CAN rot
 * silently is the ARITHMETIC around it, and that is what these pin:
 *   - sensitivity and specificity stay SEPARATE (the blended rate is the
 *     number that would quietly overstate the judge),
 *   - self-consistency counts BINARY FLIPS, not just |Δ| (a |Δ| that never
 *     crosses the bar injects no label noise; one that crosses it flips a label),
 *   - the re-judge rows never double-count into the arm aggregates,
 *   - pair construction is deterministic and excludes the referenced item.
 *
 * The LLM transport is a scripted fake, so these run offline at zero cost.
 */
import { describe, expect, it } from 'vitest';

import {
  composeJudgeScaffoldProbe,
  JUDGE_PROMPT_SCAFFOLD_VERSION,
  type LlmCallFn,
} from '@papercusp/testing-shell/llm';

import {
  aggregateByArm,
  buildPairsForQuery,
  deriveJudgeAgreementRubricVersion,
  JUDGE_AGREEMENT_RUBRIC_VERSION,
  JUDGE_INSTRUCTION_CONTRACT,
  runJudgeAgreement,
  RELEVANCE_PASS_BAR,
  SEARCH_RELEVANCE_RUBRIC,
  synthesizePairRun,
  type JudgedPair,
  type PairOutcome,
} from './judge-agreement';
import { sha256 } from './judge-cache';
import type { GoldQuery, PoolDoc } from './ref-expansion-gold';

/**
 * A fake judge that returns a scripted score per call, in order. Mirrors the
 * real transport's result shape so `judgeRun` parses it on the happy path.
 */
function fakeJudge(scores: readonly number[]): { llm: LlmCallFn; calls: () => number } {
  let i = 0;
  const llm: LlmCallFn = async () => {
    const relevance = scores[i % scores.length]!;
    i++;
    return {
      text: JSON.stringify({ scores: { relevance } }),
      json: { scores: { relevance }, notes: `scripted ${relevance}` },
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      raw: {},
    };
  };
  return { llm, calls: () => i };
}

function pair(over: Partial<JudgedPair> & Pick<JudgedPair, 'pairId' | 'goldRelevant'>): JudgedPair {
  return {
    ref: 'WI-1',
    arm: 'verbatim',
    query: 'q',
    docId: 'D-1',
    docText: 'doc',
    ...over,
  };
}

function outcome(over: Partial<PairOutcome> & Pick<PairOutcome, 'goldRelevant' | 'relevance'>): PairOutcome {
  const judgedRelevant = over.relevance >= RELEVANCE_PASS_BAR;
  return {
    pairId: `p${Math.random()}`,
    ref: 'WI-1',
    arm: 'verbatim',
    query: 'q',
    docId: 'D-1',
    docText: 'doc',
    judgedRelevant,
    agrees: judgedRelevant === over.goldRelevant,
    judgeCostUsd: 0,
    ...over,
  };
}

describe('aggregateByArm', () => {
  it('reports sensitivity and specificity SEPARATELY rather than one blended rate', () => {
    // 2 positives, both missed by the judge; 6 negatives, all correctly rejected.
    const outcomes: PairOutcome[] = [
      outcome({ goldRelevant: true, relevance: 1 }),
      outcome({ goldRelevant: true, relevance: 2 }),
      ...Array.from({ length: 6 }, () => outcome({ goldRelevant: false, relevance: 0 })),
    ];
    const [agg] = aggregateByArm(outcomes);

    expect(agg!.positives.sensitivity).toBe(0);
    expect(agg!.negatives.specificity).toBe(1);
    // The blended number looks like a 75%-accurate judge while it is in fact
    // catching NONE of the relevant documents — this is why it is never quoted alone.
    expect(agg!.rawAgreement).toBe(0.75);
  });

  it('separates the two arms instead of pooling them', () => {
    const outcomes: PairOutcome[] = [
      outcome({ arm: 'verbatim', goldRelevant: true, relevance: 5 }),
      outcome({ arm: 'verbatim', goldRelevant: false, relevance: 0 }),
      outcome({ arm: 'degraded', goldRelevant: true, relevance: 1 }),
      outcome({ arm: 'degraded', goldRelevant: false, relevance: 0 }),
    ];
    const byArm = aggregateByArm(outcomes);
    const verbatim = byArm.find((a) => a.arm === 'verbatim')!;
    const degraded = byArm.find((a) => a.arm === 'degraded')!;

    expect(verbatim.positives.sensitivity).toBe(1);
    expect(degraded.positives.sensitivity).toBe(0);
    // Separation is the judge's discrimination on that arm.
    expect(verbatim.separation).toBe(5);
    expect(degraded.separation).toBe(1);
  });

  it('scores an empty class as 0 without dividing by zero', () => {
    const [agg] = aggregateByArm([outcome({ goldRelevant: true, relevance: 4 })]);
    expect(agg!.negatives.n).toBe(0);
    expect(agg!.negatives.specificity).toBe(0);
    expect(Number.isNaN(agg!.negatives.meanScore)).toBe(false);
  });
});

describe('content-derived rubric version', () => {
  /**
   * Re-derives the version the way judge-agreement.ts does, over supplied content.
   * `scaffold` defaults to the live one so every pre-existing control below keeps
   * measuring exactly what it measured before the third layer was added.
   */
  const versionOf = (
    axes: unknown,
    instructions: unknown,
    scaffold: string = JUDGE_PROMPT_SCAFFOLD_VERSION,
  ) =>
    `search-relevance.${sha256(JSON.stringify({ rubric: { axes }, instructions, scaffold })).slice(
      0,
      12,
    )}`;

  it('derives from the judging axes AND the instruction contract', () => {
    expect(JUDGE_AGREEMENT_RUBRIC_VERSION).toBe(
      versionOf(SEARCH_RELEVANCE_RUBRIC.axes, JUDGE_INSTRUCTION_CONTRACT),
    );
    expect(SEARCH_RELEVANCE_RUBRIC.version).toBe(JUDGE_AGREEMENT_RUBRIC_VERSION);
  });

  /**
   * EI-21444532129225543. The axes were already hashed; the instruction text actually
   * handed to the judge was NOT, so rewording it kept serving grades a different
   * contract had produced. These are permanently-resident defective controls — each
   * mutates a COPY of the contract, never the tree — so the guard is provably
   * falsifiable rather than merely never-failing.
   */
  it.each([
    ['scenarioTemplate', { scenarioTemplate: 'Score anything that looks related.' }],
    ['personaSummary', { personaSummary: 'a chatty simulated user' }],
    ['goalSummary', { goalSummary: 'lexical overlap between query and document' }],
    ['criticality', { criticality: 'high' as const }],
  ])('moves the cache namespace when %s changes', (_field, override) => {
    const mutated = { ...JUDGE_INSTRUCTION_CONTRACT, ...override };
    expect(versionOf(SEARCH_RELEVANCE_RUBRIC.axes, mutated)).not.toBe(
      JUDGE_AGREEMENT_RUBRIC_VERSION,
    );
  });

  it('is NOT the pre-fix axes-only derivation (the regression pin)', () => {
    // This is what the version was before EI-21444532129225543: sha over the rubric
    // content alone. Asserting the live version differs from it is what makes every
    // instruction-contract test above meaningful — under the old derivation they
    // would all still pass while the defect was fully present.
    const preFix = `search-relevance.${sha256(
      JSON.stringify({ axes: SEARCH_RELEVANCE_RUBRIC.axes }),
    ).slice(0, 12)}`;
    expect(JUDGE_AGREEMENT_RUBRIC_VERSION).not.toBe(preFix);
  });

  it('moves the cache namespace when a judging axis changes', () => {
    const mutatedAxes = [
      { ...SEARCH_RELEVANCE_RUBRIC.axes[0]!, description: 'Reward shared vocabulary.' },
    ];
    expect(versionOf(mutatedAxes, JUDGE_INSTRUCTION_CONTRACT)).not.toBe(
      JUDGE_AGREEMENT_RUBRIC_VERSION,
    );
  });

  it('keeps the per-pair query OUT of the hashed contract (query_hash covers it)', () => {
    // The template must stay a constant carrying a placeholder. Interpolating the
    // query into it would make the version vary per pair, which would defeat the
    // cache entirely rather than merely under-invalidate it.
    expect(JUDGE_INSTRUCTION_CONTRACT.scenarioTemplate).toContain('{query}');
    expect(JUDGE_AGREEMENT_RUBRIC_VERSION).toBe(
      versionOf(SEARCH_RELEVANCE_RUBRIC.axes, JUDGE_INSTRUCTION_CONTRACT),
    );
  });

  /**
   * EI-21446121743333195 — the THIRD instance of this defect class, and the reason
   * the contract now covers the transcript as well as the instructions. These four
   * values all reach the judge through `synthesizePairRun`: the framing prose and
   * finishReason via formatTranscript (judge.ts:331,341), the two numbers via
   * formatTelemetry (judge.ts:352-363), and scenarioId via the system prompt's first
   * line (judge.ts:232). Permanently-resident defective controls, each mutating a COPY.
   */
  it.each([
    ['scenarioId', { scenarioId: 'generic-eval' }],
    ['transcriptTemplate', { transcriptTemplate: 'Document for "{query}":\n\n{docText}' }],
    ['turnFinishReason', { turnFinishReason: 'error' as const }],
    ['turnLatencyMs', { turnLatencyMs: 12 }],
    ['turnCostUsd', { turnCostUsd: 0.01 }],
  ])('moves the cache namespace when %s changes', (_field, override) => {
    const mutated = { ...JUDGE_INSTRUCTION_CONTRACT, ...override };
    expect(versionOf(SEARCH_RELEVANCE_RUBRIC.axes, mutated)).not.toBe(
      JUDGE_AGREEMENT_RUBRIC_VERSION,
    );
  });

  it('is NOT the pre-fix instructions-only derivation (the EI-21446121743333195 pin)', () => {
    // The regression pin for THIS fix, mirroring the axes-only pin above. Before it,
    // the contract held only these four fields and the transcript framing sat outside
    // the hash entirely — under that derivation every transcript control above would
    // still pass while the defect was fully present.
    const { scenarioTemplate, personaSummary, goalSummary, criticality } =
      JUDGE_INSTRUCTION_CONTRACT;
    const preFix = versionOf(SEARCH_RELEVANCE_RUBRIC.axes, {
      scenarioTemplate,
      personaSummary,
      goalSummary,
      criticality,
    });
    expect(JUDGE_AGREEMENT_RUBRIC_VERSION).not.toBe(preFix);
  });

  /**
   * WI-41675 — the FOURTH instance of this defect class, one layer further out than
   * the three above. Those were about values THIS file authors that escaped its own
   * hash. This is about text this file never authors and cannot see: the rules, the
   * score-5 anchor, the output schema and the structural labels that
   * `@papercusp/testing-shell` wraps around every judge prompt. Editing one of them
   * changed every judged prompt on the platform while leaving already-paid grades
   * reachable under an unchanged key.
   */
  it('binds the live version to the live testing-shell scaffold version', () => {
    expect(JUDGE_AGREEMENT_RUBRIC_VERSION).toBe(
      deriveJudgeAgreementRubricVersion(JUDGE_PROMPT_SCAFFOLD_VERSION),
    );
  });

  it('moves the cache namespace when the scaffold version changes', () => {
    // The falsifiability control for the whole layer. The derivation is a pure
    // function of the scaffold version, so two scaffolds MUST key differently —
    // and the live key must not be reachable from some other scaffold.
    expect(deriveJudgeAgreementRubricVersion('aaaaaaaaaaaa')).not.toBe(
      deriveJudgeAgreementRubricVersion('bbbbbbbbbbbb'),
    );
    expect(deriveJudgeAgreementRubricVersion('aaaaaaaaaaaa')).not.toBe(
      JUDGE_AGREEMENT_RUBRIC_VERSION,
    );
  });

  it('is NOT the pre-fix scaffold-blind derivation (the WI-41675 pin)', () => {
    // Mirrors the two pins above. Before this fix the key was the rubric plus the
    // instruction contract and nothing else — under that derivation every scaffold
    // control here would still pass while the defect was fully present.
    const preFix = `search-relevance.${sha256(
      JSON.stringify({
        rubric: { axes: SEARCH_RELEVANCE_RUBRIC.axes },
        instructions: JUDGE_INSTRUCTION_CONTRACT,
      }),
    ).slice(0, 12)}`;
    expect(JUDGE_AGREEMENT_RUBRIC_VERSION).not.toBe(preFix);
  });

  /**
   * A hash is only as honest as the input it is taken over, and the scaffold version
   * is taken over a PROBE — text composed by the real builders rather than the real
   * prompt. So enumerate what that probe must contain. Each marker below is static
   * text the judge genuinely reads; if the probe ever stopped composing the surface
   * carrying it, the version would go quietly blind to that surface while every
   * other test here still passed.
   */
  it.each([
    ['the score-5 anchor rule', 'Score-5 anchor'],
    ['the behavioral-suggestion rule', 'NOT an implementation change'],
    ['the no-code-changes rule', 'Do not propose code changes'],
    ['the output schema', '"agrees_with_deterministic_asserts"'],
    ['the known-tool-registry branch', 'Known tool registry'],
    ['the no-registry fallback branch', 'NO ground-truth tool registry'],
    ['the transcript turn label', '### Turn'],
    ['the finishReason label', '**finishReason:**'],
    ['the telemetry total label', 'Total:'],
    ['the empty-violations text', '(none — all deterministic asserts passed)'],
  ])('the hashed scaffold probe covers %s', (_surface, marker) => {
    expect(composeJudgeScaffoldProbe()).toContain(marker);
  });
});

/**
 * Hashing a field is worthless if the code that talks to the judge does not READ it.
 * These assert the binding itself — that the prompt-visible half of the synthesized
 * run is derived from the hashed contract — which is the half a version test cannot see.
 */
describe('synthesizePairRun prompt-visible fields derive from the hashed contract', () => {
  const pair = {
    pairId: 'ref-1:verbatim:pos',
    query: 'vector index rebuild',
    docId: 'doc-1',
    docText: 'How to rebuild the vector index.',
  };

  it('builds the transcript turn from transcriptTemplate, not a restated literal', () => {
    const run = synthesizePairRun(pair, 'test-model');
    expect(run.turns[0]!.assistantText).toBe(
      JUDGE_INSTRUCTION_CONTRACT.transcriptTemplate
        .replace('{query}', pair.query)
        .replace('{docText}', pair.docText),
    );
    // Both per-pair halves must survive substitution — they are what the judge scores.
    expect(run.turns[0]!.assistantText).toContain(pair.query);
    expect(run.turns[0]!.assistantText).toContain(pair.docText);
    expect(run.turns[0]!.assistantText).not.toContain('{query}');
    expect(run.turns[0]!.assistantText).not.toContain('{docText}');
  });

  it('takes finishReason and the telemetry numbers from the contract', () => {
    const run = synthesizePairRun(pair, 'test-model');
    expect(run.turns[0]!.finishReason).toBe(JUDGE_INSTRUCTION_CONTRACT.turnFinishReason);
    expect(run.turns[0]!.latencyMs).toBe(JUDGE_INSTRUCTION_CONTRACT.turnLatencyMs);
    expect(run.turns[0]!.costUsd).toBe(JUDGE_INSTRUCTION_CONTRACT.turnCostUsd);
    expect(run.totalCostUsd).toBe(JUDGE_INSTRUCTION_CONTRACT.turnCostUsd);
  });

  it('carries NO per-pair identity into scenarioId, which the cache key cannot see', () => {
    // `pair_id` is INSERTed into search_judge_grades but is NOT one of the six key
    // columns, so a scenarioId varying by pairId would let two pairs sharing a key be
    // judged under different prompts. Per-pair identity belongs on runId/identityHash,
    // neither of which reaches the prompt.
    const a = synthesizePairRun(pair, 'test-model');
    const b = synthesizePairRun({ ...pair, pairId: 'ref-9:degraded:neg' }, 'test-model');
    expect(a.scenarioId).toBe(JUDGE_INSTRUCTION_CONTRACT.scenarioId);
    expect(a.scenarioId).toBe(b.scenarioId);
    expect(a.scenarioId).not.toContain(pair.pairId);
    expect(a.runId).not.toBe(b.runId);
  });

  it('does not let $-sequences in a document corrupt the substitution', () => {
    // String.prototype.replace makes `$&`, `$\``, `$'` and `$1` SPECIAL in the
    // replacement, so a document containing them would be rewritten into a copy of the
    // matched placeholder. Corpus text is arbitrary, so this is reachable, and it would
    // silently change what the judge scores rather than throwing.
    const nasty = { ...pair, docText: "cost is $& plus $' and $1", query: 'price of $&' };
    const run = synthesizePairRun(nasty, 'test-model');
    expect(run.turns[0]!.assistantText).toContain("cost is $& plus $' and $1");
    expect(run.turns[0]!.assistantText).toContain('price of $&');
  });

  it('CALIBRATION: the pre-fix restated-literal synthesizer fails these same assertions', () => {
    // A permanently-resident defective control. This is what synthesizePairRun did
    // before EI-21446121743333195 — a hand-written literal and a per-pair scenarioId,
    // with the naive two-pass replace. Asserting it FAILS the checks the real function
    // passes is what shows those checks discriminate, rather than holding for any
    // implementation. Without this, every assertion above could be vacuously true.
    const defective = (p: typeof pair) => ({
      scenarioId: `search-relevance-${p.pairId}`,
      assistantText: `Search result document for the query "${p.query}":\n\n${p.docText}`,
    });

    // 1. per-pair identity leaks into the prompt-visible scenarioId
    const a = defective(pair);
    const b = defective({ ...pair, pairId: 'ref-9:degraded:neg' });
    expect(a.scenarioId).not.toBe(b.scenarioId);
    expect(a.scenarioId).toContain(pair.pairId);

    // 2. the framing is a second copy, so rewording the contract does NOT move it
    const reworded = { ...JUDGE_INSTRUCTION_CONTRACT, transcriptTemplate: 'Doc: {docText}' };
    expect(defective(pair).assistantText).not.toBe(
      reworded.transcriptTemplate.replace('{docText}', pair.docText),
    );
    // ...while the real synthesizer tracks the contract it is derived from.
    expect(synthesizePairRun(pair, 'test-model').turns[0]!.assistantText).toBe(
      JUDGE_INSTRUCTION_CONTRACT.transcriptTemplate
        .replace('{query}', pair.query)
        .replace('{docText}', pair.docText),
    );
  });

  it('does not re-substitute a placeholder that appears inside a substituted value', () => {
    // Two sequential replaces would let a query containing the literal `{docText}`
    // capture the document. One pass with a single regex cannot.
    const run = synthesizePairRun({ ...pair, query: 'literally {docText}' }, 'test-model');
    expect(run.turns[0]!.assistantText).toContain('literally {docText}');
    expect(run.turns[0]!.assistantText).toContain(pair.docText);
  });
});

describe('runJudgeAgreement self-consistency', () => {
  it('counts a BINARY FLIP only when the re-judge crosses the pass bar', async () => {
    // First pass scores every pair 4 (relevant). The re-judge pass scores 5 —
    // a |Δ| of 1 that changes no label.
    const pairs = [pair({ pairId: 'a', goldRelevant: true }), pair({ pairId: 'b', goldRelevant: true })];
    const { llm } = fakeJudge([4, 4, 5, 5]);

    const report = await runJudgeAgreement({ pairs, llm, selfConsistencyN: 2 });

    expect(report.selfConsistency).not.toBeNull();
    expect(report.selfConsistency!.meanAbsDelta).toBe(1);
    // The delta moved but no label did — the flip rate is what bounds label noise.
    expect(report.selfConsistency!.flipRate).toBe(0);
  });

  it('counts a flip when the re-judge crosses the bar downward', async () => {
    const pairs = [pair({ pairId: 'a', goldRelevant: true })];
    // 3 (relevant, at the bar) then 2 (not relevant) — |Δ| 1 that DOES flip.
    const { llm } = fakeJudge([3, 2]);

    const report = await runJudgeAgreement({ pairs, llm, selfConsistencyN: 1 });

    expect(report.selfConsistency!.meanAbsDelta).toBe(1);
    expect(report.selfConsistency!.flipRate).toBe(1);
  });

  it('excludes the re-judge rows from the arm aggregates', async () => {
    const pairs = [pair({ pairId: 'a', goldRelevant: true }), pair({ pairId: 'b', goldRelevant: false })];
    const { llm } = fakeJudge([5, 0, 5, 0]);

    const report = await runJudgeAgreement({ pairs, llm, selfConsistencyN: 2 });
    const [agg] = report.byArm;

    // 4 outcomes are retained (2 first-pass + 2 re-judged) but only the 2
    // first-pass rows may count, or every rate is computed over a doubled n.
    expect(report.outcomes).toHaveLength(4);
    expect(agg!.positives.n).toBe(1);
    expect(agg!.negatives.n).toBe(1);
    expect(report.outcomes.filter((o) => o.pairId.endsWith('#rejudge'))).toHaveLength(2);
  });

  it('reports null self-consistency when disabled rather than a fabricated zero', async () => {
    const { llm } = fakeJudge([4]);
    const report = await runJudgeAgreement({
      pairs: [pair({ pairId: 'a', goldRelevant: true })],
      llm,
      selfConsistencyN: 0,
    });
    // A 0% flip rate and "never measured" must not be the same value.
    expect(report.selfConsistency).toBeNull();
  });

  it('carries the limits with the numbers', async () => {
    const { llm } = fakeJudge([4]);
    const report = await runJudgeAgreement({
      pairs: [pair({ pairId: 'a', goldRelevant: true })],
      llm,
      selfConsistencyN: 0,
    });
    expect(report.caveats.length).toBeGreaterThan(0);
    expect(report.caveats.join(' ')).toMatch(/UPPER BOUND/);
    expect(report.caveats.join(' ')).toMatch(/LOWER bound/);
  });
});

describe('buildPairsForQuery', () => {
  const pool: PoolDoc[] = [
    { id: 'D-cites', v1Text: 'cites the ref', v2Text: '', refs: ['WI-9'] },
    { id: 'WI-9', v1Text: 'the referenced item itself', v2Text: '', refs: [] },
    { id: 'D-other-1', v1Text: 'unrelated one', v2Text: '', refs: [] },
    { id: 'D-other-2', v1Text: 'unrelated two', v2Text: '', refs: [] },
  ];
  const q: GoldQuery = {
    ref: 'WI-9',
    text: 'the referenced item title',
    degraded: 'referenced title',
    relevantIds: ['D-cites'],
  };

  it('never draws the referenced item itself as a negative', () => {
    const pairs = buildPairsForQuery(q, pool);
    const negatives = pairs.filter((p) => !p.goldRelevant);
    expect(negatives.length).toBeGreaterThan(0);
    // WI-9 is topically identical to the query but gold never labels it
    // relevant (it does not cite itself) — drawing it would manufacture a
    // disagreement and charge it to the judge.
    expect(negatives.every((p) => p.docId !== 'WI-9')).toBe(true);
  });

  it('is deterministic — a re-run judges the same pairs', () => {
    expect(buildPairsForQuery(q, pool)).toEqual(buildPairsForQuery(q, pool));
  });

  it('emits both arms with one positive and one negative each', () => {
    const pairs = buildPairsForQuery(q, pool);
    expect(pairs).toHaveLength(4);
    expect(pairs.filter((p) => p.arm === 'verbatim')).toHaveLength(2);
    expect(pairs.filter((p) => p.arm === 'degraded')).toHaveLength(2);
    expect(pairs.filter((p) => p.goldRelevant)).toHaveLength(2);
    expect(pairs.find((p) => p.arm === 'degraded')!.query).toBe('referenced title');
  });

  it('yields nothing when the query has no usable positive or negative', () => {
    const onlyRelevant: PoolDoc[] = [{ id: 'D-cites', v1Text: 'x', v2Text: '', refs: ['WI-9'] }];
    expect(buildPairsForQuery(q, onlyRelevant)).toEqual([]);
    expect(buildPairsForQuery({ ...q, relevantIds: ['D-missing'] }, pool)).toEqual([]);
  });
});
