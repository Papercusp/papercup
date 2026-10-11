/**
 * FSWE-P009-CONTAMINATION@1 (benchmark-coverage-frontierswe-v2-2026-10-10 P-009, WI-10008258):
 * a headline benchmark claim built from tasks created before the evaluated model's training cutoff is
 * labelled contamination-exposed in its report. Falsifier: a report over pre-cutoff tasks carries no label.
 *
 * Every expected label below is hand-derived from the fixture dates and the cutoff month, never from the
 * code under test. claude-opus-5-5's training-data cutoff is 2026-06 (platform.claude.com models overview),
 * so its coverage ends at 2026-07-01T00:00Z.
 */
import { describe, expect, it } from 'vitest';
import {
  armContamination,
  classifyTaskExposure,
  contaminationLabelFor,
  MODEL_TRAINING_CUTOFFS,
  trainingCutoffEnd,
  trainingCutoffFor,
} from './contamination';
import { buildReportHtml, bundleFromRollouts } from './report/report-builder';

const MODEL = 'claude-opus-5-5';

function row(taskId: string, resolved: boolean) {
  return {
    taskId, arm: 'su', seed: 0, resolved, graderStatus: 'graded', costUsd: 0.1,
    tokensIn: 10, tokensOut: 10, tokensTotal: 20, wallClockMs: 1000,
  };
}

function report(taskCreatedAt: Record<string, string | null>, opts: { trainingCutoffs?: Record<string, string | null> } = {}) {
  const taskIds = Object.keys(taskCreatedAt);
  return bundleFromRollouts({
    runId: 'run-p009', suite: 'swe-rebench', createdAt: '2026-10-11T00:00:00Z', arms: ['su'], models: { su: MODEL },
    assignedTaskIds: taskIds, assignedSeeds: [0],
    runResults: taskIds.map((id, i) => row(id, i % 2 === 0)),
    taskCreatedAt, trainingCutoffs: opts.trainingCutoffs,
  });
}

describe('contamination policy — report headline label (FSWE-P009-CONTAMINATION@1)', () => {
  it('labels a headline over a pool created before the model cutoff contamination-exposed', () => {
    const bundle = report({ 'old-1': '2025-11-03T10:00:00Z', 'old-2': '2026-02-14T09:30:00Z' });
    const c = bundle.arms[0].contamination!;
    expect(c.label).toBe('contamination-exposed');
    expect(c.modelId).toBe(MODEL);
    expect(c.trainingDataCutoff).toBe('2026-06');
    expect(c.exposed.taskIds).toEqual(['old-1', 'old-2']);
    expect(c.postCutoff.taskIds).toEqual([]);
    // The label survives rendering into the portable HTML report.
    expect(buildReportHtml(bundle)).toContain('"label":"contamination-exposed"');
  });

  it('calibration control: a pool created after the cutoff month carries no contamination label', () => {
    const c = report({ 'new-1': '2026-07-01T00:00:00Z', 'new-2': '2026-09-20T12:00:00Z' }).arms[0].contamination!;
    expect(c.label).toBe('post-cutoff');
    expect(c.exposed.taskIds).toEqual([]);
    expect(c.postCutoff.taskIds).toEqual(['new-1', 'new-2']);
  });

  it('a task created inside the cutoff month counts as exposed (month precision covers the whole month)', () => {
    expect(report({ 'june-30': '2026-06-30T23:59:59Z' }).arms[0].contamination!.label).toBe('contamination-exposed');
  });

  it('an undated pool is contamination-unknown, never clean', () => {
    const c = report({ 'u-1': null, 'u-2': 'not-a-date' }).arms[0].contamination!;
    expect(c.label).toBe('contamination-unknown');
    expect(c.unknown.taskIds).toEqual(['u-1', 'u-2']);
  });

  it('a report built without any task dates is contamination-unknown', () => {
    const bundle = bundleFromRollouts({
      runId: 'r', suite: 's', createdAt: '2026-10-11T00:00:00Z', arms: ['su'], models: { su: MODEL },
      runResults: [row('t-1', true)],
    });
    expect(bundle.arms[0].contamination!.label).toBe('contamination-unknown');
  });

  it('a model with no sourced cutoff is contamination-unknown even over post-cutoff tasks', () => {
    const bundle = bundleFromRollouts({
      runId: 'r', suite: 's', createdAt: '2026-10-11T00:00:00Z', arms: ['x'], models: { x: 'gpt-6-sol' },
      runResults: [{ ...row('t-1', true), arm: 'x' }], taskCreatedAt: { 't-1': '2026-09-01T00:00:00Z' },
    });
    const c = bundle.arms[0].contamination!;
    expect(c.label).toBe('contamination-unknown');
    expect(c.trainingDataCutoff).toBeNull();
    expect(c.cutoffSource).toBeNull();
  });

  it('a mixed pool is exposed, and reports each subset with its own primary outcome', () => {
    // Key order is the row index and row() resolves even indexes: old-1 (0) and old-2 (2) resolve,
    // new-1 (1) and new-2 (3) fail — so exposed is 1.0 and post-cutoff is 0.0 (bench-metrics' primaryResolvedPct
    // is a FRACTION in [0,1], despite its name).
    const c = report({
      'old-1': '2026-01-10T00:00:00Z', 'new-1': '2026-08-01T00:00:00Z',
      'old-2': '2026-03-10T00:00:00Z', 'new-2': '2026-08-02T00:00:00Z',
    }).arms[0].contamination!;
    expect(c.label).toBe('contamination-exposed');
    expect(c.exposed.taskIds).toEqual(['old-1', 'old-2']);
    expect(c.postCutoff.taskIds).toEqual(['new-1', 'new-2']);
    expect(c.exposed.primaryResolvedPct).toBe(1);
    expect(c.postCutoff.primaryResolvedPct).toBe(0);
  });

  it('a caller-pinned cutoff overrides the curated table, and a pinned null means unknown', () => {
    const pinned = report({ 't-1': '2026-03-01T00:00:00Z' }, { trainingCutoffs: { [MODEL]: '2026-01' } }).arms[0].contamination!;
    expect(pinned.label).toBe('post-cutoff');
    expect(pinned.cutoffSource).toBe('caller-supplied');
    const unknown = report({ 't-1': '2026-03-01T00:00:00Z' }, { trainingCutoffs: { [MODEL]: null } }).arms[0].contamination!;
    expect(unknown.label).toBe('contamination-unknown');
  });
});

