/**
 * WI-6554700010048238: the git-sync stall watchdog raises incident severity with stall
 * duration. These cover the pure inputs the watchdog hands to raiseStallIncidentSeverity.
 */
import { describe, expect, it } from 'vitest';
import { gitSyncStallDurationMs, gitSyncStallIncidentKeys } from './git-sync-stall-watchdog';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const H = 3_600_000;

describe('gitSyncStallDurationMs', () => {
  it('uses the frozen-HEAD clock for a commit stall', () => {
    expect(gitSyncStallDurationMs({ commitStale: true, fireStale: false }, { headUnchangedMs: 7 * H, lastFiredMs: NOW, nowMs: NOW }))
      .toBe(7 * H);
  });

  it('uses time since the last fire for a wedged scheduler, and the longer clock when both apply', () => {
    expect(gitSyncStallDurationMs({ commitStale: false, fireStale: true }, { headUnchangedMs: null, lastFiredMs: NOW - 2 * H, nowMs: NOW }))
      .toBe(2 * H);
    expect(gitSyncStallDurationMs({ commitStale: true, fireStale: true }, { headUnchangedMs: H, lastFiredMs: NOW - 3 * H, nowMs: NOW }))
      .toBe(3 * H);
  });

  it('returns null for a fault or reap streak with no clock, so severity is left alone', () => {
    expect(gitSyncStallDurationMs({ commitStale: false, fireStale: false }, { headUnchangedMs: 9 * H, lastFiredMs: NOW - 9 * H, nowMs: NOW }))
      .toBeNull();
    expect(gitSyncStallDurationMs({ commitStale: true, fireStale: false }, { headUnchangedMs: null, lastFiredMs: null, nowMs: NOW }))
      .toBeNull();
  });

  it('never returns a negative duration (a future lastFired from clock skew)', () => {
    expect(gitSyncStallDurationMs({ commitStale: false, fireStale: true }, { headUnchangedMs: null, lastFiredMs: NOW + H, nowMs: NOW }))
      .toBe(0);
  });
});

describe('gitSyncStallIncidentKeys', () => {
  it('covers the watchdog alarm key and the capture default key, deduplicated', () => {
    expect(gitSyncStallIncidentKeys('papercusp')).toEqual(['git-sync-stall:papercusp']);
    expect(gitSyncStallIncidentKeys('papercusp/libs/papercusp')).toEqual([
      'git-sync-stall:papercusp/libs/papercusp',
      'git-sync-stall:papercusp',
    ]);
  });
});
