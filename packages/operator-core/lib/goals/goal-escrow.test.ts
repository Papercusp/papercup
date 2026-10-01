import { describe, expect, it } from 'vitest';
import {
  GOAL_ESCROW_DEPOSIT_KEYS,
  evaluateGoalEscrow,
  summarizeGoalEscrowSample,
  type EscrowWorkItem,
  type GoalEscrowDepositKey,
  type GoalEscrowSnapshot,
} from './goal-escrow';

const NOW = Date.parse('2026-10-01T04:00:00.000Z');
const MIN = 60_000;

function item(over: Partial<EscrowWorkItem> = {}): EscrowWorkItem {
  return {
    id: 'WI-1',
    status: 'done',
    completionAuthority: 'committed',
    assignee: null,
    takenBy: null,
    terminalOwner: 'su-implementer',
    closedAtMs: NOW - 120 * MIN,
    hasCompletionEvidence: true,
    testResult: 'pass',
    ...over,
  };
}

/** A goal that is genuinely finished: every deposit present, status achieved. */
function closableSnapshot(over: Partial<GoalEscrowSnapshot> = {}): GoalEscrowSnapshot {
  return {
    observedAtMs: NOW,
    goal: {
      id: 'goal-a',
      status: 'achieved',
      standing: false,
      disposition: 'achieved',
      dispositionAtMs: NOW - 60 * MIN,
      closureReason: null,
      killCriterion: 'abandon if nothing moves in 7 days',
      budgetCents: 20_000,
      updatedAtMs: NOW - 60 * MIN,
    },
    workItems: [item()],
    plans: [{ slug: 'plan-a', status: 'shipped' }],
    gate: { lastVerdict: 'green', observedAtMs: NOW - 10 * MIN, lastGreenAtMs: NOW - 10 * MIN },
    noGoReason: null,
    grades: [
      { id: 'EI-9', rubricRef: 'acceptance', score10: 9, gradedBy: 'su-grader', createdAtMs: NOW - 90 * MIN, subjectRef: 'plan-a' },
    ],
    spend: { spentCents: 364, spentAtMs: NOW - 50 * MIN, lineageCents: 364, unmeasuredReason: null },
    ownerReports: [{ diagnosis: 'complete', atMs: NOW - 80 * MIN }],
    ownerReportRequired: true,
    ownerReportNotRequiredReason: null,
    ...over,
  };
}

function stateOf(snap: GoalEscrowSnapshot, key: GoalEscrowDepositKey) {
  return evaluateGoalEscrow(snap).deposits.find((d) => d.key === key)!;
}

describe('goal escrow: positive control', () => {
  it('a fully deposited achieved goal closes and matches its status with nothing actionable', () => {
    const result = evaluateGoalEscrow(closableSnapshot());
    expect(result.deposits.map((d) => d.key)).toEqual([...GOAL_ESCROW_DEPOSIT_KEYS]);
    expect(result.deposits.every((d) => d.state === 'present')).toBe(true);
    expect(result.verdict).toBe('close');
    expect(result.agreement).toBe('match');
    expect(result.overclaimsClose).toBe(false);
    expect(result.actionable).toEqual([]);
  });
});

describe('goal escrow: implementation_delta', () => {
  it('is missing when nothing is linked', () => {
    const d = stateOf(closableSnapshot({ workItems: [], plans: [] }), 'implementation_delta');
    expect(d.state).toBe('missing');
  });

  it('is missing when linked items never reached a delivered status', () => {
    const d = stateOf(closableSnapshot({ workItems: [item({ status: 'wip', closedAtMs: null })] }), 'implementation_delta');
    expect(d.state).toBe('missing');
  });

  it('is conflicting when an item claims done with no completion evidence', () => {
    const d = stateOf(closableSnapshot({ workItems: [item({ hasCompletionEvidence: false })] }), 'implementation_delta');
    expect(d.state).toBe('conflicting');
    expect(d.reasons.join(' ')).toContain('WI-1');
  });

  it('is stale while a delivered item is only at proposed authority', () => {
    const d = stateOf(closableSnapshot({ workItems: [item({ completionAuthority: 'proposed' })] }), 'implementation_delta');
    expect(d.state).toBe('stale');
  });

  it('is stale while sibling items are still open', () => {
    const snap = closableSnapshot({ workItems: [item(), item({ id: 'WI-2', status: 'wip', closedAtMs: null })] });
    expect(stateOf(snap, 'implementation_delta').state).toBe('stale');
  });

  it('does not count a dropped item as open work', () => {
    const snap = closableSnapshot({ workItems: [item(), item({ id: 'WI-2', status: 'dropped', closedAtMs: NOW - MIN })] });
    expect(stateOf(snap, 'implementation_delta').state).toBe('present');
  });
});