describe('contamination policy — building blocks', () => {
  it('cutoff ends are exclusive next-period instants', () => {
    expect(trainingCutoffEnd('2026-06').toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(trainingCutoffEnd('2025-12').toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(trainingCutoffEnd('2026-06-15').toISOString()).toBe('2026-06-16T00:00:00.000Z');
    expect(() => trainingCutoffEnd('June 2026')).toThrow(/not YYYY-MM/);
    expect(() => trainingCutoffEnd('2026-13')).toThrow(/calendar date/);
  });

  it('classifies a task against a cutoff', () => {
    expect(classifyTaskExposure('2026-05-01T00:00:00Z', '2026-06')).toBe('exposed');
    expect(classifyTaskExposure('2026-07-01T00:00:00Z', '2026-06')).toBe('post-cutoff');
    expect(classifyTaskExposure('2026-07-01T00:00:00Z', null)).toBe('unknown');
    expect(classifyTaskExposure(undefined, '2026-06')).toBe('unknown');
  });

  it('label precedence: exposed beats unknown; an empty pool is unknown', () => {
    expect(contaminationLabelFor(['post-cutoff', 'unknown', 'exposed'])).toBe('contamination-exposed');
    expect(contaminationLabelFor(['post-cutoff', 'unknown'])).toBe('contamination-unknown');
    expect(contaminationLabelFor(['post-cutoff'])).toBe('post-cutoff');
    expect(contaminationLabelFor([])).toBe('contamination-unknown');
  });

  it('looks up vendor-prefixed and suffixed ids', () => {
    expect(trainingCutoffFor('anthropic/claude-opus-5-5')?.trainingDataCutoff).toBe('2026-06');
    expect(trainingCutoffFor('gpt-6-sol')).toBeNull();
    expect(trainingCutoffFor(null)).toBeNull();
  });

  it('every curated cutoff parses and cites an https source', () => {
    expect(Object.keys(MODEL_TRAINING_CUTOFFS).length).toBeGreaterThan(0);
    for (const [id, fact] of Object.entries(MODEL_TRAINING_CUTOFFS)) {
      expect(() => trainingCutoffEnd(fact.trainingDataCutoff), id).not.toThrow();
      expect(fact.source, id).toMatch(/^https:\/\//);
      expect(fact.retrievedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('refuses a malformed pinned cutoff instead of silently labelling', () => {
    expect(() => armContamination({ modelId: MODEL, assignedTaskIds: ['t'], rows: [], trainingCutoffOverride: 'soon' })).toThrow(/not YYYY-MM/);
  });
});
