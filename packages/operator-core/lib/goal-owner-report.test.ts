import { describe, expect, it } from 'vitest';

import {
  GOAL_OWNER_REPORT_DIAGNOSIS_RANK,
  GOAL_OWNER_REPORT_FIELD,
  GOAL_OWNER_REPORT_FIELDS,
  GOAL_OWNER_REPORT_HEADING_LIST,
  GOAL_OWNER_REPORT_HEADINGS,
  GOAL_OWNER_REPORT_SCHEMA_VERSION,
  buildGoalOwnerReportDraft,
  diagnoseGoalOwnerReportEnvelope,
  envelopeHasCompleteGoalOwnerReport,
  isGoalOwnerReportStamp,
  parseGoalOwnerReport,
  stampGoalOwnerReport,
  type GoalOwnerReportEnvelopeDiagnosis,
} from './goal-owner-report';

const GOAL = 'work-on-everything-070565';

describe('P-021 evidence-backed owner report draft', () => {
  const base = {
    goalId: GOAL,
    observedAt: '2026-09-25T20:00:00.000Z',
    previousReportAt: '2026-09-25T19:00:00.000Z',
    movements: [{ ref: 'plan:papercusp/alpha', state: 'shipped', updatedAt: '2026-09-25T19:30:00.000Z',
      artifact: { ref: 'scorecard:alpha', updatedAt: '2026-09-25T19:25:00.000Z' } }],
    cost: { spentCents: 340, budgetCents: 1000, source: 'goal-pots-rollup',
      coverage: 'measured-pot', unmeasuredPricedSpend: false },
    ownerWalls: [{ ref: 'WI-1', action: 'choose a domain' }],
    killed: [{ ref: 'fleet:old', criterion: 'cost exceeded 1000c', at: '2026-09-25T19:40:00.000Z' }],
    artifactReads: [] as Array<{ ref: string; readAt: string }>,
  };

  it('marks a terminal label unverified until an exact fresh artifact read exists', () => {
    const unread = buildGoalOwnerReportDraft(base);
    expect(unread.unreadArtifacts).toEqual(['scorecard:alpha']);
    expect(unread.fields.moved).toContain('completion unverified (artifact unread)');
    expect(unread.fields.cost).toContain('coverage=measured-pot; source=goal-pots-rollup');
    expect(unread.fields.ownerWalled).toContain('WI-1: choose a domain');
    expect(unread.fields.killed).toContain('fleet:old');
    expect(parseGoalOwnerReport(unread.text).complete).toBe(true);
    const stale = buildGoalOwnerReportDraft({ ...base, artifactReads: [
      { ref: 'scorecard:alpha', readAt: '2026-09-25T19:20:00.000Z' },
    ] });
    expect(stale.unreadArtifacts).toEqual(['scorecard:alpha']);
    const read = buildGoalOwnerReportDraft({ ...base, artifactReads: [
      { ref: 'scorecard:alpha', readAt: '2026-09-25T19:50:00.000Z' },
    ] });
    expect(read.unreadArtifacts).toEqual([]);
    expect(read.fields.moved).toContain('artifact scorecard:alpha read 2026-09-25T19:50:00.000Z');
  });

  it('never turns a first snapshot or missing reads into false movement, cost, walls or kills', () => {
    const draft = buildGoalOwnerReportDraft({ ...base, previousReportAt: null,
      cost: { spentCents: null, budgetCents: 1000, source: null,
        coverage: 'unverified', unmeasuredPricedSpend: true }, ownerWalls: null, killed: null });
    expect(draft.fields.moved).toContain('no previous report watermark');
    expect(draft.fields.cost).toContain('unknown; coverage=unverified');
    expect(draft.fields.ownerWalled).toContain('unknown');
    expect(draft.fields.killed).toContain('unknown');
    expect(parseGoalOwnerReport(draft.text).complete).toBe(true);
  });
});

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

/**
 * EI-23742424491420721 — a bare "no owner report" verdict is indistinguishable
 * from "four were delivered and all four parsed as non-attempts". The reader
 * must return WHY, and the boolean face must be derived from that same pass so
 * the two can never disagree.
 */
