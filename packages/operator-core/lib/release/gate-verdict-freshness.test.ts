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
import {
  evaluateGateVerdictFreshness,
  GATE_FIRE_INTERVAL_MS,
  reconcileGateVerdictFreshnessWithCheckpointRun,
  reconcileGateVerdictFreshnessWithRepairQueue,
} from './gate-verdict-freshness';
// EI-20571364274022293: the reasonCode's whole contract is what this correction does with it, so
// the two are asserted together rather than each against its own private idea of the other.
import { pinProvenGateCorrection } from '../git-pipeline-stats';

/** Raw cached counters as they stand on a genuinely red gate. */
const RAW_RED = { consecutiveReds: 2, stalled: true, failingTests: ['a.test.ts'], firstRedAtMs: 1 };

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
    // WI-10002059: this assertion used to be `toMatch(/SKIPPED/)`, pinning rule 2's claim that
    // the runs were being SKIPPED on the run-lock. That cause is NOT measured here — a converging
    // frozen repair queue produces identical timestamps — and asserting it sent readers to cancel
    // or force-fire a HEALTHY gate, destroying a real ~55min suite. Rule 2 now reports what it
    // OBSERVED and enumerates the candidate causes; the disambiguation lives in the reconcilers.
    expect(v.reason).toMatch(/CAUSE is not measured here/);
    expect(v.reason).not.toMatch(/being SKIPPED \(run-lock contention\)/);
    // EI-13714: writer-starvation is UNVERIFIED, not proof of green — callers must not treat it
    // the same as a pin-advance (see the pin-advance case below + git-pipeline-stats.ts).
    expect(v.reasonCode).toBe('writer-starved');
  });

  it('⭐ flags a red the pin has advanced past — the pin only moves on a GREEN checkpoint', () => {
    const v = evaluateGateVerdictFreshness({
      ...LIVE_INCIDENT,
      lastFiredAtMs: LAST_VERDICT + 60_000, // writer NOT starved — rule 2 cannot fire
      currentGreenPinSha: '6d9aff3704c9c5937a0ffe13e139021d9101cff3', // but the pin MOVED
      // EI-20571364274022293: the base pin was READ LIVE at verdict time, so the move is ordered
      // AFTER the verdict. Without this the same input is only 'pin-advance-unordered' — see the
      // two cases below.
      observedFromPinFresh: true,
    });
    expect(v.stale).toBe(true);
    expect(v.reason).toMatch(/only moves on a GREEN checkpoint/);
    // EI-13714: pin-advance is HARD PROOF a green happened — the one reasonCode a caller may
    // treat as "reset the streak to 0", not merely "unknown" (git-pipeline-stats.ts's
    // pinProvenGateCorrection is the one place that acts on this).
    expect(v.reasonCode).toBe('pin-advance');
  });

  /**
   * EI-20571364274022293 — the 2026-08-16 incident, and the reason rule 1 is no longer a bare sha
   * comparison.
   *
   * The green-checkpoint could not START (its release worktree was orphaned), so every run failed
   * before resolving the live pin. The writer's `lastFrom: fromPin ?? gh.lastFrom` then froze
   * `lastFrom` at a PRE-INCIDENT value while the real pin had already advanced ~2h BEFORE the
   * streak's first red. Rule 1 saw two different shas, called it "hard proof the gate has greened
   * since", and `pinProvenGateCorrection` rendered a DEAD gate as `consecutiveReds: 0`.
   *
   * The discrimination pinned here: a pin difference is proof only when the base it is measured
   * from was actually OBSERVED. An unprovenanced base must degrade to "unverified", never to
   * "green" — a false green is strictly worse than an admitted unknown, because it retires the
   * question instead of raising it.
   */
  describe('EI-20571364274022293 — a pin difference is proof only if its base was observed', () => {
    const PIN_MOVED = {
      ...LIVE_INCIDENT,
      lastFiredAtMs: LAST_VERDICT + 60_000, // rule 2 cannot fire
      currentGreenPinSha: '6d9aff3704c9c5937a0ffe13e139021d9101cff3',
    };

    it('⭐ does NOT claim green when the base pin was carried forward, not read', () => {
      const v = evaluateGateVerdictFreshness({ ...PIN_MOVED, observedFromPinFresh: false });
      expect(v.stale).toBe(true); // still "do not act on this red"...
      expect(v.reasonCode).toBe('pin-advance-unordered'); // ...but NOT proof of a green
      expect(v.reasonCode).not.toBe('pin-advance');
      expect(v.reason).toMatch(/NOT read live/);
      expect(v.reason).toMatch(/UNVERIFIED, NOT as greened/);
    });

    it('degrades the same way on a blob predating the provenance field (absent ⇒ not proof)', () => {
      // The transition case: every pre-existing blob lacks `lastFromFresh`. Failing toward
      // "unverified" is the whole point — an unprovenanced pin is not a timestamped one.
      const v = evaluateGateVerdictFreshness(PIN_MOVED);
      expect(v.stale).toBe(true);
      expect(v.reasonCode).toBe('pin-advance-unordered');
    });

    it('⭐ the weaker code does NOT reset the streak — a dead gate keeps reading red', () => {
      // The correction in git-pipeline-stats keys on 'pin-advance' ALONE; this is the property
      // that failed in the incident, asserted here at the boundary that produces the code.
      const v = evaluateGateVerdictFreshness({ ...PIN_MOVED, observedFromPinFresh: false });
      expect(pinProvenGateCorrection(v.reasonCode, RAW_RED)).toEqual(RAW_RED);
      // ...while a genuine, provenanced advance still clears it.
      const proven = evaluateGateVerdictFreshness({ ...PIN_MOVED, observedFromPinFresh: true });
      expect(pinProvenGateCorrection(proven.reasonCode, RAW_RED).consecutiveReds).toBe(0);
    });

    it('a fresh base pin that has NOT moved is not stale at all — the rule stays falsifiable', () => {
      // Calibration (the EI-10609 lesson): if the healthy case also came back stale, the three
      // assertions above would pass for the wrong reason.
      const v = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        lastFiredAtMs: LAST_VERDICT + 60_000,
        observedFromPinFresh: true, // pin read live, and unchanged (LIVE_INCIDENT default)
      });
      expect(v.stale).toBe(false);
      expect(v.reasonCode).toBeNull();
    });
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

  /**
   * Rule 5 — CANDIDATE-FOSSIL (EI-19346660748445728).
   *
   * Rules 1-4 all ask "has something happened SINCE this verdict?", so all four are blind to a
   * verdict that was already describing ancient code when it was WRITTEN. Fixtures below are the
   * real measured population from 2026-08-02, taken from the persisted verdict logs
   * (`~/.papercusp/checkpoint-logs/<ts>-base-<sha>-cand-<sha>.log`), whose filenames carry both
   * the write time and the candidate.
   *
   * The discrimination that matters is the EI-10609 lesson this suite already states: a detector
   * that fires on the healthy case is worse than none. The healthy band here is TIGHT (19-35 min)
   * and the outliers are ORDERS out (up to 651), so the threshold has real room — but only if the
   * healthy cases are pinned, which is what `HEALTHY_AGES_MIN` does.
   */
  describe('rule 5 — candidate-fossil', () => {
    /** A red that none of rules 1-4 can touch: pin unmoved, routine on time, no retriage. This is
     *  the shape the 12:53Z incident actually had — which is why it read as a live red. */
    const UNTOUCHED_BY_OTHER_RULES = {
      consecutiveReds: 1,
      observedFromPin: 'e79857e2d593',
      currentGreenPinSha: 'e79857e2d593',
      lastFiredAtMs: null,
    };
    /** The real outlier: verdict written 12:53:12Z judging a candidate committed 02:01:48Z. */
    const FOSSIL_VERDICT_AT = Date.parse('2026-08-02T12:53:12Z');
    const FOSSIL_CANDIDATE_AT = Date.parse('2026-08-02T02:01:48Z');

    it('⭐ flags the 2026-08-02 12:53Z incident: a verdict judging a 10.9h-old candidate', () => {
      const v = evaluateGateVerdictFreshness({
        ...UNTOUCHED_BY_OTHER_RULES,
        observedAtMs: FOSSIL_VERDICT_AT,
        candidateCommittedAtMs: FOSSIL_CANDIDATE_AT,
        commitsBehindTip: 86,
      });
      expect(v.stale).toBe(true);
      expect(v.reasonCode).toBe('candidate-fossil');
      expect(v.reason).toMatch(/ALREADY 10\.9h old/);
      expect(v.reason).toMatch(/86 commit\(s\) landed on staging that it never saw/);
      // The operative instruction: this red must not dispatch anyone at the tests it names.
      expect(v.reason).toMatch(/Do NOT go fix the test\(s\) it names/);
    });

    /** Every healthy candidate age measured that day, in minutes (n=25), plus the two benign 54s.
     *  NONE may trip the rule — this is the false-positive floor. */
    const HEALTHY_AGES_MIN = [19, 25, 25, 26, 28, 28, 29, 29, 29, 30, 30, 31, 32, 33, 33, 34, 34, 34, 35, 35, 35, 39, 54, 54];
    it.each(HEALTHY_AGES_MIN)('does NOT fire on the healthy structural window (%i min)', (min) => {
      const v = evaluateGateVerdictFreshness({
        ...UNTOUCHED_BY_OTHER_RULES,
        observedAtMs: FOSSIL_VERDICT_AT,
        candidateCommittedAtMs: FOSSIL_VERDICT_AT - min * 60_000,
        commitsBehindTip: 4,
      });
      expect(v.stale).toBe(false);
      expect(v.reasonCode).toBeNull();
      // ...but the measurement is still surfaced, so a caller can show the ordinary window.
      expect(v.candidateAgeMs).toBe(min * 60_000);
    });

    it('fires on the 121-min outlier (the same candidate judged twice, 2026-08-01 23:35Z)', () => {
      const v = evaluateGateVerdictFreshness({
        ...UNTOUCHED_BY_OTHER_RULES,
        observedAtMs: FOSSIL_VERDICT_AT,
        candidateCommittedAtMs: FOSSIL_VERDICT_AT - 121 * 60_000,
      });
      expect(v.stale).toBe(true);
      expect(v.reasonCode).toBe('candidate-fossil');
      // No commitsBehindTip ⇒ the clause is omitted rather than rendered with a null/0.
      expect(v.reason).not.toMatch(/commit\(s\) landed/);
    });

    it('is UNAVAILABLE (never a false positive) on a blob predating candidateCommittedAt', () => {
      const v = evaluateGateVerdictFreshness({
        ...UNTOUCHED_BY_OTHER_RULES,
        observedAtMs: FOSSIL_VERDICT_AT,
        candidateCommittedAtMs: null,
      });
      expect(v.stale).toBe(false);
      expect(v.candidateAgeMs).toBeNull();
    });

    it('treats clock skew (candidate committed AFTER the verdict) as unavailable, not as a fossil', () => {
      const v = evaluateGateVerdictFreshness({
        ...UNTOUCHED_BY_OTHER_RULES,
        observedAtMs: FOSSIL_VERDICT_AT,
        candidateCommittedAtMs: FOSSIL_VERDICT_AT + 5 * 60_000,
      });
      expect(v.stale).toBe(false);
      expect(v.candidateAgeMs).toBeNull();
    });

    it('never fires on a GREEN blob — a stale green is inert (the module-wide invariant)', () => {
      const v = evaluateGateVerdictFreshness({
        ...UNTOUCHED_BY_OTHER_RULES,
        consecutiveReds: 0,
        observedAtMs: FOSSIL_VERDICT_AT,
        candidateCommittedAtMs: FOSSIL_CANDIDATE_AT,
      });
      expect(v.stale).toBe(false);
      expect(v.reasonCode).toBeNull();
    });

    it('⭐ yields to pin-advance: PROOF of a green outranks "the candidate was old"', () => {
      const v = evaluateGateVerdictFreshness({
        ...UNTOUCHED_BY_OTHER_RULES,
        currentGreenPinSha: '1e0ddc586454', // pin moved ⇒ a green provably happened since
        observedFromPinFresh: true, // EI-20571364274022293: ...and the base it moved from was real
        observedAtMs: FOSSIL_VERDICT_AT,
        candidateCommittedAtMs: FOSSIL_CANDIDATE_AT,
      });
      expect(v.reasonCode).toBe('pin-advance');
      // The measurement rides along regardless of WHICH rule fired.
      expect(v.candidateAgeMs).toBe(FOSSIL_VERDICT_AT - FOSSIL_CANDIDATE_AT);
    });

    it('⭐ outranks writer-starved: name the concrete defect, not the weakest inference', () => {
      const v = evaluateGateVerdictFreshness({
        ...UNTOUCHED_BY_OTHER_RULES,
        observedAtMs: FOSSIL_VERDICT_AT,
        // Both rules hold: the writer also starved for >1.5 intervals after this verdict.
        lastFiredAtMs: FOSSIL_VERDICT_AT + GATE_FIRE_INTERVAL_MS * 2,
        candidateCommittedAtMs: FOSSIL_CANDIDATE_AT,
      });
      expect(v.reasonCode).toBe('candidate-fossil');
    });

    it('honours an explicit fossilAgeMs override', () => {
      const base = {
        ...UNTOUCHED_BY_OTHER_RULES,
        observedAtMs: FOSSIL_VERDICT_AT,
        candidateCommittedAtMs: FOSSIL_VERDICT_AT - 40 * 60_000,
      };
      expect(evaluateGateVerdictFreshness(base).stale).toBe(false);
      expect(evaluateGateVerdictFreshness({ ...base, fossilAgeMs: 30 * 60_000 }).stale).toBe(true);
    });
  });

  describe('reconcileGateVerdictFreshnessWithCheckpointRun — measured contention', () => {
    const writerStarved = evaluateGateVerdictFreshness(LIVE_INCIDENT);

    it('reclassifies only writer-starved with measured active run-lock liveness', () => {
      const out = reconcileGateVerdictFreshnessWithCheckpointRun(writerStarved, {
        active: true,
        activeSource: 'run-lock',
      });

      expect(out.stale).toBe(true);
      expect(out.reasonCode).toBe('run-in-flight');
      expect(out.reason).toMatch(/verdict is pending/);
      expect(out.reason).toMatch(/do NOT fire release:checkpoint-run/);
    });

    it('reclassifies writer-starved during measured pre-lock process authority', () => {
      const out = reconcileGateVerdictFreshnessWithCheckpointRun(writerStarved, {
        active: true,
        activeSource: 'process-authority',
      });
      expect(out.reasonCode).toBe('run-in-flight');
      expect(out.reason).toMatch(/authority environment \+ cgroup/);
      expect(out.reason).toMatch(/do NOT fire release:checkpoint-run/);
    });

    it.each([
      ['measured idle', { active: false, activeSource: 'run-lock' as const }],
      ['unknown', null],
      ['cache-only active', { active: true }],
    ])('preserves writer-starved for %s liveness', (_label, reading) => {
      expect(reconcileGateVerdictFreshnessWithCheckpointRun(writerStarved, reading)).toEqual(writerStarved);
    });

    it('preserves a stronger freshness rule even when a run-lock is active', () => {
      const stronger = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: Date.now() - 60_000,
        inFlightRetriage: {
          fromCandidate: LIVE_INCIDENT.observedFromPin,
          refiringCandidate: '221dc407abcd',
          refireAttempt: 1,
          maxRefires: 2,
          failingFiles: ['a.test.ts'],
          observedAtMs: Date.now(),
        },
      });

      expect(stronger.reasonCode).toBe('refire-in-flight');
      expect(
        reconcileGateVerdictFreshnessWithCheckpointRun(stronger, { active: true, activeSource: 'run-lock' }),
      ).toEqual(stronger);
    });
  });

  // WI-10002059. Rule 2 fires on a purely TEMPORAL observation ("fired since the last verdict")
  // and used to ASSERT run-lock contention — a mechanism it never measured. A converging frozen
  // repair queue produces the identical timestamps while the gate is HEALTHY, and the two demand
  // OPPOSITE responses (triage the lock vs. leave it alone), so blaming contention actively
  // misdirects: cancelling a healthy run destroys a real ~55min suite.
  describe('reconcileGateVerdictFreshnessWithRepairQueue — convergence is not contention', () => {
    const writerStarved = evaluateGateVerdictFreshness(LIVE_INCIDENT);

    it('is writer-starved to begin with, and never asserts the run-lock as the measured cause', () => {
      // Guards the rule-2 prose itself: the bug was a confident causal claim, so the absence of
      // that claim is the thing worth pinning, not merely the presence of the new one.
      expect(writerStarved.reasonCode).toBe('writer-starved');
      expect(writerStarved.reason).not.toMatch(/being SKIPPED \(run-lock contention\)/);
      expect(writerStarved.reason).toMatch(/CAUSE is not measured here/);
    });

    it('reclassifies on the gate\'s OWN recorded disposition (direct evidence)', () => {
      const out = reconcileGateVerdictFreshnessWithRepairQueue(writerStarved, {
        status: 'repair-in-progress',
        phase: 'ready-to-verify',
      });

      expect(out.stale).toBe(true);
      expect(out.reasonCode).toBe('repair-converging');
      expect(out.reason).toMatch(/NOT being skipped on the run-lock/);
      expect(out.reason).toMatch(/recorded 'repair-in-progress'/);
      expect(out.reason).toMatch(/do NOT release:checkpoint-cancel/i);
      // The staleness itself must survive: convergence explains the missing verdict, it does not
      // prove the red is wrong. Reporting green here would be the opposite error.
      expect(out.stale).toBe(true);
    });

    it('reclassifies on structural phase evidence when no disposition was recorded', () => {
      const out = reconcileGateVerdictFreshnessWithRepairQueue(writerStarved, {
        status: null,
        phase: 'awaiting-fixer',
      });
      expect(out.reasonCode).toBe('repair-converging');
      expect(out.reason).toMatch(/phase 'awaiting-fixer'/);
    });

    it.each([
      ['no queue at all', null],
      ['a BLOCKED queue, which is not converging', { status: null, phase: 'blocked' as const }],
      ['a queue whose recorded status is unrelated', { status: 'run-lock', phase: null }],
    ])('preserves writer-starved for %s', (_label, reading) => {
      expect(reconcileGateVerdictFreshnessWithRepairQueue(writerStarved, reading)).toEqual(writerStarved);
    });

    it('PRECEDENCE: a live run still wins — run-in-flight is not downgraded to repair-converging', () => {
      // Composition order is load-bearing at the call site: "wait for THIS run" is more immediate
      // and more actionable than the standing convergence that run happens to sit inside.
      const inFlight = reconcileGateVerdictFreshnessWithCheckpointRun(writerStarved, {
        active: true,
        activeSource: 'run-lock',
      });
      expect(inFlight.reasonCode).toBe('run-in-flight');
      expect(
        reconcileGateVerdictFreshnessWithRepairQueue(inFlight, {
          status: 'repair-in-progress',
          phase: 'ready-to-verify',
        }),
      ).toEqual(inFlight);
    });

    it('preserves a stronger freshness rule even while a queue converges', () => {
      const stronger = evaluateGateVerdictFreshness({
        ...LIVE_INCIDENT,
        observedAtMs: Date.now() - 60_000,
        inFlightRetriage: {
          fromCandidate: LIVE_INCIDENT.observedFromPin,
          refiringCandidate: '221dc407abcd',
          refireAttempt: 1,
          maxRefires: 2,
          failingFiles: ['a.test.ts'],
          observedAtMs: Date.now(),
        },
      });
      expect(stronger.reasonCode).toBe('refire-in-flight');
      expect(
        reconcileGateVerdictFreshnessWithRepairQueue(stronger, {
          status: 'repair-in-progress',
          phase: 'ready-to-verify',
        }),
      ).toEqual(stronger);
    });

    // PERMANENT WRONG-IMPLEMENTATION CONTROL. Keep this here: it is what proves the guard above
    // can actually fail. The naive rule the system shipped — "fired without a verdict ⇒ run-lock
    // contention" — is expressed directly and asserted to DIVERGE from the real one on the exact
    // input that was measured in production. If these two ever stop diverging, the distinction
    // has been lost and every reader is being misdirected again.
    it('DIVERGES from the naive "fired-without-verdict ⇒ contention" rule', () => {
      const naiveContentionVerdict = (f: typeof writerStarved) => ({
        ...f,
        reason: 'its runs are being SKIPPED (run-lock contention), so this red is unverified',
        reasonCode: 'writer-starved' as const,
      });

      const convergingQueue = { status: 'repair-in-progress' as const, phase: 'ready-to-verify' as const };
      const real = reconcileGateVerdictFreshnessWithRepairQueue(writerStarved, convergingQueue);
      const naive = naiveContentionVerdict(writerStarved);

      expect(real.reasonCode).not.toBe(naive.reasonCode);
      expect(real.reason).not.toBe(naive.reason);
      expect(naive.reason).toMatch(/run-lock contention/);
      expect(real.reason).not.toMatch(/being SKIPPED \(run-lock contention\)/);

      // Calibration: on an input where the two SHOULD agree (no queue), they must agree — else
      // this control would "pass" against an implementation that simply never matches anything.
      expect(reconcileGateVerdictFreshnessWithRepairQueue(writerStarved, null).reasonCode).toBe(
        naive.reasonCode,
      );
    });
  });
});
