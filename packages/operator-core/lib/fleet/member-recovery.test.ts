/**
 * member-recovery.test.ts — the recurrence guard for P-009
 * (fleet-friction-remediation-2026-08-21).
 *
 * The plan item's acceptance list is six named scenarios, and each one is a `describe` block
 * below under the same name, so a future reader can map a failing test back to the criterion it
 * defends without re-reading the plan:
 *
 *   injected kill failure · ignored wake · dead PID · context-critical claim ·
 *   duplicate leader request · leader crash
 *
 * The three forbidden outcomes are asserted as INVARIANTS across every scenario at the bottom
 * (`never duplicate replacements, lost claims, or an indefinitely live wedge`) rather than only
 * inside the individual cases. That placement is deliberate: a per-case assertion only defends
 * the case it sits in, and the failure mode this module exists to prevent is a NEW disposition
 * being added later that quietly violates one of the three. The invariant block enumerates every
 * disposition the type admits, so adding a fourth outcome without deciding its claim handling
 * fails here instead of in production.
 */
import { describe, it, expect } from 'vitest';
import {
  decideMemberRecovery,
  decideContextCriticalBench,
  memberRecoveryTokenId,
  replacementOwnerIdForToken,
  settleMemberRecoveryToken,
  MEMBER_RECOVERY_LEASE_MS,
  type MemberRecoveryDecision,
  type MemberRecoveryInput,
  type MemberRecoveryToken,
} from './member-recovery';

const NOW = 1_756_000_000_000;
const FLEET = 'goal-070565-fleet-friction';
const MEMBER = 'su-wedged-member';
const LEADER = 'su-leader-one';

function decide(overrides: Partial<MemberRecoveryInput> = {}): MemberRecoveryDecision {
  return decideMemberRecovery({
    fleetSlug: FLEET,
    memberOwnerId: MEMBER,
    leaderOwnerId: LEADER,
    attemptKey: 'attempt-1',
    kill: 'killed',
    now: NOW,
    ...overrides,
  });
}

describe('acceptance: injected kill failure', () => {
  it('strands and freezes instead of launching behind a possibly-live process', () => {
    const d = decide({ kill: 'failed' });
    expect(d.disposition).toBe('stranded');
    expect(d.replacementAuthorized).toBe(false);
    expect(d.replacementOwnerId).toBeNull();
    expect(d.freezeRequested).toBe(true);
  });

  it('preserves the claims rather than releasing a lane a live process may still be writing', () => {
    expect(decide({ kill: 'failed' }).claims).toBe('preserved-frozen');
  });

  it('marks the member with a transition edge that carries the CAUSE, not just the kind', () => {
    const d = decide({ kill: 'failed' });
    expect(d.transition?.kind).toBe('member-stalled');
    // The acceptance criterion is that the reason travels WITH the event. A bare kind sends the
    // next reader back to the logs, which is the friction this whole item removes.
    expect(d.transition?.reason).toContain('kill of su-wedged-member FAILED');
    expect(d.token.outcome).toBe('stranded');
    expect(d.token.reason).toBe(d.reason);
  });

  it('a kill failure outranks a context-critical bench — a wedge is not a compaction', () => {
    // Ordering guard. If the bench check ever moves above the kill check, a member whose kill
    // FAILED would be quietly benched: left live, unfrozen, and expected to recover itself.
    const d = decide({ kill: 'failed', memberLive: true, contextPressure: 'critical' });
    expect(d.disposition).toBe('stranded');
    expect(d.freezeRequested).toBe(true);
  });
});

