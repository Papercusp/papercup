import { describe, expect, it } from 'vitest';

import {
  GOAL_OWNER_REPORT_FIELD,
  GOAL_OWNER_REPORT_SCHEMA_VERSION,
  envelopeHasCompleteGoalOwnerReport,
  isGoalOwnerReportStamp,
  parseGoalOwnerReport,
  stampGoalOwnerReport,
} from './goal-owner-report';

const GOAL = 'work-on-everything-070565';

describe('parseGoalOwnerReport', () => {
  it('parses and normalizes the four structured coord sections, including explicit none/unknown', () => {
    const parsed = parseGoalOwnerReport([
      { text: 'MOVED:  P-006 advanced\nwith focused tests' },
      { text: '**COST:** unknown (goal-pots rollup unavailable)' },
      { text: '## OWNER-WALLED — none' },
      { text: '- KILLED: none' },
    ]);

    expect(parsed).toEqual({
      attempted: true,
      complete: true,
      fields: {
        moved: 'P-006 advanced\nwith focused tests',
        cost: 'unknown (goal-pots rollup unavailable)',
        ownerWalled: 'none',
        killed: 'none',
      },
      missing: [],
      empty: [],
      duplicate: [],
    });
  });

  it('accepts a legacy flat body whose heading values are on following lines', () => {
    const parsed = parseGoalOwnerReport(
      `Goal ${GOAL}\n\nMOVED\nP-001 landed\n\nCOST\n12c measured\n\nOWNER_WALLED\nnone\n\nKILLED\nold experiment`,
    );
    expect(parsed.complete).toBe(true);
    expect(parsed.fields.ownerWalled).toBe('none');
  });

  it('reports missing, empty, and duplicate fields instead of choosing silently', () => {
    const parsed = parseGoalOwnerReport(['MOVED: first', 'MOVED: second', 'COST:', 'KILLED: none']);
    expect(parsed).toMatchObject({
      attempted: true,
      complete: false,
      missing: ['ownerWalled'],
      empty: ['cost'],
      duplicate: ['moved'],
    });
  });

  it('does not classify ordinary prose or the slash-separated contract reminder as a report attempt', () => {
    expect(parseGoalOwnerReport('We moved the build and reduced cost.').attempted).toBe(false);
    expect(parseGoalOwnerReport('MOVED / COST / OWNER-WALLED / KILLED').attempted).toBe(false);
  });
});

describe('goal owner report evidence', () => {
  const complete = parseGoalOwnerReport('MOVED: P-006\nCOST: 3c\nOWNER-WALLED: none\nKILLED: stale plan');

  it('stamps the server-resolved goal and validates every normalized field', () => {
    const stamp = stampGoalOwnerReport(GOAL, complete);
    expect(stamp).toEqual({
      schemaVersion: GOAL_OWNER_REPORT_SCHEMA_VERSION,
      goalId: GOAL,
      moved: 'P-006',
      cost: '3c',
      ownerWalled: 'none',
      killed: 'stale plan',
    });
    expect(isGoalOwnerReportStamp(stamp, GOAL)).toBe(true);
    expect(isGoalOwnerReportStamp(stamp, 'wrong-goal')).toBe(false);
  });

  it('accepts a current stamp or a complete goal-naming legacy body, never an arbitrary human ping', () => {
    const stamp = stampGoalOwnerReport(GOAL, complete);
    expect(envelopeHasCompleteGoalOwnerReport({ [GOAL_OWNER_REPORT_FIELD]: stamp }, GOAL)).toBe(true);
    expect(
      envelopeHasCompleteGoalOwnerReport(
        { body: `Goal ${GOAL}\nMOVED: P-006\nCOST: 3c\nOWNER-WALLED: none\nKILLED: none` },
        GOAL,
      ),
    ).toBe(true);
    expect(envelopeHasCompleteGoalOwnerReport({ body: `Status for ${GOAL}: still working.` }, GOAL)).toBe(false);
    expect(
      envelopeHasCompleteGoalOwnerReport({ body: `Goal ${GOAL}\nMOVED: P-006\nCOST: 3c\nOWNER-WALLED: none` }, GOAL),
    ).toBe(false);
    expect(
      envelopeHasCompleteGoalOwnerReport({ [GOAL_OWNER_REPORT_FIELD]: { ...stamp, goalId: 'wrong-goal' } }, GOAL),
    ).toBe(false);
  });
});
