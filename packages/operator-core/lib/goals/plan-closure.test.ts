import { describe, expect, it } from 'vitest';

import { GATE_CODE_OWNERSHIP } from '../agent-obligation-providers';
import { compileGoalPlanPlacement } from '../goal-launch-settings';
import type { PlanAcceptanceGateCode } from '../plan-acceptance-gate';
import {
  GATE_CODE_CLOSURE_LEG,
  PLAN_CLOSURE_LEGS,
  PLAN_CLOSURE_REPORT_FIELDS,
  parsePlanClosureReport,
  planClosureNextAction,
  resolvePlanClosure,
  type PlanClosureVerdict,
} from './plan-closure';

const read = (
  gate: { satisfied: boolean; code?: PlanAcceptanceGateCode; skipped?: string; message?: string },
  acceptanceReasoning?: string | null,
): PlanClosureVerdict =>
  resolvePlanClosure({
    planSlug: 'subject-plan',
    status: 'read',
    gate: gate as never,
    acceptanceReasoning: acceptanceReasoning ?? null,
  });

const COMPLETE_REPORT = [
  'EFFECT: goal-mode stopped counting 205 awaiting-acceptance plans as finished.',
  'COST: one portfolio re-parse per administratively complete plan.',
  'UNCERTAINTY: the gate reports one code, so unexamined legs stay unknown.',
  'RESIDUE: the reader still raises acceptance obligations only for currentPlanSlug.',
].join('\n');

describe('GATE_CODE_CLOSURE_LEG', () => {
  // DERIVED, never hand-listed: the sibling Record is itself exhaustive over
  // PlanAcceptanceGateCode, so comparing key sets is what catches a code that was
  // added to the union and classified in one map but not the other. A hand-written
  // list here would silently stop covering the newest code — the exact drift both
  // Records exist to prevent.
  it('classifies every acceptance-gate code, with no invented ones', () => {
    expect(Object.keys(GATE_CODE_CLOSURE_LEG).sort()).toEqual(Object.keys(GATE_CODE_OWNERSHIP).sort());
  });

  it('assigns each code to a declared leg with a declared rating', () => {
    for (const [code, classified] of Object.entries(GATE_CODE_CLOSURE_LEG)) {
      expect(PLAN_CLOSURE_LEGS, `${code} names a real leg`).toContain(classified.leg);
      expect(['fail', 'unknown'], `${code} has a real rating`).toContain(classified.rating);
    }
  });

  it('routes the gate codes that are MEASUREMENT failures to `unknown`, not `fail`', () => {
    // A failed measurement ranked as a finding sends a holder to repair a plan
    // whose state was never read. These four are the gate's own unmeasured set.
    for (const code of [
      'acceptance_lineage_unreadable',
      'acceptance_rubric_revision_unreadable',
      'design_evidence_unavailable',
      'spec_coverage_unavailable',
    ] as const) {
      expect(GATE_CODE_CLOSURE_LEG[code].rating, code).toBe('unknown');
    }
  });
});

