/**
 * presence-wakeability.test.ts — the pure derivation guard for the P-001
 * coordinator wakeability signals (fleet-dispatch-wake-clarity-2026-06-22).
 *
 * The IO seam (fetchWakeability) is covered by presence.integration.test.ts; here
 * we pin the keep/cut boundary of deriveSessionState — the table that decides
 * whether a coordinator sees an agent as live | parked | ended.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveSessionState,
  isHardStale,
  overrideIntentStaleForSessionState,
  PRESENCE_DEAD_MS,
} from './presence-wakeability';

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

  // fleet-liveness-zombie-await-2026-07-07: an abrupt death (reboot/SIGKILL)
  // leaves the wake-await un-cancelled, so `wakeable:true` would pin a long-dead
  // row to `parked` forever. `hardStale` (heartbeat cold > PRESENCE_DEAD_MS) is
  // the authoritative backstop that forces it to `ended`.
  it('hardStale overrides a lingering (never-cancelled) wake-await → ended', () => {
    // The exact incident shape: wakeable (zombie await) + no running turn, but the
    // heartbeat has been cold past the DEAD ceiling ⇒ dead, needs relaunch.
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: false, hardStale: true })).toBe('ended');
    // hardStale beats even a (spurious) running-turn signal.
    expect(deriveSessionState({ stale: false, wakeable: true, liveTurn: true, hardStale: true })).toBe('ended');
  });

  it('hardStale:false leaves the pre-fix behavior unchanged (back-compat)', () => {
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: false, hardStale: false })).toBe('parked');
    // omitted hardStale defaults to false
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: false })).toBe('parked');
  });

  // WI-3898 P1 (coord:presence liveness parity): a local kill(pid, 0) probe
  // (probeProcessLiveness) that confirms the process is gone is a DIRECT OS
  // observation — it must beat even hardStale's 30-minute wait, detecting a
  // locally co-located dead agent in ~seconds instead of up to 30 minutes.
  it('pidConfirmedDead overrides everything (even a fresh heartbeat + a running turn + a live wake-await) → ended', () => {
    expect(
      deriveSessionState({ stale: false, wakeable: true, liveTurn: true, pidConfirmedDead: true }),
    ).toBe('ended');
    expect(
      deriveSessionState({
        stale: false,
        wakeable: true,
        liveTurn: true,
        hardStale: false,
        pidConfirmedDead: true,
      }),
    ).toBe('ended');
  });

  it('pidConfirmedDead:false / omitted leaves prior behavior unchanged (back-compat)', () => {
    expect(
      deriveSessionState({ stale: false, wakeable: true, liveTurn: true, pidConfirmedDead: false }),
    ).toBe('live');
    // omitted pidConfirmedDead defaults to undefined (falsy) — no behavior change.
    expect(deriveSessionState({ stale: false, wakeable: true, liveTurn: true })).toBe('live');
  });
});

describe('overrideIntentStaleForSessionState (EI-9262)', () => {
  it('forces intentStale TRUE the moment sessionState is parked, even when the 30m activity clock says fresh', () => {
    // The reported repro: killed ~10m ago, well under the 30m intentStale
    // threshold, but sessionState has already converged to parked.
    expect(overrideIntentStaleForSessionState(false, 'parked')).toBe(true);
    expect(overrideIntentStaleForSessionState(null, 'parked')).toBe(true);
  });

  it('forces intentStale TRUE for ended too', () => {
    expect(overrideIntentStaleForSessionState(false, 'ended')).toBe(true);
    expect(overrideIntentStaleForSessionState(null, 'ended')).toBe(true);
  });

  it('leaves intentStale untouched for live (a running turn is never intent-stale)', () => {
    expect(overrideIntentStaleForSessionState(false, 'live')).toBe(false);
    expect(overrideIntentStaleForSessionState(null, 'live')).toBe(null);
  });

  it('leaves intentStale untouched for recorded (authoritatively live, not yet inbox-registered)', () => {
    expect(overrideIntentStaleForSessionState(false, 'recorded')).toBe(false);
    expect(overrideIntentStaleForSessionState(null, 'recorded')).toBe(null);
  });

  it('leaves intentStale untouched for an unknown (null) sessionState — e.g. a federated row', () => {
    expect(overrideIntentStaleForSessionState(true, null)).toBe(true);
    expect(overrideIntentStaleForSessionState(false, null)).toBe(false);
    expect(overrideIntentStaleForSessionState(null, null)).toBe(null);
  });

  it('an already-true intentStale stays true for parked/ended (idempotent)', () => {
    expect(overrideIntentStaleForSessionState(true, 'parked')).toBe(true);
    expect(overrideIntentStaleForSessionState(true, 'ended')).toBe(true);
  });
});

describe('isHardStale', () => {
  const now = 1_000_000_000_000;
  it('true only once the heartbeat is cold beyond PRESENCE_DEAD_MS', () => {
    expect(isHardStale(now - (PRESENCE_DEAD_MS + 1), now)).toBe(true);
    expect(isHardStale(now - (PRESENCE_DEAD_MS - 1), now)).toBe(false);
    expect(isHardStale(now, now)).toBe(false);
  });
  it('is conservative on missing/unparseable timestamps (never force-ends on absent data)', () => {
    expect(isHardStale(null, now)).toBe(false);
    expect(isHardStale(undefined, now)).toBe(false);
    expect(isHardStale(NaN, now)).toBe(false);
  });
  it('the 72-min-cold incident heartbeat is hard-stale (DEAD ceiling is 30m)', () => {
    expect(PRESENCE_DEAD_MS).toBe(30 * 60_000);
    expect(isHardStale(now - 72 * 60_000, now)).toBe(true);
  });
});
