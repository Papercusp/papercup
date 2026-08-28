import { describe, expect, it } from 'vitest';
import type { ScoredItem } from '../harness/improvements/digest';
import type { RoutedIdeaProvenance } from '../scout/outcome-feedback';
import {
  LEARNING_IMPROVE_ROW_LIMIT,
  mergeLearningImproveRows,
  normalizeLearningImproveViewArgs,
  projectLearningImproveRows,
  summarizeLearningImproveRows,
} from './learning-improve-view-query';

const item = (id: string, patch: Partial<ScoredItem> = {}): ScoredItem => ({
  id,
  kind: 'bug',
  title: `item ${id}`,
  scope: 'harness:a',
  severity: 'minor',
  state: 'open',
  assignee: null,
  tier: 'human',
  score: 10,
  ageDays: 1,
  tierReason: 'ordinary reason',
  ideaType: 'code-bug',
  source: 'Scout',
  ...patch,
});

const idea = (ideaId: string, routedRef: string, patch: Partial<RoutedIdeaProvenance> = {}): RoutedIdeaProvenance => ({
  ideaId,
  routedRef,
  rail: 'improvement',
  lens: 'risk-first' as RoutedIdeaProvenance['lens'],
  routedAt: '2026-08-22T00:00:00.000Z',
  title: `idea ${ideaId}`,
  ...patch,
});