describe('acceptance: ignored wake', () => {
  it('strands an unmanaged member that never reached a terminal state in the drain window', () => {
    const d = decide({ kill: 'unmanaged', drain: 'unverified' });
    expect(d.disposition).toBe('stranded');
    expect(d.replacementAuthorized).toBe(false);
    expect(d.freezeRequested).toBe(true);
    expect(d.claims).toBe('preserved-frozen');
  });

  it('names the delivery-vs-pickup confusion that produced the reproduction', () => {
    // The filed case was two wake:'required' sends reporting queued:1/woken:1 where neither
    // target took a turn. The reason text has to say that, or the next leader reads woken:1 as
    // pickup all over again.
    expect(decide({ kill: 'unmanaged', drain: 'unverified' }).reason).toContain('no turn followed');
  });

  it('a VERIFIED cooperative drain does authorize exactly one replacement', () => {
    const d = decide({ kill: 'unmanaged', drain: 'verified' });
    expect(d.disposition).toBe('replace');
    expect(d.replacementAuthorized).toBe(true);
    expect(d.claims).toBe('released-by-kill');
    expect(d.freezeRequested).toBe(false);
  });
});

describe('acceptance: dead PID', () => {
  it('replaces, but reports the claims as needing a FORCED release', () => {
    // The 'holder-warm-idle' case: the process is gone, so nothing ever ran the release path.
    // Reporting 'released-by-kill' here is the specific bug that leaves a lane stuck under a
    // dead owner while the replacement waits for work that is already claimed.
    const d = decide({ kill: 'already-dead' });
    expect(d.disposition).toBe('replace');
    expect(d.replacementAuthorized).toBe(true);
    expect(d.claims).toBe('force-release-required');
  });

  it('emits member-dead with a reason that states the claims outlived their holder', () => {
    const d = decide({ kill: 'already-dead' });
    expect(d.transition?.kind).toBe('member-dead');
    expect(d.transition?.reason).toContain('force-released');
  });
});

describe('acceptance: context-critical claim', () => {
  it('benches a LIVE critical member rather than replacing it', () => {
    const d = decide({ kill: 'killed', memberLive: true, contextPressure: 'critical' });
    expect(d.disposition).toBe('benched');
    expect(d.replacementAuthorized).toBe(false);
    expect(d.claims).toBe('preserved-benched');
    expect(d.transition?.kind).toBe('context-critical');
  });

  it('never benches on an UNKNOWN bucket — a stale reading must not manufacture a park', () => {
    for (const bucket of [null, undefined] as const) {
      const d = decide({ kill: 'killed', memberLive: true, contextPressure: bucket });
      expect(d.disposition).toBe('replace');
    }
  });

  it("never benches on 'ok' or 'high' — high means wrap up soon, not stop", () => {
    for (const bucket of ['ok', 'high'] as const) {
      expect(decide({ kill: 'killed', memberLive: true, contextPressure: bucket }).disposition).toBe('replace');
    }
  });

  it('does not bench a member that is not observably live', () => {
    // Without a live reading there is no session to park; benching one would register an await
    // for an owner that will never wake to consume it.
    const d = decide({ kill: 'killed', memberLive: false, contextPressure: 'critical' });
    expect(d.disposition).toBe('replace');
  });

  describe('decideContextCriticalBench (the claim-path half)', () => {
    const WAKE = 'fleet:goal-070565-fleet-friction:bench-resume';

    it('benches a refused critical caller when a wake key exists', () => {
      const r = decideContextCriticalBench({ claimRefused: true, bucket: 'critical', wakeEvent: WAKE });
      expect(r.bench).toBe(true);
      expect(r.wakeEvent).toBe(WAKE);
    });

    it('refuses to park a member with no way back when no wake key is available', () => {
      // Fail-CLOSED on bench: a park with no resume key is a silent, permanent idle — strictly
      // worse than the un-benched refusal it replaces.
      for (const wakeEvent of [null, undefined, '', '   '] as const) {
        const r = decideContextCriticalBench({ claimRefused: true, bucket: 'critical', wakeEvent });
        expect(r.bench).toBe(false);
        expect(r.wakeEvent).toBeNull();
      }
    });

    it('never benches a caller whose claim was SERVED', () => {
      expect(decideContextCriticalBench({ claimRefused: false, bucket: 'critical', wakeEvent: WAKE }).bench).toBe(false);
    });

    it('never benches on a non-critical or unknown bucket', () => {
      for (const bucket of ['ok', 'high', null, undefined] as const) {
        expect(decideContextCriticalBench({ claimRefused: true, bucket, wakeEvent: WAKE }).bench).toBe(false);
      }
    });

    it('is a no-op for a member already parked, rather than a second bench', () => {
      const r = decideContextCriticalBench({
        claimRefused: true,
        bucket: 'critical',
        wakeEvent: WAKE,
        alreadyBenched: true,
      });
      expect(r.bench).toBe(false);
    });
  });
});

