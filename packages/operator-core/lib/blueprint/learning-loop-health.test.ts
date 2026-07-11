/**
 * learning-loop-health tests (relight-self-learning-edges-2026-06-14 P-030).
 */
import { describe, it, expect } from 'vitest';
import {
  computeLearningLoopHealth,
  computeActivityLaneHealth,
  summarizeLearningLoopHealth,
  singletonRoutineName,
  type LearningLoopSpec,
  type LearningRoutineRow,
} from './learning-loop-health';

const NOW = Date.parse('2026-06-14T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// calibration = frontier (dark-by-design when inactive); scout = always-on.
const LOOPS: LearningLoopSpec[] = [
  { blueprintId: 'calibration', legacyRoutine: 'calibration-resolve' },
  { blueprintId: 'scout', legacyRoutine: 'scout-cycle' },
];

const sRow = (blueprintId: string, p: Partial<LearningRoutineRow> = {}): LearningRoutineRow => ({
  installSlug: '@singleton',
  name: singletonRoutineName(blueprintId),
  active: true,
  lastFiredAt: daysAgo(0),
  ...p,
});

describe('computeLearningLoopHealth — per-loop routine verdict', () => {
  it('an active loop that fired recently is "firing"', () => {
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [sRow('calibration', { lastFiredAt: daysAgo(0) })], { nowMs: NOW });
    expect(cal.status).toBe('firing');
    expect(cal.active).toBe(true);
    expect(cal.daysSinceFire).toBe(0);
    expect(cal.activityLastAt).toBeNull();
  });

  it('an active loop that has not fired within the stale window is "stale" (a wedge)', () => {
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [sRow('calibration', { lastFiredAt: daysAgo(5) })], {
      nowMs: NOW,
      staleAfterDays: 3,
    });
    expect(cal.status).toBe('stale');
    expect(cal.daysSinceFire).toBe(5);
  });

  it('marks Scout stale when its routine fired but scout_ticks activity is stale', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: daysAgo(0) })],
      {
        nowMs: NOW,
        staleAfterDays: 1,
        activityByBlueprintId: {
          scout: { lastActivityAt: daysAgo(2), source: 'scout_ticks' },
        },
      },
    );

    expect(scout.status).toBe('stale');
    expect(scout.daysSinceFire).toBe(0);
    expect(scout.daysSinceActivity).toBe(2);
    expect(scout.activitySource).toBe('scout_ticks');
  });

  it('marks Scout stale when routine fire is fresh but newer than scout_ticks by the grace window', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: new Date(NOW).toISOString() })],
      {
        nowMs: NOW,
        staleAfterDays: 1,
        activityByBlueprintId: {
          scout: { lastActivityAt: new Date(NOW - 20 * 60_000).toISOString(), source: 'scout_ticks' },
        },
        activityLagGraceMs: 5 * 60_000,
      },
    );

    expect(scout.status).toBe('stale');
    expect(scout.daysSinceFire).toBe(0);
    expect(scout.daysSinceActivity).toBe(0);
  });

  it('keeps Scout firing when routine fire and scout_ticks activity are within the grace window', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: new Date(NOW).toISOString() })],
      {
        nowMs: NOW,
        staleAfterDays: 1,
        activityByBlueprintId: {
          scout: { lastActivityAt: new Date(NOW - 2 * 60_000).toISOString(), source: 'scout_ticks' },
        },
        activityLagGraceMs: 5 * 60_000,
      },
    );

    expect(scout.status).toBe('firing');
  });

  it('keeps Scout firing when its scout_ticks activity is fresh', () => {
    const [scout] = computeLearningLoopHealth(
      [LOOPS[1]],
      [sRow('scout', { lastFiredAt: daysAgo(0) })],
      {
        nowMs: NOW,
        staleAfterDays: 1,
        activityByBlueprintId: {
          scout: { lastActivityAt: daysAgo(0), source: 'scout_ticks' },
        },
      },
    );

    expect(scout.status).toBe('firing');
    expect(scout.daysSinceActivity).toBe(0);
  });

  it('an active loop NEVER fired but with its first fire still ahead is "pending" (just armed, not a wedge)', () => {
    const [cal] = computeLearningLoopHealth(
      [LOOPS[0]],
      [sRow('calibration', { lastFiredAt: null, nextFireAt: daysAgo(-1) })], // next fire 1d in the FUTURE
      { nowMs: NOW },
    );
    expect(cal.status).toBe('pending');
    expect(cal.daysSinceFire).toBeNull();
  });

  it('an active loop NEVER fired whose first fire is already overdue is "stale" (a stuck fire path)', () => {
    const [cal] = computeLearningLoopHealth(
      [LOOPS[0]],
      [sRow('calibration', { lastFiredAt: null, nextFireAt: daysAgo(1) })], // next fire 1d in the PAST
      { nowMs: NOW },
    );
    expect(cal.status).toBe('stale');
  });

  it('an active loop NEVER fired with no next-fire time is "stale" (cannot vouch for it)', () => {
    const [cal] = computeLearningLoopHealth(
      [LOOPS[0]],
      [sRow('calibration', { lastFiredAt: null, nextFireAt: null })],
      { nowMs: NOW },
    );
    expect(cal.status).toBe('stale');
  });

  it('an inactive FRONTIER loop is "dark-by-design"', () => {
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [sRow('calibration', { active: false, lastFiredAt: null })], { nowMs: NOW });
    expect(cal.status).toBe('dark-by-design');
    expect(cal.alwaysOn).toBe(false);
  });

  it('an inactive ALWAYS-ON loop is "should-be-on-but-dark" (a real gap)', () => {
    const [scout] = computeLearningLoopHealth([LOOPS[1]], [sRow('scout', { active: false })], { nowMs: NOW });
    expect(scout.status).toBe('should-be-on-but-dark');
    expect(scout.alwaysOn).toBe(true);
  });

  it('a loop with no routine row at all is "absent"', () => {
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [], { nowMs: NOW });
    expect(cal.status).toBe('absent');
    expect(cal.active).toBe(false);
    expect(cal.daysSinceFire).toBeNull();
  });

  it('matches the legacy per-home row when no @singleton row exists', () => {
    const legacy: LearningRoutineRow = { installSlug: 'acme-home', name: 'calibration-resolve', active: true, lastFiredAt: daysAgo(0) };
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [legacy], { nowMs: NOW, homeSlug: 'acme-home' });
    expect(cal.status).toBe('firing');
    expect(cal.legacyRow).not.toBeNull();
    expect(cal.singletonRow).toBeNull();
  });

  it('flags the @singleton↔legacy double-state as a collision (prefers the @singleton row)', () => {
    const both: LearningRoutineRow[] = [
      sRow('calibration', { active: false }),
      { installSlug: 'acme-home', name: 'calibration-resolve', active: true, lastFiredAt: daysAgo(0) },
    ];
    const [cal] = computeLearningLoopHealth([LOOPS[0]], both, { nowMs: NOW, homeSlug: 'acme-home' });
    expect(cal.collision).toBe(true);
    expect(cal.active).toBe(false); // the @singleton row wins
  });
});