describe('Learning Improve pure merged query', () => {
  it('finds a tierReason-only match beyond page one while keeping the wire projection bounded', () => {
    const items = Array.from({ length: LEARNING_IMPROVE_ROW_LIMIT + 20 }, (_, i) =>
      item(`EI-${i.toString().padStart(4, '0')}`, {
        ageDays: i,
        tierReason: i === LEARNING_IMPROVE_ROW_LIMIT + 10 ? 'deep-only tier token' : 'ordinary reason',
      }),
    );
    const corpus = mergeLearningImproveRows(items, [], Date.parse('2026-08-22T00:00:00.000Z'));
    const args = normalizeLearningImproveViewArgs({ q: 'deep-only tier token' });
    const rows = projectLearningImproveRows(corpus, args);
    const summary = summarizeLearningImproveRows(corpus, args);
    expect(rows.map((row) => row.item?.id)).toEqual([
      `EI-${(LEARNING_IMPROVE_ROW_LIMIT + 10).toString().padStart(4, '0')}`,
    ]);
    expect(summary).toMatchObject({ total: LEARNING_IMPROVE_ROW_LIMIT + 20, matched: 1 });
    expect(projectLearningImproveRows(corpus, normalizeLearningImproveViewArgs({}))).toHaveLength(
      LEARNING_IMPROVE_ROW_LIMIT,
    );
  });

  it('merges the newest wi route and keeps non-work-item routes as idea-only rows', () => {
    const rows = mergeLearningImproveRows(
      [item('EI-1')],
      [
        idea('old', 'wi:EI-1', { routedAt: '2026-08-20T00:00:00.000Z' }),
        idea('new', 'wi:EI-1', { routedAt: '2026-08-21T00:00:00.000Z' }),
        idea('plan-only', 'plan:alpha', { rail: 'plan' }),
      ],
      Date.parse('2026-08-22T00:00:00.000Z'),
    );
    expect(rows.find((row) => row.item?.id === 'EI-1')?.idea?.ideaId).toBe('new');
    expect(rows.find((row) => row.key === 'plan-only')).toMatchObject({ item: null, rail: 'plan', stage: 'not-ready' });
  });

  it('applies OR within a dimension, AND across dimensions, numeric ranges, and exact zero', () => {
    const corpus = mergeLearningImproveRows(
      [
        item('EI-a', { kind: 'bug', severity: 'critical', score: 90, ageDays: 3, tier: 'auto' }),
        item('EI-b', { kind: 'change', severity: 'major', score: 70, ageDays: 5 }),
        item('EI-c', { kind: 'feature', severity: 'minor', score: 20, ageDays: 9 }),
      ],
      [idea('a', 'wi:EI-a', { rail: 'gym' }), idea('b', 'wi:EI-b', { rail: 'plan' })],
    );
    const args = normalizeLearningImproveViewArgs({
      kinds: ['bug', 'change'],
      severities: ['critical', 'major'],
      score: { min: 60 },
      ageDays: { max: 6 },
    });
    expect(projectLearningImproveRows(corpus, args).map((row) => row.key)).toEqual(['EI-a', 'EI-b']);
    expect(summarizeLearningImproveRows(corpus, args).matched).toBe(2);
    expect(summarizeLearningImproveRows(corpus, normalizeLearningImproveViewArgs({ q: 'absent' })).matched).toBe(0);
  });

  it('computes drill-down facet counts with all other selections applied', () => {
    const corpus = mergeLearningImproveRows(
      [
        item('EI-a', { kind: 'bug', severity: 'critical' }),
        item('EI-b', { kind: 'change', severity: 'critical' }),
        item('EI-c', { kind: 'feature', severity: 'minor' }),
      ],
      [],
    );
    const summary = summarizeLearningImproveRows(
      corpus,
      normalizeLearningImproveViewArgs({ kinds: ['bug'], severities: ['critical'] }),
    );
    const kind = summary.facets.find((facet) => facet.key === 'kind');
    const severity = summary.facets.find((facet) => facet.key === 'severity');
    const kindValues = kind?.values.map(({ value, count }) => [value, count]);
    expect(kindValues).toHaveLength(2);
    expect(kindValues).toEqual(
      expect.arrayContaining([
        ['bug', 1],
        ['change', 1],
      ]),
    );
    expect(severity?.values.map(({ value, count }) => [value, count])).toEqual([['critical', 1]]);
  });

  // D-005 of learning-tab-improve-retain-clarity-2026-08-28: an item leaves Improve
  // exactly when it arrives on Retain. These three cases pin the whole invariant —
  // never on both, never on neither — so a future change cannot restore the
  // double-listing without a red test.
  it('drops LANDED rows from Improve, because Retain is where they now live', () => {
    const corpus = mergeLearningImproveRows(
      [
        item('EI-open', { state: 'open' }),
        item('EI-inflight', { state: 'open', assignee: 'su-1' }),
        item('EI-landed', { state: 'resolved' }),
      ],
      [],
    );
    expect(corpus.map((row) => row.key).sort()).toEqual(['EI-inflight', 'EI-open']);
    // The exact matched total and the facets are derived from the same corpus, so
    // the landed row is gone from the count and the Stage facet too — not merely
    // hidden from the page-one projection.
    const summary = summarizeLearningImproveRows(corpus, normalizeLearningImproveViewArgs({}));
    expect(summary).toMatchObject({ total: 2, matched: 2 });
    expect(summary.facets.find((facet) => facet.key === 'stage')?.values.map((v) => v.value)).not.toContain(
      'shipped',
    );
  });

  it('KEEPS dropped rows on Improve — Retain never takes them, so excluding them would hide them everywhere', () => {
    const corpus = mergeLearningImproveRows([item('EI-dropped', { state: 'closed' })], []);
    expect(corpus.map((row) => ({ key: row.key, stage: row.stage }))).toEqual([
      { key: 'EI-dropped', stage: 'dropped' },
    ]);
  });

  it('does not resurrect a landed item as a bare idea row', () => {
    // The idea's outcome LANDED; it belongs to the funnel instruments, not to a
    // table of work still to improve. Regressing this would re-list the same work
    // under its idea id — the double-listing wearing a different key.
    const corpus = mergeLearningImproveRows(
      [item('EI-landed', { state: 'resolved' })],
      [idea('idea-1', 'wi:EI-landed')],
    );
    expect(corpus).toEqual([]);
  });
});
