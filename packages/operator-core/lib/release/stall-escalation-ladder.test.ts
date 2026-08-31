/**
 * WI-42116 / D-022. The load-bearing test in this file is `EI-7472 regression guard` — the
 * one-shot this ladder replaces exists BECAUSE a per-tick re-alert once spammed the fleet
 * hourly, so "does it stay quiet between rungs" is the property that must never regress.
 */
import { describe, expect, it } from 'vitest';
import {
  STALL_LADDER_GROWTH,
  decideStallNotification,
  describeLadderPosition,
  highestRungCrossed,
  type StallLadderInput,
  type StallLadderMarks,
} from './stall-escalation-ladder';

/** The shipped defaults: release-checkpoint-config.ts stallReds 3, stallAgeMs 6h. */
const STALL_REDS = 3;
const STALL_AGE_MS = 6 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function input(over: Partial<StallLadderInput> & { marks?: StallLadderMarks }): StallLadderInput {
  return {
    consecutiveReds: 0,
    stallAgeMs: null,
    stallRedsThreshold: STALL_REDS,
    stallAgeThresholdMs: STALL_AGE_MS,
    marks: {},
    ...over,
  };
}

describe('highestRungCrossed', () => {
  it('returns null below the first rung', () => {
    expect(highestRungCrossed(2, 3)).toBeNull();
    expect(highestRungCrossed(0, 3)).toBeNull();
  });

  it('returns the first rung exactly at the threshold', () => {
    expect(highestRungCrossed(3, 3)).toEqual({ rung: 3, index: 0 });
  });

  it('holds the first rung until the second is reached', () => {
    for (const reds of [4, 5, 6, 7, 8]) {
      expect(highestRungCrossed(reds, 3)).toEqual({ rung: 3, index: 0 });
    }
    expect(highestRungCrossed(9, 3)).toEqual({ rung: 9, index: 1 });
  });

  it('grows geometrically, so rung count is logarithmic in depth', () => {
    expect(highestRungCrossed(27, 3)).toEqual({ rung: 27, index: 2 });
    expect(highestRungCrossed(80, 3)).toEqual({ rung: 27, index: 2 });
    expect(highestRungCrossed(81, 3)).toEqual({ rung: 81, index: 3 });
    // A pathological depth must not need a pathological number of rungs.
    const deep = highestRungCrossed(1_000_000, 3);
    expect(deep).not.toBeNull();
    expect(deep!.index).toBeLessThan(20);
  });

  it('goes SILENT on a misconfigured threshold rather than looping or alerting forever', () => {
    expect(highestRungCrossed(50, 0)).toBeNull();
    expect(highestRungCrossed(50, -1)).toBeNull();
    expect(highestRungCrossed(50, Number.NaN)).toBeNull();
    expect(highestRungCrossed(Number.NaN, 3)).toBeNull();
    expect(highestRungCrossed(null, 3)).toBeNull();
    expect(highestRungCrossed(undefined, 3)).toBeNull();
  });
});

describe('decideStallNotification — the count axis', () => {
  it('stays quiet below the first rung', () => {
    const d = decideStallNotification(input({ consecutiveReds: 2 }));
    expect(d.shouldNotify).toBe(false);
    expect(d.reason).toContain('below the first rung');
  });

  it('fires at the first rung and records the mark', () => {
    const d = decideStallNotification(input({ consecutiveReds: 3 }));
    expect(d.shouldNotify).toBe(true);
    expect(d.axis).toBe('count');
    expect(d.rung).toBe(3);
    expect(d.rungIndex).toBe(0);
    expect(d.marks.stallAlertedAtReds).toBe(3);
  });

  /**
   * EI-7472 REGRESSION GUARD. The resolved bug was a dedup flag clobbered every red tick,
   * re-spamming the fleet ~hourly. Between rungs this MUST be silent.
   */
  it('EI-7472 regression guard: stays silent on every tick between rungs', () => {
    const marks: StallLadderMarks = { stallAlertedAtReds: 3 };
    for (const reds of [3, 4, 5, 6, 7, 8]) {
      const d = decideStallNotification(input({ consecutiveReds: reds, marks }));
      expect(d.shouldNotify, `reds=${reds} must not re-alert`).toBe(false);
      expect(d.reason).toContain('EI-7472');
    }
  });

  it('fires again only once the next rung is reached', () => {
    const d = decideStallNotification(input({ consecutiveReds: 9, marks: { stallAlertedAtReds: 3 } }));
    expect(d.shouldNotify).toBe(true);
    expect(d.rung).toBe(9);
    expect(d.rungIndex).toBe(1);
  });

  it('a jump past several rungs alerts ONCE, at the highest crossed rung', () => {
    const d = decideStallNotification(input({ consecutiveReds: 50, marks: { stallAlertedAtReds: 3 } }));
    expect(d.shouldNotify).toBe(true);
    expect(d.rung).toBe(27);
    expect(d.marks.stallAlertedAtReds).toBe(27);
    // and the follow-up tick is quiet
    expect(
      decideStallNotification(input({ consecutiveReds: 50, marks: { stallAlertedAtReds: 27 } })).shouldNotify,
    ).toBe(false);
  });

  it('is idempotent when the returned marks are fed back', () => {
    const first = decideStallNotification(input({ consecutiveReds: 12 }));
    expect(first.shouldNotify).toBe(true);
    const second = decideStallNotification(input({ consecutiveReds: 12, marks: first.marks }));
    expect(second.shouldNotify).toBe(false);
  });

  it('never regresses a mark, even if the red count somehow drops', () => {
    const d = decideStallNotification(input({ consecutiveReds: 4, marks: { stallAlertedAtReds: 27 } }));
    expect(d.shouldNotify).toBe(false);
    expect(d.marks.stallAlertedAtReds).toBe(27);
  });
});

