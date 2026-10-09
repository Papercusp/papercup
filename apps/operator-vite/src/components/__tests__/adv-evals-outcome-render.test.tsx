import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PreservedOutcomeStats } from '../adv/AdvEvalsTab';

const renderOutcome = (overrides: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(
  PreservedOutcomeStats,
  { summary: { arm: 'papercusp', resolvedCount: 1, taskCount: 5, gradedCount: 1,
    resolvedPct: 0.2, conditionalResolvedPct: 1, missingGradeCount: 0, ...overrides } },
));

describe('rendered preserved outcome scores', () => {
  it('shows the assigned primary denominator separately from conditional graded quality', () => {
    const html = renderOutcome();
    expect(html).toContain('20%');
    expect(html).toContain('1/5 assigned tasks resolved');
    expect(html).toContain('100%');
    expect(html).toContain('1/1 graded submissions · conditional quality');
    expect(html).toContain('including non-attempts and generation failures');
  });

  it('shows missing grader measurement as inconclusive while retaining measured conditional quality', () => {
    const html = renderOutcome({ resolvedPct: null, missingGradeCount: 2 });
    expect(html).toContain('2 submissions await official grades; primary score is inconclusive');
    expect(html).toContain('—');
    expect(html).toContain('1/5 assigned tasks resolved');
    expect(html).toContain('100%');
    expect(html).not.toContain('20%');
  });

  it('retains measured zero and an absent conditional measurement for an unattempted run', () => {
    const html = renderOutcome({ resolvedCount: 0, gradedCount: 0, resolvedPct: 0, conditionalResolvedPct: null });
    expect(html).toContain('0%');
    expect(html).toContain('0/5 assigned tasks resolved');
    expect(html).toContain('0/0 graded submissions · conditional quality');
    expect(html).toContain('—');
    expect(html).not.toContain('inconclusive');
  });
});
