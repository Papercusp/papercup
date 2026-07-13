/**
 * success-metrics.test.ts — the P-015 program done-check.
 *
 * The point of these tests is DISCRIMINATION, not coverage: every bar is exercised in all
 * three states (pass / fail / unknown) on hand-built ledger snapshots, because a gate that
 * cannot be shown to fail on bad data is not a gate — it is a green light with extra steps
 * (agent-insights/prove-it-discriminates-before-it-acts).
 */
import { describe, expect, it } from 'vitest';

import { evaluateProgramSuccess, type ProgramSuccessReport } from './success-metrics';
import type { ScoutQualityInputs } from './quality-metrics';
import type { ScoutTickRecord } from './tick-ledger';
import type { RoutedIdeaProvenance, LensOutcomeReport } from './outcome-feedback';
import { SU_IDEATION_LENSES, type SuIdeationLens } from './types';

const emptyOutcomes = (): LensOutcomeReport<SuIdeationLens> => ({
  byLens: Object.fromEntries(
    SU_IDEATION_LENSES.map((l) => [l, { won: 0, lost: 0, pending: 0, winRate: null, weight: 1 }]),
  ) as LensOutcomeReport<SuIdeationLens>['byLens'],
});

const ranTick = (over: Partial<ScoutTickRecord> = {}): ScoutTickRecord => ({
  status: 'ran',
  ideasGenerated: 3,
  ideasRouted: 0,
  detail: { cycleId: 'c1', reason: 'signal-volume' },
  ...over,
});

const idea = (over: Partial<RoutedIdeaProvenance> = {}): RoutedIdeaProvenance => ({
  ideaId: 'i1',
  lens: 'risk-first' as unknown as RoutedIdeaProvenance['lens'],
  rail: 'plan' as RoutedIdeaProvenance['rail'],
  routedRef: 'plan:some-plan',
  cycleId: 'c1',
  ...over,
});

const inputs = (
  ticks: ScoutTickRecord[],
  routedIdeas: RoutedIdeaProvenance[],
): ScoutQualityInputs<SuIdeationLens> => ({ ticks, routedIdeas, lensOutcomes: emptyOutcomes() });

const bar = (r: ProgramSuccessReport, key: string) => r.criteria.find((c) => c.key === key)!;

describe('evaluateProgramSuccess — rubric-grounded ideas', () => {
  it('PASSES when a routed idea is grounded in the rubric lane', () => {
    const r = evaluateProgramSuccess(
      inputs([ranTick({ ideasRouted: 1 })], [idea({ addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'] })]),
    );
    expect(bar(r, 'rubric-grounded-ideas').status).toBe('pass');
    expect(bar(r, 'rubric-grounded-ideas').observed).toContain('1 of 1');
  });

  it('FAILS when ideas route but NONE are rubric-grounded — the founding defect (lane silently at zero)', () => {
    const r = evaluateProgramSuccess(
      inputs([ranTick({ ideasRouted: 2 })], [idea({ addressesPatternRefs: ['corpus:x'] }), idea({ ideaId: 'i2' })]),
    );
    expect(bar(r, 'rubric-grounded-ideas').status).toBe('fail');
    expect(r.verdict).toBe('fail');
  });

  it('is UNKNOWN (never pass) on an empty ledger — an empty window cannot certify the program', () => {
    const r = evaluateProgramSuccess(inputs([], []));
    expect(bar(r, 'rubric-grounded-ideas').status).toBe('unknown');
    expect(r.verdict).toBe('incomplete');
    expect(r.passed).toBe(0);
  });
});

describe('evaluateProgramSuccess — zero-signal cycles', () => {
  it('PASSES when every scored cycle fired on real signal, and counts the quiet-period vetoes', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [
          ranTick({ detail: { cycleId: 'c1', signalScore: 42 } }),
          { status: 'gated', gate: 'no-signal' },
          { status: 'gated', gate: 'no-signal' },
        ],
        [],
      ),
    );
    expect(bar(r, 'zero-signal-cycles').status).toBe('pass');
    expect(bar(r, 'zero-signal-cycles').observed).toContain('2 quiet ticks vetoed');
  });

  it('FAILS when a cycle fired at score 0 — pure wasted spend', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ detail: { cycleId: 'c1', signalScore: 0 } })], []));
    expect(bar(r, 'zero-signal-cycles').status).toBe('fail');
  });

  it('an ABSENT score is UNKNOWN, not a 0 — legacy ticks must not fail the bar on history', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ detail: { cycleId: 'c1' } })], []));
    expect(bar(r, 'zero-signal-cycles').status).toBe('unknown');
  });
});