describe('decideStallNotification — back-compat with the legacy one-shot', () => {
  it('does NOT immediately re-alert a stall the old boolean already announced', () => {
    const d = decideStallNotification(input({ consecutiveReds: 5, marks: { stallAlerted: true } }));
    expect(d.shouldNotify).toBe(false);
    expect(d.marks.stallAlertedAtReds).toBe(STALL_REDS);
  });

  it('resumes the ladder at the SECOND rung for a legacy-seeded stall', () => {
    const d = decideStallNotification(input({ consecutiveReds: 9, marks: { stallAlerted: true } }));
    expect(d.shouldNotify).toBe(true);
    expect(d.rung).toBe(9);
  });

  it('treats a legacy-false flag as never-alerted', () => {
    const d = decideStallNotification(input({ consecutiveReds: 3, marks: { stallAlerted: false } }));
    expect(d.shouldNotify).toBe(true);
    expect(d.rung).toBe(3);
  });
});

describe('decideStallNotification — the age axis (the livelocked gate)', () => {
  /**
   * In release-actions.ts, `carryStreak = recordOnly || alreadyCountedPending` holds
   * consecutiveReds FIXED on withheld ticks. A livelocked gate (every red withheld as
   * candidate-fossil) therefore never advances the count axis — which is exactly the gate
   * this ladder exists to catch, so the age axis must carry it.
   */
  it('escalates on age while the red count is frozen', () => {
    const frozenReds = 43;
    const marks: StallLadderMarks = { stallAlertedAtReds: 27, stallAlertedAtAgeMs: 6 * HOUR };
    const d = decideStallNotification(input({ consecutiveReds: frozenReds, stallAgeMs: 20 * HOUR, marks }));
    expect(d.shouldNotify).toBe(true);
    expect(d.axis).toBe('age');
    expect(d.rung).toBe(18 * HOUR);
    expect(d.reason).toContain('livelocked');
  });

  it('stays silent between age rungs', () => {
    const marks: StallLadderMarks = { stallAlertedAtReds: 27, stallAlertedAtAgeMs: 18 * HOUR };
    for (const hrs of [19, 30, 45, 53]) {
      const d = decideStallNotification(input({ consecutiveReds: 43, stallAgeMs: hrs * HOUR, marks }));
      expect(d.shouldNotify, `age=${hrs}h must not re-alert`).toBe(false);
    }
  });

  it('tolerates an unknown stall age', () => {
    const d = decideStallNotification(input({ consecutiveReds: 3, stallAgeMs: null }));
    expect(d.shouldNotify).toBe(true);
    expect(d.axis).toBe('count');
    expect(d.marks.stallAlertedAtAgeMs).toBeNull();
  });

  it('when both axes cross on the same tick, count is attributed but BOTH marks advance', () => {
    const d = decideStallNotification(input({ consecutiveReds: 9, stallAgeMs: 20 * HOUR }));
    expect(d.shouldNotify).toBe(true);
    expect(d.axis).toBe('count');
    expect(d.marks.stallAlertedAtReds).toBe(9);
    expect(d.marks.stallAlertedAtAgeMs).toBe(18 * HOUR);
    // the age axis must not fire a redundant alert on the next tick
    expect(
      decideStallNotification(input({ consecutiveReds: 9, stallAgeMs: 20 * HOUR, marks: d.marks })).shouldNotify,
    ).toBe(false);
  });
});

