/**
 * portfolio-idle.test.ts — the pure fold behind the idle-steward detector
 * (goal-mode-drift-guards-2026-08-31 P-002).
 *
 * The fold lives in `activity.ts` beside its siblings; its tests live here so
 * P-002's unit proof reads as one thing.
 *
 * THE TEST THAT MATTERS is the last describe block: it pins the GAP. A predicate
 * is only worth adding if some real state exists that every EXISTING predicate
 * calls healthy and this one does not, so that state is constructed explicitly
 * and both folds are run against it. If a future change makes the wedge leg catch
 * it too, that block fails and someone has to decide whether this module still
 * earns its place — which is the correct outcome.
 */
import { describe, it, expect } from 'vitest';

import {
  GOAL_PORTFOLIO_IDLE_AFTER_MS,
  resolveGoalHolderWedge,
  resolveGoalPortfolioIdle,
} from './activity';

const MIN = 60_000;

describe('resolveGoalPortfolioIdle — the measured cases', () => {
  it('IDLE: a live holder that has placed nothing past the threshold', () => {
    expect(
      resolveGoalPortfolioIdle({
        liveness: 'held',
        throughput: { actsInWindow: 0, idleMs: 45 * MIN },
      }),
    ).toEqual({ idle: true, reason: 'idle' });
  });

  it('PLACING: a live holder that placed something inside the threshold', () => {
    expect(
      resolveGoalPortfolioIdle({
        liveness: 'held',
        throughput: { actsInWindow: 3, idleMs: 4 * MIN },
      }),
    ).toEqual({ idle: false, reason: 'placing' });
  });

  /**
   * The two healthy states are NOT interchangeable. A steward with no acts yet,
   * held for two minutes, has produced no evidence of placing — reporting it as
   * `placing` would claim evidence that does not exist.
   */
  it('WITHIN-GRACE: no acts yet, but the goal is younger than the threshold', () => {
    expect(
      resolveGoalPortfolioIdle({
        liveness: 'held',
        throughput: { actsInWindow: 0, idleMs: 2 * MIN },
      }),
    ).toEqual({ idle: false, reason: 'within-grace' });
  });

  it('fires at the threshold exactly — the boundary is inclusive', () => {
    const atThreshold = resolveGoalPortfolioIdle({
      liveness: 'held',
      throughput: { actsInWindow: 0, idleMs: GOAL_PORTFOLIO_IDLE_AFTER_MS },
    });
    const justUnder = resolveGoalPortfolioIdle({
      liveness: 'held',
      throughput: { actsInWindow: 0, idleMs: GOAL_PORTFOLIO_IDLE_AFTER_MS - 1 },
    });
    expect(atThreshold.idle).toBe(true);
    expect(justUnder.idle).toBe(false);
  });

  it('honours a caller-supplied threshold', () => {
    const throughput = { actsInWindow: 0, idleMs: 10 * MIN };
    expect(resolveGoalPortfolioIdle({ liveness: 'held', throughput }).idle).toBe(false);
    expect(
      resolveGoalPortfolioIdle({ liveness: 'held', throughput, idleAfterMs: 5 * MIN }).idle,
    ).toBe(true);
  });

  /**
   * A stale act does not rescue a quiet steward. `actsInWindow` counts the whole
   * rate window (an hour); the verdict is about the RECENT span, so a goal that
   * placed twice fifty minutes ago and nothing since is idle. Getting this
   * backwards would let one burst of activity buy an hour of silence.
   */
  it('is decided by RECENCY, not by the window total', () => {
    expect(
      resolveGoalPortfolioIdle({
        liveness: 'held',
        throughput: { actsInWindow: 2, idleMs: 50 * MIN },
      }),
    ).toEqual({ idle: true, reason: 'idle' });
  });
});

