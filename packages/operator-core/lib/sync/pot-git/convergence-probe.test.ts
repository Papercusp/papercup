/**
 * Unit tests for the pot-git convergence probe (WI-6372, fix D).
 *
 * The bulk of these are NEVER-FIRES-ON-HEALTHY tests. That weighting is
 * deliberate and is the lesson from WI-6364's fix C: a mechanism that REFUSES
 * or ALARMS is only as good as the guard that keeps it silent on a healthy
 * case, because a detector that cries wolf gets ignored and then the one true
 * alarm is lost. Each guard is exercised in isolation so a mutation to it fails
 * exactly its own test.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONVERGENCE_PERSISTENCE_MS,
  formatConvergenceVerdict,
  judgeConvergence,
  type ConvergenceState,
} from './convergence-probe';

const SELF = 'SELFdevicePubkeyBase64AAAAAAAAAAAAAAAAAAAAAAA=';
const PEER = 'PEERdevicePubkeyBase64AAAAAAAAAAAAAAAAAAAAAAA=';
const PEER2 = 'PEER2devicePubkeyBase64AAAAAAAAAAAAAAAAAAAA=';
const STRANGER = 'STRANGERdevicePubkeyBase64AAAAAAAAAAAAAAAAA=';

const NOW = 1_800_000_000_000;

/** The healthy baseline: one attested peer, we mirror exactly what it announced. */
function judge(over: Partial<Parameters<typeof judgeConvergence>[0]> = {}) {
  return judgeConvergence({
    candidateDevicePubkeys: [PEER],
    announced: [{ devicePubkeyBase64: PEER, version: 7 }],
    local: [{ devicePubkeyBase64: PEER, version: 7 }],
    priorState: null,
    nowMs: NOW,
    ...over,
  });
}

describe('judgeConvergence — never fires on a healthy case', () => {
  it('is converged when local equals announced', () => {
    const v = judge();
    expect(v.converged).toBe(true);
    expect(v.behind).toEqual([]);
    expect(v.notConverged).toEqual([]);
    expect(v.judged).toBe(1);
    expect(v.state).toEqual({});
  });

  it('is converged when local is AHEAD of the announcement (we fetched past a stale announce)', () => {
    const v = judge({ local: [{ devicePubkeyBase64: PEER, version: 9 }] });
    expect(v.converged).toBe(true);
    expect(v.behind).toEqual([]);
  });

  it('GUARD 1: ignores SELF — our own device is never judged against its own announcement', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER], // self deliberately absent, as the leg computes it
      announced: [
        { devicePubkeyBase64: PEER, version: 7 },
        { devicePubkeyBase64: SELF, version: 99 }, // we hold no sigrefs row for self here
      ],
      local: [{ devicePubkeyBase64: PEER, version: 7 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.judged).toBe(1);
    expect(v.converged).toBe(true);
  });

  it('GUARD 1: ignores an announcement from a device that is not an attested member', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [
        { devicePubkeyBase64: PEER, version: 7 },
        { devicePubkeyBase64: STRANGER, version: 4_000_000 },
      ],
      local: [{ devicePubkeyBase64: PEER, version: 7 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.judged).toBe(1);
    expect(v.converged).toBe(true);
    expect(v.state[STRANGER]).toBeUndefined();
  });

  it('GUARD 2: a member that has never announced is never judged behind, even with no local mirror', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER, PEER2],
      announced: [{ devicePubkeyBase64: PEER, version: 7 }],
      local: [{ devicePubkeyBase64: PEER, version: 7 }], // nothing at all for PEER2
      priorState: null,
      nowMs: NOW,
    });
    expect(v.judged).toBe(1);
    expect(v.converged).toBe(true);
    expect(v.behind).toEqual([]);
  });

  it('GUARD 5: a malformed announced version is skipped, not trusted', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [
        { devicePubkeyBase64: PEER, version: Number.NaN },
        { devicePubkeyBase64: PEER, version: 1.5 },
        { devicePubkeyBase64: PEER, version: -3 },
      ],
      local: [{ devicePubkeyBase64: PEER, version: 2 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.judged).toBe(0);
    expect(v.converged).toBe(true);
  });

  it('GUARD 3: a recovered device DROPS its prior lag state instead of carrying it', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 7, local: 3, since: NOW - 10 * DEFAULT_CONVERGENCE_PERSISTENCE_MS },
    };
    const v = judge({ priorState });
    expect(v.converged).toBe(true);
    expect(v.state[PEER]).toBeUndefined();
  });

  it('takes the HIGHEST announced version per device, so a replayed old announce cannot mask real lag', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [
        { devicePubkeyBase64: PEER, version: 9 },
        { devicePubkeyBase64: PEER, version: 2 }, // replay of an older announcement, arriving later
      ],
      local: [{ devicePubkeyBase64: PEER, version: 5 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.behind).toHaveLength(1);
    expect(v.behind[0]!.announced).toBe(9);
  });
});