describe('decideStallNotification — the fixer-succession axis', () => {
  const FIXER_GAP_MS = 15 * 60_000;

  it('fires when an awaiting-fixer ownership gap reaches its first threshold', () => {
    const d = decideStallNotification(
      input({
        fixerSuccessionAgeMs: FIXER_GAP_MS,
        fixerSuccessionThresholdMs: FIXER_GAP_MS,
      }),
    );
    expect(d.shouldNotify).toBe(true);
    expect(d.axis).toBe('fixer');
    expect(d.rung).toBe(FIXER_GAP_MS);
    expect(d.marks.stallAlertedAtFixerAgeMs).toBe(FIXER_GAP_MS);
    expect(d.reason).toContain('awaiting-fixer');
  });

  it('is independent of the legacy stall one-shot — a later fixer death is still new', () => {
    const d = decideStallNotification(
      input({
        consecutiveReds: STALL_REDS,
        fixerSuccessionAgeMs: FIXER_GAP_MS,
        fixerSuccessionThresholdMs: FIXER_GAP_MS,
        marks: { stallAlerted: true },
      }),
    );
    expect(d.shouldNotify).toBe(true);
    expect(d.axis).toBe('fixer');
    // The old boolean seeds only the two axes it historically represented.
    expect(d.marks.stallAlertedAtFixerAgeMs).toBe(FIXER_GAP_MS);
  });

  it('holds between fixer rungs and re-alerts only at the next geometric rung', () => {
    const marks: StallLadderMarks = { stallAlertedAtFixerAgeMs: FIXER_GAP_MS };
    for (const age of [FIXER_GAP_MS, FIXER_GAP_MS * 2, FIXER_GAP_MS * 3 - 1]) {
      expect(
        decideStallNotification(input({ fixerSuccessionAgeMs: age, fixerSuccessionThresholdMs: FIXER_GAP_MS, marks }))
          .shouldNotify,
      ).toBe(false);
    }
    const next = decideStallNotification(
      input({
        fixerSuccessionAgeMs: FIXER_GAP_MS * STALL_LADDER_GROWTH,
        fixerSuccessionThresholdMs: FIXER_GAP_MS,
        marks,
      }),
    );
    expect(next.shouldNotify).toBe(true);
    expect(next.axis).toBe('fixer');
    expect(next.rungIndex).toBe(1);
  });

  it('wins attribution when several axes cross together, while all marks advance', () => {
    const d = decideStallNotification(
      input({
        consecutiveReds: STALL_REDS,
        stallAgeMs: STALL_AGE_MS,
        fixerSuccessionAgeMs: FIXER_GAP_MS,
        fixerSuccessionThresholdMs: FIXER_GAP_MS,
      }),
    );
    expect(d.axis).toBe('fixer');
    expect(d.marks).toMatchObject({
      stallAlertedAtReds: STALL_REDS,
      stallAlertedAtAgeMs: STALL_AGE_MS,
      stallAlertedAtFixerAgeMs: FIXER_GAP_MS,
    });
  });

  it('starts a fresh first rung when the fixer-attempt identity changes', () => {
    const first = decideStallNotification(
      input({
        fixerSuccessionAgeMs: FIXER_GAP_MS,
        fixerSuccessionThresholdMs: FIXER_GAP_MS,
        fixerSuccessionKey: 'attempt-1',
      }),
    );
    expect(first.marks.stallFixerSuccessionKey).toBe('attempt-1');
    const successor = decideStallNotification(
      input({
        fixerSuccessionAgeMs: FIXER_GAP_MS,
        fixerSuccessionThresholdMs: FIXER_GAP_MS,
        fixerSuccessionKey: 'attempt-2',
        marks: first.marks,
      }),
    );
    expect(successor.shouldNotify).toBe(true);
    expect(successor.axis).toBe('fixer');
    expect(successor.rungIndex).toBe(0);
    expect(successor.marks.stallFixerSuccessionKey).toBe('attempt-2');
  });

  it('describes the fixer-succession rung independently of the gate age', () => {
    const s = describeLadderPosition(
      input({
        fixerSuccessionAgeMs: FIXER_GAP_MS,
        fixerSuccessionThresholdMs: FIXER_GAP_MS,
      }),
    );
    expect(s).toContain('fixer-succession axis');
    expect(s).toContain('15m');
  });
});