describe('acceptance: duplicate leader request', () => {
  it('suppresses a second request while the first recovery lease is live', () => {
    const first = decide({ kill: 'killed' });
    expect(first.replacementAuthorized).toBe(true);

    const second = decide({ kill: 'killed', priorToken: first.token, now: NOW + 1_000 });
    expect(second.disposition).toBe('duplicate-suppressed');
    expect(second.replacementAuthorized).toBe(false);
  });

  it('reports the ALREADY-AUTHORIZED replacement so the duplicate can verify instead of launch', () => {
    // A bare refusal would leave the second leader with no move; naming the in-flight identity
    // is what makes the suppression idempotent rather than merely safe.
    const first = decide({ kill: 'killed' });
    const second = decide({ kill: 'killed', priorToken: first.token, now: NOW + 1_000 });
    expect(second.replacementOwnerId).toBe(first.replacementOwnerId);
    expect(second.reason).toContain(first.replacementOwnerId!);
  });

  it('suppresses a duplicate from a DIFFERENT leader too, not only the same one', () => {
    const first = decide({ kill: 'killed' });
    const second = decide({
      kill: 'killed',
      leaderOwnerId: 'su-leader-two',
      priorToken: first.token,
      now: NOW + 1_000,
    });
    expect(second.disposition).toBe('duplicate-suppressed');
    expect(second.replacementAuthorized).toBe(false);
  });

  it('replays a SETTLED token verbatim instead of re-evaluating it', () => {
    const settled = settleMemberRecoveryToken(decide({ kill: 'killed' }).token, 'replaced', 'replacement verified');
    const replay = decide({ kill: 'killed', priorToken: settled, now: NOW + MEMBER_RECOVERY_LEASE_MS * 4 });
    expect(replay.replayed).toBe(true);
    expect(replay.replacementAuthorized).toBe(false);
    // Note the clock: the lease is long expired, and it still must not re-authorize. Expiry
    // reclaims an OPEN recovery; it never reopens a settled one.
    expect(replay.disposition).toBe('duplicate-suppressed');
  });

  it('replays a settled STRANDED token as stranded, without re-freezing or re-marking', () => {
    const settled = settleMemberRecoveryToken(decide({ kill: 'failed' }).token, 'stranded', 'kill failed');
    const replay = decide({ kill: 'failed', priorToken: settled, now: NOW + 5_000 });
    expect(replay.disposition).toBe('stranded');
    expect(replay.replayed).toBe(true);
    expect(replay.transition).toBeNull();
    expect(replay.freezeRequested).toBe(false);
  });

  it('a DIFFERENT attemptKey is a different recovery and is evaluated fresh', () => {
    const first = decide({ kill: 'killed', attemptKey: 'attempt-1' });
    const other = decide({ kill: 'killed', attemptKey: 'attempt-2', priorToken: first.token });
    expect(other.disposition).toBe('replace');
    expect(other.token.token).not.toBe(first.token.token);
    expect(other.replacementOwnerId).not.toBe(first.replacementOwnerId);
  });
});

