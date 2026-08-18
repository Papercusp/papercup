/**
 * The point of this marker is that a reader NEVER has to infer which sha a run is judging, so
 * these tests are written against the misreadings that inference actually produced — each case
 * names the real incident it prevents rather than just exercising a branch.
 */
import { describe, expect, it } from 'vitest';

import {
  IN_FLIGHT_CANDIDATE_MAX_AGE_MS,
  describeInFlightCandidate,
  parseInFlightCandidate,
  type StoredInFlightCandidate,
} from './in-flight-candidate';

const NOW = 1_785_000_000_000;

function marker(over: Partial<StoredInFlightCandidate> = {}): StoredInFlightCandidate {
  return {
    candidate: 'd5fcc6149021aea811a9fe7b4927ea0a444afff7',
    base: '1e0ddc58645453a9edb3faa394e3d5019b2e7060',
    selectedAtMs: NOW - 60_000,
    quietCutApplied: true,
    tipAtSelection: 'c333084918aa11bb22cc33dd44ee55ff66aa77bb',
    refireDepth: 0,
    pid: 1884596,
    observedAtMs: NOW - 60_000,
    ...over,
  };
}

describe('parseInFlightCandidate', () => {
  it('round-trips every published field — a field added to the interface but dropped here is persisted-but-unread', () => {
    // The exact regression EI-19343516395023183 caught on the sibling marker: charged/totalRefires/
    // absoluteCeiling were written by both publish sites and reached NO reader, so consumers
    // rendered a budget whose ceiling they could not see. An explicit object literal makes that
    // failure silent, so it is asserted field-by-field rather than by shape.
    const parsed = parseInFlightCandidate(marker(), NOW);
    expect(parsed).toEqual(marker());
  });

  it('returns null for a marker older than the freshness bound — an abandoned run must not read as live', () => {
    const stale = marker({ observedAtMs: NOW - IN_FLIGHT_CANDIDATE_MAX_AGE_MS - 1 });
    expect(parseInFlightCandidate(stale, NOW)).toBeNull();
  });

  it('keeps a marker exactly at the bound — a ~55min suite plus refires is legitimately long', () => {
    const old = marker({ observedAtMs: NOW - IN_FLIGHT_CANDIDATE_MAX_AGE_MS });
    expect(parseInFlightCandidate(old, NOW)?.candidate).toBe(marker().candidate);
  });

  it.each([
    ['null', null],
    ['a string', 'd5fcc614'],
    ['an empty object', {}],
    ['a blank candidate', { candidate: '', selectedAtMs: NOW, observedAtMs: NOW }],
    ['no candidate', { selectedAtMs: NOW, observedAtMs: NOW }],
    ['no observedAtMs', { candidate: 'abc', selectedAtMs: NOW }],
  ])('returns null for %s rather than a half-populated marker', (_label, raw) => {
    // A partially-parsed marker is worse than none: it would answer "which sha" with a confident
    // blank, which is the shape of every proxy this module replaces.
    expect(parseInFlightCandidate(raw, NOW)).toBeNull();
  });

  it('defaults refireDepth to 0 and quietCutApplied to false when absent, never to a truthy guess', () => {
    const parsed = parseInFlightCandidate({ candidate: 'abc123', selectedAtMs: NOW, observedAtMs: NOW }, NOW);
    expect(parsed).toMatchObject({ refireDepth: 0, quietCutApplied: false, tipAtSelection: null, base: null });
  });
});

describe('describeInFlightCandidate', () => {
  it('names the candidate and its age — the two facts a reader otherwise reconstructs by hand', () => {
    const line = describeInFlightCandidate(marker({ quietCutApplied: false, tipAtSelection: null }), NOW);
    expect(line).toContain('judging d5fcc6149021');
    expect(line).toContain('60s ago');
  });

  it('says the candidate MOVED IN-PROCESS on a refire — the signature repeatedly misread as corruption', () => {
    // A refire recurses in the SAME process, so pid/started_at stay fixed while the candidate
    // advances. CLAUDE.md records agents reading that as a bogus field and firing a manual run,
    // which discards the very rescue in progress.
    const line = describeInFlightCandidate(marker({ refireDepth: 2 }), NOW);
    expect(line).toContain('auto-refire #2');
    expect(line).toMatch(/pid\/started_at did not/);
  });

  it('reports the quiet cut as deliberate exclusion, so "my commit is missing" is not read as a fault', () => {
    // The single most misread behaviour of this gate: a fresh commit is NOT judged, by design.
    const line = describeInFlightCandidate(marker(), NOW);
    expect(line).toContain('quiet cut stepped back from tip c3330849');
    expect(line).toContain('deliberately NOT judged');
  });

  it('omits the quiet-cut clause when it did not apply, rather than printing an empty one', () => {
    const line = describeInFlightCandidate(marker({ quietCutApplied: false, tipAtSelection: null }), NOW);
    expect(line).not.toContain('quiet cut');
  });
});

