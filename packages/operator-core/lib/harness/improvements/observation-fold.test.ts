/**
 * observation-fold.test.ts — the LABELLED-SAMPLE calibration for the fold guard
 * (learning-loop-identity-and-consumption-2026-08-08 P-014).
 *
 * P-014 requires the HARD/SOFT boundary to be calibrated on a HAND-LABELLED
 * sample with PUBLISHED precision, because "an unlabelled threshold is a guess
 * wearing a number". This file IS that sample, and the published figure is
 * printed by the `publishes precision` test below.
 *
 * WHY PRECISION IS THE METRIC THAT MATTERS, and recall is not.
 * The two errors are not symmetric and must not be traded off as if they were:
 *  - A false FOLD (precision error) is SILENT and unrecoverable in practice: a
 *    genuinely distinct problem is absorbed into another row and is never seen
 *    again. D-042 names this as the failure that "is worse than the noise it
 *    replaces".
 *  - A missed fold (recall error) is VISIBLE and self-correcting: you get the
 *    row growth we already have, which is merely the status quo.
 * So the bar asserted here is precision = 1.00 on the labelled sample — zero
 * false folds — and recall is REPORTED but deliberately NOT floored.
 *
 * TEMPLATED PAIRS ARE OVER-SAMPLED ON PURPOSE (D-043). The upstream
 * semantic-dupe-guard calibration (2026-08-12) explicitly EXCLUDED templated
 * watchdog filings because they inflate the corpus baseline. The observation
 * lane is full of them, so its precision figure does not transfer unadjusted —
 * this sample puts them back in, and they are exactly the pairs the D-036
 * discriminator has to catch.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyObservationFold,
  discriminate,
  subjectTokens,
  type FoldCandidate,
} from './observation-fold';

/** A hand-labelled pair. `label` is the ground truth a human assigned. */
interface LabelledPair {
  name: string;
  incoming: string;
  candidate: string;
  /** Measured-or-realistic scores the retrieval layer would produce. */
  similarity: number;
  titleSimilarity: number;
  /** GROUND TRUTH: is this actually the same problem? */
  label: 'duplicate' | 'distinct';
  /** Is this a templated filing shape (shared wording, varying subject)? */
  templated: boolean;
}

/**
 * THE LABELLED SAMPLE.
 *
 * Titles follow the real shapes observed in `lane='observation'` on
 * workspace `papercusp-workspace`. Cosine/title scores are set in the bands the
 * 2026-08-12 calibration measured for each class: known duplicates 0.861–0.892,
 * known-distinct 0.857–0.868, templated siblings materially higher on both legs
 * (which is precisely why cosine alone cannot be trusted here).
 */
