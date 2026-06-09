/**
 * hive-directory-boot.test.ts — the boot-join composition (p2p-hive-directory P-003).
 *
 * Uses a fake-deps HiveDirectory + a fake swarm to assert wireHiveDirectoryAtBoot
 * joins the global topic, pipes a freshly-paired peer our owned announces, routes
 * inbound frames to ingest, publishes owned hives, and stops cleanly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

// Reuse the Protomux fake from the directory-swarm test pattern.
interface FakeChannel {
  protocol: string;
  onopen?: () => void;
  onclose?: () => void;
  sent: unknown[];
  inbound?: (frame: unknown) => void;
  pair(): void;
}
const muxers: FakeChannel[] = [];
vi.mock('protomux', () => ({
  default: {
    from: () => ({
      createChannel(spec: { protocol: string; onopen?: () => void; onclose?: () => void }) {
        const ch: FakeChannel = {
          protocol: spec.protocol,
          onopen: spec.onopen,
          onclose: spec.onclose,
          sent: [],
          pair() {
            this.onopen?.();
          },
        };
        (ch as unknown as { addMessage: (m: { onmessage?: (f: unknown) => void }) => { send: (v: unknown) => void } }).addMessage = (m) => {
          ch.inbound = m.onmessage;
          return { send: (v: unknown) => ch.sent.push(v) };
        };
        (ch as unknown as { open: () => void }).open = () => {};
        muxers.push(ch);
        return ch;
      },
    }),
  },
}));

const { wireHiveDirectoryAtBoot } = await import('./hive-directory-boot');
const { HiveDirectory } = await import('./hive-directory');
import type { HiveDirectoryDeps } from './hive-directory';
import type { HiveDirectoryMeta, HiveOwnerIdentity } from './hive-publish';

const NOW = 1_700_000_000_000;

function ownerIdentity(): HiveOwnerIdentity {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
  return { githubLogin: 'alice', githubUserId: 4242, devicePubkey: pubkey, attestationGistId: 'g' };
}

function fakeDirDeps(): HiveDirectoryDeps {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    sign: (b) => Promise.resolve(nodeSign(null, b, privateKey)),
    verifyAttestation: async () => true,
    broadcast: async () => {},
    now: () => NOW,
  };
}

function fakeSwarm() {
  // Real Hyperswarm is an EventEmitter — multiple topic joins each add a
  // 'connection' listener, so the fake keeps an ARRAY (one per joined topic).
  const handlers: Array<(s: unknown) => void> = [];
  const joined: Buffer[] = [];
  return {
    swarm: {
      join(t: Buffer) {
        joined.push(t);
        return {};
      },
      leave() {},
      on(_e: 'connection', l: (s: unknown) => void) {
        handlers.push(l);
      },
      off(_e: 'connection', l: (s: unknown) => void) {
        const i = handlers.indexOf(l);
        if (i >= 0) handlers.splice(i, 1);
      },
    },
    connect() {
      // One connection fans out to every topic's listener (each opens its channel).
      for (const h of [...handlers]) h({});
    },
    joined,
  };
}

function meta(over: Partial<HiveDirectoryMeta> = {}): HiveDirectoryMeta {
  return { hiveId: 'h1', title: 'Hive 1', description: 'd', visibility: 'public', memberTopics: [], createdAt: NOW - 1, ...over };
}

beforeEach(() => {
  muxers.length = 0;
});

describe('wireHiveDirectoryAtBoot (P-003 boot-join)', () => {
  it('hydrates the discovered set from the PG offline cache before the swarm reconnects', async () => {
    const f = fakeSwarm();
    const cached = {
      hiveId: 'cached-hive',
      title: 'Cached Hive',
      description: 'seen last session',
      ownerGithubLogin: 'alice',
      ownerGithubUserId: 4242,
      ownerDevicePubkey: 'pk',
      memberTopics: [],
      visibility: 'public' as const,
      createdAt: NOW - 86_400_000,
      announcedTs: NOW - 60_000,
      lastSeenMs: NOW - 60_000,
      attested: true as const,
    };
    const dir = new HiveDirectory({ ...fakeDirDeps(), loadCache: async () => [cached] });
    const wiring = await wireHiveDirectoryAtBoot({ swarm: f.swarm, keychainId: 'kc', owner: ownerIdentity(), dir });
    // Offline listing works immediately — the cache hydrated at wire time.
    expect(dir.listDiscoveredHives().map((h) => h.hiveId)).toContain('cached-hive');
    await wiring.stop();
  });

  it('joins the global directory topic and registers a connection handler', async () => {
    const f = fakeSwarm();
    const dir = new HiveDirectory(fakeDirDeps());
    const wiring = await wireHiveDirectoryAtBoot({ swarm: f.swarm, keychainId: 'kc', owner: ownerIdentity(), dir });
    expect(f.joined).toHaveLength(1);
    expect(f.joined[0].length).toBe(32);
    await wiring.stop();
  });

  it('sends a freshly-paired peer our owned public-hive announces', async () => {
    const f = fakeSwarm();
    const dir = new HiveDirectory(fakeDirDeps());
    const wiring = await wireHiveDirectoryAtBoot({
      swarm: f.swarm,
      keychainId: 'kc',
      owner: ownerIdentity(),
      ownedHives: [meta({ hiveId: 'pub', visibility: 'public' }), meta({ hiveId: 'priv', visibility: 'private' })],
      dir,
    });
    f.connect();
    muxers[0].pair();
    await new Promise((r) => setTimeout(r, 0));
    const ids = muxers[0].sent.map((s) => (s as { hive_id: string }).hive_id);
    expect(ids).toContain('pub'); // public is announced
    expect(ids).not.toContain('priv'); // private never on the wire
    await wiring.stop();
  });

  it('routes an inbound announce to the directory ingest (verified-only)', async () => {
    const f = fakeSwarm();
    const dir = new HiveDirectory(fakeDirDeps());
    const ingest = vi.spyOn(dir, 'ingestAnnounce');
    const wiring = await wireHiveDirectoryAtBoot({ swarm: f.swarm, keychainId: 'kc', owner: ownerIdentity(), dir });
    f.connect();
    muxers[0].inbound?.({ hive_id: 'remote' });
    expect(ingest).toHaveBeenCalledTimes(1);
    await wiring.stop();
  });

  it('publishing a public owned hive registers it as discoverable to listDiscoveredHives via its own announce path', async () => {
    const f = fakeSwarm();
    const dir = new HiveDirectory(fakeDirDeps());
    const announce = vi.spyOn(dir, 'announceLocalHive');
    const wiring = await wireHiveDirectoryAtBoot({
      swarm: f.swarm,
      keychainId: 'kc',
      owner: ownerIdentity(),
      ownedHives: [meta({ hiveId: 'pub', visibility: 'public' })],
      dir,
    });
    expect(announce).toHaveBeenCalledWith('pub');
    await wiring.stop();
  });

  it('joins the invite topic for an owned invite hive (a SECOND topic beyond global)', async () => {
    const f = fakeSwarm();
    const dir = new HiveDirectory(fakeDirDeps());
    const wiring = await wireHiveDirectoryAtBoot({
      swarm: f.swarm,
      keychainId: 'kc',
      owner: ownerIdentity(),
      ownedHives: [meta({ hiveId: 'inv', visibility: 'invite', inviteSecret: 'sekret' })],
      dir,
    });
    // Two distinct 32-byte topics joined: the global directory + the invite topic.
    expect(f.joined).toHaveLength(2);
    expect(f.joined[0].equals(f.joined[1])).toBe(false);
    await wiring.stop();
  });

  it('an invite hive announces ONLY on its invite topic, never the global one (no leak)', async () => {
    const f = fakeSwarm();
    const dir = new HiveDirectory(fakeDirDeps());
    const wiring = await wireHiveDirectoryAtBoot({
      swarm: f.swarm,
      keychainId: 'kc',
      owner: ownerIdentity(),
      ownedHives: [
        meta({ hiveId: 'pub', visibility: 'public' }),
        meta({ hiveId: 'inv', visibility: 'invite', inviteSecret: 'sekret' }),
      ],
      dir,
    });
    // muxers[0] = the GLOBAL topic channel (first joined); pair it.
    f.connect();
    muxers[0].pair();
    await new Promise((r) => setTimeout(r, 0));
    const globalIds = muxers[0].sent.map((s) => (s as { hive_id: string }).hive_id);
    expect(globalIds).toContain('pub'); // public goes to the global topic
    expect(globalIds).not.toContain('inv'); // the invite hive does NOT leak to global
    await wiring.stop();
  });

  it('joinInviteTopic (invitee side) joins an additional topic from a received secret', async () => {
    const f = fakeSwarm();
    const dir = new HiveDirectory(fakeDirDeps());
    const wiring = await wireHiveDirectoryAtBoot({ swarm: f.swarm, keychainId: 'kc', owner: ownerIdentity(), dir });
    expect(f.joined).toHaveLength(1); // just the global topic
    await wiring.joinInviteTopic('an-invite-secret');
    expect(f.joined).toHaveLength(2); // + the invite topic
    await wiring.stop();
  });
});
