/**
 * hive-publish.test.ts — the announce-on-publish adapter (p2p-hive-directory P-004).
 *
 * Drives publishHiveToDirectory over a real HiveDirectory with fake transport
 * seams, pinning: public announces on the global topic, invite on its invite
 * topic, private registers-but-never-announces, the invite-without-secret guard,
 * and unpublish stops re-announcing.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { HiveDirectory, type HiveDirectoryDeps } from './hive-directory';
import { publishHiveToDirectory, unpublishHiveFromDirectory, type HiveDirectoryMeta, type HiveOwnerIdentity } from './hive-publish';
import { deriveDirectoryTopic, deriveInviteTopic, hiveTopicAsHex } from './sync/hyperbee/derive-hive-topic';

const NOW = 1_700_000_000_000;

function owner(): HiveOwnerIdentity {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
  return { githubLogin: 'alice', githubUserId: 4242, devicePubkey: pubkey, attestationGistId: 'gist-1' };
}

function deps(reachable = 0): HiveDirectoryDeps & { broadcasts: Array<{ topic: string }> } {
  const broadcasts: Array<{ topic: string }> = [];
  // A real signer so buildHiveAnnounce inside announceLocalHive succeeds.
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    broadcasts,
    sign: (b) => Promise.resolve(nodeSign(null, b, privateKey)),
    verifyAttestation: async () => true,
    broadcast: async (topic) => {
      broadcasts.push({ topic });
    },
    reachablePeers: () => reachable,
    now: () => NOW,
  };
}

function meta(over: Partial<HiveDirectoryMeta> = {}): HiveDirectoryMeta {
  return {
    hiveId: 'my-hive',
    title: 'My Hive',
    description: 'mine',
    visibility: 'public',
    memberTopics: ['f'.repeat(64)],
    createdAt: NOW - 1000,
    ...over,
  };
}

describe('publishHiveToDirectory (P-004)', () => {
  it('public → registers + announces on the GLOBAL directory topic', async () => {
    const d = deps();
    const dir = new HiveDirectory(d);
    const res = await publishHiveToDirectory(dir, meta({ visibility: 'public' }), owner());
    expect(res).toMatchObject({ registered: true, announced: true, visibility: 'public' });
    expect(d.broadcasts).toHaveLength(1);
    expect(d.broadcasts[0].topic).toBe(hiveTopicAsHex(deriveDirectoryTopic()));
  });

  it('invite → announces on the INVITE topic, never the global one', async () => {
    const d = deps();
    const dir = new HiveDirectory(d);
    const res = await publishHiveToDirectory(dir, meta({ visibility: 'invite', inviteSecret: 's' }), owner());
    expect(res.announced).toBe(true);
    expect(d.broadcasts[0].topic).toBe(hiveTopicAsHex(deriveInviteTopic('s')));
    expect(d.broadcasts[0].topic).not.toBe(hiveTopicAsHex(deriveDirectoryTopic()));
  });

  it('deceptive-publish: announced is HONEST about reachable peers (0 = broadcast into the void)', async () => {
    // No swarm connections — the announce frame is built + broadcast, but reaches NOBODY.
    const d0 = deps(0);
    const r0 = await publishHiveToDirectory(new HiveDirectory(d0), meta({ visibility: 'public' }), owner());
    expect(r0.announced).toBe(true); // a frame WAS broadcast …
    expect(r0.reachablePeers).toBe(0); // … but to ZERO peers — the UI must NOT claim "announced to the directory"
    expect(d0.broadcasts).toHaveLength(1);

    // 3 swarm peers connected — a real, reaching broadcast.
    const d3 = deps(3);
    const r3 = await publishHiveToDirectory(new HiveDirectory(d3), meta({ visibility: 'public' }), owner());
    expect(r3.announced).toBe(true);
    expect(r3.reachablePeers).toBe(3);
  });

  // ── G-001 (Brief G) — reachablePeers is SCOPED to the announce topic (FIXED) ─
  // Was the deceptive-publish lie resurrected for invite: the publish path counted
  // peers across ALL joined topics, so an invite publish on a box also browsing the
  // global directory reported the GLOBAL peers the invite announce never reached.
  // Fixed by threading the announce topic (reachablePeersForHive → the topic's own
  // count). This test pins the honest behavior: the count fn is asked for the INVITE
  // topic, and the reported reach is that topic's (0), not the all-topics sum (3).
  // Teeth: revert publishHiveToDirectory to dir.reachablePeers() (no topic) → RED.
  it('G-001: reachablePeers is scoped to the announce topic — invite reports the invite topic (0), not global peers (3)', async () => {
    const GLOBAL = hiveTopicAsHex(deriveDirectoryTopic());
    const INVITE = hiveTopicAsHex(deriveInviteTopic('s'));
    // Topic-aware reach: 3 peers on the global topic (browsing public hives), 0 on
    // this invite's topic. No-arg returns the all-topics SUM (3) — the OLD bug's
    // value; an honest publish must NOT report it for an invite announce.
    const peersByTopic: Record<string, number> = { [GLOBAL]: 3, [INVITE]: 0 };
    const d = deps(0);
    let askedTopic: string | undefined = 'NEVER_CALLED';
    (d as { reachablePeers: (t?: string) => number }).reachablePeers = (topicHex?: string) => {
      askedTopic = topicHex;
      return topicHex === undefined ? 3 /* all-topics sum — must NOT be used here */ : (peersByTopic[topicHex] ?? 0);
    };
    const res = await publishHiveToDirectory(
      new HiveDirectory(d),
      meta({ visibility: 'invite', inviteSecret: 's' }),
      owner(),
    );
    // The announce went to the INVITE topic — where 0 peers are.
    expect(res.announced).toBe(true);
    expect(d.broadcasts[0].topic).toBe(INVITE);
    // FIXED: the publish path threads the announce topic into the count …
    expect(askedTopic).toBe(INVITE);
    // … so it reports the invite topic's real reach (0), NOT the all-topics sum (3).
    expect(res.reachablePeers).toBe(0);
  });

  // Symmetric to the invite case: a PUBLIC publish must report the GLOBAL topic's
  // peers, not the all-topics sum — a box browsing other hives' invite topics must
  // not inflate a public publish's reported reach.
  it('G-001: a PUBLIC publish reports the global topic count, not the all-topics sum', async () => {
    const GLOBAL = hiveTopicAsHex(deriveDirectoryTopic());
    const OTHER_INVITE = hiveTopicAsHex(deriveInviteTopic('other')); // another hive's invite topic this box also joined
    const peersByTopic: Record<string, number> = { [GLOBAL]: 2, [OTHER_INVITE]: 5 };
    const d = deps(0);
    let askedTopic: string | undefined = 'NEVER_CALLED';
    (d as { reachablePeers: (t?: string) => number }).reachablePeers = (topicHex?: string) => {
      askedTopic = topicHex;
      return topicHex === undefined ? 7 /* 2+5 all-topics sum — must NOT be used */ : (peersByTopic[topicHex] ?? 0);
    };
    const res = await publishHiveToDirectory(new HiveDirectory(d), meta({ visibility: 'public' }), owner());
    expect(res.announced).toBe(true);
    expect(d.broadcasts[0].topic).toBe(GLOBAL);
    expect(askedTopic).toBe(GLOBAL); // scoped to the global directory topic …
    expect(res.reachablePeers).toBe(2); // … so 2, NOT the 7-peer all-topics sum.
  });

  it('private → registers but NEVER announces (opt-in floor)', async () => {
    const d = deps();
    const dir = new HiveDirectory(d);
    const res = await publishHiveToDirectory(dir, meta({ visibility: 'private' }), owner());
    expect(res).toMatchObject({ registered: true, announced: false, visibility: 'private' });
    expect(d.broadcasts).toHaveLength(0);
  });

  it('invite without a secret is rejected (an invite needs a topic)', async () => {
    const dir = new HiveDirectory(deps());
    await expect(publishHiveToDirectory(dir, meta({ visibility: 'invite' }), owner())).rejects.toThrow(/inviteSecret/);
  });

  it('re-publish after a metadata edit re-announces the new title (convergence)', async () => {
    const d = deps();
    const dir = new HiveDirectory(d);
    const o = owner();
    await publishHiveToDirectory(dir, meta({ title: 'v1' }), o);
    await publishHiveToDirectory(dir, meta({ title: 'v2' }), o);
    expect(d.broadcasts).toHaveLength(2); // each publish broadcasts
  });

  it('unpublish stops the hive being re-announced by the timer body', async () => {
    const d = deps();
    const dir = new HiveDirectory(d);
    await publishHiveToDirectory(dir, meta({ visibility: 'public' }), owner());
    unpublishHiveFromDirectory(dir, 'my-hive');
    const n = await dir.reannounceAll();
    expect(n).toBe(0); // no longer owned → not re-announced
  });
});
