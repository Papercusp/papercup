/**
 * Unit tests for the auto-revert tripwire pure core (B-16 / P-080, P-081).
 */
import { describe, it, expect } from 'vitest';
import type { AutonomyDecision } from '../decider';
import {
  armTripwire,
  evaluateTripwire,
  demoteGraduatedLevel,
  findingClassForDecision,
  signalMatchesRow,
  type ArmedTripwire,
  type TripwireWatchSignal,
} from './core';

const HOUR = 3_600_000;

function decision(over: Partial<AutonomyDecision> = {}): AutonomyDecision {
  return {
    posture: 'auto',
    category: 'implementation',
    action: 'work_items:create',
    riskTier: 'low',
    authority: 'system',
    reversibility: 'reversible',
    effectiveCeiling: 'low',
    protected: false,
    armed: true,
    wouldAutoIfArmed: true,
    ownerFullAutonomy: false,
    reasons: [],
    ...over,
  };
}

const handle = { kind: 'config-edit', sha: 'abc123' };

describe('armTripwire', () => {
  it('arms an auto + reversible + non-protected decision with a window', () => {
    const res = armTripwire({ decision: decision(), revertHandle: handle, windowHours: 24, nowMs: 1000 });
    expect('armed' in res).toBe(true);
    if (!('armed' in res)) return;
    expect(res.armed.category).toBe('implementation');
    expect(res.armed.findingClass).toBe('work_items:create');
    expect(res.armed.revertHandle).toEqual(handle);
    expect(res.armed.armedAtMs).toBe(1000);
    expect(res.armed.windowUntilMs).toBe(1000 + 24 * HOUR);
  });

  it('refuses a gated decision (nothing was auto-taken)', () => {
    const res = armTripwire({ decision: decision({ posture: 'gated' }), revertHandle: handle, windowHours: 24, nowMs: 0 });
    expect('refused' in res).toBe(true);
  });

  it('refuses an irreversible action (cannot arm a revert)', () => {
    const res = armTripwire({ decision: decision({ reversibility: 'irreversible' }), revertHandle: handle, windowHours: 24, nowMs: 0 });
    expect('refused' in res).toBe(true);
  });

  it('refuses an unmapped (null) category', () => {
    const res = armTripwire({ decision: decision({ category: null }), revertHandle: handle, windowHours: 24, nowMs: 0 });
    expect('refused' in res).toBe(true);
  });

  it('refuses a protected category (belt-and-braces — must never have auto-decided)', () => {
    const res = armTripwire({ decision: decision({ category: 'release-deploy' }), revertHandle: handle, windowHours: 24, nowMs: 0 });
    expect('refused' in res).toBe(true);
  });

  it('defaults the window when windowHours <= 0, and findingClass override wins', () => {
    const res = armTripwire({ decision: decision(), revertHandle: handle, findingClass: 'narrow-class', windowHours: 0, nowMs: 0 });
    if (!('armed' in res)) throw new Error('expected armed');
    expect(res.armed.findingClass).toBe('narrow-class');
    expect(res.armed.windowUntilMs).toBeGreaterThan(0);
  });

  it('findingClassForDecision falls back to the action then unclassified', () => {
    expect(findingClassForDecision(decision({ action: 'x:y' }))).toBe('x:y');
    expect(findingClassForDecision(decision({ action: undefined }))).toBe('unclassified');
    expect(findingClassForDecision(decision(), 'override')).toBe('override');
  });
});

const armedRow: ArmedTripwire = {
  id: 'tw-1',
  category: 'implementation',
  findingClass: 'work_items:create',
  armedAtMs: 1000,
  windowUntilMs: 1000 + 24 * HOUR,
  status: 'armed',
};

describe('evaluateTripwire', () => {
  it('stays armed when the window is open and no signal landed', () => {
    expect(evaluateTripwire(armedRow, [], 1000 + HOUR)).toEqual({ outcome: 'still-armed' });
  });

  it('clears when the window has closed with no matching signal', () => {
    expect(evaluateTripwire(armedRow, [], 1000 + 25 * HOUR)).toEqual({ outcome: 'cleared' });
  });

  it('trips on a global signal inside the window (earliest wins)', () => {
    const signals: TripwireWatchSignal[] = [
      { kind: 'gym-regression', atMs: 1000 + 5 * HOUR, label: 'late', global: true },
      { kind: 'ekg-drift', atMs: 1000 + 2 * HOUR, label: 'early', global: true },
    ];
    const v = evaluateTripwire(armedRow, signals, 1000 + 25 * HOUR);
    expect(v.outcome).toBe('tripped');
    if (v.outcome === 'tripped') expect(v.reason).toBe('ekg-drift'); // earliest
  });

  it('ignores a signal outside the window', () => {
    const signals: TripwireWatchSignal[] = [{ kind: 'gym-regression', atMs: 1000 + 48 * HOUR, label: 'after', global: true }];
    // now is past window-end → cleared (the late signal is outside [armed, windowUntil])
    expect(evaluateTripwire(armedRow, signals, 1000 + 49 * HOUR)).toEqual({ outcome: 'cleared' });
  });

  it('ignores a signal that does not match scope', () => {
    const signals: TripwireWatchSignal[] = [
      { kind: 'validator-bounce', atMs: 1000 + 2 * HOUR, label: 'other cat', category: 'review-merge' },
    ];
    expect(evaluateTripwire(armedRow, signals, 1000 + 25 * HOUR)).toEqual({ outcome: 'cleared' });
  });

  it('trips on a category-scoped, findingClass-scoped, and id-scoped signal', () => {
    const inWindow = 1000 + 2 * HOUR;
    const cat: TripwireWatchSignal = { kind: 'validator-bounce', atMs: inWindow, label: 'c', category: 'implementation' };
    const cls: TripwireWatchSignal = { kind: 'validator-bounce', atMs: inWindow, label: 'f', findingClass: 'work_items:create' };
    const id: TripwireWatchSignal = { kind: 'owner-thumbs-down', atMs: inWindow, label: 'i', tripwireId: 'tw-1' };
    for (const s of [cat, cls, id]) {
      expect(evaluateTripwire(armedRow, [s], 1000 + 25 * HOUR).outcome).toBe('tripped');
    }
  });

  it('is a no-op (still-armed sentinel) for a non-armed row', () => {
    expect(evaluateTripwire({ ...armedRow, status: 'cleared' }, [], 1e15)).toEqual({ outcome: 'still-armed' });
  });
});

describe('signalMatchesRow', () => {
  it('an id-scoped signal matches only its row', () => {
    expect(signalMatchesRow({ kind: 'owner-thumbs-down', atMs: 0, label: '', tripwireId: 'tw-1' }, armedRow)).toBe(true);
    expect(signalMatchesRow({ kind: 'owner-thumbs-down', atMs: 0, label: '', tripwireId: 'tw-2' }, armedRow)).toBe(false);
  });
});

describe('demoteGraduatedLevel', () => {
  it('lowers one rank, flooring at never-auto', () => {
    expect(demoteGraduatedLevel('critical')).toBe('high');
    expect(demoteGraduatedLevel('low')).toBe('trivial');
    expect(demoteGraduatedLevel('trivial')).toBe('never-auto');
    expect(demoteGraduatedLevel('never-auto')).toBe('never-auto');
  });
});