describe('judgeConvergence — GUARD 6: the clock tracks LOCAL PROGRESS, not behind-ness', () => {
  it('a busy peer we trail but keep advancing on NEVER goes persistent, however long it trails', () => {
    // The false-positive that would get this detector disabled: peer announces
    // a new version every tick, we fetch it a tick later. Permanently "behind",
    // permanently HEALTHY.
    let priorState: ConvergenceState | null = null;
    let converged = true;
    for (let tick = 0; tick < 200; tick++) {
      const nowMs = NOW + tick * 5 * 60_000; // 200 ticks ≈ 16 hours
      const v = judgeConvergence({
        candidateDevicePubkeys: [PEER],
        announced: [{ devicePubkeyBase64: PEER, version: 100 + tick }],
        local: [{ devicePubkeyBase64: PEER, version: 99 + tick }], // always one behind, always moving
        priorState,
        nowMs,
      });
      converged &&= v.converged;
      priorState = v.state;
    }
    expect(converged).toBe(true);
  });

  it('a mirror frozen while the pot runs ahead DOES go persistent — the WI-6364 shape', () => {
    let priorState: ConvergenceState | null = null;
    let verdict = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 100 }],
      local: [{ devicePubkeyBase64: PEER, version: 42 }],
      priorState,
      nowMs: NOW,
    });
    // First observation: behind, but NOT yet persistent — one sample proves nothing.
    expect(verdict.behind).toHaveLength(1);
    expect(verdict.converged).toBe(true);

    priorState = verdict.state;
    verdict = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 118 }], // pot ran further ahead
      local: [{ devicePubkeyBase64: PEER, version: 42 }], // we did not move
      priorState,
      nowMs: NOW + DEFAULT_CONVERGENCE_PERSISTENCE_MS + 1,
      });
    expect(verdict.converged).toBe(false);
    expect(verdict.notConverged).toHaveLength(1);
    expect(verdict.notConverged[0]!.local).toBe(42);
    expect(verdict.notConverged[0]!.announced).toBe(118);
    expect(verdict.notConverged[0]!.since).toBe(NOW); // clock carried from the FIRST observation
  });

  it('local progress RESETS the clock even while still behind', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 100, local: 42, since: NOW - 10 * DEFAULT_CONVERGENCE_PERSISTENCE_MS },
    };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 100 }],
      local: [{ devicePubkeyBase64: PEER, version: 43 }], // moved by one — progress
      priorState,
      nowMs: NOW,
    });
    expect(v.converged).toBe(true);
    expect(v.behind[0]!.since).toBe(NOW);
    expect(v.behind[0]!.lagMs).toBe(0);
  });

  it('a cold joiner with no mirror at all is behind but NOT immediately not-converged', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 7 }],
      local: [{ devicePubkeyBase64: PEER, version: null }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.behind).toHaveLength(1);
    expect(v.behind[0]!.local).toBeNull();
    expect(v.converged).toBe(true);
  });

  it('a mirror ABSENT for the whole window goes persistent (the never-seeded stuck joiner)', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 7, local: null, since: NOW - DEFAULT_CONVERGENCE_PERSISTENCE_MS - 1 },
    };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 7 }],
      local: [{ devicePubkeyBase64: PEER, version: null }],
      priorState,
      nowMs: NOW,
    });
    expect(v.converged).toBe(false);
    expect(v.notConverged[0]!.local).toBeNull();
  });

  it('a `since` in the future (clock skew / metadata from another box) reads as no lag, never instant failure', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 100, local: 42, since: NOW + 60 * 60_000 },
    };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 100 }],
      local: [{ devicePubkeyBase64: PEER, version: 42 }],
      priorState,
      nowMs: NOW,
    });
    expect(v.behind[0]!.lagMs).toBe(0);
    expect(v.converged).toBe(true);
  });

  it('judges each device independently — one stuck peer does not clear a healthy one, or vice versa', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 100, local: 42, since: NOW - DEFAULT_CONVERGENCE_PERSISTENCE_MS - 1 },
    };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER, PEER2],
      announced: [
        { devicePubkeyBase64: PEER, version: 100 },
        { devicePubkeyBase64: PEER2, version: 5 },
      ],
      local: [
        { devicePubkeyBase64: PEER, version: 42 },
        { devicePubkeyBase64: PEER2, version: 5 },
      ],
      priorState,
      nowMs: NOW,
    });
    expect(v.judged).toBe(2);
    expect(v.converged).toBe(false);
    expect(v.notConverged).toHaveLength(1);
    expect(v.notConverged[0]!.devicePubkeyBase64).toBe(PEER);
    expect(v.state[PEER2]).toBeUndefined(); // the healthy one carries no state
  });

  it('GUARD 4: never compares versions across devices', () => {
    // PEER2 announces a much higher counter than PEER. If the code ever
    // compared across devices, PEER's local v7 would read as far behind v900.
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER, PEER2],
      announced: [
        { devicePubkeyBase64: PEER, version: 7 },
        { devicePubkeyBase64: PEER2, version: 900 },
      ],
      local: [
        { devicePubkeyBase64: PEER, version: 7 },
        { devicePubkeyBase64: PEER2, version: 900 },
      ],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.converged).toBe(true);
    expect(v.behind).toEqual([]);
  });
});