describe('resolvePlanClosure', () => {
  it('reports `closed` only when every leg passes — the calibration case', () => {
    const verdict = read({ satisfied: true }, COMPLETE_REPORT);
    expect(verdict.state).toBe('closed');
    expect(verdict.legs).toEqual({
      terminalEvidence: 'pass',
      verificationReadBack: 'pass',
      independentRegrade: 'pass',
      measuredReport: 'pass',
    });
    expect(verdict.evidenceSatisfied).toBe(true);
    expect(planClosureNextAction(verdict)).toBeNull();
  });

  it('does NOT report closed when acceptance passed but the measured report is absent', () => {
    const verdict = read({ satisfied: true }, null);
    expect(verdict.state).not.toBe('closed');
    expect(verdict.state).toBe('unknown');
    expect(verdict.legs.measuredReport).toBe('unknown');
    // The evidence legs DID pass, so this must not be answered with a fleet launch.
    expect(verdict.evidenceSatisfied).toBe(true);
    expect(planClosureNextAction(verdict)?.kind).toBe('report');
  });

  it('reports `partial` when the report is attempted but incomplete', () => {
    const verdict = read({ satisfied: true }, 'EFFECT: it worked.\nCOST: two hours.');
    expect(verdict.state).toBe('partial');
    expect(verdict.legs.measuredReport).toBe('fail');
    expect(verdict.report.missing).toEqual(['uncertainty', 'residue']);
  });

  it('maps a refusal onto the leg it falsifies and leaves the UNEXAMINED legs unknown', () => {
    const verdict = read({ satisfied: false, code: 'acceptance_ungraded', message: 'no independent grade' });
    expect(verdict.legs.independentRegrade).toBe('fail');
    // The gate reports ONE code; it did not adjudicate these. Rating them `pass`
    // would be exactly the "declare success from claims" failure P-026 names.
    expect(verdict.legs.terminalEvidence).toBe('unknown');
    expect(verdict.legs.verificationReadBack).toBe('unknown');
    expect(verdict.evidenceSatisfied).toBe(false);
    expect(verdict.state).toBe('partial');
  });

  it('never reports progress for an unfinished plan', () => {
    const verdict = read({ satisfied: false, code: 'plan_items_unfinished' });
    expect(verdict.legs.terminalEvidence).toBe('fail');
    expect(verdict.evidenceSatisfied).toBe(false);
    expect(verdict.state).not.toBe('closed');
  });

  it('reports `unknown` — never `closed` — when the gate could not be read', () => {
    const verdict = resolvePlanClosure({
      planSlug: 'subject-plan',
      status: 'unreadable',
      failure: { code: 'gate-unreadable', detail: 'connection closed' },
    });
    expect(verdict.state).toBe('unknown');
    expect(verdict.evidenceSatisfied).toBe(false);
    expect(verdict.unreadable?.code).toBe('gate-unreadable');
    expect(planClosureNextAction(verdict)?.kind).toBe('inspect');
  });

  it('reports `unknown` when the gate is switched off, rather than a clean bill', () => {
    const verdict = read({ satisfied: false, skipped: 'flag-off' });
    expect(verdict.state).toBe('unknown');
    expect(verdict.evidenceSatisfied).toBe(false);
    expect(verdict.unreadable?.code).toBe('gate-not-evaluated');
  });

  it('reports `unknown` when a refusal names no code', () => {
    const verdict = read({ satisfied: false, message: 'refused without a code' });
    expect(verdict.state).toBe('unknown');
    expect(verdict.code).toBeNull();
  });

  it('treats a template subject as not-applicable rather than passed', () => {
    const verdict = read({ satisfied: false, skipped: 'rubric-template-plan' });
    expect(verdict.state).toBe('closed');
    expect(verdict.legs.terminalEvidence).toBe('not-applicable');
    expect(verdict.evidenceSatisfied).toBe(true);
  });

  it('credits an already-shipped plan with the evidence legs shipping required', () => {
    const verdict = read({ satisfied: false, skipped: 'already-shipped' }, COMPLETE_REPORT);
    expect(verdict.state).toBe('closed');
    expect(verdict.evidenceSatisfied).toBe(true);
  });
});

