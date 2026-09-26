import { describe, expect, it } from 'vitest';

import { goalLocalPlanIdeaId, parsePlanRef, patternRefsFromEvidence } from './goal-feedback';

describe('goal-feedback pure helpers (P-009)', () => {
  it('normalises work-item evidence to the wi: pattern vocabulary and drops unresolvable refs', () => {
    expect(
      patternRefsFromEvidence([
        'EI-24344596755054491',
        'wi:WI-10002631',
        'work-item:F-12',
        ' rubric:acceptance-x#c1@papercup ',
        'session_turn:claude:abc:3',
        'plan:papercusp/local-plan',
        'https://example.test/EI-1',
        'EI-24344596755054491',
      ]),
    ).toEqual(['wi:EI-24344596755054491', 'wi:WI-10002631', 'wi:F-12', 'rubric:acceptance-x#c1@papercup']);
  });

  it('parses both plan ref shapes and rejects anything else', () => {
    expect(parsePlanRef('plan:local-plan')).toEqual({ planSlug: 'local-plan' });
    expect(parsePlanRef('plan:papercusp/local-plan')).toEqual({ harnessSlug: 'papercusp', planSlug: 'local-plan' });
    expect(parsePlanRef('plan:a/b/c')).toBeNull();
    expect(parsePlanRef('wi:EI-1')).toBeNull();
    expect(parsePlanRef('plan:')).toBeNull();
  });

  it('derives one deterministic idea id per goal-local plan', () => {
    expect(goalLocalPlanIdeaId('goal-1', 'papercusp', 'p')).toBe('goal-plan:goal-1:papercusp/p');
    expect(goalLocalPlanIdeaId('goal-1', 'papercusp', 'p')).not.toBe(goalLocalPlanIdeaId('goal-2', 'papercusp', 'p'));
  });
});