describe('computeActivityLaneHealth — routine-less activity-only lane (su-ideate P-013)', () => {
  const lane = (lastActivityAt: string | null) => ({
    blueprintId: 'su-ideation',
    lastActivityAt,
    source: 'su-ideate-ticks+ungraded-watchdog',
  });

  it('never any activity → dark-by-design (built, not yet turning — no routine to be "absent")', () => {
    const h = computeActivityLaneHealth(lane(null), { nowMs: NOW });
    expect(h.status).toBe('dark-by-design');
    expect(h.active).toBe(false);
    expect(h.singletonRow).toBeNull();
    expect(h.legacyRow).toBeNull();
    expect(h.collision).toBe(false);
    expect(h.alwaysOn).toBe(false);
    expect(h.lastFiredAt).toBeNull();
    expect(h.activityLastAt).toBeNull();
    expect(h.activitySource).toBe('su-ideate-ticks+ungraded-watchdog');
  });

  it('fresh activity within the stale window → firing', () => {
    const h = computeActivityLaneHealth(lane(daysAgo(0)), { nowMs: NOW, staleAfterDays: 3 });
    expect(h.status).toBe('firing');
    expect(h.active).toBe(true);
    expect(h.daysSinceActivity).toBe(0);
  });

  it('activity older than the stale window → stale (the "a dead loop shows" signal)', () => {
    const h = computeActivityLaneHealth(lane(daysAgo(5)), { nowMs: NOW, staleAfterDays: 3 });
    expect(h.status).toBe('stale');
    expect(h.active).toBe(true);
    expect(h.daysSinceActivity).toBe(5);
  });

  it('a stale activity-only lane is surfaced by summarize needs-attention', () => {
    const stale = computeActivityLaneHealth(lane(daysAgo(10)), { nowMs: NOW, staleAfterDays: 3 });
    const s = summarizeLearningLoopHealth([stale]);
    expect(s.total).toBe(1);
    expect(s.stale).toBe(1);
    expect(s.needsAttention).toEqual(['su-ideation']);
  });

  it('a dark-by-design activity-only lane is NOT flagged (silence on a judgment-driven lane is not a wedge)', () => {
    const dark = computeActivityLaneHealth(lane(null), { nowMs: NOW });
    const s = summarizeLearningLoopHealth([dark]);
    expect(s.darkByDesign).toBe(1);
    expect(s.needsAttention).toEqual([]);
  });
});

describe('summarizeLearningLoopHealth — rollup + needs-attention partition', () => {
  it('counts by status and surfaces only the loops that warrant a look', () => {
    const rows = computeLearningLoopHealth(
      LOOPS,
      [
        sRow('calibration', { active: false, lastFiredAt: null }), // dark-by-design (frontier)
        sRow('scout', { active: false }), // should-be-on-but-dark (always-on)
      ],
      { nowMs: NOW },
    );
    const s = summarizeLearningLoopHealth(rows);
    expect(s.total).toBe(2);
    expect(s.darkByDesign).toBe(1);
    expect(s.shouldBeOnButDark).toBe(1);
    expect(s.needsAttention).toEqual(['scout']); // dark-by-design is NOT flagged; the always-on gap IS
  });
});
