/**
 * joined-pot-identity-heal.test.ts — WI-10003559. A member joined through a bare
 * invite link (no hive_pubkey) must recover its Pot identity row from local,
 * already-received data, and must accept ONLY a pubkey that re-derives the link
 * topic it recorded at join. All IO is seam-injected — no PG, no filesystem.
 */
import { describe, it, expect, vi } from 'vitest';

import { deriveSwarmTopic } from '../sync/hyperbee/derive-swarm-topic';
import {
  healJoinedPotIdentity,
  selectTopicVerifiedHivePubkey,
  type JoinedPotIdentityHealDeps,
} from './joined-pot-identity-heal';

// Two well-formed raw-32 Ed25519-shaped pubkeys (base64 of 32 bytes).
const POT_KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const topicOf = (k: string) => deriveSwarmTopic({ kind: 'hive', hive_pubkey: k }).toString('hex');
const POT_TOPIC = topicOf(POT_KEY);

describe('selectTopicVerifiedHivePubkey', () => {
  it('accepts the candidate whose hive topic equals the link topic', () => {
    expect(selectTopicVerifiedHivePubkey(POT_TOPIC, [OTHER_KEY, POT_KEY])).toBe(POT_KEY);
  });

  it('is case-insensitive on the recorded topic', () => {
    expect(selectTopicVerifiedHivePubkey(POT_TOPIC.toUpperCase(), [POT_KEY])).toBe(POT_KEY);
  });

  it('rejects every candidate that does not re-derive the topic (a peer cannot substitute its own key)', () => {
    expect(selectTopicVerifiedHivePubkey(POT_TOPIC, [OTHER_KEY])).toBeNull();
  });

  it('skips malformed / empty candidates and a malformed topic, never throws', () => {
    expect(selectTopicVerifiedHivePubkey(POT_TOPIC, ['', null, undefined, POT_KEY])).toBe(POT_KEY);
    expect(selectTopicVerifiedHivePubkey('not-a-topic', [POT_KEY])).toBeNull();
    expect(selectTopicVerifiedHivePubkey(POT_TOPIC, [])).toBeNull();
  });

  it('matches the measured rig pair (topic 0edc4b5f… commits to pubkey n1zVC5KM…)', () => {
    expect(
      selectTopicVerifiedHivePubkey('0edc4b5f618f81b331f796c742ae76ed3858e2fd37543d78e81462ebc140ae2f', [
        'dt7o6ioLVBSnppkg+H7WO+NLLKK1EUcXHQVR45BMNyA=',
        'n1zVC5KMlf19w+nAECE+kD9elJpIQZsNldaxB3s3E4Q=',
      ]),
    ).toBe('n1zVC5KMlf19w+nAECE+kD9elJpIQZsNldaxB3s3E4Q=');
  });
});

function deps(over: Partial<JoinedPotIdentityHealDeps> = {}) {
  const upserts: Array<Parameters<JoinedPotIdentityHealDeps['upsertIdentity']>[0]> = [];
  const d: JoinedPotIdentityHealDeps = {
    hasIdentity: async () => false,
    readLinkTopic: async () => POT_TOPIC,
    listCandidatePubkeys: async () => [OTHER_KEY, POT_KEY],
    upsertIdentity: async (input) => {
      upserts.push(input);
    },
    ...over,
  };
  return { d, upserts };
}

describe('healJoinedPotIdentity', () => {
  const input = { workspaceId: 'ws', homeSlug: 'hello-world-3-pot' };

  it('writes the topic-verified pubkey under the pot home slug with a non-signing remote keychain', async () => {
    const { d, upserts } = deps();
    await expect(healJoinedPotIdentity(input, d)).resolves.toEqual({ status: 'healed', pubkeyBase64: POT_KEY });
    expect(upserts).toEqual([
      { workspaceId: 'ws', homeSlug: 'hello-world-3-pot', pubkeyBase64: POT_KEY, keychainId: 'remote:hello-world-3-pot' },
    ]);
  });

  it('is a no-op when the identity row already exists (no candidate read, no write)', async () => {
    const list = vi.fn(async () => [POT_KEY]);
    const { d, upserts } = deps({ hasIdentity: async () => true, listCandidatePubkeys: list });
    await expect(healJoinedPotIdentity(input, d)).resolves.toEqual({ status: 'present' });
    expect(list).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
  });

  it('reports no-link-topic when the slug has no join-state record (never guesses)', async () => {
    const { d, upserts } = deps({ readLinkTopic: async () => null });
    await expect(healJoinedPotIdentity(input, d)).resolves.toEqual({ status: 'no-link-topic' });
    expect(upserts).toEqual([]);
  });

  it('reports no-verified-candidate (with the distinct count seen) and writes nothing when no key matches', async () => {
    const { d, upserts } = deps({ listCandidatePubkeys: async () => [OTHER_KEY, OTHER_KEY] });
    await expect(healJoinedPotIdentity(input, d)).resolves.toEqual({
      status: 'no-verified-candidate',
      candidatesSeen: 1,
    });
    expect(upserts).toEqual([]);
  });

  it('folds a failing write into an error outcome instead of throwing', async () => {
    const { d } = deps({
      upsertIdentity: async () => {
        throw new Error('duplicate key value violates unique constraint "pots_public_key_key"');
      },
    });
    await expect(healJoinedPotIdentity(input, d)).resolves.toEqual({
      status: 'error',
      reason: 'duplicate key value violates unique constraint "pots_public_key_key"',
    });
  });
});
