/**
 * Plan size advice (WI-6554700010048088) — the pure measure + advisory.
 *
 * The handler wiring (the advisory reaching the caller, the decision still being
 * written) is pinned in add-decision.test.ts; this file pins the budget lines and
 * what the advice says.
 */
import { describe, it, expect } from 'vitest';
import { measurePlanSize, planSizeAdvisory, PLAN_SIZE_BUDGET } from './plan-size-advisory';

const TODAY = '2026-11-13';
const decisionsDated = (n: number, date: string | null) => Array.from({ length: n }, () => ({ date }));

describe('measurePlanSize', () => {
  it('counts the appended decision and stamps it today', () => {
    const measure = measurePlanSize('body', [...decisionsDated(3, '2026-10-01'), ...decisionsDated(2, TODAY)], TODAY, 1);
    expect(measure).toEqual({ decisions: 6, bytes: 4, decisionsToday: 3 });
  });

  it('adds nothing for a no-op retry', () => {
    expect(measurePlanSize('body', decisionsDated(2, TODAY), TODAY)).toEqual({ decisions: 2, bytes: 4, decisionsToday: 2 });
  });

  it('measures UTF-8 bytes, not characters', () => {
    // One em dash is three bytes; a char count would under-read a plan full of them.
    expect(measurePlanSize('—', [], TODAY).bytes).toBe(3);
  });

  it('ignores undated decisions when counting today', () => {
    expect(measurePlanSize('', decisionsDated(4, null), TODAY).decisionsToday).toBe(0);
  });
});

describe('planSizeAdvisory', () => {
  const within = { decisions: PLAN_SIZE_BUDGET.decisions, bytes: PLAN_SIZE_BUDGET.bytes, decisionsToday: 0 };

  it('is null when the plan was not measured', () => {
    expect(planSizeAdvisory(undefined)).toBeNull();
    expect(planSizeAdvisory(null)).toBeNull();
  });

  it('is null AT the budget on both lines — the budget is what a plan may hold', () => {
    expect(planSizeAdvisory(within)).toBeNull();
  });

  it('fires one decision past the decision line, naming only that line', () => {
    const advisory = planSizeAdvisory({ ...within, decisions: PLAN_SIZE_BUDGET.decisions + 1 });
    expect(advisory).toMatchObject({
      code: 'plan_over_size_budget',
      decisions: PLAN_SIZE_BUDGET.decisions + 1,
      over: ['decisions'],
      budget: { decisions: PLAN_SIZE_BUDGET.decisions, bytes: PLAN_SIZE_BUDGET.bytes },
    });
  });

  it('fires one byte past the size line, naming only that line', () => {
    const advisory = planSizeAdvisory({ decisions: 1, bytes: PLAN_SIZE_BUDGET.bytes + 1, decisionsToday: 1 });
    expect(advisory).toMatchObject({ over: ['bytes'], bytes: PLAN_SIZE_BUDGET.bytes + 1 });
  });

  it('names both lines when both are exceeded', () => {
    const advisory = planSizeAdvisory({ decisions: 354, bytes: 965_000, decisionsToday: 0 });
    expect(advisory?.over).toEqual(['decisions', 'bytes']);
  });

  it('says the decision was recorded and where a step-by-step note goes instead', () => {
    const advisory = planSizeAdvisory({ decisions: 354, bytes: 965_000, decisionsToday: 0 });
    // The author reads the message, so pin what it tells them: the write landed
    // (this is advice, not a refusal), the measured size, and the two exact calls.
    expect(advisory?.message).toMatch(/^Recorded\./);
    expect(advisory?.message).toContain('354 decisions in 965 KB');
    expect(advisory?.message).toContain('work_items:checkpoint { id, checkpoint }');
    expect(advisory?.message).toContain('work_items:comment { id, body }');
    expect(advisory?.workLogInstead).toEqual([
      'work_items:checkpoint { id, checkpoint }',
      'work_items:comment { id, body }',
    ]);
  });

  it('mentions same-day decisions only when there are enough to be a work-log tell', () => {
    const quiet = planSizeAdvisory({ decisions: 40, bytes: 10, decisionsToday: 4 });
    const busy = planSizeAdvisory({ decisions: 40, bytes: 10, decisionsToday: 5 });
    expect(quiet?.message).not.toContain('dated today');
    expect(busy?.message).toContain('5 of them are dated today.');
    // The count itself is always on the payload, whichever way the sentence went.
    expect(quiet?.decisionsToday).toBe(4);
  });

  it('hands back a copy of the budget, so a caller cannot mutate the shared constant', () => {
    const advisory = planSizeAdvisory({ decisions: 40, bytes: 10, decisionsToday: 0 });
    expect(advisory?.budget).not.toBe(PLAN_SIZE_BUDGET);
    expect(advisory?.budget).toEqual({ decisions: PLAN_SIZE_BUDGET.decisions, bytes: PLAN_SIZE_BUDGET.bytes });
  });
});