describe('parsePlanClosureReport', () => {
  it('accepts the decorated headings real prose uses', () => {
    const parsed = parsePlanClosureReport(
      ['## **Effect** — it shipped', '* COST: 3h', '> Uncertainty: none measured', '**RESIDUE**: one follow-up'].join(
        '\n',
      ),
    );
    expect(parsed.complete).toBe(true);
    expect(parsed.fields.effect).toBe('it shipped');
    expect(parsed.fields.residue).toBe('one follow-up');
  });

  it('is incomplete when a required field is missing, and names which', () => {
    const parsed = parsePlanClosureReport('EFFECT: it shipped');
    expect(parsed.attempted).toBe(true);
    expect(parsed.complete).toBe(false);
    expect(parsed.missing).toEqual(['cost', 'uncertainty', 'residue']);
  });

  it('reports nothing attempted for prose that carries no headings', () => {
    const parsed = parsePlanClosureReport('I believe this plan went well and everyone is happy with it.');
    expect(parsed.attempted).toBe(false);
    expect(parsed.complete).toBe(false);
    expect(parsed.missing).toEqual([...PLAN_CLOSURE_REPORT_FIELDS]);
  });

  it('keeps the FIRST measurement when a heading is restated', () => {
    const parsed = parsePlanClosureReport('COST: 3h\nCOST: actually free');
    expect(parsed.fields.cost).toBe('3h');
  });
});

describe('compileGoalPlanPlacement closure gate', () => {
  const base = {
    plan: { harness: 'papercusp', slug: 'subject-plan', ambiguousMatches: 1 },
    itemStatuses: ['done', 'done'],
    actionableItemId: null,
    source: {},
    now: new Date('2026-09-22T21:00:00.000Z'),
  };

  it('parks an administratively complete plan at `awaiting-closure` when no closure was read', () => {
    // THE REGRESSION GUARD. Before P-026 this exact input returned `terminal`,
    // which dropped the plan out of the goal worklist entirely.
    const placement = compileGoalPlanPlacement({ ...base, status: 'awaiting-acceptance' });
    expect(placement.state).toBe('awaiting-closure');
    expect(placement.reconciliation.action).toBe('close-plan');
    expect(placement.reconciliation.consistent).toBe(false);
    // Never a launch: the execution already happened.
    expect(placement.reconciliation.toolCall).toBeNull();
    expect(placement.closure).toBeNull();
  });

  it('parks a plan whose items are all done even when the status never advanced', () => {
    const placement = compileGoalPlanPlacement({ ...base, status: 'ready' });
    expect(placement.state).toBe('awaiting-closure');
  });

  it('keeps `terminal` for a plan whose closure evidence IS satisfied', () => {
    const placement = compileGoalPlanPlacement({
      ...base,
      status: 'shipped',
      closure: {
        state: 'closed',
        evidenceSatisfied: true,
        reason: 'acceptance satisfied',
        legs: {
          terminalEvidence: 'pass',
          verificationReadBack: 'pass',
          independentRegrade: 'pass',
          measuredReport: 'pass',
        },
      },
    });
    expect(placement.state).toBe('terminal');
    expect(placement.reconciliation.action).toBe('none');
    expect(placement.closure?.reportOutstandingOnly).toBe(false);
  });

  it('does NOT terminate a shipped plan whose closure could not be measured', () => {
    const placement = compileGoalPlanPlacement({
      ...base,
      status: 'shipped',
      closure: {
        state: 'unknown',
        evidenceSatisfied: false,
        reason: 'the acceptance gate is disabled, so closure was never evaluated',
        legs: {
          terminalEvidence: 'unknown',
          verificationReadBack: 'unknown',
          independentRegrade: 'unknown',
          measuredReport: 'unknown',
        },
      },
    });
    expect(placement.state).toBe('awaiting-closure');
    expect(placement.reconciliation.reason).toContain('closure is unknown');
  });

  it('flags a report-only gap so the obligation can ask for a report, not a launch', () => {
    const placement = compileGoalPlanPlacement({
      ...base,
      status: 'shipped',
      closure: {
        state: 'unknown',
        evidenceSatisfied: true,
        reason: 'measured closure report is absent',
        legs: {
          terminalEvidence: 'pass',
          verificationReadBack: 'pass',
          independentRegrade: 'pass',
          measuredReport: 'unknown',
        },
      },
    });
    // The evidence legs passed, so the plan IS terminal for placement purposes…
    expect(placement.state).toBe('terminal');
    // …while the outstanding report stays visible rather than being rounded away.
    expect(placement.closure?.reportOutstandingOnly).toBe(true);
  });
});
