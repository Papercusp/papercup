/**
 * WI-4489 — a stale RED is not a red.
 *
 * The fixture that matters is TODAY'S LIVE INCIDENT (2026-07-12): the gate's last real verdict was
 * 18:29 (4 reds, from the WI-4427 pnpm-hijack window); the routine then fired at 19:15 / 20:15 /
 * 21:15, each `skipped-locked` — a no-op that leaves `gate_health` untouched while still refreshing
 * `last_fired_at`. Every consumer read `consecutiveReds: 4, fireStale: false` (a confident RED) for
 * ~3.5h while the gate was in fact green on every actual run, and all 8 named tests passed.
 *
 * The discrimination this suite pins: a STALE red and a LIVE red must not look the same — and,
 * symmetrically, a live red must still be reported as red (the EI-10609 lesson: a detector that
 * fires on the healthy case is worse than none).
 */
import { describe, it, expect } from 'vitest';
import { evaluateGateVerdictFreshness, GATE_FIRE_INTERVAL_MS } from './gate-verdict-freshness';

const H = 3_600_000;
/** 2026-07-12 21:15 EDT — the last (skipped) fire. */
const LAST_FIRE = Date.parse('2026-07-13T01:15:00Z');
/** 18:29 EDT — the last run that actually produced a verdict. */
const LAST_VERDICT = Date.parse('2026-07-12T22:29:00Z');

/** The live incident, as it stood BEFORE the pin moved: 4 reds, routine firing on time, no green
 *  pin movement yet. Only the writer-starvation rule can catch this one. */
const LIVE_INCIDENT = {
  consecutiveReds: 4,
  observedAtMs: LAST_VERDICT,
  observedFromPin: '28a3a3d50258',
  currentGreenPinSha: '28a3a3d50258', // pin had NOT moved yet
  lastFiredAtMs: LAST_FIRE,
};