describe('goal escrow: green_proof_or_no_go_reason', () => {
  it('is conflicting when a delivered item records a failing test result', () => {
    const d = stateOf(closableSnapshot({ workItems: [item({ testResult: 'fail' })] }), 'green_proof_or_no_go_reason');
    expect(d.state).toBe('conflicting');
  });

  it('is missing when the gate is red and no bounded no-go reason is recorded', () => {
    const gate = { lastVerdict: 'not-green', observedAtMs: NOW - MIN, lastGreenAtMs: null };
    expect(stateOf(closableSnapshot({ gate }), 'green_proof_or_no_go_reason').state).toBe('missing');
  });

  it('accepts a bounded no-go reason as present and marks it noGo', () => {
    const gate = { lastVerdict: 'not-green', observedAtMs: NOW - MIN, lastGreenAtMs: null };
    const noGoReason = { text: 'frozen repair queue holds main', observedAtMs: NOW - MIN };
    const d = stateOf(closableSnapshot({ gate, noGoReason }), 'green_proof_or_no_go_reason');
    expect(d.state).toBe('present');
    expect(d.noGo).toBe(true);
  });

  it('is stale for an open goal whose only proof is an old gate reading', () => {
    const snap = closableSnapshot({
      goal: { ...closableSnapshot().goal, status: 'active', disposition: null, dispositionAtMs: null },
      workItems: [item({ testResult: null })],
      gate: { lastVerdict: 'green', observedAtMs: NOW - 8 * 60 * MIN, lastGreenAtMs: NOW - 8 * 60 * MIN },
    });
    expect(stateOf(snap, 'green_proof_or_no_go_reason').state).toBe('stale');
  });

  it('is missing when nothing was delivered', () => {
    const snap = closableSnapshot({ workItems: [item({ status: 'wip', closedAtMs: null })] });
    expect(stateOf(snap, 'green_proof_or_no_go_reason').state).toBe('missing');
  });
});

describe('goal escrow: independent_grade', () => {
  it('is missing with no grades at all', () => {
    expect(stateOf(closableSnapshot({ grades: [] }), 'independent_grade').state).toBe('missing');
  });

  it('is missing when the only grade came from the implementer', () => {
    const snap = closableSnapshot({
      grades: [{ id: 'EI-9', rubricRef: 'acceptance', score10: 10, gradedBy: 'su-implementer', createdAtMs: NOW - MIN, subjectRef: 'plan-a' }],
    });
    const d = stateOf(snap, 'independent_grade');
    expect(d.state).toBe('missing');
    expect(d.reasons.join(' ')).toContain('self-graded');
  });

  it('is conflicting when independent graders disagree', () => {
    const snap = closableSnapshot({
      grades: [
        { id: 'EI-9', rubricRef: 'acceptance', score10: 9, gradedBy: 'su-g1', createdAtMs: NOW - 90 * MIN, subjectRef: 'plan-a' },
        { id: 'EI-10', rubricRef: 'acceptance', score10: 3, gradedBy: 'su-g2', createdAtMs: NOW - 90 * MIN, subjectRef: 'plan-a' },
      ],
    });
    expect(stateOf(snap, 'independent_grade').state).toBe('conflicting');
  });

  it('is conflicting when the independent grade is below the pass bar', () => {
    const snap = closableSnapshot({
      grades: [{ id: 'EI-9', rubricRef: 'acceptance', score10: 4, gradedBy: 'su-g1', createdAtMs: NOW - 90 * MIN, subjectRef: 'plan-a' }],
    });
    expect(stateOf(snap, 'independent_grade').state).toBe('conflicting');
  });

  it('is stale when the newest independent grade predates the last delivered close', () => {
    const snap = closableSnapshot({
      grades: [{ id: 'EI-9', rubricRef: 'acceptance', score10: 9, gradedBy: 'su-g1', createdAtMs: NOW - 200 * MIN, subjectRef: 'plan-a' }],
    });
    expect(stateOf(snap, 'independent_grade').state).toBe('stale');
  });
});