const SAMPLE: LabelledPair[] = [
  // ── TEMPLATED, DISTINCT (the D-036 trap; over-sampled) ────────────────────
  {
    name: 'templated test-failure, different test file',
    incoming: 'Test failing repeatedly: packages/operator-core/lib/harness/improvements/decay.test.ts',
    candidate: 'Test failing repeatedly: packages/operator-core/lib/harness/improvements/triage.test.ts',
    similarity: 0.968,
    titleSimilarity: 0.91,
    label: 'distinct',
    templated: true,
  },
  {
    name: 'templated canary breach, different hive',
    incoming: 'Hive canary breached for `papercusp-workspace`',
    candidate: 'Hive canary breached for `luna-workspace`',
    similarity: 0.961,
    titleSimilarity: 0.88,
    label: 'distinct',
    templated: true,
  },
  {
    name: 'templated lock timeout, different resource',
    incoming: 'Lock acquisition timed out on resource `git-sync:papercusp`',
    candidate: 'Lock acquisition timed out on resource `git-sync:luna`',
    similarity: 0.955,
    titleSimilarity: 0.93,
    label: 'distinct',
    templated: true,
  },
  {
    name: 'templated typecheck red, different package',
    incoming: 'Typecheck red in packages/agent-mcp after migration',
    candidate: 'Typecheck red in packages/operator-core after migration',
    similarity: 0.949,
    titleSimilarity: 0.87,
    label: 'distinct',
    templated: true,
  },
  {
    name: 'templated work-item citation, different item',
    incoming: 'Citation could not be resolved for WI-40665',
    candidate: 'Citation could not be resolved for WI-38056',
    similarity: 0.972,
    titleSimilarity: 0.9,
    label: 'distinct',
    templated: true,
  },

  // ── TEMPLATED, GENUINE DUPLICATE (same subject, changing measurement) ─────
  // P-002's founding evidence: the measurement moves, the condition does not.
  {
    name: 'same condition, measurement drifted (92/92 -> 96/96)',
    incoming: 'replication-liveness fires on 96/96 ticks in `papercusp-workspace`',
    candidate: 'replication-liveness fires on 92/92 ticks in `papercusp-workspace`',
    similarity: 0.964,
    titleSimilarity: 0.86,
    label: 'duplicate',
    templated: true,
  },
  {
    name: 'same condition, signal count drifted',
    incoming: 'watchdog fires on 100% of ticks (389 signals/24h) in `papercusp-workspace`',
    candidate: 'watchdog fires on 100% of ticks (356 signals/24h) in `papercusp-workspace`',
    similarity: 0.958,
    titleSimilarity: 0.84,
    label: 'duplicate',
    templated: true,
  },

  // ── UNTEMPLATED, GENUINE DUPLICATE (differently worded, same problem) ─────
  {
    name: 'same subsystem re-filed with different wording',
    incoming: 'coord:orient shed under load, blocking fleet bootstrap',
    candidate: 'coord:orient rejected during bootstrap when the host is saturated',
    similarity: 0.889,
    titleSimilarity: 0.52,
    label: 'duplicate',
    templated: false,
  },
  {
    name: 'same defect, different phrasing',
    incoming: 'ToolSearch cannot select colon-form tool names',
    candidate: 'ToolSearch select: fails for tool names written with a colon',
    similarity: 0.881,
    titleSimilarity: 0.55,
    label: 'duplicate',
    templated: false,
  },
  {
    name: 'same pipeline stall, reworded',
    incoming: 'git-sync push leg stalled for hours without alerting',
    candidate: 'git-sync stopped pushing to origin and nothing paged',
    similarity: 0.872,
    titleSimilarity: 0.51,
    label: 'duplicate',
    templated: false,
  },

  // ── UNTEMPLATED, DISTINCT (the overlap band that defeats pure cosine) ─────
  {
    name: 'topically close but different defects',
    incoming: 'Observation lane rows leak into the work queue',
    candidate: 'Observation lane rows are never marked consumed',
    similarity: 0.868,
    titleSimilarity: 0.41,
    label: 'distinct',
    templated: false,
  },
  {
    name: 'same subsystem, different failure',
    incoming: 'Scout tick errored on an upstream outage',
    candidate: 'Scout tick was gated by the circuit breaker',
    similarity: 0.863,
    titleSimilarity: 0.38,
    label: 'distinct',
    templated: false,
  },
  {
    name: 'adjacent but separate concerns',
    incoming: 'Plan projection missing from disk for a live plan',
    candidate: 'Plan decisions are not parsed from hand-authored bullets',
    similarity: 0.857,
    titleSimilarity: 0.22,
    label: 'distinct',
    templated: false,
  },

  // ── CLEARLY UNRELATED ─────────────────────────────────────────────────────
  {
    name: 'unrelated subsystems',
    incoming: 'Desktop sidecar records an empty build SHA',
    candidate: 'Rubric criterion omitted from a graded scorecard',
    similarity: 0.61,
    titleSimilarity: 0.08,
    label: 'distinct',
    templated: false,
  },
];

function classifyPair(p: LabelledPair) {
  const candidate: FoldCandidate = {
    id: 'EI-CANDIDATE',
    title: p.candidate,
    similarity: p.similarity,
    titleSimilarity: p.titleSimilarity,
  };
  return classifyObservationFold(p.incoming, [candidate]);
}

describe('observation-fold — subject token extraction', () => {
  it('extracts paths, ids, backticked literals and dotted symbols', () => {
    expect(subjectTokens('Test failing repeatedly: packages/a/foo.test.ts')).toContain(
      'packages/a/foo.test.ts',
    );
    expect(subjectTokens('Citation could not be resolved for WI-40665')).toContain('wi-40665');
    expect(subjectTokens('Hive canary breached for `luna-workspace`')).toContain('luna-workspace');
  });

  it('NEVER treats bare numbers or ratios as subjects (P-002: measurements are normalized out)', () => {
    // This is the load-bearing exclusion. If digits discriminated, the two
    // readings below would read as different subjects and never fold — which is
    // the exact re-filing shape this plan exists to stop.
    const a = subjectTokens('fires on 92/92 ticks');
    const b = subjectTokens('fires on 96/96 ticks');
    expect(a).toEqual(b);
    expect(a.some((t) => /^\d/.test(t))).toBe(false);
  });

  it('returns nothing for prose that names no identifier', () => {
    expect(subjectTokens('the queue keeps growing without bound')).toEqual([]);
  });
});

