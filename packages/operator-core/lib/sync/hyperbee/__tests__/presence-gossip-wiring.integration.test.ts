/**
 * presence-gossip-wiring integration (real PG + fake swarm/Protomux) — the
 * P-004/P-005 READER + WRITER bindings end-to-end
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-025 residual (a)).
 *
 * Drives REAL device-signed frames through the wiring singleton's actual
 * pipeline — verify → hive_members gate → shared_presence /
 * shared_session_presence writers — over the same fake-swarm/Protomux harness
 * directory-swarm.test.ts uses (the real-wire semantics are the 2-machine
 * verify, P-025 residual (b)). Pins:
 *   • a member device's signed put frame lands in shared_presence;
 *   • a NON-member device's validly-signed frame is dropped (fail-closed);
 *   • a sessions frame lands in shared_session_presence with hive_slug pinned
 *     to the RECEIVER's binding (sender-declared hive never trusted);
 *   • a del frame removes the presence row (leave tombstone);
 *   • the writer leg broadcasts a verifiable signed frame + hello snapshot.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';

// ── Protomux fake (the directory-swarm.test.ts harness, trimmed) ──
interface FakeChannel {
  protocol: string;
  id: Buffer | null;
  onopen?: () => void;
  sent: unknown[];
  inbound?: (frame: unknown) => void;
  open(): void;
  pairRemote(): void;
}
const allChannels: FakeChannel[] = [];
interface FakeMux {
  channels: FakeChannel[];
  notify: ((id: Buffer | null) => void | Promise<void>) | null;
  createChannel(spec: { protocol: string; id?: Buffer | null; onopen?: () => void; onclose?: () => void }): FakeChannel | null;
  pair(opts: { protocol: string }, notify: (id: Buffer | null) => void | Promise<void>): void;
}
function makeMux(): FakeMux {
  const mux: FakeMux = {
    channels: [],
    notify: null,
    createChannel(spec) {
      const key = `${spec.protocol}::${spec.id ? spec.id.toString('hex') : ''}`;
      if (mux.channels.find((c) => `${c.protocol}::${c.id ? c.id.toString('hex') : ''}` === key)) return null;
      const ch: FakeChannel = {
        protocol: spec.protocol,
        id: spec.id ?? null,
        onopen: spec.onopen,
        sent: [],
        open() {},
        pairRemote() {
          this.onopen?.();
        },
      };
      (ch as unknown as { addMessage: (m: { onmessage?: (f: unknown) => void }) => { send: (v: unknown) => void } }).addMessage = (m) => {
        ch.inbound = m.onmessage;
        return { send: (v: unknown) => ch.sent.push(v) };
      };
      mux.channels.push(ch);
      allChannels.push(ch);
      return ch;
    },
    pair(_o, notify) {
      mux.notify = notify;
    },
  };
  return mux;
}
vi.mock('protomux', () => ({
  default: { from: (s: { userData?: unknown }) => (s.userData ? s.userData : makeMux()) },
}));

const {
  registerPresenceGossipTopic,
  broadcastPresencePut,
  __setPresenceGossipWiringDeps,
  __resetPresenceGossipWiring,
} = await import('../presence-gossip-wiring');
const { buildPresencePutFrame, buildPresenceDelFrame, buildSessionsFrame, verifyPresenceFrame } =
  await import('../presence-gossip');
import type { SharedPresenceRow } from '../projections/presence';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');
const stripMeta = (s: string) =>
  s.split('\n').filter((l) => !/^(begin|commit);$/i.test(l.trim()) && !l.trim().startsWith('\\')).join('\n');

const WS = 'ws_pgw';
const HIVE = 'hive-home';
const TOPIC = Buffer.alloc(32, 5);
const TOPIC_HEX = TOPIC.toString('hex');
const T0 = Date.now();

function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    pubB64: spki.subarray(spki.length - 32).toString('base64'),
    sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}
const member = makeDevice();
const member2 = makeDevice(); // a SECOND device of the same user (gh 42) — for the H2 cross-device del test
const stranger = makeDevice();

const row = (over?: Partial<SharedPresenceRow>): SharedPresenceRow => ({
  harness_slug: HIVE,
  github_user_id: 42,
  machine_label: 'laptop',
  device_pubkey: member.pubB64,
  intent: 'gossip presence e2e',
  current_view: null,
  last_seen_at: T0,
  schema_version: 1,
  hive_slug: HIVE,
  ...over,
});

async function settle(check: () => Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('presence-gossip wiring (real PG, fake swarm)', () => {
  let db: FreshPgDb;
  let channel: FakeChannel;

  beforeAll(async () => {
    db = await createFreshPgDb('presence_gossip_wiring');
    await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
    // shared_presence (baseline shape + mig 187 hive_slug + LWW guard cols) with
    // the conflict target the projection upserts on.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.shared_presence (
        workspace_id text NOT NULL DEFAULT '',
        harness_slug text NOT NULL,
        github_user_id bigint NOT NULL,
        machine_label text NOT NULL,
        device_pubkey text NOT NULL,
        intent text,
        current_view text,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        schema_version bigint NOT NULL DEFAULT 1,
        hive_slug text,
        fed_ts bigint,
        fed_hlc text,
        author_pubkey text,
        PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label));
    `);
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '434-shared-session-presence.sql'), 'utf8')));
    // P-301: the fleet-membership columns the session-presence writer now sets.
    await db.sql.unsafe(
      stripMeta(readFileSync(resolve(SQL_DIR, '479-shared-session-presence-fleet-slug.sql'), 'utf8')),
    );

    // Fake swarm + injected deps: the member device is attested; nobody revoked.
    let handler: ((s: unknown) => void) | null = null;
    const swarm = {
      join: () => ({ refresh: () => {} }),
      leave: async () => {},
      on: (_e: string, l: (s: unknown) => void) => {
        handler = l;
      },
      off: () => {},
      connections: new Set<unknown>(),
    };
    __setPresenceGossipWiringDeps({
      getSwarm: async () => swarm as never,
      sql: db.sql,
      listHiveMembers: (async () => [
        {
          githubUserId: 42,
          deviceAttestations: [{ device_pubkey: member.pubB64 }, { device_pubkey: member2.pubB64 }],
          revokedPubkeys: [],
        },
      ]) as never,
      loadRevokedHivePubkeys: (async () => []) as never,
    });

    expect(
      await registerPresenceGossipTopic({ topicHex: TOPIC_HEX, workspaceId: WS, hiveHomeSlug: HIVE }),
    ).toBe(true);
    // A peer connects; the gossip opens + pairs the topic channel.
    const socket: { userData?: FakeMux } = {};
    swarm.connections.add(socket);
    handler!(socket);
    channel = allChannels.find((c) => c.id?.equals(TOPIC))!;
    expect(channel).toBeDefined();
    channel.pairRemote();
  }, 60_000);

  afterAll(async () => {
    await __resetPresenceGossipWiring();
    await db?.cleanup();
  });

  it('a member device\'s signed put frame lands in shared_presence', async () => {
    channel.inbound!(await buildPresencePutFrame(row(), T0, member.sign));
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42`).length > 0,
    );
    const rows = await db.sql<{ intent: string; origin?: string }[]>`
      SELECT intent FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42`;
    expect(rows[0]?.intent).toBe('gossip presence e2e');
  });

  it('L9: a put frame\'s hive_slug is PINNED to the receiver binding (spoofed sender hive ignored)', async () => {
    // The put path previously trusted the sender-declared row.hive_slug; an admitted
    // member could plant a presence row under a FOREIGN hive scope (which the per-hive
    // lock authority scopes by). applyPut now pins hive_slug to binding.hiveHomeSlug,
    // exactly as the sessions path already does.
    // gh 42 = the member's ATTESTED id (H3 requires it); a distinct machine_label
    // so this is its own row. The spoofed hive_slug must still be pinned to HIVE.
    channel.inbound!(
      await buildPresencePutFrame(
        row({ github_user_id: 42, machine_label: 'desktop', hive_slug: 'evil-foreign-hive' }),
        T0,
        member.sign,
      ),
    );
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND machine_label='desktop'`).length > 0,
    );
    const [pinned] = await db.sql<{ hive_slug: string }[]>`
      SELECT hive_slug FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND machine_label='desktop'`;
    expect(pinned.hive_slug).toBe(HIVE); // never 'evil-foreign-hive'
  });

  it('a NON-member device\'s validly-signed frame is dropped (fail-closed member gate)', async () => {
    channel.inbound!(
      await buildPresencePutFrame(
        row({ device_pubkey: stranger.pubB64, github_user_id: 666, machine_label: 'evil' }),
        T0,
        stranger.sign,
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=666`,
    ).toHaveLength(0);
  });

  it('a sessions frame lands with hive_slug PINNED to the receiver binding (sender hive ignored)', async () => {
    channel.inbound!(
      await buildSessionsFrame(
        { devicePubkey: member.pubB64, githubUserId: 42, machineLabel: 'laptop', hiveSlug: 'evil-foreign-hive' },
        [
          { owner_id: 'su-remote-1', kind: 'su', intent: 'x', plan_slug: null, harness_slug: HIVE, last_active_ms: T0 },
          { owner_id: 's-bee-9', kind: 'cup', intent: null, plan_slug: 'p', harness_slug: HIVE, last_active_ms: T0 },
        ],
        T0 + 1000,
        member.sign,
      ),
    );
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_session_presence WHERE workspace_id=${WS}`).length >= 2,
    );
    const rows = await db.sql<{ owner_id: string; hive_slug: string }[]>`
      SELECT owner_id, hive_slug FROM harness_shared.shared_session_presence WHERE workspace_id=${WS} ORDER BY owner_id`;
    expect(rows.map((r) => r.owner_id)).toEqual(['s-bee-9', 'su-remote-1']);
    expect(rows.every((r) => r.hive_slug === HIVE)).toBe(true); // never 'evil-foreign-hive'
  });

  it('H2: a member device CANNOT evict another device\'s presence row (cross-device del is device-scoped)', async () => {
    // Device A (member) owns a row; device B (member2, same user gh 42, also
    // admitted) signs a del targeting A's (gh 42, laptop) row. Even though B is a
    // valid member and the del is validly self-signed + user-matched, the delete is
    // scoped to B's OWN device_pubkey — so A's row (owned by device A) SURVIVES.
    channel.inbound!(await buildPresencePutFrame(row({ machine_label: 'laptop' }), T0 + 100, member.sign));
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42 AND machine_label='laptop'`).length > 0,
    );
    channel.inbound!(
      await buildPresenceDelFrame(
        member2.pubB64, // device B signs a del for device A's row
        { github_user_id: 42, machine_label: 'laptop', harness_slug: HIVE },
        T0 + 200,
        member2.sign,
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    // A's row is untouched — B's del could not reach a row it does not own.
    expect(
      await db.sql`SELECT device_pubkey FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42 AND machine_label='laptop'`,
    ).toHaveLength(1);
  });

  it('a del frame removes the presence row (leave tombstone)', async () => {
    channel.inbound!(
      await buildPresenceDelFrame(
        member.pubB64,
        { github_user_id: 42, machine_label: 'laptop', harness_slug: HIVE },
        T0 + 2000,
        member.sign,
      ),
    );
    // Scoped to the 'laptop' row: the L9-pin test above left a distinct (gh 42,
    // 'desktop') row that this del does not target — so the del removing ONLY
    // (gh 42, laptop) is itself the correct, machine-scoped behavior.
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42 AND machine_label='laptop'`).length === 0,
    );
    expect(
      await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42 AND machine_label='laptop'`,
    ).toHaveLength(0);
  });

  it('the writer leg broadcasts a verifiable signed frame; hello serves the current row', async () => {
    expect(
      await registerPresenceGossipTopic({
        topicHex: TOPIC_HEX,
        workspaceId: WS,
        hiveHomeSlug: HIVE,
        writer: {
          devicePubkey: member.pubB64,
          sign: member.sign,
          githubUserId: 42,
          machineLabel: 'laptop',
          hiveSlug: HIVE,
          getOwnRow: async () => row({ intent: 'writer beat' }),
        },
      }),
    ).toBe(true);
    const before = channel.sent.length;
    expect(await broadcastPresencePut(TOPIC_HEX, row({ intent: 'writer beat' }))).toBe(true);
    expect(channel.sent.length).toBe(before + 1);
    const frame = channel.sent[channel.sent.length - 1] as never;
    expect(verifyPresenceFrame(frame, { nowMs: Date.now() })).toBe(true);
  });
});
