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
  needsLivenessConfirmation,
  isHardStale,
  overrideIntentStaleForSessionState,
  PRESENCE_DEAD_MS,
  isConfirmedWakeAttemptMiss,
} from './presence-wakeability';

describe('deriveSessionState', () => {
  it('not wakeable + NO live turn → ended (cleanly ended / idle no-await; a wake reaches nobody — relaunch only)', () => {
    // A non-wakeable session that is NOT mid-turn is genuinely gone: no await ⇒
    // a wake can't land, and no in-flight turn ⇒ nothing is running.
    expect(deriveSessionState({ stale: false, wakeable: false, liveTurn: false })).toBe('ended');
    expect(deriveSessionState({ stale: true, wakeable: false, liveTurn: false })).toBe('ended');
  });

  // EI-12699: wakeability and liveness are ORTHOGONAL. A cup:spawn'd one-turn bee
  // (invoke-once.ts) doing agentic work never registers a coord:inbox-wake await
  // (wakeable:false) yet is very much alive mid-turn (a fresh liveTurn). The old
  // `!wakeable ⇒ ended` short-circuit fired ahead of the liveTurn check and served
  // a self-contradictory row — `ended` while `lastActiveSecAgo` was seconds — so
  // peers' wake:'required' reported `recipient_dead` and black-holed into a LIVE
  // agent. A demonstrably-active session must NEVER read `ended`.
  it('EI-12699: a live turn in flight is `live` even when NOT wakeable (never a false `ended` for an active bee)', () => {
    // The exact incident shape: a one-turn bee mid-turn — fresh heartbeat, a turn
    // running, but no inbox-wake await. Alive, not dead.
    expect(deriveSessionState({ stale: false, wakeable: false, liveTurn: true })).toBe('live');
    // `wakeable` is emitted as its own field, so the honest read is `live` +
    // `wakeable:false` — "alive and working, but a wake won't land right now".
    // A non-wakeable stale-but-recently-active row is `draining` (confirm before
    // assuming dead), never a flat `ended`.
    expect(deriveSessionState({ stale: true, wakeable: false, liveTurn: true })).toBe('draining');
  });

  it('wakeable + a running turn (fresh heartbeat) → live', () => {
    expect(deriveSessionState({ stale: false, wakeable: true, liveTurn: true })).toBe('live');
  });

  it('wakeable but no running turn → parked (the ideal dispatch target)', () => {
    // Just-ended-but-still-warm: fresh heartbeat, but the last marker was the
    // session-end (liveTurn=false) — THE confusion D-001 fixes (heartbeat lags).
    expect(deriveSessionState({ stale: false, wakeable: true, liveTurn: false })).toBe('parked');
  });

  it('stale + wakeable → draining (not a healthy parked dispatch target)', () => {
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: true })).toBe('draining');
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: false })).toBe('draining');
  });

  // EI-21356139961831796 — WARM-DEAD. `hardStale` only catches a process that
  // DIED (heartbeat clock). A process that is alive and heartbeating with a
  // wedged agent loop keeps hardStale=false + wakeable=true and used to fall
  // through to `parked`. A confirmed wake MISS is the direct evidence.
  describe('warm-dead: a confirmed wake miss is not a dispatch target', () => {
    // The measured incident shape: pid alive 22h54m, heartbeat 7s fresh, last
    // turn 21h25m ago, two delivered wakes, zero turns — and it was scored the
    // TOP consult responder.
    it('wakeable + fresh heartbeat + no turn after a delivered wake → ended, not parked', () => {
      expect(
        deriveSessionState({ stale: false, wakeable: true, liveTurn: false, wakeAttemptMiss: true }),
      ).toBe('ended');
    });

    it('CONTROL — the SAME row without the wake miss is still parked', () => {
      // Proves the verdict is driven by the miss and not by the other inputs;
      // without this, the assertion above passes for the wrong reason.
      expect(
        deriveSessionState({ stale: false, wakeable: true, liveTurn: false, wakeAttemptMiss: false }),
      ).toBe('parked');
      expect(deriveSessionState({ stale: false, wakeable: true, liveTurn: false })).toBe('parked');
    });

    it('a live turn still WINS over a wake miss (never call a working agent dead)', () => {
      // isConfirmedWakeAttemptMiss goes false as soon as activity postdates the
      // attempt, so these cannot really disagree — but ordering is asserted so a
      // later refactor cannot reintroduce the EI-12699 "ended while mid-turn" bug.
      expect(
        deriveSessionState({ stale: false, wakeable: true, liveTurn: true, wakeAttemptMiss: true }),
      ).toBe('live');
      expect(
        deriveSessionState({ stale: true, wakeable: true, liveTurn: true, wakeAttemptMiss: true }),
      ).toBe('draining');
    });

    it('claims still held downgrade to suspect, mirroring the hardStale line', () => {
      expect(
        deriveSessionState({
          stale: false,
          wakeable: true,
          liveTurn: false,
          wakeAttemptMiss: true,
          claimsHeld: true,
        }),
      ).toBe('suspect');
    });

    it('an unchecked/absent miss signal never force-ends (conservative on missing data)', () => {
      expect(
        deriveSessionState({ stale: false, wakeable: true, liveTurn: false, wakeAttemptMiss: undefined }),
      ).toBe('parked');
    });
  });

  // fleet-liveness-zombie-await-2026-07-07: an abrupt death (reboot/SIGKILL)
  // leaves the wake-await un-cancelled, so `wakeable:true` would pin a long-dead
  // row to `parked` forever. `hardStale` (heartbeat cold > PRESENCE_DEAD_MS) is
  // the authoritative backstop that forces it to `ended`.
  it('hardStale overrides a lingering (never-cancelled) wake-await → ended', () => {
    // The exact incident shape: wakeable (zombie await) + no running turn, but the
    // heartbeat has been cold past the DEAD ceiling ⇒ dead, needs relaunch.
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: false, hardStale: true })).toBe('ended');
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: false, hardStale: true, claimsHeld: true })).toBe('suspect');
    // hardStale beats even a (spurious) running-turn signal.
    expect(deriveSessionState({ stale: false, wakeable: true, liveTurn: true, hardStale: true })).toBe('ended');
  });

  it('hardStale:false preserves resumability while exposing stale wind-down', () => {
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: false, hardStale: false })).toBe('draining');
    // omitted hardStale defaults to false
    expect(deriveSessionState({ stale: true, wakeable: true, liveTurn: false })).toBe('draining');
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

  it('pidConfirmedDead with held claims → suspect until claim cleanup runs', () => {
    expect(
      deriveSessionState({ stale: false, wakeable: true, liveTurn: true, pidConfirmedDead: true, claimsHeld: true }),
    ).toBe('suspect');
  });

  it('pidConfirmedDead:false / omitted leaves prior behavior unchanged (back-compat)', () => {
    expect(
      deriveSessionState({ stale: false, wakeable: true, liveTurn: true, pidConfirmedDead: false }),
    ).toBe('live');
    // omitted pidConfirmedDead defaults to undefined (falsy) — no behavior change.
    expect(deriveSessionState({ stale: false, wakeable: true, liveTurn: true })).toBe('live');
  });
});