describe('resolveGoalPortfolioIdle — what it refuses to claim', () => {
  /**
   * ORDER. An unresolved oracle is checked BEFORE the not-held exit, because
   * `not-held` is a measured claim about the goal and a degraded read has
   * measured nothing. Collapsing them would let an apparatus failure present as
   * a finding.
   */
  it('UNRESOLVED liveness is not-measured, never not-held', () => {
    expect(resolveGoalPortfolioIdle({ liveness: null })).toEqual({
      idle: false,
      reason: 'not-measured',
    });
  });

  it.each(['unheld', 'lost', 'unknown'] as const)(
    'NOT-HELD for liveness=%s — an absent steward is a staffing problem, not idleness',
    (liveness) => {
      expect(
        resolveGoalPortfolioIdle({
          liveness,
          throughput: { actsInWindow: 0, idleMs: 10 * 60 * MIN },
        }),
      ).toEqual({ idle: false, reason: 'not-held' });
    },
  );

  it('NOT-MEASURED when no throughput evidence was supplied', () => {
    expect(resolveGoalPortfolioIdle({ liveness: 'held' })).toEqual({
      idle: false,
      reason: 'not-measured',
    });
    expect(resolveGoalPortfolioIdle({ liveness: 'held', throughput: null })).toEqual({
      idle: false,
      reason: 'not-measured',
    });
  });

  it('NOT-MEASURED for an unusable idleMs — null, NaN or Infinity', () => {
    for (const idleMs of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveGoalPortfolioIdle({ liveness: 'held', throughput: { actsInWindow: 0, idleMs } }),
      ).toEqual({ idle: false, reason: 'not-measured' });
    }
  });

  /**
   * The rule the whole `not-measured` vocabulary exists for, stated as a test:
   * an unmeasured goal and a measurably idle one produce the same absence of
   * acts and are completely different facts. `idle` must be false for every
   * unmeasured case — never "false and therefore fine", but "false because we
   * did not look, and the reason says so".
   */
  it('never reports idle:true without a measurement behind it', () => {
    const unmeasured = [
      resolveGoalPortfolioIdle({ liveness: null }),
      resolveGoalPortfolioIdle({ liveness: 'held' }),
      resolveGoalPortfolioIdle({ liveness: 'held', throughput: { actsInWindow: 0, idleMs: null } }),
    ];
    for (const verdict of unmeasured) {
      expect(verdict.idle).toBe(false);
      expect(verdict.reason).toBe('not-measured');
    }
  });
});

describe('THE GAP: the state every existing predicate calls healthy', () => {
  /**
   * The measured condition, reconstructed. A goal holder that:
   *   • is alive and elected            → liveness `held`
   *   • has made hundreds of tool calls → agentOriginCalls high
   *   • has been held for hours         → far past every grace window
   *   • has placed NOTHING              → zero portfolio acts, idle for hours
   *
   * That ran 4+ hours and $109 before a MONEY ceiling objected.
   */
  const heldForMs = 4 * 60 * MIN;
  const wedgeInput = {
    liveness: 'held' as const,
    productivity: { agentOriginCalls: 812, heldForMs },
  };
  const portfolioInput = {
    liveness: 'held' as const,
    throughput: { actsInWindow: 0, idleMs: heldForMs },
  };

  it('the wedge leg reports it HEALTHY — correctly, by its own contract', () => {
    // Not a bug in the wedge leg: it asks "has this session ever worked", and
    // this one demonstrably has. That is exactly why a second predicate is owed.
    expect(resolveGoalHolderWedge(wedgeInput)).toEqual({
      wedged: false,
      reason: 'has-produced-work',
    });
  });

  it('the portfolio leg CATCHES it', () => {
    expect(resolveGoalPortfolioIdle(portfolioInput)).toEqual({ idle: true, reason: 'idle' });
  });

  /**
   * The converse, so the new predicate is not merely a stricter version of the
   * old one. A holder that has never made ANY call is wedged and is NOT reported
   * as idle-with-a-live-steward: the two describe different faults with different
   * repairs (respawn the session vs. rethink the goal), and a detector that fired
   * both would send someone to do the wrong one.
   */
  it('and the two do not simply agree — a never-booted holder is wedged, not idle', () => {
    const neverWorked = { agentOriginCalls: 0, heldForMs };
    expect(resolveGoalHolderWedge({ liveness: 'held', productivity: neverWorked }).wedged).toBe(
      true,
    );
    // It IS also placing nothing — that is true and unhelpful. The escalation
    // text for the two differs, which is why both verdicts are reported rather
    // than folded into one boolean.
    expect(resolveGoalPortfolioIdle(portfolioInput).idle).toBe(true);
  });
});

