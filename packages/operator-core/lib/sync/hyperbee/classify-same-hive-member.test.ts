/**
 * classify-same-hive-member.test — the WI-559 same-hive cross-member SCOPE decision (the asymmetric
 * A→B peer stall fix). Pure function, so these are deterministic unit tests of the decision the boot
 * closure's `resolveSameHiveMember` applies (admit / buffer-on-miss / fall-through).
 *
 * THE WI-559 FIX, in one assertion: a same-hive candidate whose membership has NOT federated to us
 * yet classifies as 'miss' (→ the caller BUFFERS it for retry), NOT as a conclusive drop. Each
 * assertion pairs with its opposite under the same setup minus the one triggering field, so
 * neutering a guard flips a test RED.
 */
import { describe, it, expect } from 'vitest';
import { classifySameHiveMember, type SameHiveDecision } from './boot';

// Use the classifier's OWN input type so the null/undefined cases below typecheck.
type Input = Parameters<typeof classifySameHiveMember>[0];

const BASE: Input = {
  originSlug: 'fed-a-member',
  ownSlug: 'fed-b-member',
  hiveHome: 'fixawitness-hive',
  devicePubkey: '5cWxDYOf',
  memberDevices: ['5cWxDYOf', 'someOtherDevice'],
};

const decide = (over: Partial<Input>): SameHiveDecision =>
  classifySameHiveMember({ ...BASE, ...over });

describe('classifySameHiveMember', () => {
  it("ADMITS a registered same-hive member's device", () => {
    expect(decide({})).toBe('admit');
  });

  it("WI-559: a same-hive candidate NOT YET in hive_members is a MISS (→ buffer, not a drop)", () => {
    // Same setup minus the membership row (B has not federated A in yet) → 'miss'.
    expect(decide({ memberDevices: [] })).toBe('miss');
    expect(decide({ memberDevices: ['someOtherDevice'] })).toBe('miss');
    // Teeth: add A's device back (membership federates in) → flips to 'admit'.
    expect(decide({ memberDevices: ['5cWxDYOf'] })).toBe('admit');
  });

  it("is NOT a candidate when the origin slug is our OWN slug (in-own-scope, handled upstream)", () => {
    expect(decide({ originSlug: BASE.ownSlug })).toBe('not-candidate');
  });

  it('is NOT a candidate when the origin slug is absent (legacy / single-harness peer)', () => {
    expect(decide({ originSlug: null })).toBe('not-candidate');
  });

  it('D-002 P-001: admits by AUTHOR IDENTITY (device_pubkey ∈ hive_members) — github_user_id not required', () => {
    // Admitted: device is registered in the federated member set.
    expect(decide({ memberDevices: [BASE.devicePubkey] })).toBe('admit');
    // Miss (not drop): device not yet in the set → buffer for retry.
    expect(decide({ memberDevices: [] })).toBe('miss');
    expect(decide({ memberDevices: ['other-device'] })).toBe('miss');
    // Teeth: add the device back → flips to admit.
    expect(decide({ memberDevices: [BASE.devicePubkey, 'other-device'] })).toBe('admit');
  });

  it('is NOT a candidate when we have no hive home to check membership against', () => {
    // Even a would-be member is not-candidate without a resolved hive home — the caller buffers it
    // as scope_unresolved (A-003), not as a membership miss.
    expect(decide({ hiveHome: null })).toBe('not-candidate');
    expect(decide({ hiveHome: null, memberDevices: [] })).toBe('not-candidate');
  });

  it('D-023 BUG C: the OWNER ADMITS a verified brand-new joiner on a MISS (no deadlock); a non-owner still buffers', () => {
    // A cross-slug joiner whose hive_members row does not exist yet (the OWNER is its SOURCE —
    // join-hive's freeSlug gives the joiner a member slug ≠ the owner's home slug, so its announce
    // is always out-of-own-scope and lands here as a MISS).
    const joinerMiss: Partial<Input> = { memberDevices: [] };
    // Non-owner (or owner-ness unknown) → BUFFER for retry (WI-559, unchanged).
    expect(decide({ ...joinerMiss })).toBe('miss');
    expect(decide({ ...joinerMiss, isOwner: false })).toBe('miss');
    expect(decide({ ...joinerMiss, memberDevices: ['someOtherDevice'], isOwner: false })).toBe('miss');
    // THE FIX: the OWNER ADMITS so admitAnnouncedPeerAsOwner runs the membership policy + upserts
    // the row — instead of buffering forever (the open-mode auto-admission deadlock, D-023 BUG C).
    expect(decide({ ...joinerMiss, isOwner: true })).toBe('admit');
    expect(decide({ ...joinerMiss, memberDevices: ['someOtherDevice'], isOwner: true })).toBe('admit');
    // isOwner NEVER widens a non-candidate (own-slug / no hive-home stay not-candidate).
    expect(decide({ originSlug: BASE.ownSlug, isOwner: true })).toBe('not-candidate');
    expect(decide({ hiveHome: null, isOwner: true })).toBe('not-candidate');
    // A KNOWN member is 'admit' regardless of isOwner (the owner-gate only affects a MISS).
    expect(decide({ isOwner: false })).toBe('admit');
    expect(decide({ isOwner: true })).toBe('admit');
  });
});
