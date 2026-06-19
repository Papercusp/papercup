/**
 * Teeth-verified unit tests for the P-MEMBER admission decision
 * (Brief EN-3 / hive-membership-policy.ts).
 *
 * Each enforcement property is paired with the "neuter → RED" idiom the brief
 * mandates: the refuse/pending assertions only hold while the corresponding check
 * is live, so neutering `isAllowlisted` (→ always-true) or `isBannedGithubId`
 * (→ always-false) flips a test RED — the signal the gate stopped enforcing.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateMembershipAdmission,
  isBannedGithubId,
  isAllowlisted,
  type MembershipPolicyView,
} from './hive-membership-policy';

const alice = { githubUserId: 1001, githubUsername: 'alice' };
const mallory = { githubUserId: 6666, githubUsername: 'mallory' };

describe('evaluateMembershipAdmission — default / open (existing hives unaffected)', () => {
  it('null policy ⇒ admit (no policy = no enforcement, EN-1 guarantee #2)', () => {
    expect(evaluateMembershipAdmission(null, alice)).toEqual({ decision: 'admit' });
    expect(evaluateMembershipAdmission(undefined, alice)).toEqual({ decision: 'admit' });
  });

  it('explicit membership:"open" ⇒ admit', () => {
    expect(evaluateMembershipAdmission({ membership: 'open' }, alice)).toEqual({ decision: 'admit' });
  });

  it('policy present but no membership key ⇒ admit (absent ⇒ open)', () => {
    expect(evaluateMembershipAdmission({ moderation: { reportable: true } }, alice)).toEqual({
      decision: 'admit',
    });
  });
});

describe('evaluateMembershipAdmission — allowlist (teeth: neuter the allowlist check → RED)', () => {
  const policy: MembershipPolicyView = { membership: 'allowlist', allowlist: ['alice', 'Bob'] };

  it('listed login ⇒ admit', () => {
    expect(evaluateMembershipAdmission(policy, alice)).toEqual({ decision: 'admit' });
  });

  it('listed login is case-insensitive (GitHub logins are)', () => {
    expect(
      evaluateMembershipAdmission(policy, { githubUserId: 2002, githubUsername: 'BOB' }),
    ).toEqual({ decision: 'admit' });
    expect(
      evaluateMembershipAdmission(policy, { githubUserId: 2002, githubUsername: '  bob  ' }),
    ).toEqual({ decision: 'admit' });
  });

  it('NON-listed login ⇒ refuse(not_allowlisted)  ← RED if the allowlist check is neutered', () => {
    expect(evaluateMembershipAdmission(policy, mallory)).toEqual({
      decision: 'refuse',
      reason: 'not_allowlisted',
    });
  });

  it('EMPTY allowlist refuses ALL (owner pre-approves explicitly)', () => {
    const empty: MembershipPolicyView = { membership: 'allowlist', allowlist: [] };
    expect(evaluateMembershipAdmission(empty, alice)).toEqual({
      decision: 'refuse',
      reason: 'not_allowlisted',
    });
  });

  it('allowlist mode with NO allowlist key ⇒ refuse all (nothing pre-approved)', () => {
    expect(evaluateMembershipAdmission({ membership: 'allowlist' }, alice)).toEqual({
      decision: 'refuse',
      reason: 'not_allowlisted',
    });
  });
});

describe('evaluateMembershipAdmission — approval (pending until owner-approved)', () => {
  it('approval mode ⇒ pending(awaiting_owner_approval), NOT admitted', () => {
    const d = evaluateMembershipAdmission({ membership: 'approval' }, alice);
    expect(d).toEqual({ decision: 'pending', reason: 'awaiting_owner_approval' });
    // teeth: a joiner under approval is never auto-admitted.
    expect(d.decision).not.toBe('admit');
  });
});

describe('evaluateMembershipAdmission — ban precedence (the strongest in-policy lever)', () => {
  it('banned id refused in OPEN mode (ban overrides the permissive default)', () => {
    const policy: MembershipPolicyView = {
      membership: 'open',
      moderation: { bannedGithubIds: ['6666'] },
    };
    expect(evaluateMembershipAdmission(policy, mallory)).toEqual({
      decision: 'refuse',
      reason: 'banned',
    });
  });

  it('ban WINS over an allowlist entry (banned id refused even though login is listed)', () => {
    // mallory was allowlisted, then banned — the ban must win (repeat-abuse takedown).
    const policy: MembershipPolicyView = {
      membership: 'allowlist',
      allowlist: ['mallory', 'alice'],
      moderation: { bannedGithubIds: ['6666'] },
    };
    expect(evaluateMembershipAdmission(policy, mallory)).toEqual({
      decision: 'refuse',
      reason: 'banned',
    });
    // a non-banned listed user is still admitted (the ban is targeted, not a global lock).
    expect(evaluateMembershipAdmission(policy, alice)).toEqual({ decision: 'admit' });
  });

  it('ban is keyed on the STABLE numeric id, not the login (no rejoin under a renamed login)', () => {
    // mallory renamed her login to "mallory-v2" and re-applies under allowlist — same id ⇒ still banned.
    const policy: MembershipPolicyView = {
      membership: 'allowlist',
      allowlist: ['mallory-v2'],
      moderation: { bannedGithubIds: ['6666'] },
    };
    expect(
      evaluateMembershipAdmission(policy, { githubUserId: 6666, githubUsername: 'mallory-v2' }),
    ).toEqual({ decision: 'refuse', reason: 'banned' });
  });

  it('ban refused even in APPROVAL mode (never even reaches the owner queue)', () => {
    const policy: MembershipPolicyView = {
      membership: 'approval',
      moderation: { bannedGithubIds: ['6666'] },
    };
    expect(evaluateMembershipAdmission(policy, mallory)).toEqual({
      decision: 'refuse',
      reason: 'banned',
    });
  });
});

describe('evaluateMembershipAdmission — forward-compat (unknown mode fails SAFE)', () => {
  it('unknown membership mode ⇒ pending(unknown_mode), never auto-admit', () => {
    const d = evaluateMembershipAdmission(
      { membership: 'invite-only-v2' } as MembershipPolicyView,
      alice,
    );
    expect(d).toEqual({ decision: 'pending', reason: 'unknown_mode' });
    expect(d.decision).not.toBe('admit');
  });
});

describe('helper predicates', () => {
  it('isBannedGithubId: matches stringified numeric id, tolerates whitespace, false on empty/absent', () => {
    expect(isBannedGithubId({ moderation: { bannedGithubIds: ['6666'] } }, 6666)).toBe(true);
    expect(isBannedGithubId({ moderation: { bannedGithubIds: [' 6666 '] } }, 6666)).toBe(true);
    expect(isBannedGithubId({ moderation: { bannedGithubIds: ['1001'] } }, 6666)).toBe(false);
    expect(isBannedGithubId({ moderation: { bannedGithubIds: [] } }, 6666)).toBe(false);
    expect(isBannedGithubId(null, 6666)).toBe(false);
    expect(isBannedGithubId({}, 6666)).toBe(false);
  });

  it('isAllowlisted: case-insensitive login match, false on empty/absent', () => {
    expect(isAllowlisted({ allowlist: ['Alice'] }, 'alice')).toBe(true);
    expect(isAllowlisted({ allowlist: ['alice'] }, 'mallory')).toBe(false);
    expect(isAllowlisted({ allowlist: [] }, 'alice')).toBe(false);
    expect(isAllowlisted(null, 'alice')).toBe(false);
    expect(isAllowlisted({}, 'alice')).toBe(false);
  });
});