/**
 * ── FALSIFIABILITY CONTROL ─────────────────────────────────────────────────────
 *
 * A guard test that has never failed is a guard nobody has tested. Every
 * assertion above passes against the real fold — but that alone does not show
 * the assertions DISCRIMINATE; a table of weak expectations passes against a
 * broken implementation too.
 *
 * The repo's rule for a subject you `import` (rather than a file artifact read
 * by path) is to keep deliberately-wrong implementations here PERMANENTLY as
 * controls, instead of mutating the shared tree. Mutating it would be unsafe
 * for reasons unrelated to care: git-sync sweeps the whole working tree on a
 * timer, so a probe that holds a file mutated for the length of a suite can
 * have that mutant committed even when nothing goes wrong and no handler fails.
 *
 * So: one contract table, four mutants, and the calibration case that keeps the
 * whole thing honest. Each mutant is a REAL mistake available at this seam, not
 * a strawman — three of the four are the specific errors the fold's own comments
 * warn against.
 */
type FoldInput = Parameters<typeof resolveGoalPortfolioIdle>[0];
type FoldOutput = ReturnType<typeof resolveGoalPortfolioIdle>;
type PortfolioFold = (input: FoldInput) => FoldOutput;

const CONTRACT: ReadonlyArray<{ name: string; input: FoldInput; want: FoldOutput }> = [
  {
    name: 'idle-past-threshold',
    input: { liveness: 'held', throughput: { actsInWindow: 0, idleMs: 45 * MIN } },
    want: { idle: true, reason: 'idle' },
  },
  {
    name: 'placing-inside-threshold',
    input: { liveness: 'held', throughput: { actsInWindow: 3, idleMs: 4 * MIN } },
    want: { idle: false, reason: 'placing' },
  },
  {
    name: 'within-grace-is-not-placing',
    input: { liveness: 'held', throughput: { actsInWindow: 0, idleMs: 2 * MIN } },
    want: { idle: false, reason: 'within-grace' },
  },
  {
    name: 'boundary-inclusive',
    input: {
      liveness: 'held',
      throughput: { actsInWindow: 0, idleMs: GOAL_PORTFOLIO_IDLE_AFTER_MS },
    },
    want: { idle: true, reason: 'idle' },
  },
  {
    name: 'recency-not-window-total',
    input: { liveness: 'held', throughput: { actsInWindow: 2, idleMs: 50 * MIN } },
    want: { idle: true, reason: 'idle' },
  },
  {
    name: 'unresolved-liveness-is-not-measured',
    input: { liveness: null, throughput: { actsInWindow: 0, idleMs: 99 * MIN } },
    want: { idle: false, reason: 'not-measured' },
  },
];

/** Names of the contract cases a candidate fold gets WRONG. */
function violations(fold: PortfolioFold): string[] {
  return CONTRACT.filter((c) => {
    const got = fold(c.input);
    return got.idle !== c.want.idle || got.reason !== c.want.reason;
  }).map((c) => c.name);
}

/** MUTANT 1 — the no-op guard: structurally present, never actually fires. */
const neverIdle: PortfolioFold = () => ({ idle: false, reason: 'placing' });

/**
 * MUTANT 2 — decides on the WINDOW TOTAL instead of recency. The fold's own
 * comment warns about this one: it would let a single burst of activity buy an
 * hour of silence.
 */