describe('goal escrow: spend_snapshot_with_timestamp', () => {
  it('is missing when no spend figure exists', () => {
    const spend = { spentCents: null, spentAtMs: null, lineageCents: null, unmeasuredReason: 'no-lineage-samples' };
    const d = stateOf(closableSnapshot({ spend }), 'spend_snapshot_with_timestamp');
    expect(d.state).toBe('missing');
    expect(d.reasons.join(' ')).toContain('no-lineage-samples');
  });

  it('is missing when the figure has no timestamp', () => {
    const spend = { spentCents: 100, spentAtMs: null, lineageCents: 100, unmeasuredReason: null };
    expect(stateOf(closableSnapshot({ spend }), 'spend_snapshot_with_timestamp').state).toBe('missing');
  });

  it('is conflicting when the headline figure differs from the authoritative lineage', () => {
    const spend = { spentCents: 364, spentAtMs: NOW - 50 * MIN, lineageCents: 25_181, unmeasuredReason: null };
    expect(stateOf(closableSnapshot({ spend }), 'spend_snapshot_with_timestamp').state).toBe('conflicting');
  });

  it('is conflicting when spend exceeds a non-standing goal ceiling', () => {
    const spend = { spentCents: 30_000, spentAtMs: NOW - 50 * MIN, lineageCents: 30_000, unmeasuredReason: null };
    expect(stateOf(closableSnapshot({ spend }), 'spend_snapshot_with_timestamp').state).toBe('conflicting');
  });

  it('does not flag a standing goal for exceeding its per-window ceiling', () => {
    const base = closableSnapshot();
    const snap = closableSnapshot({
      goal: { ...base.goal, standing: true, status: 'active', disposition: null, dispositionAtMs: null },
      spend: { spentCents: 30_000, spentAtMs: NOW - 5 * MIN, lineageCents: 30_000, unmeasuredReason: null },
    });
    expect(stateOf(snap, 'spend_snapshot_with_timestamp').state).toBe('present');
  });

  it('is stale for a closed goal whose snapshot predates the closure', () => {
    const spend = { spentCents: 364, spentAtMs: NOW - 5 * 60 * MIN, lineageCents: 364, unmeasuredReason: null };
    expect(stateOf(closableSnapshot({ spend }), 'spend_snapshot_with_timestamp').state).toBe('stale');
  });

  it('is stale for an open goal whose snapshot is older than the freshness window', () => {
    const base = closableSnapshot();
    const snap = closableSnapshot({
      goal: { ...base.goal, status: 'active', disposition: null, dispositionAtMs: null },
      spend: { spentCents: 364, spentAtMs: NOW - 45 * MIN, lineageCents: 364, unmeasuredReason: null },
    });
    expect(stateOf(snap, 'spend_snapshot_with_timestamp').state).toBe('stale');
  });
});

