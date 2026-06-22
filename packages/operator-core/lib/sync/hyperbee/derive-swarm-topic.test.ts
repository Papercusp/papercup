/**
 * derive-swarm-topic — the federation topic derivation, incl. the per-HIVE
 * binding that re-keys federation from the shared-harness slug to the Hive's
 * Ed25519 pubkey (shared-hive-federation-2026-06-08 P-003, D-003). Pure +
 * deterministic — same binding ⇒ same 32-byte topic across runs.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  serializeBinding,
  deriveSwarmTopic,
  deriveHiveFederationTopic,
  topicAsHex,
  bindingResolvesHiveHomeProjection,
  type SwarmBinding,
} from './derive-swarm-topic';

describe('derive-swarm-topic', () => {
  it('existing bindings stay deterministic + 32 bytes (gh, local), and differ from each other', () => {
    const gh = deriveSwarmTopic({ kind: 'gh', github_repository_id: 42 });
    expect(gh).toHaveLength(32);
    expect(deriveSwarmTopic({ kind: 'gh', github_repository_id: 42 }).equals(gh)).toBe(true);

    const local = deriveSwarmTopic({ kind: 'local', workspace_id: 'ws', harness_slug: 's' });
    expect(local).toHaveLength(32);
    expect(gh.equals(local)).toBe(false);
  });

  it('topicAsHex renders 64 hex chars', () => {
    expect(topicAsHex(deriveHiveFederationTopic('AAAA'))).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('explicit topic binding (the join-vs-owner topic-split fix)', () => {
    const PUB = Buffer.alloc(32, 9).toString('base64');
    it('uses the topic VERBATIM (not hashed) so a joiner lands on the exact link topic', () => {
      const hex = deriveHiveFederationTopic(PUB).toString('hex'); // the owner's hive topic
      const viaExplicit = deriveSwarmTopic({ kind: 'topic', topic_hex: hex });
      expect(viaExplicit.equals(Buffer.from(hex, 'hex'))).toBe(true);
    });
    it('a joiner with only the link topic matches the owner HIVE topic — NOT the gh-repo topic', () => {
      // Owner federates on hive:<pubkey>; the member link carries THAT topic.
      const ownerHive = deriveSwarmTopic({ kind: 'hive', hive_pubkey: PUB });
      const linkTopicHex = topicAsHex(ownerHive);
      // Joiner only has the topic (no pubkey) → explicit-topic binding.
      const joiner = deriveSwarmTopic({ kind: 'topic', topic_hex: linkTopicHex });
      // THE BUG this guards: re-deriving gh:<repo_id> would split them apart.
      const ghRepo = deriveSwarmTopic({ kind: 'gh', github_repository_id: 1300192 });
      expect(joiner.equals(ownerHive)).toBe(true); // joiner == owner ✓ (sync works)
      expect(joiner.equals(ghRepo)).toBe(false); // and NOT the gh-repo topic (the split)
    });
    it('serializeBinding round-trips + validates the 64-hex topic', () => {
      const hex = 'a'.repeat(64);
      expect(serializeBinding({ kind: 'topic', topic_hex: hex })).toBe(`topic:${hex}`);
      expect(() => deriveSwarmTopic({ kind: 'topic', topic_hex: 'nothex' })).toThrow();
    });
  });

  describe('hive binding (P-003 — federation topic = Hive pubkey)', () => {
    // a stand-in raw-32-byte base64 pubkey (the encoding hive-keypair.ts returns)
    const PUB = Buffer.alloc(32, 7).toString('base64');

    it('deriveHiveFederationTopic === the {kind:hive} binding — 32 bytes, deterministic', () => {
      const a = deriveHiveFederationTopic(PUB);
      const b = deriveSwarmTopic({ kind: 'hive', hive_pubkey: PUB });
      expect(a).toHaveLength(32);
      expect(a.equals(b)).toBe(true);
      expect(deriveHiveFederationTopic(PUB).equals(a)).toBe(true);
    });

    it('matches sha256("papercusp-substrate-v1:hive:" + pubkey) exactly', () => {
      const expected = createHash('sha256')
        .update('papercusp-substrate-v1:hive:' + PUB, 'utf8')
        .digest();
      expect(deriveHiveFederationTopic(PUB).equals(expected)).toBe(true);
    });

    it('serializeBinding renders `hive:<pubkey>`', () => {
      expect(serializeBinding({ kind: 'hive', hive_pubkey: PUB })).toBe('hive:' + PUB);
    });

    it('distinct hive pubkeys → distinct topics', () => {
      const other = Buffer.alloc(32, 9).toString('base64');
      expect(deriveHiveFederationTopic(PUB).equals(deriveHiveFederationTopic(other))).toBe(false);
    });

    it('the hive binding is domain-separated from gh/local (prefix collision is impossible)', () => {
      // even if a gh id literally equalled "hive:<pubkey>", the serialized forms differ
      // ("gh:hive:<pub>" vs "hive:<pub>") so the topics never alias.
      const hiveTopic = deriveHiveFederationTopic(PUB);
      const ghLookalike = deriveSwarmTopic({ kind: 'gh', github_repository_id: 'hive:' + PUB });
      expect(hiveTopic.equals(ghLookalike)).toBe(false);
    });

    it('serializeBinding throws on an empty hive_pubkey', () => {
      expect(() => serializeBinding({ kind: 'hive', hive_pubkey: '' } as SwarmBinding)).toThrow(/hive_pubkey/);
    });
  });

  // EI-1690: the `local:<ws>/<slug>` delimiter is unescaped, so a slashful
  // workspace_id would let two distinct tenancy pairs collide onto ONE swarm topic.
  // The serializer now rejects `/` in workspace_id (rejecting, not escaping —
  // escaping would change the derived topic and break federation with live peers).
  describe('local binding workspace_id delimiter guard (EI-1690)', () => {
    it('rejects a workspace_id containing the "/" delimiter', () => {
      expect(() =>
        serializeBinding({ kind: 'local', workspace_id: 'a/x', harness_slug: 'y' }),
      ).toThrow(/EI-1690/);
    });

    it('closes the former collision: the ambiguous pair (ws:"a/x",slug:"y") throws; the slash-free pair is unambiguous', () => {
      // Pre-fix BOTH of these serialized to "local:a/x/y" → same topic.
      expect(() =>
        serializeBinding({ kind: 'local', workspace_id: 'a/x', harness_slug: 'y' }),
      ).toThrow();
      expect(serializeBinding({ kind: 'local', workspace_id: 'a', harness_slug: 'x' })).toBe('local:a/x');
    });

    it('accepts every workspace_id in production use unchanged (no topic change, incl. the "*" sentinel)', () => {
      for (const ws of ['default', 'papercusp-workspace', 'generic-test', 'lane7', '*']) {
        expect(serializeBinding({ kind: 'local', workspace_id: ws, harness_slug: 's' })).toBe(`local:${ws}/s`);
      }
    });
  });

  describe('bindingResolvesHiveHomeProjection (WI-498 GAP 2 — joiner hive-home rebind kinds)', () => {
    it("resolves the hive-home projection for BOTH 'hive' AND 'topic' bindings", () => {
      // 'topic' is the DIRECT invite/link binding: the member link carries the topic
      // hash but NOT the hive pubkey, so a direct join (no prior DHT directory
      // discovery) boots on a 'topic' binding. It MUST resolve the hive-home projection
      // so the OWNER's hive-home announce is in-scope on the joiner — the GAP-2 fix that
      // unblocks mid-session-join federation. TEETH: reverting the 'topic' arm flips
      // this RED (the exact live bug witnessed on the 2-machine rig: scope_unresolved →
      // pending_grace_expired → no federation).
      expect(bindingResolvesHiveHomeProjection({ kind: 'hive', hive_pubkey: 'p' })).toBe(true);
      expect(bindingResolvesHiveHomeProjection({ kind: 'topic', topic_hex: 'a'.repeat(64) })).toBe(true);
    });

    it("does NOT resolve for 'gh' / 'local' / null / undefined (fail-open to the member-slug binding)", () => {
      expect(bindingResolvesHiveHomeProjection({ kind: 'gh', github_repository_id: 42 })).toBe(false);
      expect(
        bindingResolvesHiveHomeProjection({ kind: 'local', workspace_id: 'ws', harness_slug: 's' }),
      ).toBe(false);
      expect(bindingResolvesHiveHomeProjection(null)).toBe(false);
      expect(bindingResolvesHiveHomeProjection(undefined)).toBe(false);
    });
  });
});
