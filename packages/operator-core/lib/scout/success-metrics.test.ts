/**
 * success-metrics.test.ts — the P-015 program done-check.
 *
 * The point of these tests is DISCRIMINATION, not coverage: every bar is exercised in all
 * three states (pass / fail / unknown) on hand-built ledger snapshots, because a gate that
 * cannot be shown to fail on bad data is not a gate — it is a green light with extra steps
 * (agent-insights/prove-it-discriminates-before-it-acts).
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateProgramSuccess,
  CYCLE_ERROR_WINDOW_MS,
  LEDGER_RECONCILE_EPOCH_MS,
  LENS_DIVERSITY_SAMPLE,
  programSuccessReadScopes,
  SCOUT_TICK_INSTALL_SLUG,
  type ProgramSuccessReport,
  type ProgramSuccessInputs,
} from './success-metrics';
import type { ScoutQualityInputs } from './quality-metrics';
import { isCapacityError } from './scheduler';
import { hasForcedDiversity } from './invariants';
import type { ScoutTickRecord } from './tick-ledger';
import type { RoutedIdeaProvenance, LensOutcomeReport } from './outcome-feedback';
import { SU_IDEATION_LENSES, type SuIdeationLens, type CreativeLens } from './types';

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

/**
 * The two-partition shape: cadence bars read the SCOUT tick partition, idea bars read every
 * routed idea. The fixtures pass the same ideas as both the cadence partition's ledger (so
 * the per-cycle reconcile join has rows) and the union — which is what production does for
 * a scout-origin idea.
 */
const inputs = (ticks: ScoutTickRecord[], routedIdeas: RoutedIdeaProvenance[]): ProgramSuccessInputs => ({
  cadence: { ticks, routedIdeas, lensOutcomes: emptyOutcomes() } as unknown as ScoutQualityInputs<CreativeLens>,
  ideas: routedIdeas,
});

const bar = (r: ProgramSuccessReport, key: string) => r.criteria.find((c) => c.key === key)!;

describe('evaluateProgramSuccess — rubric-grounded ideas', () => {
  it('PASSES when a routed idea is grounded in the rubric lane', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 1 })],
        [idea({ addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'] })],
      ),
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

  it('counts the live EI-11417 downstream-wait timeout as a genuine error', () => {
    const ticks: ScoutTickRecord[] = [
      ...[...Array(12)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      {
        status: 'error',
        detail: {
          cycleId: 'scout-1783958405158',
          error:
            'Scout ideator analogical did not receive an upstream response before the cycle deadline (left the local governor but remained queued/stalled downstream; not generation)',
        },
      },
    ];
    const r = evaluateProgramSuccess(inputs(ticks, []));
    expect(bar(r, 'cycle-error-rate').status).toBe('fail');
    expect(bar(r, 'cycle-error-rate').observed).toContain('1 error ticks / 13 total');
  });
});

describe('programSuccessReadScopes — release window and singleton host', () => {
  it('reads Scout ticks and routed ideas from @singleton while keeping su-ideate harness-scoped', () => {
    const nowMs = Date.parse('2026-07-13T16:30:00Z');
    const scopes = programSuccessReadScopes({ harnessSlug: 'papercusp', nowMs });
    expect(scopes.cadence.harnessSlug).toBe(SCOUT_TICK_INSTALL_SLUG);
    expect(scopes.cadence.tickInstallSlug).toBe(SCOUT_TICK_INSTALL_SLUG);
    expect(scopes.cadence.tickSinceMs).toBe(nowMs - CYCLE_ERROR_WINDOW_MS);
    expect(scopes.cadence.tickLimit).toBeUndefined();
    // su-ideate is a per-harness partition; it must not inherit the singleton tick host.
    expect(scopes.suIdeate.harnessSlug).toBe('papercusp');
    expect(scopes.suIdeate.tickInstallSlug).toBeUndefined();
  });

  it('still scopes the cadence ledger to @singleton when no member harness is supplied', () => {
    const scopes = programSuccessReadScopes({ nowMs: Date.parse('2026-07-13T16:30:00Z') });
    expect(scopes.cadence.harnessSlug).toBe(SCOUT_TICK_INSTALL_SLUG);
    expect(scopes.suIdeate.harnessSlug).toBeUndefined();
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

  it('EXCLUDES pre-fix cycles — their rows were destroyed by the pre-P-003 overwrite bug, so judging them would red-pin the bar on unrepairable history forever', () => {
    const preFix = `scout-${LEDGER_RECONCILE_EPOCH_MS - 60_000}`;
    const postFix = `scout-${LEDGER_RECONCILE_EPOCH_MS + 60_000}`;
    const r = evaluateProgramSuccess(
      inputs(
        [
          ranTick({ ideasRouted: 3, detail: { cycleId: preFix } }), // destroyed history — must NOT count
          ranTick({ ideasRouted: 1, detail: { cycleId: postFix } }), // the fix governs this one
        ],
        [idea({ cycleId: postFix })],
      ),
    );
    expect(bar(r, 'ledger-reconciles').status).toBe('pass');
    expect(bar(r, 'ledger-reconciles').observed).toContain('1 pre-fix cycle(s) excluded');
  });

  it('still FAILS on post-fix drift — the epoch floor excuses history, never a live regression', () => {
    const postFix = `scout-${LEDGER_RECONCILE_EPOCH_MS + 60_000}`;
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 3, detail: { cycleId: postFix } })], []));
    expect(bar(r, 'ledger-reconciles').status).toBe('fail');
  });

  it('reconcileEpochMs:0 re-opens all of history — the escape hatch for measuring the pre-fix damage', () => {
    const preFix = `scout-${LEDGER_RECONCILE_EPOCH_MS - 60_000}`;
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 3, detail: { cycleId: preFix } })], []), {
      reconcileEpochMs: 0,
    });
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