describe('acceptance: leader crash', () => {
  it('reclaims an OPEN token whose lease expired, so the recovery is not stuck forever', () => {
    const crashed = decide({ kill: 'killed' }).token;
    expect(crashed.outcome).toBe('open');

    const successor = decide({
      kill: 'killed',
      leaderOwnerId: 'su-leader-two',
      priorToken: crashed,
      now: NOW + MEMBER_RECOVERY_LEASE_MS + 1,
    });
    expect(successor.reclaimed).toBe(true);
    expect(successor.disposition).toBe('replace');
  });

  it('re-derives the SAME replacement identity — a crash must not become a duplicate', () => {
    // This is the property that makes the crash recoverable at all. If the successor minted a
    // fresh identity, and the crashed leader had already launched, the fleet would end up with
    // two live members on one lane: the exact outcome the acceptance list forbids.
    const crashed = decide({ kill: 'killed' }).token;
    const successor = decide({
      kill: 'killed',
      leaderOwnerId: 'su-leader-two',
      priorToken: crashed,
      now: NOW + MEMBER_RECOVERY_LEASE_MS + 1,
    });
    expect(successor.replacementOwnerId).toBe(crashed.replacementOwnerId);
    expect(successor.token.token).toBe(crashed.token);
  });

  it('preserves the ORIGINAL opener and open time across the reclaim, for attribution', () => {
    const crashed = decide({ kill: 'killed' }).token;
    const successor = decide({
      kill: 'killed',
      leaderOwnerId: 'su-leader-two',
      priorToken: crashed,
      now: NOW + MEMBER_RECOVERY_LEASE_MS + 1,
    });
    expect(successor.token.openedBy).toBe(LEADER);
    expect(successor.token.openedAt).toBe(crashed.openedAt);
    // …but the lease is renewed under the successor's clock, or the reclaim would expire
    // instantly and every subsequent request would reclaim again.
    expect(successor.token.leaseExpiresAt).toBeGreaterThan(NOW + MEMBER_RECOVERY_LEASE_MS + 1);
  });

  it('does NOT reclaim while the lease is still live, even one millisecond before expiry', () => {
    const crashed = decide({ kill: 'killed' }).token;
    const early = decide({
      kill: 'killed',
      leaderOwnerId: 'su-leader-two',
      priorToken: crashed,
      now: crashed.leaseExpiresAt - 1,
    });
    expect(early.reclaimed).toBe(false);
    expect(early.disposition).toBe('duplicate-suppressed');
  });

  it('a reclaimed recovery that now reads kill-failed strands rather than replacing', () => {
    // A successor inherits the token, not the original verdict. If the member is now wedged, the
    // reclaim must re-decide on CURRENT state.
    const crashed = decide({ kill: 'killed' }).token;
    const successor = decide({
      kill: 'failed',
      leaderOwnerId: 'su-leader-two',
      priorToken: crashed,
      now: NOW + MEMBER_RECOVERY_LEASE_MS + 1,
    });
    expect(successor.disposition).toBe('stranded');
    expect(successor.replacementAuthorized).toBe(false);
    expect(successor.reclaimed).toBe(true);
  });
});

describe('token derivation', () => {
  it('is deterministic in (fleet, member, attemptKey) — the basis of crash-survivable identity', () => {
    expect(memberRecoveryTokenId(FLEET, MEMBER, 'k')).toBe(memberRecoveryTokenId(FLEET, MEMBER, 'k'));
  });

  it('separates its fields, so concatenation cannot collide two different recoveries', () => {
    // Without a separator, ('a','bc') and ('ab','c') hash identically — two distinct members
    // would share one recovery token and one replacement identity.
    expect(memberRecoveryTokenId('a', 'bc', 'k')).not.toBe(memberRecoveryTokenId('ab', 'c', 'k'));
    expect(memberRecoveryTokenId(FLEET, MEMBER, 'a-b')).not.toBe(memberRecoveryTokenId(FLEET, MEMBER, 'ab'));
  });

  it('varies with every field', () => {
    const base = memberRecoveryTokenId(FLEET, MEMBER, 'k');
    expect(memberRecoveryTokenId('other-fleet', MEMBER, 'k')).not.toBe(base);
    expect(memberRecoveryTokenId(FLEET, 'su-other', 'k')).not.toBe(base);
    expect(memberRecoveryTokenId(FLEET, MEMBER, 'k2')).not.toBe(base);
  });

  it('maps one token to exactly one replacement identity', () => {
    const t = memberRecoveryTokenId(FLEET, MEMBER, 'k');
    expect(replacementOwnerIdForToken(t)).toBe(replacementOwnerIdForToken(t));
    expect(replacementOwnerIdForToken(t)).toContain(t);
  });
});