describe('observation-fold — the D-036 discriminator', () => {
  it('reports disjoint when both titles name DIFFERENT subjects', () => {
    const r = discriminate(
      'Test failing repeatedly: packages/a/foo.test.ts',
      'Test failing repeatedly: packages/b/bar.test.ts',
    );
    expect(r.disjoint).toBe(true);
  });

  it('reports NOT disjoint when the subjects agree', () => {
    const r = discriminate(
      'replication-liveness fires on 96/96 ticks in `papercusp-workspace`',
      'replication-liveness fires on 92/92 ticks in `papercusp-workspace`',
    );
    expect(r.disjoint).toBe(false);
  });

  it('does NOT demote on ignorance — one side naming no subject is not evidence', () => {
    // Demoting here would quietly convert the common untemplated case into
    // permanent non-folding and restore the row growth we are bending.
    const r = discriminate('the queue keeps growing', 'Test failing: packages/a/foo.test.ts');
    expect(r.disjoint).toBe(false);
  });
});

describe('observation-fold — verdicts', () => {
  it('folds a same-subject templated repeat (the founding P-002 shape)', () => {
    const v = classifyPair(SAMPLE.find((p) => p.name.startsWith('same condition, measurement'))!);
    expect(v.verdict).toBe('hard');
  });

  it('REFUSES to fold a templated pair with different subjects, and links instead', () => {
    const v = classifyPair(SAMPLE.find((p) => p.name.startsWith('templated test-failure'))!);
    expect(v.verdict).toBe('soft');
    expect(v.rule).toBe('discriminator-demoted');
    expect(v.discriminator?.demoted).toBe(true);
    // Both rows must survive — that is what makes a demotion recoverable.
    expect(v.candidate).not.toBeNull();
  });

  it('links (never folds) in the soft band', () => {
    const v = classifyObservationFold('some new reading', [
      { id: 'EI-1', title: 'a related but weaker match', similarity: 0.91, titleSimilarity: 0.2 },
    ]);
    expect(v.verdict).toBe('soft');
    expect(v.rule).toBe('soft-band');
  });

  it('returns none when nothing is close', () => {
    expect(classifyObservationFold('x', []).verdict).toBe('none');
    expect(
      classifyObservationFold('x', [{ id: 'EI-1', title: 'y', similarity: 0.4 }]).verdict,
    ).toBe('none');
  });

  it('cannot fold on cosine alone inside the overlap band without a title co-signal', () => {
    // 0.88 is inside the 0.861–0.892 overlap where duplicates and distinct
    // filings are indistinguishable by cosine. Without the title leg it must
    // not fold.
    const v = classifyObservationFold('a', [
      { id: 'EI-1', title: 'b', similarity: 0.88, titleSimilarity: 0.1 },
    ]);
    expect(v.verdict).not.toBe('hard');
  });

  it('NEVER produces a rejecting verdict (D-003 half that D-042 left unweakened)', () => {
    for (const p of SAMPLE) {
      expect(['hard', 'soft', 'none']).toContain(classifyPair(p).verdict);
    }
  });
});

describe('observation-fold — PUBLISHED precision on the labelled sample (P-014)', () => {
  it('publishes precision and recall, and admits ZERO false folds', () => {
    let truePositive = 0; // folded, and genuinely a duplicate
    let falsePositive = 0; // folded, but genuinely distinct  ← the silent failure
    let falseNegative = 0; // not folded, but genuinely a duplicate
    const falseFolds: string[] = [];

    for (const p of SAMPLE) {
      const folded = classifyPair(p).verdict === 'hard';
      if (folded && p.label === 'duplicate') truePositive += 1;
      if (folded && p.label === 'distinct') {
        falsePositive += 1;
        falseFolds.push(p.name);
      }
      if (!folded && p.label === 'duplicate') falseNegative += 1;
    }

    const precision = truePositive / (truePositive + falsePositive || 1);
    const recall = truePositive / (truePositive + falseNegative || 1);
    const templated = SAMPLE.filter((p) => p.templated).length;

    // THE PUBLISHED FIGURE (P-014). Printed so it appears in the run output and
    // can be quoted without re-deriving it.
    // eslint-disable-next-line no-console
    console.log(
      `[P-014 fold calibration] n=${SAMPLE.length} (templated=${templated}, ` +
        `duplicates=${SAMPLE.filter((p) => p.label === 'duplicate').length}) ` +
        `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} ` +
        `TP=${truePositive} FP=${falsePositive} FN=${falseNegative}`,
    );

    // Precision is FLOORED at 1.0: a false fold is silent and unrecoverable.
    expect(falseFolds).toEqual([]);
    expect(precision).toBe(1);

    // Recall is REPORTED, not floored — a missed fold is merely the status quo.
    // This asserts only that the guard is not inert (it must fold something, or
    // it is a no-op wearing a threshold).
    expect(truePositive).toBeGreaterThan(0);
  });
});
