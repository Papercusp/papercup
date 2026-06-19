/**
 * visibility-content-topic-separation.test.ts — Brief E (shared-hive-release-testing),
 * membership lifecycle & visibility. The automated half of FINDING E-001:
 *
 *   "public → private withdraws DIRECTORY discovery, NOT CONTENT federation."
 *
 * A hive lives on TWO unrelated topic families:
 *   - the DIRECTORY gossip topic — `sha256("papercusp-hive-v1:directory")` (global)
 *     or `sha256("papercusp-hive-v1:invite:<secret>")` (invite-scoped). This is where
 *     a listing is announced; `withdrawHiveFromDirectory` (the public→private flip)
 *     broadcasts an unlist tombstone HERE.
 *   - the CONTENT log-replication topic — `deriveHiveFederationTopic(pubkey)` =
 *     `sha256("papercusp-substrate-v1:hive:<pubkey>")`. This is the swarm a MEMBER /
 *     a pubkey-holder actually reads and writes content on.
 *
 * The two families use DIFFERENT hash domains (`papercusp-hive-v1:` vs
 * `papercusp-substrate-v1:`), and the content topic is a PURE function of the hive
 * pubkey — it takes no visibility argument. So withdrawing the directory listing
 * (= going private) cannot, by construction, remove a peer that is already on the
 * content topic: the flip only stops NEW directory DISCOVERY.
 *
 * Combined with the static proof below (`hive-set-listing.ts`'s private branch has
 * NO federation-cutoff leg), this is the visibility-axis sibling of Brief C's C-001
 * (member-remove is write-plane only; reads persist) — SAME architectural root:
 * immutable hive identity + a content topic = hash(pubkey) that is never re-keyed
 * on a lifecycle/visibility transition. See findings-E.md (E-001).
 *
 * This is a GAP-DEMONSTRATING test: it PASSES today and documents that the cutoff
 * a release reader would expect from "go private" does not exist at the substrate.
 * It is NOT a regression guard for a fix — if a re-key-on-private fix lands, this
 * file's framing must be revisited (the topics may then diverge per visibility).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveDirectoryTopic,
  deriveInviteTopic,
} from './derive-hive-topic';
import { deriveHiveFederationTopic } from './derive-swarm-topic';

// A representative raw-32-byte base64 hive pubkey (the directory/link distributes
// this; anyone who learns it can derive the content topic and join — see
// derive-swarm-topic.ts's `hive:` binding docstring).
const HIVE_PUBKEY = Buffer.alloc(32, 7).toString('base64');
const INVITE_SECRET = 'invite-secret-xyz';

describe('E-001: a hive content topic is independent of, and distinct from, every directory topic', () => {
  it('the CONTENT topic is NOT the global directory topic — withdrawing the listing cannot remove a content-topic peer', () => {
    const content = deriveHiveFederationTopic(HIVE_PUBKEY);
    const directory = deriveDirectoryTopic();
    // Different topic ⇒ different swarm. The public→private unlist tombstone is
    // broadcast on `directory`; it can never reach a peer joined on `content`.
    expect(content.equals(directory)).toBe(false);
  });

  it('the CONTENT topic is NOT the invite-scoped directory topic either', () => {
    const content = deriveHiveFederationTopic(HIVE_PUBKEY);
    expect(content.equals(deriveInviteTopic(INVITE_SECRET))).toBe(false);
  });

  it('the CONTENT topic is a PURE function of the pubkey — it carries NO visibility input, so a visibility transition cannot change it', () => {
    // There is no `visibility` parameter to deriveHiveFederationTopic; the topic for
    // a given hive is therefore identical before and after ANY public↔private↔invite
    // flip. The "private" hive and the "public" hive of the same pubkey are the SAME
    // content swarm. (Determinism stands in for the absent visibility axis.)
    const before = deriveHiveFederationTopic(HIVE_PUBKEY);
    const afterAnyFlip = deriveHiveFederationTopic(HIVE_PUBKEY);
    expect(before.equals(afterAnyFlip)).toBe(true);
    expect(before.length).toBe(32);
  });
});

describe('E-001 (static): the public→private flip has NO federation-cutoff leg', () => {
  // Same proven pattern as the G24 dissolve static finding
  // (lifecycle-membership-teardown.gap.integration.test.ts): a source assertion that
  // a lifecycle op does NOT reach for the substrate. setHiveListing's private branch
  // calls ONLY directory + Cupboard withdrawal; it never revokes a peer, re-keys the
  // hive, evicts a connection, or touches the content swarm.
  const setListingSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../hive-set-listing.ts'),
    'utf8',
  );

  // Scope the assertion to the PRIVATE branch only — from `=== 'private'` to where the
  // public/invite publish branch begins. This deliberately EXCLUDES the publish path so
  // Brief G's G-001 fix (threading the announce topic into `reachablePeers` counting on
  // the public branch) can land without false-RED-ing this test. The private branch is
  // what a public→private flip executes.
  const privFrom = setListingSrc.indexOf("=== 'private'");
  const privTo = setListingSrc.indexOf('// public/invite:');
  const privateBranch = setListingSrc.slice(privFrom, privTo > privFrom ? privTo : undefined);

  it('the private flip withdraws the directory listing + unlists Cupboard rows', () => {
    expect(privFrom).toBeGreaterThan(-1);
    expect(/withdrawHiveFromDirectory/.test(privateBranch)).toBe(true);
    expect(/unlistHiveCupboardRows|unlist-hive-rows/.test(privateBranch)).toBe(true);
  });

  it('and the private branch references NO content-swarm cutoff mechanism (no revoke / re-key / evict / replicate / boot / leaveTopic)', () => {
    // If a true cryptographic cutoff is ever added to the private flip (fix option
    // (a)/(c) from C-001 — re-key on transition / connection eviction), one of these
    // tokens appears in the private branch and this assertion flips RED — the signal the
    // gap closed. (Scoped to the private branch so it is robust to publish-path edits.)
    expect(privTo).toBeGreaterThan(privFrom); // the public/invite branch marker exists → slice is the private branch
    const cutoffLeg =
      /\brevoke\b|\bre-?key\b|\bevict\b|\.replicate\b|bootHarnessSubstrate|closeBootedHarness|\bleaveTopic\b/;
    expect(cutoffLeg.test(privateBranch)).toBe(false);
  });
});

describe('E-002 (positive): an invite hive never lands on the GLOBAL directory topic (no-leak)', () => {
  it('the invite directory topic differs from the global directory topic — a non-secret-holder watching global never sees it', () => {
    expect(deriveInviteTopic(INVITE_SECRET).equals(deriveDirectoryTopic())).toBe(false);
  });

  it('per-secret isolation — two different invite secrets yield different topics', () => {
    expect(deriveInviteTopic('secret-A').equals(deriveInviteTopic('secret-B'))).toBe(false);
  });
});