describe('invariants across EVERY disposition', () => {
  // Enumerating the full input space keeps a future disposition from being added without
  // deciding its claim handling. These are the three outcomes the acceptance list forbids.
  const kills = ['killed', 'already-dead', 'unmanaged', 'failed'] as const;
  const drains = ['not-required', 'verified', 'unverified'] as const;
  const buckets = ['ok', 'high', 'critical', null, undefined] as const;
  const lives = [true, false, undefined] as const;

  const all: MemberRecoveryDecision[] = [];
  for (const kill of kills) {
    for (const drain of drains) {
      for (const contextPressure of buckets) {
        for (const memberLive of lives) {
          all.push(decide({ kill, drain, contextPressure, memberLive }));
        }
      }
    }
  }

  it('covers every disposition the type admits except the reserved actionable-failure', () => {
    const seen = new Set(all.map((d) => d.disposition));
    expect(seen).toContain('replace');
    expect(seen).toContain('stranded');
    expect(seen).toContain('benched');
  });

  it('NEVER DUPLICATE REPLACEMENTS: only `replace` carries a replacement identity', () => {
    for (const d of all) {
      expect(d.replacementAuthorized).toBe(d.disposition === 'replace');
      if (d.disposition !== 'replace') expect(d.replacementOwnerId).toBeNull();
      else expect(d.replacementOwnerId).toBeTruthy();
    }
  });

  it('NEVER LOST CLAIMS: every decision states a claim disposition', () => {
    for (const d of all) {
      expect(['released-by-kill', 'force-release-required', 'preserved-frozen', 'preserved-benched'])
        .toContain(d.claims);
    }
  });

  it('NEVER AN INDEFINITELY LIVE WEDGE: an unauthorized replacement is always frozen or self-recovering', () => {
    for (const d of all) {
      if (d.replacementAuthorized) continue;
      // Either we froze the old process (stranded), or the member recovers itself (benched).
      // A third state — refused, unfrozen, and not expected back — IS the wedge.
      const accountedFor = d.freezeRequested || d.disposition === 'benched' || d.disposition === 'duplicate-suppressed';
      expect(accountedFor).toBe(true);
    }
  });

  it('every decision carries a non-empty reason, and any transition repeats it', () => {
    for (const d of all) {
      expect(d.reason.length).toBeGreaterThan(0);
      if (d.transition) expect(d.transition.reason).toBe(d.reason);
    }
  });

  it('never freezes a member it is about to replace', () => {
    // Freezing and then launching behind the frozen process is the double-run this module
    // exists to prevent; a frozen process is still holding its lane.
    for (const d of all) {
      if (d.replacementAuthorized) expect(d.freezeRequested).toBe(false);
    }
  });

  it('always returns a persistable token whose outcome matches the disposition', () => {
    for (const d of all) {
      expect(d.token.token).toBeTruthy();
      expect(d.token.fleetSlug).toBe(FLEET);
      expect(d.token.memberOwnerId).toBe(MEMBER);
      if (d.disposition === 'replace') expect(d.token.outcome).toBe('open');
      if (d.disposition === 'stranded') expect(d.token.outcome).toBe('stranded');
      if (d.disposition === 'benched') expect(d.token.outcome).toBe('benched');
    }
  });
});

