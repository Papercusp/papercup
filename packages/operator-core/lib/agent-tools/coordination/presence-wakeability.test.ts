/**
 * presence-wakeability.test.ts — the pure derivation guard for the P-001
 * coordinator wakeability signals (fleet-dispatch-wake-clarity-2026-06-22).
 *
 * The IO seam (fetchWakeability) is covered by presence.integration.test.ts; here
 * we pin the keep/cut boundary of deriveSessionState — the table that decides
 * whether a coordinator sees an agent as live | parked | ended.
 */
import { describe, it, expect } from 'vitest';
import { deriveSessionState } from './presence-wakeability';

describe('deriveSessionState', () => {
  it('not wakeable → ended (no live await; a wake reaches nobody — relaunch only)', () => {
    // Even with a fresh heartbeat + a running turn, no await ⇒ a wake can't land.
    expect(deriveSessionState({ stale: false, wakeable: false, liveTurn: true })).toBe('ended');
    expect(deriveSessionState({ stale: true, wakeable: false, liveTurn: false })).toBe('ended');
  });

  it('wakeable + a running turn (fresh heartbeat) → live', () => {
    expect(deriveSessionState({ stale: false, wakeable: true, liveTurn: true })).toBe('live');
  });

  it('wakeable but no running turn → parked (the ideal dispatch target)', () => {
    // Just-ended-but-still-warm: fresh heartbeat, but the last marker was the
    // session-end (liveTurn=false) — THE confusion D-001 fixes (heartbeat lags).
    expect(deriveSessionState({ stale: false, wakeable: true, liveTurn: false })).toBe('parked');
  });

  it('wakeable + stale heartbeat → parked (process exited but the await resumes it)', () => {
    // A stale row is NOT automatically dead: a live await means a wake relaunches it.
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: true })).toBe('parked');
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: false })).toBe('parked');
  });
});