describe('evaluateGateVerdictFreshness', () => {
  it('⭐ flags the live incident: the routine fired for hours without producing a verdict', () => {
    const v = evaluateGateVerdictFreshness(LIVE_INCIDENT);
    expect(v.stale).toBe(true);
    expect(v.reason).toMatch(/without producing a new one/);
    expect(v.reason).toMatch(/SKIPPED/);
    // EI-13714: writer-starvation is UNVERIFIED, not proof of green — callers must not treat it
    // the same as a pin-advance (see the pin-advance case below + git-pipeline-stats.ts).
    expect(v.reasonCode).toBe('writer-starved');
  });

  it('⭐ flags a red the pin has advanced past — the pin only moves on a GREEN checkpoint', () => {
    const v = evaluateGateVerdictFreshness({
      ...LIVE_INCIDENT,
      lastFiredAtMs: LAST_VERDICT + 60_000, // writer NOT starved — rule 2 cannot fire
      currentGreenPinSha: '6d9aff3704c9c5937a0ffe13e139021d9101cff3', // but the pin MOVED
    });
    expect(v.stale).toBe(true);
    expect(v.reason).toMatch(/only moves on a GREEN checkpoint/);
    // EI-13714: pin-advance is HARD PROOF a green happened — the one reasonCode a caller may
    // treat as "reset the streak to 0", not merely "unknown" (git-pipeline-stats.ts's
    // pinProvenGateCorrection is the one place that acts on this).
    expect(v.reasonCode).toBe('pin-advance');
  });

  it('compares pins by short sha — a full sha and its 12-char prefix are the SAME pin, not a move', () => {
    const v = evaluateGateVerdictFreshness({
      ...LIVE_INCIDENT,
      lastFiredAtMs: LAST_VERDICT + 60_000,
      observedFromPin: '28a3a3d50258',
      currentGreenPinSha: '28a3a3d50258595a3dd2278296ad2440fd9f311c', // same commit, full form
    });
    expect(v.stale).toBe(false); // a formatting difference is NOT evidence of a green
  });

  it('⭐ does NOT flag a LIVE red: fresh verdict, pin unmoved — the gate really is red', () => {
    const v = evaluateGateVerdictFreshness({
      ...LIVE_INCIDENT,
      observedAtMs: LAST_FIRE - 60_000, // the last fire DID produce this verdict
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('never flags a GREEN verdict — a stale green is inert and marking it would invent a phantom', () => {
    const v = evaluateGateVerdictFreshness({
      ...LIVE_INCIDENT,
      consecutiveReds: 0,
      observedAtMs: LAST_VERDICT - 50 * H, // ancient, and the routine has fired since
    });
    expect(v.stale).toBe(false);
    expect(v.reasonCode).toBeNull();
  });

  it('tolerates one late fire — 1.5× the interval of slack, so a slightly-delayed tick is not "starved"', () => {
    const v = evaluateGateVerdictFreshness({
      ...LIVE_INCIDENT,
      observedAtMs: LAST_FIRE - GATE_FIRE_INTERVAL_MS * 1.2,
    });
    expect(v.stale).toBe(false);
  });

  it('a blob with no observedAt (pre-WI-4489) is not GUESSED stale — absence of a stamp is not evidence', () => {
    const v = evaluateGateVerdictFreshness({
      ...LIVE_INCIDENT,
      observedAtMs: null,
    });
    expect(v.stale).toBe(false); // rule 2 unavailable; rule 1 still applies if the pin moves
  });

  it('…but rule 1 still rescues an un-stamped legacy blob once the pin advances', () => {
    const v = evaluateGateVerdictFreshness({
      ...LIVE_INCIDENT,
      observedAtMs: null,
      currentGreenPinSha: '6d9aff3704c9c5937a0ffe13e139021d9101cff3',
    });
    expect(v.stale).toBe(true);
  });

  /** EI-13288: the gate's own stale-candidate re-triage already re-ran its named failing files at
   *  a newer tip and they PASSED, but the auto-refire cap was reached before a full suite could
   *  confirm that tip green — so this verdict's failing-test names are unconfirmed AT RECORD
   *  TIME, not merely aged. Neither the pin (unmoved — the gate correctly held) nor the writer
   *  (fresh, on-time fire) is stale here; only Rule 3 can catch it. */
  describe('Rule 3 — RETRIAGE-PROVEN (EI-13288)', () => {
    it('⭐ flags a FRESH, on-time verdict whose own retriage proved the named files pass at tip', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: LAST_FIRE - 60_000, // the last fire DID produce this verdict — not starved
        // pin unmoved (LIVE_INCIDENT default) — the gate correctly held, this is not a pin-advance
        retriageStaleTip: '9f8e7d6c5b4a',
      });
      expect(v.stale).toBe(true);
      expect(v.reason).toMatch(/re-triage/);
      expect(v.reason).toMatch(/9f8e7d6c5b4a/);
      expect(v.reason).toMatch(/PASSED/);
      // EI-13714: retriage-proven is NOT a full-suite green proof — distinct from pin-advance.
      expect(v.reasonCode).toBe('retriage-proven');
    });

    it('does not flag a genuinely-broken red whose retriage never found a stale-candidate', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: LAST_FIRE - 60_000,
        retriageStaleTip: null,
      });
      expect(v.stale).toBe(false);
    });

    it('is inert on a green (0-red) verdict, same as every other rule', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        consecutiveReds: 0,
        observedAtMs: LAST_FIRE - 60_000,
        retriageStaleTip: 'abc123def456',
      });
      expect(v.stale).toBe(false);
    });

    it('takes priority over the other rules — checked first, independent of pin/writer state', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT, // pin unmoved, writer starved (the rule-2 fixture)
        retriageStaleTip: 'deadbeef0000',
      });
      expect(v.stale).toBe(true);
      expect(v.reason).toMatch(/re-triage/); // rule 3's reason, not rule 2's
    });
  });

  /** EI-18669342433807110: a stale-candidate auto-refire for the EXACT cached red is running RIGHT
   *  NOW — green-checkpoint.ts recursed onto a newer tip but that recursion can take minutes and
   *  writes nothing to gate_health until it settles, so a concurrent reader must be told "a fresh
   *  verdict is imminent" instead of "fix these tests" or even "go fire a fresh checkpoint run". */
  describe('Rule 4 — REFIRE-IN-FLIGHT (EI-18669342433807110)', () => {
    const inFlight = (overrides: Partial<NonNullable<Parameters<typeof evaluateGateVerdictFreshness>[0]['inFlightRetriage']>> = {}) => ({
      fromCandidate: LIVE_INCIDENT.observedFromPin,
      refiringCandidate: '221dc407abcd',
      refireAttempt: 1,
      maxRefires: 2,
      failingFiles: ['a.test.ts', 'b.test.ts'],
      observedAtMs: Date.now(),
      ...overrides,
    });

    it('⭐ flags a fresh, on-time, pin-unmoved red whose refire marker names THIS candidate', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: LAST_FIRE - 60_000, // fresh — not starved
        inFlightRetriage: inFlight(),
      });
      expect(v.stale).toBe(true);
      expect(v.reason).toMatch(/IN FLIGHT/);
      expect(v.reason).toMatch(/attempt 1\/2/);
      expect(v.reason).toMatch(/221dc407abcd/);
      expect(v.reasonCode).toBe('refire-in-flight');
    });

    /**
     * EI-19343516395023183. "A fresh verdict is imminent, stand down" is correct advice right up
     * until the LAST refire, where the imminent verdict is the FINAL one and a red STICKS. The
     * reader could not tell those apart: it was handed only the CHARGED counter, which does not
     * advance on a successful rescue, so a run at the absolute ceiling read as `attempt 0/2`.
     */
    it('⭐ warns that this is the LAST refire when the ABSOLUTE CEILING is reached, not just when the charged budget is', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: LAST_FIRE - 60_000,
        inFlightRetriage: inFlight({ refireAttempt: 0, totalRefires: 6, absoluteCeiling: 6 }),
      });
      expect(v.reasonCode).toBe('refire-in-flight');
      expect(v.reason).toMatch(/refire 6\/6 performed, charged budget 0\/2 spent/);
      expect(v.reason).toMatch(/LAST refire/);
    });

    it('does NOT cry "last refire" while budget genuinely remains', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: LAST_FIRE - 60_000,
        inFlightRetriage: inFlight({ refireAttempt: 0, totalRefires: 2, absoluteCeiling: 6 }),
      });
      expect(v.reason).not.toMatch(/LAST refire/);
    });

    it('does not flag a red when the marker names a DIFFERENT candidate (an earlier, superseded red)', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: LAST_FIRE - 60_000,
        inFlightRetriage: inFlight({ fromCandidate: 'some0therSha1' }),
      });
      expect(v.stale).toBe(false);
    });

    it('is inert on a green (0-red) verdict, same as every other rule', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        consecutiveReds: 0,
        observedAtMs: LAST_FIRE - 60_000,
        inFlightRetriage: inFlight(),
      });
      expect(v.stale).toBe(false);
    });

    it('takes priority over rule 3 — checked first, live evidence beats a completed run\'s', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: LAST_FIRE - 60_000,
        retriageStaleTip: 'deadbeef0000', // rule 3 would also fire
        inFlightRetriage: inFlight(),
      });
      expect(v.reasonCode).toBe('refire-in-flight'); // rule 4's, not rule 3's
    });

    it('ignores a null/absent marker (the common case — no refire running)', () => {
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: LAST_FIRE - 60_000,
        inFlightRetriage: null,
      });
      expect(v.stale).toBe(false);
    });
  });
});