describe('evaluateProgramSuccess — cycle error rate', () => {
  it('PASSES under the 5% bar', () => {
    const ticks = [...Array(20)].map((_, i) => ranTick({ detail: { cycleId: `c${i}`, signalScore: 5 } }));
    expect(bar(evaluateProgramSuccess(inputs(ticks, [])), 'cycle-error-rate').status).toBe('pass');
  });

  it('FAILS at the historical ~30% error rate the program set out to fix', () => {
    const ticks: ScoutTickRecord[] = [
      ...[...Array(7)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      ...[...Array(3)].map((): ScoutTickRecord => ({ status: 'error' })),
    ];
    const r = evaluateProgramSuccess(inputs(ticks, []));
    expect(bar(r, 'cycle-error-rate').status).toBe('fail');
    expect(bar(r, 'cycle-error-rate').observed).toContain('30.0%');
  });

  it('is exclusive at the bar — exactly 5% FAILS (< , not <=)', () => {
    const ticks: ScoutTickRecord[] = [
      ...[...Array(19)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      { status: 'error' },
    ];
    expect(bar(evaluateProgramSuccess(inputs(ticks, [])), 'cycle-error-rate').status).toBe('fail');
  });
});

describe('evaluateProgramSuccess — ledger reconciliation', () => {
  it('PASSES when each cycle’s routed count matches its ledger rows', () => {
    const r = evaluateProgramSuccess(
      inputs([ranTick({ ideasRouted: 2, detail: { cycleId: 'c1' } })], [idea(), idea({ ideaId: 'i2' })]),
    );
    expect(bar(r, 'ledger-reconciles').status).toBe('pass');
  });

  it('FAILS on per-cycle drift — a tick claiming routes with no ledger rows behind it', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 3, detail: { cycleId: 'c1' } })], []));
    expect(bar(r, 'ledger-reconciles').status).toBe('fail');
    expect(bar(r, 'ledger-reconciles').observed).toContain('tick claims 3, ledger has 0');
  });

  it('does NOT let opposite per-cycle drifts cancel out (a window SUM would certify this as healthy)', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [
          ranTick({ ideasRouted: 3, detail: { cycleId: 'c1' } }), // ledger has 1 → -2
          ranTick({ ideasRouted: 1, detail: { cycleId: 'c2' } }), // ledger has 3 → +2
        ],
        [
          idea({ cycleId: 'c1' }),
          idea({ ideaId: 'i2', cycleId: 'c2' }),
          idea({ ideaId: 'i3', cycleId: 'c2' }),
          idea({ ideaId: 'i4', cycleId: 'c2' }),
        ],
      ),
    );
    expect(bar(r, 'ledger-reconciles').status).toBe('fail');
  });

  it('a TRUNCATED ledger read is UNKNOWN, never fail — it must not manufacture phantom drift', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 3, detail: { cycleId: 'c1' } })], []), {
      ledgerTruncated: true,
    });
    expect(bar(r, 'ledger-reconciles').status).toBe('unknown');
    expect(r.failed).toBe(0);
    expect(r.window.ledgerTruncated).toBe(true);
  });
});

describe('evaluateProgramSuccess — grader suggestion adopted', () => {
  it('PASSES on a graded, attributed idea that was routed onto a rail (the closed loop)', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 1 })],
        [idea({ humanGrade: 4, humanFeedback: 'tighten the scope', gradedBy: 'owner', routedRef: 'wi:WI-1' })],
      ),
    );
    expect(bar(r, 'grader-suggestion-adopted').status).toBe('pass');
  });

  it('FAILS when grades exist but none carry an attributed suggestion that shipped', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [idea({ humanGrade: 2 })]));
    expect(bar(r, 'grader-suggestion-adopted').status).toBe('fail');
  });

  it('is UNKNOWN when nothing is graded yet — the channel has produced no input', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [idea()]));
    expect(bar(r, 'grader-suggestion-adopted').status).toBe('unknown');
  });
});

describe('evaluateProgramSuccess — verdict roll-up', () => {
  it('only a fully-passing gate closes the program', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 1, detail: { cycleId: 'c1', signalScore: 30 } })],
        [
          idea({
            addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'],
            humanGrade: 5,
            humanFeedback: 'ship it',
            gradedBy: 'owner',
          }),
        ],
      ),
    );
    expect(r.verdict).toBe('pass');
    expect(r.passed).toBe(5);
    expect(r.failed + r.unknown).toBe(0);
  });

  it('a single FAIL dominates any number of passes', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 1, detail: { cycleId: 'c1', signalScore: 0 } })], // score-0 fire → fail
        [
          idea({
            addressesPatternRefs: ['rubric:x/y'],
            humanGrade: 5,
            humanFeedback: 'ok',
            gradedBy: 'owner',
          }),
        ],
      ),
    );
    expect(r.verdict).toBe('fail');
    expect(r.failed).toBe(1);
  });

  it('unknowns alone are INCOMPLETE — never a silent pass', () => {
    const r = evaluateProgramSuccess(inputs([], []));
    expect(r.verdict).toBe('incomplete');
    expect(r.failed).toBe(0);
    expect(r.unknown).toBe(5);
  });
});
