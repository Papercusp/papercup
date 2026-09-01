import { describe, expect, it } from 'vitest';
import {
  ADMISSION_MERGE_QUALITY_DATASET_HASH,
  ADMISSION_MERGE_QUALITY_GOLD_CORPUS,
  ADMISSION_MERGE_QUALITY_THRESHOLDS,
  admissionMergeQualityGoldJudgements,
  assertAdmissionMergeQualityCorpus,
  assertAdmissionMergeQualityThresholds,
  failedAdmissionMergeQualityReport,
  isCurrentAdmissionMergeQualityPass,
  prepareAdmissionMergeQualityGate,
  scoreAdmissionMergeQualityGate,
  type AdmissionMergeQualityGoldCase,
} from './work-items-admission-merge-quality';
import type { PromoterItem, PromoterPair } from './work-items-admission-promoter';

const prompt = (pairs: readonly PromoterPair[], _ghosts: readonly PromoterItem[]) => ({
  system: 'production duplication-only charter',
  user: pairs.map((pair) => pair.pairKey).join('\n'),
});

function prepared(overrides: Partial<Parameters<typeof prepareAdmissionMergeQualityGate>[0]> = {}) {
  return prepareAdmissionMergeQualityGate({ model: 'test-model:xhigh', buildPrompt: prompt, ...overrides });
}