describe('goal escrow: owner_report_or_not_required', () => {
  it('is present when explicitly not required', () => {
    const snap = closableSnapshot({
      ownerReports: [],
      ownerReportRequired: false,
      ownerReportNotRequiredReason: 'standing goal: reports ride the cadence rail',
    });
    expect(stateOf(snap, 'owner_report_or_not_required').state).toBe('present');
  });

  it('is missing when required and no complete report exists', () => {
    expect(stateOf(closableSnapshot({ ownerReports: [] }), 'owner_report_or_not_required').state).toBe('missing');
    const partial = closableSnapshot({ ownerReports: [{ diagnosis: 'incomplete', atMs: NOW - MIN }] });
    expect(stateOf(partial, 'owner_report_or_not_required').state).toBe('missing');
  });

  it('is conflicting when the only reports are vouched for a different goal', () => {
    const snap = closableSnapshot({ ownerReports: [{ diagnosis: 'wrong-goal', atMs: NOW - MIN }] });
    expect(stateOf(snap, 'owner_report_or_not_required').state).toBe('conflicting');
  });

  it('is stale when the newest complete report predates the last delivered close', () => {
    const snap = closableSnapshot({ ownerReports: [{ diagnosis: 'complete', atMs: NOW - 300 * MIN }] });
    expect(stateOf(snap, 'owner_report_or_not_required').state).toBe('stale');
  });
});

describe('goal escrow: closure_verdict', () => {
  it('is missing (expected) while the goal is open', () => {
    const base = closableSnapshot();
    const snap = closableSnapshot({ goal: { ...base.goal, status: 'active', disposition: null, dispositionAtMs: null } });
    expect(stateOf(snap, 'closure_verdict').state).toBe('missing');
  });

  it('is conflicting when status says achieved but the disposition says killed', () => {
    const base = closableSnapshot();
    const snap = closableSnapshot({ goal: { ...base.goal, status: 'achieved', disposition: 'killed' } });
    expect(stateOf(snap, 'closure_verdict').state).toBe('conflicting');
  });

  it('is missing when a terminal status carries no disposition or reason', () => {
    const base = closableSnapshot();
    const snap = closableSnapshot({ goal: { ...base.goal, disposition: null, dispositionAtMs: null, closureReason: null } });
    expect(stateOf(snap, 'closure_verdict').state).toBe('missing');
  });

  it('is stale when work was delivered after the verdict was recorded', () => {
    const base = closableSnapshot();
    const snap = closableSnapshot({
      goal: { ...base.goal, dispositionAtMs: NOW - 300 * MIN },
      workItems: [item({ closedAtMs: NOW - 100 * MIN })],
    });
    expect(stateOf(snap, 'closure_verdict').state).toBe('stale');
  });
});

