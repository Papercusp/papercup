/**
 * discover-join-flow.integration.test.ts — Lane T2 release-gate coverage
 * (plan shared-hive-public-release-2026-06-22, coordinator su-34db4).
 *
 * The end-to-end DISCOVER → JOIN flow that lets a SECOND user find + join a hive,
 * exercised across the REAL modules (vs the per-route unit tests, which mock each
 * seam): the visibility→announce contract (`publishHiveToDirectory` over a real
 * `HiveDirectory`), the cross-peer ingest into a JOINER directory, the
 * `discovery:pots` browse projection, and the two JOIN routes whose INPUT is
 * sourced from the real discovery output.
 *
 * Covers (the release gate for the public-hive flow):
 *   - set-hive each visibility:
 *       public  → announces on the GLOBAL directory topic;
 *       invite  → announces on the SECRET-gated invite topic (NOT the global one);
 *       private → never announced (no frame ever reaches the wire).
 *   - discovery:pots lists a published public + invite hive…
 *   - …and a PRIVATE hive is NOT discoverable — never announced (no broadcast),
 *     rejected at ingest (verifyHiveAnnounce drops `private`), and filtered at the
 *     projection. The triple guarantee.
 *   - join-hive: the discovered hive's `memberLinks` flow into the route and
 *     materialize the joiner-side `remote_hive` view (`potSlug`).
 *   - join-invite: joining via the SAME invite secret the hive was published with.
 *
 * Faithful-but-deterministic seam: the full HTTP set-hive composition
 * (`setHiveListing` → PG save → republish-from-repo) is unit-covered in
 * set-hive.test.ts; this drives the directory ANNOUNCE contract directly
 * (`publishHiveToDirectory` — the pure adapter the create/edit surface calls) so
 * the flow stays swarm-/PG-/keychain-free. The two JOIN routes do real I/O
 * (clones, topic subscribe), so their composition seams are mocked — but the
 * INPUT (member links / invite secret) is the real discovery output, which the
 * per-route unit tests (synthetic constants) never assert.
 *
 * NEW file, READ-only on impl (disjoint — no edits to impl or sibling tests).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

// ── JOIN-route seams (real I/O) — mocked, mirroring the sibling unit tests. None
//    of these modules are imported by the directory stack exercised below, so the
//    mocks never perturb the real publish→ingest→browse flow. ──────────────────
const joinHiveAsView = vi.fn();
const bustProjectsLiteCache = vi.fn();
vi.mock('../../../harness/join-hive', () => ({
  joinHiveAsView: (...a: unknown[]) => joinHiveAsView(...a),
}));
vi.mock('../../../harness/projects-lite', () => ({
  bustProjectsLiteCache: (...a: unknown[]) => bustProjectsLiteCache(...a),
  buildProjectsLitePayload: vi.fn(async () => ({ projects: [] })),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import type { HiveDirectoryWiring } from '../../../hive-directory-boot';
let inviteConfirm: Awaited<ReturnType<HiveDirectoryWiring['confirmInviteAnnounce']>> = {
  found: false,
  peersOnTopic: 0,
};
const joinedSecrets: string[] = [];
let inviteWiring: Pick<HiveDirectoryWiring, 'joinInviteTopic' | 'confirmInviteAnnounce'> | null = null;
vi.mock('../../../hive-directory-boot', () => ({
  ensureHiveDirectoryWired: vi.fn(async () => inviteWiring),
}));

// ── Real modules under test ──────────────────────────────────────────────────
import joinHiveRoute from './join-hive';
import joinInviteRoute from './join-invite';
import hivesTool from '../../../agent-tools/discovery/pots';
import { publishHiveToDirectory, type HiveDirectoryMeta, type HiveOwnerIdentity } from '../../../hive-publish';
import {
  HiveDirectory,
  deriveDirectoryTopic,
  deriveInviteTopic,
  type HiveDirectoryDeps,
  type SignedHiveAnnounce,
} from '../../../hive-directory';
import { hiveTopicAsHex } from '../../../sync/hyperbee/derive-hive-topic';
import { buildHiveAnnounce, type HiveAnnounceBody } from '../../../sync/hyperbee/hive-announce';
import {
  configureHiveDirectoryForTest,
  __resetHiveDirectorySingleton,
} from '../../../hive-directory-deps';
import { formatHiveInviteLink } from '../../../harness/hive-invite-link';

const NOW = 1_700_000_000_000;
const INVITE_SECRET = 'b'.repeat(64); // 64 hex = a valid minted invite secret
const GLOBAL_TOPIC = hiveTopicAsHex(deriveDirectoryTopic());

// One owner identity + Ed25519 device key, used to SIGN every owner announce so
// the joiner's verifyHiveAnnounce (sig over owner_device_pubkey) accepts it.
const { publicKey: ownerPub, privateKey: ownerPriv } = generateKeyPairSync('ed25519');
const ownerDevicePubkey = (ownerPub.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-32)
  .toString('base64');
const owner: HiveOwnerIdentity = {
  githubLogin: 'alice',
  githubUserId: 4242,
  devicePubkey: ownerDevicePubkey,
  attestationGistId: 'gist-alice',
};

const MEMBER_TOPIC = 'a'.repeat(64);
const MEMBER_LINK = 'papercusp://harness?topic=' + MEMBER_TOPIC;

function meta(over: Partial<HiveDirectoryMeta> & Pick<HiveDirectoryMeta, 'potId' | 'visibility'>): HiveDirectoryMeta {
  return {
    title: over.title ?? over.potId,
    description: 'desc',
    memberTopics: [MEMBER_TOPIC],
    memberLinks: [MEMBER_LINK],
    createdAt: NOW - 1000,
    ...over,
  };
}

// The OWNER's directory: a real HiveDirectory whose `sign` is a real Ed25519
// signature + whose `broadcast` CAPTURES (topic, frame) so we can assert which
// topic each visibility announced on. Separate instance from the joiner.
const broadcasts: Array<{ topicHex: string; frame: SignedHiveAnnounce }> = [];
const ownerDeps: HiveDirectoryDeps = {
  sign: async (bytes) => nodeSign(null, bytes, ownerPriv),
  verifyAttestation: async () => true,
  broadcast: async (topicHex, frame) => {
    broadcasts.push({ topicHex, frame });
  },
  now: () => NOW,
};
let ownerDir: HiveDirectory;

// The JOINER's directory IS the process singleton (so the discovery:pots tool,
// which reads getHiveDirectory(), projects it). verifyAttestation → true (the
// channel-2 GitHub check is exercised elsewhere; here we test the flow).
const joinerDeps: HiveDirectoryDeps = {
  sign: async (b) => Buffer.from(b),
  verifyAttestation: async () => true,
  broadcast: async () => {},
  now: () => NOW,
};
let joinerDir: HiveDirectory;

beforeEach(() => {
  broadcasts.length = 0;
  ownerDir = new HiveDirectory(ownerDeps);
  joinerDir = configureHiveDirectoryForTest(joinerDeps);

  joinHiveAsView.mockReset();
  bustProjectsLiteCache.mockReset();
  joinHiveAsView.mockResolvedValue({
    ok: true,
    potSlug: 'acme',
    members: [{ slug: 'acme', link: MEMBER_LINK, ok: true, detail: 'joined' }],
  });

  joinedSecrets.length = 0;
  inviteConfirm = { found: false, peersOnTopic: 0 };
  inviteWiring = {
    joinInviteTopic: async (s: string) => {
      joinedSecrets.push(s);
    },
    confirmInviteAnnounce: async () => inviteConfirm,
  };
});

afterEach(() => __resetHiveDirectorySingleton());

/** Owner publishes `m`; returns the publish result + the captured wire frames. */
async function publish(m: HiveDirectoryMeta) {
  broadcasts.length = 0;
  const res = await publishHiveToDirectory(ownerDir, m, owner);
  return { res, frames: [...broadcasts] };
}