describe('evaluateProgramSuccess — grader feedback revised', () => {
  const gradedAt = '2026-07-13T12:00:00.000Z';

  it('PASSES with an attributed typed revision created after the grade, including a successor session', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 1 })],
        [
          idea({
            humanGrade: 3,
            humanFeedback: 'tighten the scope',
            gradedBy: 'owner',
            gradedAt,
            createdBy: 'su-originator',
            feedbackRevisions: [
              { revisionRef: 'EI-2', createdBy: 'su-successor', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
          }),
        ],
      ),
    );
    const b = bar(r, 'grader-feedback-revised');
    expect(b.status).toBe('pass');
    expect(b.observed).toContain('1 routed idea(s) have a causally valid typed feedback revision');
  });

  it('FAILS closed on no edge, a pre-grade edge, and an unattributed edge', () => {
    const base = {
      humanGrade: 2,
      humanFeedback: 'revise it',
      gradedBy: 'owner' as const,
      gradedAt,
      createdBy: 'su-originator',
    };
    const cases: RoutedIdeaProvenance[] = [
      idea(base),
      idea({
        ...base,
        ideaId: 'i2',
        feedbackRevisions: [{ revisionRef: 'EI-2', createdBy: 'su-originator', revisedAt: '2026-07-13T11:59:00.000Z' }],
      }),
      idea({
        ...base,
        ideaId: 'i3',
        feedbackRevisions: [{ revisionRef: 'EI-3', revisedAt: '2026-07-13T12:01:00.000Z' }],
      }),
    ];
    for (const candidate of cases) {
      const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [candidate]));
      expect(bar(r, 'grader-feedback-revised').status).toBe('fail');
    }
  });

  it('is UNKNOWN when nothing is graded yet — the channel has produced no input', () => {
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [idea()]));
    expect(bar(r, 'grader-feedback-revised').status).toBe('unknown');
  });
});

describe('evaluateProgramSuccess — lens diversity (D-004, WI-4482)', () => {
  const scoutIdea = (lens: string, n: number): RoutedIdeaProvenance =>
    idea({ ideaId: `i-${lens}-${n}`, lens: lens as unknown as RoutedIdeaProvenance['lens'] });

  it('PASSES when the roster spans >=2 lenses', () => {
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 4 })],
        [
          scoutIdea('analogical', 1),
          scoutIdea('reframing', 2),
          scoutIdea('first-principles', 3),
          scoutIdea('constraint-removal', 4),
        ],
      ),
    );
    const b = bar(r, 'lens-diversity');
    expect(b.status).toBe('pass');
    expect(b.observed).toContain('4 distinct lenses');
  });

  it('FAILS when the roster has collapsed to a single lens — the live WI-4482 regression', () => {
    // maxIdeators:1 ⇒ rosterForBudget slices to the FIRST lens ⇒ every idea is analogical.
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 5 })],
        [1, 2, 3, 4, 5].map((n) => scoutIdea('analogical', n)),
      ),
    );
    const b = bar(r, 'lens-diversity');
    expect(b.status).toBe('fail');
    expect(b.observed).toContain('ROSTER COLLAPSED');
    expect(b.observed).toContain('maxIdeators');
  });

  it('a single idea is UNKNOWN, never a PASS — hasForcedDiversity() alone would false-pass here', () => {
    // The D-004 invariant returns true for <=1 idea ("a single idea cannot collapse"), which is
    // right as an invariant and WRONG as a health bar: it would green precisely when a roster
    // is so broken it emits one idea. The bar must refuse to certify on an empty denominator.
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [scoutIdea('analogical', 1)]));
    expect(bar(r, 'lens-diversity').status).toBe('unknown');
    // ...and prove the underlying invariant really would have said "fine" — i.e. this guard is
    // load-bearing, not decorative.
    expect(hasForcedDiversity([{ lens: 'analogical' as CreativeLens }], 2)).toBe(true);
  });

  it('is UNKNOWN on an empty scout partition', () => {
    expect(bar(evaluateProgramSuccess(inputs([], [])), 'lens-diversity').status).toBe('unknown');
  });

  it('judges the NEWEST sample only — stale multi-lens history must not mask a collapsed roster', () => {
    // The live trap: the ledger still holds 4-lens rows from 2026-06-11, but the roster
    // collapsed on 06-25. A lifetime distinct(lens) count reports 4 and PASSES a broken bar.
    // readRoutedIdeas returns newest-first, so the recent sample must dominate.
    const recentCollapsed = Array.from({ length: LENS_DIVERSITY_SAMPLE }, (_, n) => scoutIdea('analogical', n));
    const staleDiverse = [scoutIdea('reframing', 100), scoutIdea('first-principles', 101)];
    const r = evaluateProgramSuccess(inputs([ranTick({ ideasRouted: 1 })], [...recentCollapsed, ...staleDiverse]));
    expect(bar(r, 'lens-diversity').status).toBe('fail');
  });
});