describe('goal escrow: verdict and status agreement', () => {
  it('an achieved goal whose evidence is missing is unsupported and overclaims close', () => {
    const result = evaluateGoalEscrow(closableSnapshot({ grades: [], ownerReports: [] }));
    expect(result.verdict).toBe('insufficient');
    expect(result.agreement).toBe('unsupported');
    expect(result.overclaimsClose).toBe(true);
    expect(result.actionable).toEqual(expect.arrayContaining(['independent_grade:missing', 'owner_report_or_not_required:missing']));
  });

  it('a conflicting closure blocks an otherwise complete close', () => {
    const base = closableSnapshot();
    const result = evaluateGoalEscrow(closableSnapshot({ goal: { ...base.goal, disposition: 'killed' } }));
    expect(result.verdict).toBe('insufficient');
    expect(result.verdictReasons.join(' ')).toContain('closure_verdict conflicting');
  });

  it('a bounded no-go reason turns a complete goal into block', () => {
    const base = closableSnapshot();
    const result = evaluateGoalEscrow(
      closableSnapshot({
        goal: { ...base.goal, status: 'blocked', disposition: 'blocked', dispositionAtMs: NOW - 5 * MIN },
        gate: { lastVerdict: 'not-green', observedAtMs: NOW - MIN, lastGreenAtMs: null },
        noGoReason: { text: 'frozen repair queue holds main', observedAtMs: NOW - MIN },
        spend: { spentCents: 364, spentAtMs: NOW - 2 * MIN, lineageCents: 364, unmeasuredReason: null },
      }),
    );
    expect(result.verdict).toBe('block');
    expect(result.agreement).toBe('match');
  });

  it('a killed goal with a recorded closure verdict fails and matches', () => {
    const base = closableSnapshot();
    const result = evaluateGoalEscrow(
      closableSnapshot({ goal: { ...base.goal, status: 'killed', disposition: 'killed' }, workItems: [], plans: [], grades: [] }),
    );
    expect(result.verdict).toBe('fail');
    expect(result.agreement).toBe('match');
    expect(result.overclaimsClose).toBe(false);
  });

  it('a killed goal with no recorded reason is unsupported rather than fail', () => {
    const base = closableSnapshot();
    const result = evaluateGoalEscrow(
      closableSnapshot({ goal: { ...base.goal, status: 'killed', disposition: null, dispositionAtMs: null }, workItems: [], plans: [] }),
    );
    expect(result.verdict).toBe('insufficient');
    expect(result.agreement).toBe('unsupported');
  });

  it('an achieved goal the escrow would block is divergent, not unsupported', () => {
    const base = closableSnapshot();
    const result = evaluateGoalEscrow(
      closableSnapshot({
        goal: { ...base.goal, status: 'achieved' },
        gate: { lastVerdict: 'not-green', observedAtMs: NOW - MIN, lastGreenAtMs: null },
        noGoReason: { text: 'frozen repair queue holds main', observedAtMs: NOW - MIN },
      }),
    );
    expect(result.verdict).toBe('block');
    expect(result.agreement).toBe('divergent');
    expect(result.overclaimsClose).toBe(true);
  });

  it('an open goal that already satisfies every deposit is ready-unclosed', () => {
    const base = closableSnapshot();
    const result = evaluateGoalEscrow(
      closableSnapshot({
        goal: { ...base.goal, status: 'active', disposition: null, dispositionAtMs: null },
        spend: { spentCents: 364, spentAtMs: NOW - 5 * MIN, lineageCents: 364, unmeasuredReason: null },
      }),
    );
    expect(result.verdict).toBe('close');
    expect(result.agreement).toBe('ready-unclosed');
  });

  it('an open goal is not flagged for lacking a closure verdict', () => {
    const base = closableSnapshot();
    const result = evaluateGoalEscrow(closableSnapshot({ goal: { ...base.goal, status: 'active', disposition: null, dispositionAtMs: null } }));
    expect(result.actionable).not.toContain('closure_verdict:missing');
  });

  it('judges the evaluator honestly: a snapshot with no records yields insufficient, never close', () => {
    const base = closableSnapshot();
    const result = evaluateGoalEscrow(
      closableSnapshot({
        goal: { ...base.goal, status: 'active', disposition: null, dispositionAtMs: null },
        workItems: [],
        plans: [],
        gate: null,
        grades: [],
        spend: { spentCents: null, spentAtMs: null, lineageCents: null, unmeasuredReason: null },
        ownerReports: [],
      }),
    );
    expect(result.verdict).toBe('insufficient');
    expect(result.agreement).toBe('in-progress');
  });
});

describe('goal escrow: sample summary and falsification', () => {
  it('is NOT falsified when the sample reveals missing deposits and an overclaim', () => {
    const results = [
      evaluateGoalEscrow(closableSnapshot()),
      evaluateGoalEscrow(closableSnapshot({ grades: [], ownerReports: [] })),
    ];
    const summary = summarizeGoalEscrowSample(results);
    expect(summary.goalsEvaluated).toBe(2);
    expect(summary.goalsWithActionable).toBe(1);
    expect(summary.overclaimsClose).toBe(1);
    expect(summary.matchesWithoutAmbiguity).toBe(1);
    expect(summary.depositFindings['independent_grade:missing']).toBe(1);
    expect(summary.falsified).toBe(false);
    expect(summary.exemplars.map((e) => e.agreement)).toEqual(['unsupported']);
  });

  it('IS falsified when every goal matches its status with nothing actionable', () => {
    const summary = summarizeGoalEscrowSample([evaluateGoalEscrow(closableSnapshot()), evaluateGoalEscrow(closableSnapshot())]);
    expect(summary.matchesWithoutAmbiguity).toBe(2);
    expect(summary.falsified).toBe(true);
  });

  it('an empty sample is never reported as falsified (nothing was tested)', () => {
    const summary = summarizeGoalEscrowSample([]);
    expect(summary.goalsEvaluated).toBe(0);
    expect(summary.falsified).toBe(false);
  });
});
