/**
 * leadership-disposition.test.ts — P-004 / D-096.
 *
 * These are guards on the ways this rule could STEAL LEADERSHIP FROM A LIVE
 * LEADER, not a restatement of the implementation. `fleet:leader-brief` is a READ
 * that 27 distinct callers make hundreds of times a month; a false auto-claim
 * demotes a working leader mid-supervision and notifies them they were replaced.
 */
import { describe, expect, it } from 'vitest';
import {
  decideLeadershipDisposition,
  buildNotLeaderNotice,
  LEADER_GONE_STATES,
} from './leadership-disposition';
import type { SessionState } from '../coordination/presence-wakeability';

const CALLER = 'su-de6e9643-2fa0-4a4f-86f3-2f9e9c7f2e0d';
const OTHER = 'su-4ca244e4-540e-4acc-bb67-9335192fc85f';

describe('decideLeadershipDisposition (P-004 / D-096)', () => {
  it('leaves the registered leader alone', () => {
    expect(
      decideLeadershipDisposition({
        callerOwnerId: CALLER,
        registeredLeader: CALLER,
        leaderSessionState: 'live',
      }),
    ).toEqual({ kind: 'is-leader' });
  });

  it('auto-claims a fleet with NO registered leader — the unambiguous half', () => {
    // Nothing to take from, so the asymmetry does not apply.
    expect(
      decideLeadershipDisposition({
        callerOwnerId: CALLER,
        registeredLeader: null,
        leaderSessionState: undefined,
      }),
    ).toEqual({ kind: 'auto-claim', reason: 'no-registered-leader', previousLeader: null });
  });

  it('auto-claims ONLY on positive evidence the incumbent is gone', () => {
    for (const state of LEADER_GONE_STATES) {
      expect(
        decideLeadershipDisposition({
          callerOwnerId: CALLER,
          registeredLeader: OTHER,
          leaderSessionState: state,
        }),
        `${state} is affirmatively gone`,
      ).toEqual({ kind: 'auto-claim', reason: 'registered-leader-gone', previousLeader: OTHER });
    }
  });

  it('NEVER auto-claims from a leader in any live or ambiguous state', () => {
    // THE FALSE AUTO-CLAIM THIS FILE EXISTS TO PREVENT. `suspect` is the one worth
    // staring at: it means "a claim is not progressing", which a slow turn produces
    // just as readily as a corpse — so it must not be read as death.
    const notGone: SessionState[] = ['live', 'parked', 'draining', 'suspect'];
    for (const state of notGone) {
      const d = decideLeadershipDisposition({
        callerOwnerId: CALLER,
        registeredLeader: OTHER,
        leaderSessionState: state,
      });
      expect(d.kind, `${state} must NOT be seized`).toBe('not-leader');
    }
  });

  it('treats a leader MISSING from the roster as unknown, never as dead', () => {
    // Absence of evidence is not evidence of absence — and this is the case the
    // include_stale filter produces for a live-but-idle leader, so getting it
    // wrong steals leadership during ordinary quiet periods.
    for (const missing of [undefined, null]) {
      const d = decideLeadershipDisposition({
        callerOwnerId: CALLER,
        registeredLeader: OTHER,
        leaderSessionState: missing,
      });
      expect(d).toEqual({ kind: 'not-leader', leader: OTHER, leaderState: 'not-in-roster' });
    }
  });

  it('serves the brief unchanged when identity did not resolve', () => {
    // A read must not start failing because identity resolution degraded, and
    // there is nobody to install as leader anyway.
    expect(
      decideLeadershipDisposition({
        callerOwnerId: undefined,
        registeredLeader: OTHER,
        leaderSessionState: 'ended',
      }),
    ).toEqual({ kind: 'is-leader' });
  });
});

describe('buildNotLeaderNotice', () => {
  it('names the incumbent, its state, and the exact claim call', () => {
    const notice = buildNotLeaderNotice(
      { kind: 'not-leader', leader: OTHER, leaderState: 'live' },
      'my-fleet',
    );
    expect(notice.registeredLeader).toBe(OTHER);
    expect(notice.leaderState).toBe('live');
    expect(notice.claimWith).toBe('fleet:take-leadership { fleet: "my-fleet" }');
    // The caller must be told it is acting WITHOUT the authority it assumed.
    expect(notice.reason).toMatch(/NOT the registered leader/);
  });

  it('distinguishes an UNKNOWN leader from a live one in the reason', () => {
    // Collapsing these two would tell a caller its leader is alive when the
    // honest answer is that we do not know.
    const unknown = buildNotLeaderNotice(
      { kind: 'not-leader', leader: OTHER, leaderState: 'not-in-roster' },
      'my-fleet',
    );
    expect(unknown.reason).toMatch(/UNKNOWN \(not proven dead\)/);
    expect(unknown.reason).not.toMatch(/reads 'not-in-roster'/);
  });
});