describe('the sparsity property — the whole point of the ladder', () => {
  /**
   * Replays the MEASURED papercusp stall: hourly ticks, red count and age both advancing,
   * out to the observed 122.9 h / 43 reds and well beyond. The shipped one-shot produced 1
   * alert; a per-tick repeat (EI-7472) would produce one per tick. This must land between:
   * enough to be noticed, few enough not to be spam.
   */
  it('produces a handful of alerts across a 120-tick stall, not one per tick', () => {
    let marks: StallLadderMarks = {};
    let alerts = 0;
    const axes: string[] = [];

    for (let tick = 1; tick <= 120; tick += 1) {
      const d = decideStallNotification(input({ consecutiveReds: tick, stallAgeMs: tick * HOUR, marks }));
      if (d.shouldNotify) {
        alerts += 1;
        axes.push(`${d.axis}@${d.rung}`);
      }
      marks = d.marks;
    }

    expect(alerts).toBeGreaterThan(1); // strictly better than today's one-shot
    expect(alerts).toBeLessThanOrEqual(8); // and nowhere near the 120 of a per-tick repeat
    expect(axes.length).toBe(alerts);
  });

  it('alert count grows logarithmically, not linearly, with stall depth', () => {
    const alertsFor = (ticks: number): number => {
      let marks: StallLadderMarks = {};
      let alerts = 0;
      for (let tick = 1; tick <= ticks; tick += 1) {
        const d = decideStallNotification(input({ consecutiveReds: tick, stallAgeMs: tick * HOUR, marks }));
        if (d.shouldNotify) alerts += 1;
        marks = d.marks;
      }
      return alerts;
    };

    const short = alertsFor(120);
    const long = alertsFor(120 * STALL_LADDER_GROWTH * STALL_LADDER_GROWTH);
    // 9x the depth must cost at most a small constant more alerts, never 9x.
    expect(long - short).toBeLessThanOrEqual(4);
  });
});

/**
 * FALSIFIABILITY CONTROL. A guard that has never failed is a guard nobody has tested, and
 * the sparsity property above would pass just as happily against a broken subject if the
 * assertions were vacuous. Mutating the tracked source to prove otherwise is unsafe here
 * (git-sync sweeps the whole tree on a schedule and can commit the mutant), so the repo's
 * prescribed tier for an IMPORTED module applies: keep a deliberately-wrong implementation
 * permanently beside the real one, plus a calibration case the REAL subject must pass.
 *
 * `naiveReAlertWhileRed` is the EI-7472 behaviour: re-alert on every tick while still red.
 */
function naiveReAlertWhileRed(reds: number, stallReds: number): boolean {
  return reds >= stallReds;
}

describe('falsifiability control — the sparsity assertions can actually fail', () => {
  const replay = (decide: (tick: number, marks: StallLadderMarks) => { notify: boolean; marks: StallLadderMarks }) => {
    let marks: StallLadderMarks = {};
    let alerts = 0;
    for (let tick = 1; tick <= 120; tick += 1) {
      const r = decide(tick, marks);
      if (r.notify) alerts += 1;
      marks = r.marks;
    }
    return alerts;
  };

  it('the WRONG implementation is CAUGHT by the sparsity bound', () => {
    const naiveAlerts = replay((tick, marks) => ({
      notify: naiveReAlertWhileRed(tick, STALL_REDS),
      marks,
    }));
    // 120 ticks, red from tick 3 onward → 118 alerts. This is the bug, reproduced.
    expect(naiveAlerts).toBe(118);
    // and it would fail the very bound the real subject is held to
    expect(naiveAlerts).toBeGreaterThan(8);
  });

  it('CALIBRATION: the real subject passes the same bound the wrong one fails', () => {
    const realAlerts = replay((tick, marks) => {
      const d = decideStallNotification(input({ consecutiveReds: tick, stallAgeMs: tick * HOUR, marks }));
      return { notify: d.shouldNotify, marks: d.marks };
    });
    expect(realAlerts).toBeLessThanOrEqual(8);
    expect(realAlerts).toBeGreaterThan(1);
  });
});

describe('describeLadderPosition', () => {
  it('names the escalation number and the next rung', () => {
    expect(describeLadderPosition(input({ consecutiveReds: 12 }))).toContain('escalation 2');
    expect(describeLadderPosition(input({ consecutiveReds: 12 }))).toContain('next at 27');
  });

  it('says so plainly when below the first rung', () => {
    expect(describeLadderPosition(input({ consecutiveReds: 1 }))).toContain('below the first');
  });

  it('mentions the age axis once it is past a rung', () => {
    const s = describeLadderPosition(input({ consecutiveReds: 43, stallAgeMs: 122 * HOUR }));
    expect(s).toContain('54h');
  });
});