describe('evaluateProgramSuccess — verdict roll-up', () => {
  it('only a fully-passing gate closes the program', () => {
    // Two ideas spanning two lenses: a fully-green gate must ALSO satisfy the D-004
    // lens-diversity bar (WI-4482), which a single-lens fixture cannot.
    const r = evaluateProgramSuccess(
      inputs(
        [ranTick({ ideasRouted: 2, detail: { cycleId: 'c1', signalScore: 30 } })],
        [
          idea({
            ideaId: 'i-analogical',
            lens: 'analogical' as unknown as RoutedIdeaProvenance['lens'],
            addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'],
            humanGrade: 5,
            humanFeedback: 'ship it',
            gradedBy: 'owner',
            gradedAt: '2026-07-13T12:00:00.000Z',
            createdBy: 'su-green',
            feedbackRevisions: [
              { revisionRef: 'EI-green-2', createdBy: 'su-green', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
          }),
          idea({
            ideaId: 'i-reframing',
            lens: 'reframing' as unknown as RoutedIdeaProvenance['lens'],
            addressesPatternRefs: ['rubric:su-agent-behavior/tool-discipline'],
            humanGrade: 4,
            humanFeedback: 'also good',
            gradedBy: 'owner',
            gradedAt: '2026-07-13T12:00:00.000Z',
            createdBy: 'su-green-2',
            feedbackRevisions: [
              { revisionRef: 'EI-green-3', createdBy: 'su-green-2', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
          }),
        ],
      ),
    );
    expect(r.verdict).toBe('pass');
    expect(r.passed).toBe(6);
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
            gradedAt: '2026-07-13T12:00:00.000Z',
            createdBy: 'su-green',
            feedbackRevisions: [
              { revisionRef: 'EI-green-2', createdBy: 'su-green', revisedAt: '2026-07-13T12:01:00.000Z' },
            ],
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
    // Every bar (incl. lens-diversity) is unknown on an empty window — nothing certifies.
    expect(r.unknown).toBe(6);
  });
});

describe('isCapacityError — the no-capacity classifier (scheduler)', () => {
  it('classifies typed admission denials as capacity, not failure', () => {
    expect(isCapacityError({ admissionDenial: { reason: 'all-accounts-paused' } })).toBe(true);
    expect(isCapacityError({ admissionDenial: { reason: 'provider-429' } })).toBe(true);
    expect(isCapacityError({ admissionDenial: { reason: 'no-free-slot', freeSlots: 0 } })).toBe(false);
    // Provider prose alone is intentionally not authoritative.
    expect(isCapacityError('rate-limit pause exceeds maxWait')).toBe(false);
  });

  it('does NOT swallow genuine failures — the whole point of keeping it narrow', () => {
    // A timeout is PLAUSIBLY capacity-induced, but that link is unproven: mis-filing a real
    // hang as "pool busy" would hide a defect, which is this classification's own failure mode.
    expect(isCapacityError('Scout ideator analogical timed out after 180000ms')).toBe(false);
    expect(isCapacityError('Scout cycle timed out after 600000ms during phase critique')).toBe(false);
    expect(isCapacityError('401 unauthorized: token expired')).toBe(false);
    expect(isCapacityError('ECONNREFUSED 127.0.0.1:8788')).toBe(false);
    expect(isCapacityError('TypeError: cannot read property of undefined')).toBe(false);
  });

  it('a starved-but-healthy loop reads as PASS on the error bar, with the pressure still visible', () => {
    const ticks: ScoutTickRecord[] = [
      ...[...Array(10)].map((_, i) => ranTick({ detail: { cycleId: `c${i}` } })),
      ...[...Array(9)].map((): ScoutTickRecord => ({ status: 'gated', gate: 'no-capacity' })),
    ];
    const r = evaluateProgramSuccess(inputs(ticks, []));
    const errBar = bar(r, 'cycle-error-rate');
    // Pre-fix these 9 were status:'error' => 9/19 = 47% => FAIL. They are a starved pool, not breakage.
    expect(errBar.status).toBe('pass');
    // ...but the starvation must NOT vanish — it is reported, and actionable.
    expect(errBar.observed).toContain('9 cycle(s) withheld by the no-capacity gate');
  });
});
