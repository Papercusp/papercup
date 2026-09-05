import { describe, expect, it } from 'vitest';

import {
  decodePortfolioFrontierCheckpoint,
  finishPortfolioFrontierStep,
  orderPortfolioCandidates,
  planPortfolioFrontierStep,
  PORTFOLIO_FRONTIER_VERIFICATION_FLOOR,
  type PortfolioFrontierCheckpoint,
  type PortfolioOutcomeCandidate,
} from './portfolio-frontier';

const NOW = Date.parse('2026-08-26T20:00:00Z');

const candidate = (
  ideaId: string,
  over: Partial<PortfolioOutcomeCandidate> = {},
): PortfolioOutcomeCandidate => ({
  ideaId,
  origin: 'scout',
  routedRef: `plan:${ideaId}`,
  routedAtMs: NOW,
  humanGrade: null,
  ...over,
});

const checkpoint = (over: Partial<PortfolioFrontierCheckpoint> = {}): PortfolioFrontierCheckpoint => ({
  version: 1,
  phase: 'outcome-verification',
  cursorIdeaId: null,
  cursorGrade: null,
  cursorRoutedAtMs: null,
  currentIdeaId: null,
  itemBudget: 2,
  timeBudgetMs: 5_000,
  consumedItems: 0,
  elapsedMs: 0,
  gradingBacklog: 0,
  pendingOutcomes: 0,
  evidenceSource: null,
  updatedAt: new Date(NOW).toISOString(),
  ...over,
});

describe('portfolio frontier ordering', () => {
  it('orders recorded value first, then oldest route, then stable id', () => {
    const rows = [
      candidate('later-low', { humanGrade: 3, routedAtMs: NOW + 1 }),
      candidate('later-high', { humanGrade: 5, routedAtMs: NOW + 2 }),
      candidate('b', { humanGrade: 5, routedAtMs: NOW }),
      candidate('a', { humanGrade: 5, routedAtMs: NOW }),
      candidate('ungraded', { routedAtMs: NOW - 10_000 }),
    ];
    expect(orderPortfolioCandidates(rows).map((row) => row.ideaId)).toEqual([
      'a',
      'b',
      'later-high',
      'later-low',
      'ungraded',
    ]);
  });
});

describe('planPortfolioFrontierStep', () => {
  it('reserves a bounded outcome slice while grading remains actionable', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 1,
      pending: [candidate('a'), candidate('b'), candidate('c'), candidate('d')],
      previous: checkpoint({ cursorIdeaId: 'resume-here' }),
      itemBudget: 10,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['a', 'b', 'c']);
    expect(result.checkpoint).toMatchObject({
      phase: 'outcome-verification',
      cursorIdeaId: 'c',
      consumedItems: PORTFOLIO_FRONTIER_VERIFICATION_FLOOR,
      gradingBacklog: 1,
    });
  });

  it('enters outcome verification only on a drained grading frontier and respects the item budget', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [candidate('a'), candidate('b'), candidate('c')],
      itemBudget: 2,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['a', 'b']);
    expect(result.checkpoint).toMatchObject({
      phase: 'outcome-verification',
      cursorIdeaId: 'b',
      currentIdeaId: 'a',
      consumedItems: 2,
      itemBudget: 2,
      timeBudgetMs: 5_000,
    });
  });

  it('resumes after a stable idea-id cursor, wraps, and never relies on an array offset', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [candidate('a'), candidate('b'), candidate('c')],
      previous: checkpoint({ cursorIdeaId: 'b' }),
      itemBudget: 2,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['c', 'a']);
    expect(result.checkpoint.cursorIdeaId).toBe('a');
  });

  it('continues after the stored ordering boundary when the cursor row becomes terminal', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [
        candidate('a', { humanGrade: 5, routedAtMs: NOW }),
        candidate('c', { humanGrade: 5, routedAtMs: NOW + 2 }),
      ],
      previous: checkpoint({
        cursorIdeaId: 'b-now-terminal',
        cursorGrade: 5,
        cursorRoutedAtMs: NOW + 1,
      }),
      itemBudget: 1,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['c']);
  });

  it('restarts at the ordered head for a legacy checkpoint with no ordering boundary', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [candidate('b'), candidate('a')],
      previous: checkpoint({ cursorIdeaId: 'legacy-missing' }),
      itemBudget: 1,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['a']);
  });

  it('marks a fully drained portfolio and consumes no budget', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [],
      itemBudget: 10,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected).toEqual([]);
    expect(result.checkpoint).toMatchObject({ phase: 'drained', consumedItems: 0, pendingOutcomes: 0 });
  });

  it('treats a zero time budget as an observable no-op', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [candidate('a')],
      itemBudget: 1,
      timeBudgetMs: 0,
      nowMs: NOW,
    });
    expect(result.selected).toEqual([]);
    expect(result.checkpoint).toMatchObject({ phase: 'outcome-verification', timeBudgetMs: 0 });
  });
});

describe('checkpoint durability', () => {
  it('rejects old/malformed persisted state instead of inventing a cursor', () => {
    expect(decodePortfolioFrontierCheckpoint(null)).toBeNull();
    expect(decodePortfolioFrontierCheckpoint({ version: 2, phase: 'grading' })).toBeNull();
    expect(decodePortfolioFrontierCheckpoint({ version: 1, phase: 'surprise' })).toBeNull();
  });

  it('records elapsed budget and the authoritative evidence source', () => {
    const finished = finishPortfolioFrontierStep(checkpoint(), {
      elapsedMs: 37,
      evidenceSource: { kind: 'plan-run', ref: 'plan:shipped-plan' },
      nowMs: NOW + 37,
    });
    expect(finished).toMatchObject({
      elapsedMs: 37,
      evidenceSource: { kind: 'plan-run', ref: 'plan:shipped-plan' },
      updatedAt: new Date(NOW + 37).toISOString(),
    });
  });
});