describe('frozen admission merge-quality corpus', () => {
  it('is independently labelled, versioned, balanced, and internally valid', () => {
    expect(() => assertAdmissionMergeQualityCorpus()).not.toThrow();
    expect(ADMISSION_MERGE_QUALITY_GOLD_CORPUS).toHaveLength(22);
    expect(
      ADMISSION_MERGE_QUALITY_GOLD_CORPUS.filter((entry) => entry.expectedVerdict === 'r-finding-merge'),
    ).toHaveLength(10);
    for (const verdict of ['distinct', 'r-related', 'r-remedy-keep'] as const) {
      expect(ADMISSION_MERGE_QUALITY_GOLD_CORPUS.filter((entry) => entry.expectedVerdict === verdict)).toHaveLength(4);
    }
    expect(ADMISSION_MERGE_QUALITY_DATASET_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a corpus that makes a non-merge label destructive', () => {
    const firstNegative = ADMISSION_MERGE_QUALITY_GOLD_CORPUS.findIndex(
      (entry) => entry.expectedVerdict !== 'r-finding-merge',
    );
    const broken = ADMISSION_MERGE_QUALITY_GOLD_CORPUS.map((entry, index) =>
      index === firstNegative ? { ...entry, expectedCanonical: entry.pair.a.id } : entry,
    );
    expect(() => assertAdmissionMergeQualityCorpus(broken)).toThrow('must not name a canonical endpoint');
  });

  it('rejects thresholds outside the ratio domain before they can weaken a gate', () => {
    expect(() =>
      assertAdmissionMergeQualityThresholds({
        ...ADMISSION_MERGE_QUALITY_THRESHOLDS,
        duplicatePrecision: 1.01,
      }),
    ).toThrow('must be a finite ratio in [0,1]');
    expect(() =>
      assertAdmissionMergeQualityThresholds({
        ...ADMISSION_MERGE_QUALITY_THRESHOLDS,
        duplicateRecall: Number.NaN,
      }),
    ).toThrow('must be a finite ratio in [0,1]');
  });
});

describe('admission merge-quality scoring', () => {
  it('passes a complete all-green replay and reports every metric and canonical selection', () => {
    const gate = prepared();
    const report = scoreAdmissionMergeQualityGate({
      prepared: gate,
      judgements: admissionMergeQualityGoldJudgements(),
      servedAccount: 'pool-a',
      modelAttempts: 1,
      tokensIn: 300,
      tokensOut: 120,
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:00:01.000Z',
    });

    expect(report).toMatchObject({
      status: 'passed',
      model: 'test-model:xhigh',
      servedAccount: 'pool-a',
      counts: {
        cases: 22,
        mergePositive: 10,
        nonMerge: 12,
        returnedExpected: 22,
        predictedMerge: 10,
        truePositive: 10,
        falsePositive: 0,
        falseNegative: 0,
        correctCanonical: 10,
      },
      metrics: {
        coverage: { numerator: 22, denominator: 22, value: 1 },
        duplicatePrecision: { numerator: 10, denominator: 10, value: 1 },
        nonDuplicatePreservation: { numerator: 12, denominator: 12, value: 1 },
        duplicateRecall: { numerator: 10, denominator: 10, value: 1 },
        canonicalSelection: { numerator: 10, denominator: 10, value: 1 },
        exactVerdictAccuracy: { numerator: 22, denominator: 22, value: 1 },
      },
    });
    expect(report.failureReasons).toEqual([]);
    expect(report.outcomes.filter((outcome) => outcome.canonicalCorrect === true)).toHaveLength(10);
    expect(isCurrentAdmissionMergeQualityPass(report, gate)).toBe(true);
  });

  it('blocks one false merge on a preservation case', () => {
    const gate = prepared();
    const judgements = admissionMergeQualityGoldJudgements();
    const negative = ADMISSION_MERGE_QUALITY_GOLD_CORPUS.find((entry) => entry.expectedVerdict === 'distinct')!;
    const changed = judgements.map((judgement) =>
      judgement.pairKey === negative.pair.pairKey
        ? { ...judgement, verdict: 'r-finding-merge' as const, reason: 'incorrect destructive prediction' }
        : judgement,
    );
    const report = scoreAdmissionMergeQualityGate({ prepared: gate, judgements: changed });

    expect(report.status).toBe('blocked');
    expect(report.counts.falsePositive).toBe(1);
    expect(report.metrics.duplicatePrecision.value).toBeCloseTo(10 / 11);
    expect(report.metrics.nonDuplicatePreservation.value).toBeCloseTo(11 / 12);
    expect(report.failureReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicatePrecision'),
        expect.stringContaining('nonDuplicatePreservation'),
      ]),
    );
  });

  it('blocks an all-nonmerge replay through the anti-vacuity recall threshold', () => {
    const gate = prepared();
    const judgements = admissionMergeQualityGoldJudgements().map((judgement) => ({
      ...judgement,
      verdict: 'distinct' as const,
      reason: 'incorrectly avoids every merge',
    }));
    const report = scoreAdmissionMergeQualityGate({ prepared: gate, judgements });

    expect(report.status).toBe('blocked');
    expect(report.metrics.duplicateRecall).toEqual({ numerator: 0, denominator: 10, value: 0 });
    expect(report.metrics.canonicalSelection).toEqual({ numerator: 0, denominator: 0, value: 0 });
    expect(report.failureReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicateRecall'),
        expect.stringContaining('canonicalSelection'),
      ]),
    );
  });

  it('allows exactly 90% duplicate recall while still requiring every selected canonical to be correct', () => {
    const gate = prepared();
    const missedPositive = ADMISSION_MERGE_QUALITY_GOLD_CORPUS.find(
      (entry) => entry.expectedVerdict === 'r-finding-merge',
    )!;
    const judgements = admissionMergeQualityGoldJudgements().map((judgement) =>
      judgement.pairKey === missedPositive.pair.pairKey
        ? { ...judgement, verdict: 'distinct' as const, reason: 'one conservative false negative' }
        : judgement,
    );
    const report = scoreAdmissionMergeQualityGate({ prepared: gate, judgements });

    expect(report.status).toBe('passed');
    expect(report.metrics.duplicateRecall).toEqual({ numerator: 9, denominator: 10, value: 0.9 });
    expect(report.metrics.canonicalSelection).toEqual({ numerator: 9, denominator: 9, value: 1 });
    expect(report.metrics.exactVerdictAccuracy.value).toBeCloseTo(21 / 22);
  });

  it('blocks a deterministic canonical-selection mistake', () => {
    const original = ADMISSION_MERGE_QUALITY_GOLD_CORPUS.find((entry) => entry.expectedVerdict === 'r-finding-merge')!;
    const wrongCanonical = original.expectedCanonical === original.pair.a.id ? original.pair.b.id : original.pair.a.id;
    const corpus: AdmissionMergeQualityGoldCase[] = ADMISSION_MERGE_QUALITY_GOLD_CORPUS.map((entry) =>
      entry.caseId === original.caseId ? { ...entry, expectedCanonical: wrongCanonical } : entry,
    );
    const gate = prepared({ corpus });
    const report = scoreAdmissionMergeQualityGate({
      prepared: gate,
      judgements: admissionMergeQualityGoldJudgements(corpus),
    });

    expect(report.status).toBe('blocked');
    expect(report.metrics.canonicalSelection).toEqual({ numerator: 9, denominator: 10, value: 0.9 });
    expect(report.failureReasons).toContain('canonicalSelection 9/10=0.9000 below 1.0000');
  });

  it('blocks omitted, unknown, and duplicate pair keys instead of treating partial output as coverage', () => {
    const gate = prepared();
    const complete = admissionMergeQualityGoldJudgements();
    const omitted = scoreAdmissionMergeQualityGate({ prepared: gate, judgements: complete.slice(1) });
    expect(omitted.status).toBe('blocked');
    expect(omitted.metrics.coverage).toEqual({ numerator: 21, denominator: 22, value: 21 / 22 });
    expect(omitted.missingPairKeys).toEqual([complete[0]!.pairKey]);

    const unknown = scoreAdmissionMergeQualityGate({
      prepared: gate,
      judgements: [
        ...complete,
        { pairKey: 'UNKNOWN-A::UNKNOWN-B', verdict: 'distinct', reason: 'not in the frozen corpus' },
      ],
    });
    expect(unknown.status).toBe('blocked');
    expect(unknown.unknownPairKeys).toEqual(['UNKNOWN-A::UNKNOWN-B']);

    const duplicated = scoreAdmissionMergeQualityGate({ prepared: gate, judgements: [...complete, complete[0]!] });
    expect(duplicated.status).toBe('blocked');
    expect(duplicated.duplicatePairKeys).toEqual([complete[0]!.pairKey]);
  });
});