describe('diagnoseGoalOwnerReportEnvelope', () => {
  const stamp = {
    schemaVersion: GOAL_OWNER_REPORT_SCHEMA_VERSION,
    goalId: GOAL,
    moved: 'P-006 advanced',
    cost: 'unknown (rollup unavailable)',
    ownerWalled: 'none',
    killed: 'none',
  };

  it('separates a delivered non-attempt from a genuinely absent report', () => {
    // The exact shape that cost ~90 minutes: an owner-facing ping naming the
    // goal id verbatim. It is DELIVERED, and it is not a report attempt.
    expect(diagnoseGoalOwnerReportEnvelope({ body: `Status for ${GOAL}: still working.` }, GOAL)).toEqual({
      kind: 'not-attempted',
    });
    // Modern sends persist an array of sections, not a flat string.
    expect(
      diagnoseGoalOwnerReportEnvelope({ body: [{ text: `Progress on ${GOAL}: three items advanced.` }] }, GOAL),
    ).toEqual({ kind: 'not-attempted' });
  });

  it('names the specific unmet fields when the report was attempted', () => {
    expect(
      diagnoseGoalOwnerReportEnvelope({ body: `Goal ${GOAL}\nMOVED: P-006\nCOST: 3c\nOWNER-WALLED: none` }, GOAL),
    ).toEqual({ kind: 'incomplete', missing: ['killed'], empty: [], duplicate: [] });

    expect(
      diagnoseGoalOwnerReportEnvelope(
        { body: [{ text: 'MOVED: P-006' }, { text: 'MOVED: again' }, { text: 'COST:' }] },
        GOAL,
      ),
    ).toEqual({
      // A duplicated heading still reports its first value, so `moved` is
      // duplicate-but-not-empty; the bare `COST:` heading is the empty one.
      kind: 'incomplete',
      missing: ['ownerWalled', 'killed'],
      empty: ['cost'],
      duplicate: ['moved'],
    });
  });

  it('distinguishes a complete report aimed at another subject from a malformed one', () => {
    expect(diagnoseGoalOwnerReportEnvelope({ [GOAL_OWNER_REPORT_FIELD]: { ...stamp, goalId: 'other-goal' } }, GOAL))
      .toEqual({ kind: 'wrong-goal', stampedGoalId: 'other-goal' });

    // Legacy flat body: complete four labels, but never names this goal.
    expect(
      diagnoseGoalOwnerReportEnvelope(
        { body: 'MOVED: P-006\nCOST: 3c\nOWNER-WALLED: none\nKILLED: none' },
        GOAL,
      ),
    ).toEqual({ kind: 'wrong-goal', stampedGoalId: null });
  });

  it('flags a complete structured report that carries no server stamp', () => {
    // coord:send could not resolve the GOAL subject, so nothing vouches for it.
    expect(
      diagnoseGoalOwnerReportEnvelope(
        {
          body: [
            { text: 'MOVED: P-006 advanced' },
            { text: 'COST: 3c' },
            { text: 'OWNER-WALLED: none' },
            { text: 'KILLED: none' },
          ],
        },
        GOAL,
      ),
    ).toEqual({ kind: 'unstamped-complete' });
  });

  it('accepts the two shapes that really do register, and rejects a non-envelope', () => {
    expect(diagnoseGoalOwnerReportEnvelope({ [GOAL_OWNER_REPORT_FIELD]: stamp }, GOAL)).toEqual({ kind: 'complete' });
    expect(
      diagnoseGoalOwnerReportEnvelope(
        { body: `Goal ${GOAL}\nMOVED: P-006\nCOST: 3c\nOWNER-WALLED: none\nKILLED: none` },
        GOAL,
      ),
    ).toEqual({ kind: 'complete' });
    expect(diagnoseGoalOwnerReportEnvelope(null, GOAL)).toEqual({ kind: 'unreadable-envelope' });
    expect(diagnoseGoalOwnerReportEnvelope(['not', 'an', 'envelope'], GOAL)).toEqual({ kind: 'unreadable-envelope' });
  });

  it('keeps the boolean predicate exactly equal to a complete diagnosis', () => {
    const envelopes: unknown[] = [
      { [GOAL_OWNER_REPORT_FIELD]: stamp },
      { [GOAL_OWNER_REPORT_FIELD]: { ...stamp, goalId: 'other-goal' } },
      { body: `Goal ${GOAL}\nMOVED: a\nCOST: b\nOWNER-WALLED: c\nKILLED: d` },
      { body: 'MOVED: a\nCOST: b\nOWNER-WALLED: c\nKILLED: d' },
      { body: `Status for ${GOAL}: still working.` },
      { body: [{ text: 'MOVED: a' }, { text: 'COST: b' }, { text: 'OWNER-WALLED: c' }, { text: 'KILLED: d' }] },
      { body: null },
      null,
      [],
    ];
    for (const envelope of envelopes) {
      expect(envelopeHasCompleteGoalOwnerReport(envelope, GOAL)).toBe(
        diagnoseGoalOwnerReportEnvelope(envelope, GOAL).kind === 'complete',
      );
    }
  });

  it('ranks every diagnosis kind so the closest candidate can be chosen', () => {
    const kinds: GoalOwnerReportEnvelopeDiagnosis['kind'][] = [
      'complete',
      'unstamped-complete',
      'wrong-goal',
      'incomplete',
      'not-attempted',
      'unreadable-envelope',
    ];
    for (const kind of kinds) {
      expect(typeof GOAL_OWNER_REPORT_DIAGNOSIS_RANK[kind]).toBe('number');
    }
    // A complete report must outrank every partial one, or the gate would
    // explain a worse candidate than the one it actually evaluated.
    expect(GOAL_OWNER_REPORT_DIAGNOSIS_RANK.complete).toBeGreaterThan(
      Math.max(...kinds.filter((k) => k !== 'complete').map((k) => GOAL_OWNER_REPORT_DIAGNOSIS_RANK[k])),
    );
    expect(GOAL_OWNER_REPORT_DIAGNOSIS_RANK['not-attempted']).toBeGreaterThan(
      GOAL_OWNER_REPORT_DIAGNOSIS_RANK['unreadable-envelope'],
    );
  });
});

/**
 * The headings a refusal quotes must be the headings the parser accepts — not
 * a second hand-maintained spelling that can drift out from under it.
 */
describe('GOAL_OWNER_REPORT_HEADINGS', () => {
  it('round-trips every advertised heading back through the parser', () => {
    for (const field of GOAL_OWNER_REPORT_FIELDS) {
      const heading = GOAL_OWNER_REPORT_HEADINGS[field];
      const parsed = parseGoalOwnerReport(`${heading}: a value`);
      expect(parsed.attempted).toBe(true);
      expect(parsed.fields[field]).toBe('a value');
    }
  });

  it('advertises exactly the four contract fields, in contract order', () => {
    expect(Object.keys(GOAL_OWNER_REPORT_HEADINGS)).toEqual([...GOAL_OWNER_REPORT_FIELDS]);
    expect(GOAL_OWNER_REPORT_HEADING_LIST).toBe('MOVED / COST / OWNER-WALLED / KILLED');
  });
});