/**
 * The detector for a run that DIED without a verdict. Written against the 2026-08-17 incident
 * (agent-insights/green-checkpoint-refire-lost-to-bg-host-restart): an auto-refire onto
 * f16fa1c7030d published its marker and then vanished with its bg-host generation, leaving a
 * marker that read "in flight" for hours. A peer spent a claim waiting on that verdict.
 */
describe('judgeAbandonedInFlightCandidate', () => {
  it('never reports a run\'s OWN marker as lost — an in-process refire re-publishes over itself', () => {
    // The healthy rescue path re-enters runGreenCheckpoint recursively with pid UNCHANGED. A
    // detector that fired here would cry wolf on every refire and be switched off within a day.
    const verdict = judgeAbandonedInFlightCandidate(marker({ pid: 4242, refireDepth: 2 }), {
      selfPid: 4242,
      pidAlive: true,
      nowMs: NOW,
    });
    expect(verdict).toEqual({ abandoned: false, reason: 'own-run' });
  });

  it('reports a dead pid as an abandoned run', () => {
    const verdict = judgeAbandonedInFlightCandidate(marker({ pid: 763041 }), {
      selfPid: 226009,
      pidAlive: false,
      nowMs: NOW,
    });
    expect(verdict.abandoned).toBe(true);
    expect(verdict.abandoned && verdict.reason).toBe('dead-pid');
  });

  it('prefers the host-generation stamp over a LIVE pid — pid reuse must not mask a real loss', () => {
    // PID wrap happens ~daily on this box under fleet load, so a dead run's pid can be recycled by
    // an unrelated process and probe as alive. If `pid-alive` were checked first, that recycled pid
    // would silently convert a real loss into "still running" — the exact reading this exists to
    // kill. Ordering is the assertion here, not merely the returned reason.
    const hostStartedAtMs = NOW - 30_000;
    const verdict = judgeAbandonedInFlightCandidate(
      marker({ pid: 763041, observedAtMs: hostStartedAtMs - 1 }),
      { selfPid: 226009, pidAlive: true, hostStartedAtMs, nowMs: NOW },
    );
    expect(verdict.abandoned).toBe(true);
    expect(verdict.abandoned && verdict.reason).toBe('predates-host-generation');
  });

  it('does NOT report a loss when the pid probe could not determine liveness', () => {
    // A dead instrument reads exactly like a clean result. This writes a loud durable record, so an
    // undeterminable probe must yield "not abandoned" rather than manufacture a loss.
    const verdict = judgeAbandonedInFlightCandidate(marker({ pid: 763041 }), {
      selfPid: 226009,
      pidAlive: null,
      nowMs: NOW,
    });
    expect(verdict).toEqual({ abandoned: false, reason: 'pid-unknown' });
  });

  it('leaves a genuinely live foreign run alone', () => {
    const verdict = judgeAbandonedInFlightCandidate(marker({ pid: 763041 }), {
      selfPid: 226009,
      pidAlive: true,
      nowMs: NOW,
    });
    expect(verdict).toEqual({ abandoned: false, reason: 'pid-alive' });
  });

  it('treats an absent marker as nothing to report', () => {
    expect(judgeAbandonedInFlightCandidate(null, { selfPid: 1, pidAlive: null, nowMs: NOW })).toEqual({
      abandoned: false,
      reason: 'no-marker',
    });
  });
});

describe('isPidAlive', () => {
  it('sees this very process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false — not null — for a pid that does not exist', () => {
    // The distinction is the whole detector: `false` is a loss, `null` is an unreadable instrument.
    expect(isPidAlive(0x7ffffffe)).toBe(false);
  });

  it('returns null for a nonsense pid rather than guessing', () => {
    expect(isPidAlive(0)).toBeNull();
    expect(isPidAlive(-1)).toBeNull();
    expect(isPidAlive(1.5)).toBeNull();
  });
});

describe('describeAbandonedInFlightCandidate', () => {
  it('states outright that no verdict is coming — the sentence that ends the waiting', () => {
    const verdict = judgeAbandonedInFlightCandidate(
      marker({ pid: 763041, candidate: 'f16fa1c7030d4e5a6b7c8d9e0f1a2b3c4d5e6f70', refireDepth: 1 }),
      { selfPid: 226009, pidAlive: false, nowMs: NOW },
    );
    const line = describeAbandonedInFlightCandidate(verdict);
    expect(line).toContain('NO VERDICT IS COMING FOR f16fa1c7030d');
    // A refire is named as such, because "the candidate moved" is otherwise read as corruption.
    expect(line).toContain('auto-refire #1');
    expect(line).toContain('RECURSIVELY IN THE SAME PROCESS');
  });

  it('returns null for a healthy marker, so callers can log unconditionally', () => {
    expect(
      describeAbandonedInFlightCandidate({ abandoned: false, reason: 'pid-alive' }),
    ).toBeNull();
  });
});