describe('merge-quality identity invalidation and failed reports', () => {
  it('invalidates the gate key on dataset, prompt, model, or threshold drift', () => {
    const base = prepared();
    const promptDrift = prepared({
      buildPrompt: (pairs, ghosts) => {
        const rendered = prompt(pairs, ghosts);
        return { ...rendered, system: `${rendered.system}\nchanged charter` };
      },
    });
    const modelDrift = prepared({ model: 'other-model:xhigh' });
    const thresholdDrift = prepared({
      thresholds: { ...ADMISSION_MERGE_QUALITY_THRESHOLDS, duplicateRecall: 0.91 },
    });
    const corpusDrift: AdmissionMergeQualityGoldCase[] = ADMISSION_MERGE_QUALITY_GOLD_CORPUS.map((entry, index) =>
      index === 0 ? { ...entry, labelRationale: `${entry.labelRationale} Clarified.` } : entry,
    );
    const datasetDrift = prepared({ corpus: corpusDrift });

    expect(
      new Set([base.gateKey, promptDrift.gateKey, modelDrift.gateKey, thresholdDrift.gateKey, datasetDrift.gateKey])
        .size,
    ).toBe(5);
    expect(promptDrift.promptHash).not.toBe(base.promptHash);
    expect(modelDrift.model).not.toBe(base.model);
    expect(thresholdDrift.thresholdHash).not.toBe(base.thresholdHash);
    expect(datasetDrift.datasetHash).not.toBe(base.datasetHash);
  });

  it('turns a model/protocol exception into a structured fail-closed report', () => {
    const gate = prepared();
    const report = failedAdmissionMergeQualityReport({
      prepared: gate,
      error: new Error('reply was truncated'),
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:00:03.000Z',
    });
    expect(report.status).toBe('blocked');
    expect(report.failureReasons[0]).toBe('model replay failed: reply was truncated');
    expect(report.metrics.coverage.value).toBe(0);
    expect(isCurrentAdmissionMergeQualityPass(report, gate)).toBe(false);
  });

  it('does not trust a tampered passed report even when its top-level gate key matches', () => {
    const gate = prepared();
    const report = scoreAdmissionMergeQualityGate({
      prepared: gate,
      judgements: admissionMergeQualityGoldJudgements(),
    });
    const tampered = {
      ...report,
      failureReasons: ['hidden failure'],
      missingPairKeys: ['MQ-M01-A::MQ-M01-B'],
      metrics: { ...report.metrics, coverage: { numerator: 22, denominator: 22, value: 0.5 } },
    };
    expect(isCurrentAdmissionMergeQualityPass(tampered, gate)).toBe(false);
  });
});