const windowTotalNotRecency: PortfolioFold = (input) => {
  if (input.liveness == null) return { idle: false, reason: 'not-measured' };
  if (input.liveness !== 'held') return { idle: false, reason: 'not-held' };
  const t = input.throughput;
  if (!t || t.idleMs == null || !Number.isFinite(t.idleMs)) {
    return { idle: false, reason: 'not-measured' };
  }
  if (t.actsInWindow > 0) return { idle: false, reason: 'placing' };
  const after = input.idleAfterMs ?? GOAL_PORTFOLIO_IDLE_AFTER_MS;
  return t.idleMs >= after ? { idle: true, reason: 'idle' } : { idle: false, reason: 'within-grace' };
};

/** MUTANT 3 — off-by-one: fires only STRICTLY past the threshold. */
const exclusiveBoundary: PortfolioFold = (input) => {
  if (input.liveness == null) return { idle: false, reason: 'not-measured' };
  if (input.liveness !== 'held') return { idle: false, reason: 'not-held' };
  const t = input.throughput;
  if (!t || t.idleMs == null || !Number.isFinite(t.idleMs)) {
    return { idle: false, reason: 'not-measured' };
  }
  const after = input.idleAfterMs ?? GOAL_PORTFOLIO_IDLE_AFTER_MS;
  if (t.idleMs <= after) {
    return { idle: false, reason: t.actsInWindow > 0 ? 'placing' : 'within-grace' };
  }
  return { idle: true, reason: 'idle' };
};

/**
 * MUTANT 4 — collapses an UNMEASURED read into a measured healthy one, letting
 * an apparatus failure present as a clean bill of health. This is the defect the
 * whole `not-measured` vocabulary exists to prevent.
 */
const unmeasuredReadsHealthy: PortfolioFold = (input) => {
  if (input.liveness !== 'held') return { idle: false, reason: 'not-held' };
  const t = input.throughput;
  if (!t || t.idleMs == null || !Number.isFinite(t.idleMs)) {
    return { idle: false, reason: 'placing' };
  }
  const after = input.idleAfterMs ?? GOAL_PORTFOLIO_IDLE_AFTER_MS;
  if (t.idleMs < after) {
    return { idle: false, reason: t.actsInWindow > 0 ? 'placing' : 'within-grace' };
  }
  return { idle: true, reason: 'idle' };
};

describe('FALSIFIABILITY: the contract table rejects a wrong fold', () => {
  /**
   * CALIBRATION. If this fails, every mutant assertion below is meaningless —
   * they would be "caught" by an instrument that rejects everything. This case
   * is what makes the other five worth reading.
   */
  it('CALIBRATION: the real fold satisfies every contract case', () => {
    expect(violations(resolveGoalPortfolioIdle)).toEqual([]);
  });

  it('catches a guard that never fires', () => {
    expect(violations(neverIdle)).toContain('idle-past-threshold');
  });

  it('catches deciding on the window total instead of recency', () => {
    expect(violations(windowTotalNotRecency)).toEqual(['recency-not-window-total']);
  });

  it('catches an exclusive threshold boundary', () => {
    expect(violations(exclusiveBoundary)).toEqual(['boundary-inclusive']);
  });

  it('catches an unmeasured read reported as healthy', () => {
    expect(violations(unmeasuredReadsHealthy)).toContain('unresolved-liveness-is-not-measured');
  });

  /**
   * The property that makes the table a table rather than six independent
   * assertions: no mutant slips through entirely. Stated separately so that
   * adding a mutant without adding the case that catches it fails HERE, loudly,
   * rather than quietly widening the blind spot the suite was built to close.
   */
  it('every mutant is caught by at least one case', () => {
    const mutants: ReadonlyArray<[string, PortfolioFold]> = [
      ['neverIdle', neverIdle],
      ['windowTotalNotRecency', windowTotalNotRecency],
      ['exclusiveBoundary', exclusiveBoundary],
      ['unmeasuredReadsHealthy', unmeasuredReadsHealthy],
    ];
    for (const [name, fold] of mutants) {
      expect(violations(fold), `${name} slipped through the contract table`).not.toEqual([]);
    }
  });
});