/** Feed captured owner frames into the joiner directory (the cross-peer ingest). */
async function ingest(frames: Array<{ frame: SignedHiveAnnounce }>) {
  const out = [];
  for (const { frame } of frames) out.push(await joinerDir.ingestAnnounce(frame));
  return out;
}

/** Call the discovery:pots browse tool over the joiner singleton. */
async function browse(args: Record<string, unknown> = {}) {
  const parsed = (hivesTool.args as { parse: (x: unknown) => unknown }).parse(args) as never;
  const res = (await hivesTool.handler(parsed, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text) as {
    ok: boolean;
    count: number;
    rows: Array<{ potId: string; visibility: string; memberLinks: string[]; memberCount: number; title: string }>;
  };
}

async function postJoinHive(body: unknown) {
  const req = new Request('http://127.0.0.1/api/discovery/join-pot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = (await joinHiveRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function postJoinInvite(body: unknown) {
  const req = new Request('http://127.0.0.1/api/discovery/join-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = (await joinInviteRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe('discover→join flow: set-hive visibility → announce topic (T2)', () => {
  it('public → announces on the GLOBAL directory topic', async () => {
    const { res, frames } = await publish(meta({ potId: 'acme', visibility: 'public' }));
    expect(res).toMatchObject({ announced: true, visibility: 'public' });
    expect(frames).toHaveLength(1);
    expect(frames[0].topicHex).toBe(GLOBAL_TOPIC);
    expect(frames[0].frame.visibility).toBe('public');
  });

  it('invite → announces on the SECRET-gated invite topic, NOT the global one', async () => {
    const { res, frames } = await publish(
      meta({ potId: 'inv', visibility: 'invite', inviteSecret: INVITE_SECRET }),
    );
    expect(res).toMatchObject({ announced: true, visibility: 'invite' });
    expect(frames).toHaveLength(1);
    expect(frames[0].topicHex).toBe(hiveTopicAsHex(deriveInviteTopic(INVITE_SECRET)));
    // The whole point of invite-visibility: it is NOT on the global directory.
    expect(frames[0].topicHex).not.toBe(GLOBAL_TOPIC);
  });

  it('private → never announces (no frame ever reaches the wire)', async () => {
    const { res, frames } = await publish(meta({ potId: 'secret', visibility: 'private' }));
    expect(res).toMatchObject({ announced: false, visibility: 'private' });
    expect(res.reachablePeers).toBe(0);
    expect(frames).toHaveLength(0);
  });
});

describe('discover→join flow: discovery:pots lists published hives (T2)', () => {
  it('lists a published PUBLIC hive with its member links + count', async () => {
    const { frames } = await publish(meta({ potId: 'acme', title: 'Acme Hive', visibility: 'public' }));
    expect((await ingest(frames))[0]).toMatchObject({ accepted: true });

    const out = await browse();
    expect(out.count).toBe(1);
    expect(out.rows[0]).toMatchObject({
      potId: 'acme',
      title: 'Acme Hive',
      visibility: 'public',
      memberLinks: [MEMBER_LINK],
      memberCount: 1,
    });
  });

  it('lists a published INVITE hive (row visibility reflects invite)', async () => {
    const { frames } = await publish(
      meta({ potId: 'inv', visibility: 'invite', inviteSecret: INVITE_SECRET }),
    );
    expect((await ingest(frames))[0]).toMatchObject({ accepted: true });

    const out = await browse();
    expect(out.count).toBe(1);
    expect(out.rows[0]).toMatchObject({ potId: 'inv', visibility: 'invite' });
  });

  it('lists BOTH a public + invite hive once each is ingested', async () => {
    await ingest(await publishFrames('acme', 'public'));
    await ingest(await publishFrames('inv', 'invite', INVITE_SECRET));
    const out = await browse();
    expect(out.count).toBe(2);
    expect(new Set(out.rows.map((r) => r.potId))).toEqual(new Set(['acme', 'inv']));
  });
});

describe('discover→join flow: a PRIVATE hive is NOT discoverable (T2)', () => {
  it('produces no wire frame, so the joiner never sees it', async () => {
    const { frames } = await publish(meta({ potId: 'secret', visibility: 'private' }));
    await ingest(frames); // nothing to ingest
    const out = await browse();
    expect(out.rows.find((r) => r.potId === 'secret')).toBeUndefined();
  });

  it('rejects a hand-forged private announce at INGEST (defense in depth)', async () => {
    // Even if a `private` frame were somehow fabricated onto the wire, the
    // directory must drop it (verifyHiveAnnounce rejects visibility:private).
    const body: HiveAnnounceBody = {
      hive_id: 'forged-private',
      title: 'Forged',
      description: 'd',
      owner_github_login: owner.githubLogin,
      owner_github_user_id: owner.githubUserId,
      owner_device_pubkey: ownerDevicePubkey,
      attestation_gist_id: owner.attestationGistId,
      member_topics: [MEMBER_TOPIC],
      visibility: 'private',
      created_at: NOW - 1000,
      ts: NOW,
    };
    const forged = await buildHiveAnnounce(body, (b) => Promise.resolve(nodeSign(null, b, ownerPriv)));
    const res = await joinerDir.ingestAnnounce(forged);
    expect(res.accepted).toBe(false);
    expect((await browse()).rows.find((r) => r.potId === 'forged-private')).toBeUndefined();
  });

  it('does NOT leak a private hive even alongside a discoverable public one', async () => {
    await ingest(await publishFrames('acme', 'public'));
    await ingest(await publishFrames('secret', 'private')); // never announces
    const out = await browse();
    expect(out.count).toBe(1);
    expect(out.rows[0].potId).toBe('acme');
  });
});

describe('discover→join flow: JOIN the discovered hive (T2)', () => {
  it('join-hive: the DISCOVERED hive’s member links materialize the remote_hive view', async () => {
    await ingest(await publishFrames('acme', 'public'));
    const row = (await browse()).rows.find((r) => r.potId === 'acme')!;
    expect(row.memberLinks).toEqual([MEMBER_LINK]);

    // Drive the join with the links sourced from the real discovery output.
    const { status, body } = await postJoinHive({ potId: row.potId, memberLinks: row.memberLinks });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, potSlug: 'acme' });
    // The route composed the join over exactly the discovered links + workspace,
    // then busted the registry cache so the new view groups immediately.
    expect(joinHiveAsView).toHaveBeenCalledTimes(1);
    expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({
      potId: 'acme',
      memberLinks: [MEMBER_LINK],
      workspaceId: 'ws-test',
    });
    expect(bustProjectsLiteCache).toHaveBeenCalledTimes(1);
  });

  it('join-invite: joining via the SAME secret the hive was published with', async () => {
    // The invite hive really announced on deriveInviteTopic(SECRET); the invitee
    // confirms a hive is present on that topic → honest joined:true.
    inviteConfirm = {
      found: true,
      hive: { potId: 'inv', title: 'Acme Invite', visibility: 'invite' },
      peersOnTopic: 1,
    };
    const link = formatHiveInviteLink({ secret: INVITE_SECRET, title: 'Acme Invite' });
    const { status, body } = await postJoinInvite({ link });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, joined: true, found: true, subscribed: true });
    // The route derived the topic from the EXACT secret the owner published with.
    expect(joinedSecrets).toEqual([INVITE_SECRET]);
  });

  it('join-invite: a secret with nothing announcing is HONEST — subscribed, not joined', async () => {
    // Default inviteConfirm = { found:false } — we joined the topic, but no hive
    // is announcing there (withdrawn / wrong secret / owner offline).
    const { status, body } = await postJoinInvite({ link: formatHiveInviteLink({ secret: INVITE_SECRET }) });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, joined: false, found: false, subscribed: true });
    expect(joinedSecrets).toEqual([INVITE_SECRET]);
  });
});

/** Publish a hive of the given visibility and return its captured wire frames. */
async function publishFrames(potId: string, visibility: HiveDirectoryMeta['visibility'], inviteSecret?: string) {
  const { frames } = await publish(
    meta({ potId, visibility, ...(inviteSecret ? { inviteSecret } : {}) }),
  );
  return frames;
}