describe('formatConvergenceVerdict', () => {
  it('says so plainly when there is nothing to compare against', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [],
      local: [],
      priorState: null,
      nowMs: NOW,
    });
    expect(formatConvergenceVerdict(v)).toMatch(/no announced peer snapshots/);
  });

  it('distinguishes healthy trailing from NOT CONVERGED', () => {
    const trailing = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 8 }],
      local: [{ devicePubkeyBase64: PEER, version: 7 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(formatConvergenceVerdict(trailing)).toMatch(/trailing \(healthy/);
    expect(formatConvergenceVerdict(trailing)).not.toMatch(/NOT CONVERGED/);

    const stuck = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 118 }],
      local: [{ devicePubkeyBase64: PEER, version: 42 }],
      priorState: { [PEER]: { announced: 100, local: 42, since: NOW - DEFAULT_CONVERGENCE_PERSISTENCE_MS - 1 } },
      nowMs: NOW,
    });
    const line = formatConvergenceVerdict(stuck);
    expect(line).toMatch(/NOT CONVERGED/);
    expect(line).toMatch(/local v42 < announced v118/);
    expect(line).toMatch(/without local progress/);
  });

  it('names an ABSENT mirror distinctly from a stale one', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 7 }],
      local: [{ devicePubkeyBase64: PEER, version: null }],
      priorState: { [PEER]: { announced: 7, local: null, since: NOW - DEFAULT_CONVERGENCE_PERSISTENCE_MS - 1 } },
      nowMs: NOW,
    });
    expect(formatConvergenceVerdict(v)).toMatch(/local ABSENT < announced v7/);
  });
});
