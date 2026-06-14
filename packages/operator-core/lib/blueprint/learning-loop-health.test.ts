/**
 * learning-loop-health tests (relight-self-learning-edges-2026-06-14 P-030).
 */
import { describe, it, expect } from 'vitest';
import {
  computeLearningLoopHealth,
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
  });

  it('an active loop that has not fired within the stale window is "stale" (a wedge)', () => {
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [sRow('calibration', { lastFiredAt: daysAgo(5) })], {
      nowMs: NOW,
      staleAfterDays: 3,
    });
    expect(cal.status).toBe('stale');
    expect(cal.daysSinceFire).toBe(5);
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

  it('matches the legacy papercup row when no @singleton row exists', () => {
    const legacy: LearningRoutineRow = { installSlug: 'papercup', name: 'calibration-resolve', active: true, lastFiredAt: daysAgo(0) };
    const [cal] = computeLearningLoopHealth([LOOPS[0]], [legacy], { nowMs: NOW });
    expect(cal.status).toBe('firing');
    expect(cal.legacyRow).not.toBeNull();
    expect(cal.singletonRow).toBeNull();
  });

  it('flags the @singleton↔legacy double-state as a collision (prefers the @singleton row)', () => {
    const both: LearningRoutineRow[] = [
      sRow('calibration', { active: false }),
      { installSlug: 'papercup', name: 'calibration-resolve', active: true, lastFiredAt: daysAgo(0) },
    ];
    const [cal] = computeLearningLoopHealth([LOOPS[0]], both, { nowMs: NOW });
    expect(cal.collision).toBe(true);
    expect(cal.active).toBe(false); // the @singleton row wins
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