describe('needsLivenessConfirmation (WI-4400)', () => {
  it('flags draining and suspect takeover reads', () => {
    expect(needsLivenessConfirmation('draining')).toBe(true);
    expect(needsLivenessConfirmation('suspect')).toBe(true);
  });

  it('does not flag decisive states and preserves unknown as null', () => {
    for (const state of ['live', 'parked', 'ended', 'recorded'] as const) {
      expect(needsLivenessConfirmation(state)).toBe(false);
    }
    expect(needsLivenessConfirmation(null)).toBeNull();
    expect(needsLivenessConfirmation(undefined)).toBeNull();
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

  it('forces intentStale TRUE for draining and suspect too', () => {
    expect(overrideIntentStaleForSessionState(false, 'draining')).toBe(true);
    expect(overrideIntentStaleForSessionState(false, 'suspect')).toBe(true);
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

describe('isConfirmedWakeAttemptMiss (EI-21216592915615709)', () => {
  const attempt = Date.parse('2026-08-23T04:27:10Z');

  it('recognizes recent pre-wake activity with a terminal wake and no pickup', () => {
    expect(isConfirmedWakeAttemptMiss(attempt, attempt - 1_000)).toBe(true);
  });

  it('does not call a wake a miss when activity follows the attempt', () => {
    expect(isConfirmedWakeAttemptMiss(attempt, attempt + 1_000)).toBe(false);
  });

  it('does not infer a miss from a queued/non-terminal delivery or bad telemetry', () => {
    expect(isConfirmedWakeAttemptMiss(null, attempt - 1_000)).toBe(false);
    expect(isConfirmedWakeAttemptMiss(attempt, Number.NaN)).toBe(false);
  });
});