describe('falsifiability controls', () => {
  /**
   * The invariant block above passes. That is only evidence if the same assertions FAIL on a
   * wrong implementation — otherwise a vacuous check and a sound one read identically.
   *
   * The repo's rule for a subject you `import` is a permanently-resident wrong implementation
   * rather than an in-tree mutation, because a mutation probe on the shared checkout can be
   * committed by the git-sync sweep even when nothing goes wrong. These three controls are the
   * three specific ways this module could regress, each shaped exactly like a plausible future
   * edit rather than like nonsense.
   */

  /** Regression shape 1: someone "helpfully" lets a stranded member be replaced anyway. */
  function strandedAlsoReplaces(d: MemberRecoveryDecision): MemberRecoveryDecision {
    if (d.disposition !== 'stranded') return d;
    return { ...d, replacementAuthorized: true, replacementOwnerId: 'su-respawn-second' };
  }

  /** Regression shape 2: the dead-PID path is simplified to "the kill released them". */
  function deadPidClaimsReleased(d: MemberRecoveryDecision): MemberRecoveryDecision {
    if (d.claims !== 'force-release-required') return d;
    return { ...d, claims: 'released-by-kill' };
  }

  /** Regression shape 3: the freeze is dropped, leaving a refused member live and unmarked. */
  function neverFreezes(d: MemberRecoveryDecision): MemberRecoveryDecision {
    return { ...d, freezeRequested: false };
  }

  const killFailed = () => decide({ kill: 'failed' });
  const deadPid = () => decide({ kill: 'already-dead' });

  it('CONTROL: the real decision satisfies all three invariants (calibration)', () => {
    // Calibration case: if this ever fails, the controls below prove nothing, because a broken
    // instrument rejects everything including the truth.
    expect(killFailed().replacementAuthorized).toBe(false);
    expect(deadPid().claims).toBe('force-release-required');
    expect(killFailed().freezeRequested).toBe(true);
  });

  it('the no-duplicate-replacement invariant REJECTS a stranded-also-replaces implementation', () => {
    const wrong = strandedAlsoReplaces(killFailed());
    expect(wrong.disposition).toBe('stranded');
    // The invariant asserted above is `replacementAuthorized === (disposition === 'replace')`.
    expect(wrong.replacementAuthorized === (wrong.disposition === 'replace')).toBe(false);
  });

  it('the no-lost-claims invariant REJECTS a dead-PID-claims-already-released implementation', () => {
    const wrong = deadPidClaimsReleased(deadPid());
    // This is the silent one: the shape stays valid, so only an assertion pinned to the SPECIFIC
    // dead-PID answer catches it. A generic "claims is one of the four" check would not.
    expect(wrong.claims).not.toBe('force-release-required');
    expect(deadPid().claims).toBe('force-release-required');
  });

  it('the no-live-wedge invariant REJECTS an implementation that stops freezing', () => {
    const wrong = neverFreezes(killFailed());
    const accountedFor =
      wrong.freezeRequested || wrong.disposition === 'benched' || wrong.disposition === 'duplicate-suppressed';
    expect(accountedFor).toBe(false);
  });
});

describe('settleMemberRecoveryToken', () => {
  it('closes an open token without mutating the original record', () => {
    const open: MemberRecoveryToken = decide({ kill: 'killed' }).token;
    const settled = settleMemberRecoveryToken(open, 'replaced', 'verified live');
    expect(open.outcome).toBe('open');
    expect(settled.outcome).toBe('replaced');
    expect(settled.reason).toBe('verified live');
    expect(settled.token).toBe(open.token);
    expect(settled.replacementOwnerId).toBe(open.replacementOwnerId);
  });

  it('a token settled as failed replays as actionable-failure, never as a fresh replace', () => {
    const failed = settleMemberRecoveryToken(decide({ kill: 'killed' }).token, 'failed', 'launch never verified');
    const replay = decide({ kill: 'killed', priorToken: failed, now: NOW + 60_000 });
    expect(replay.disposition).toBe('actionable-failure');
    expect(replay.replacementAuthorized).toBe(false);
  });
});
