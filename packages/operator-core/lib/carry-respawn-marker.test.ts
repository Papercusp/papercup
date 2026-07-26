/**
 * carry-respawn-marker.test.ts — the "respawn expected" signal EI-18676518990229124's
 * fix hinges on: session:request-compaction marks an owner right before its
 * SessionEnd fires; report.ts's P-002 branch consumes (check-and-clear) it to
 * decide whether the ending owner's claims should survive the transition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESPAWN_EXPECTED_TTL_MS,
  __resetRespawnExpectedMarkers,
  consumeRespawnExpected,
  markRespawnExpected,
} from './carry-respawn-marker';

beforeEach(() => {
  __resetRespawnExpectedMarkers();
});

describe('carry-respawn-marker', () => {
  it('an unmarked owner is never treated as respawn-expected', () => {
    expect(consumeRespawnExpected('su-never-marked')).toBe(false);
  });

  it('marking then consuming returns true', () => {
    markRespawnExpected('su-a');
    expect(consumeRespawnExpected('su-a')).toBe(true);
  });

  it('consuming is SINGLE-USE — a second check for the same owner is false', () => {
    markRespawnExpected('su-b');
    expect(consumeRespawnExpected('su-b')).toBe(true);
    expect(consumeRespawnExpected('su-b')).toBe(false);
  });

  it('marks are scoped per-owner — marking one owner never affects another', () => {
    markRespawnExpected('su-c');
    expect(consumeRespawnExpected('su-d')).toBe(false);
    expect(consumeRespawnExpected('su-c')).toBe(true);
  });

  it('a mark past its TTL is treated as stale (false) — the P-001 backstop is the correct recovery, not a suppressed release', () => {
    vi.useFakeTimers();
    try {
      markRespawnExpected('su-e', 1000);
      vi.advanceTimersByTime(1001);
      expect(consumeRespawnExpected('su-e')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a mark within TTL survives right up to (not including) expiry', () => {
    vi.useFakeTimers();
    try {
      markRespawnExpected('su-f', 1000);
      vi.advanceTimersByTime(999);
      expect(consumeRespawnExpected('su-f')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the default TTL is 60s', () => {
    expect(RESPAWN_EXPECTED_TTL_MS).toBe(60_000);
  });

  it('re-marking the same owner before it is consumed refreshes the expiry (last mark wins)', () => {
    vi.useFakeTimers();
    try {
      markRespawnExpected('su-g', 1000);
      vi.advanceTimersByTime(500);
      markRespawnExpected('su-g', 1000); // refresh
      vi.advanceTimersByTime(900); // 1400ms since first mark, 900ms since second
      expect(consumeRespawnExpected('su-g')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a blank/empty ownerId is a no-op mark (never consumable)', () => {
    markRespawnExpected('');
    markRespawnExpected('   ');
    expect(consumeRespawnExpected('')).toBe(false);
    expect(consumeRespawnExpected('   ')).toBe(false);
  });
});

afterEach(() => {
  __resetRespawnExpectedMarkers();
});
