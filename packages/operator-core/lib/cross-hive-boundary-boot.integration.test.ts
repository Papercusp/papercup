/**
 * cross-hive-boundary-boot.integration.test.ts — the P-001 boot-wiring proof
 * (hive-network-surface-2026-06-11, brief B-01): after the boot ensure, the
 * boundary is LIVE — a peer's GRANTED ask is admitted per REAL PG grants and an
 * UNGRANTED kind is still rejected (sovereignty survives the auto-wiring); a
 * private hive never wires; a visibility flip to private takes the boundary
 * dark on the next ensure. The durable outbox is the REAL PgCrossHiveOutbox so
 * the boot path is exercised end-to-end against PG.
 *
 * The transport is an in-process paired mesh (deterministic) — the live
 * Hyperswarm hop is proven in cross-hive-two-hive.test.ts; what THIS test owns
 * is the boot composition: publish-state → ensure → wire → grant-gated admit.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  __resetCrossHiveBoundaryBootForTests,
  ensureCrossHiveBoundariesWired,
  type EnsureCrossHiveBoundariesOpts,
} from './cross-hive-boundary-boot';
import { getCrossHiveBoundary } from './cross-hive-boundary-registry';
import { wireCrossHiveBoundary } from './cross-hive-wiring';
import { setCrossHiveGrant, loadCrossHiveGrants } from './cross-hive-grants';
import { PgCrossHiveOutbox } from './cross-hive-outbox-pg';
import { InMemoryCrossHiveOutbox, type CrossHiveTransport, type CrossHiveWireEnvelope } from './cross-hive-transport';
import type { CrossHiveBoundaryPorts, CrossHiveEnvelope } from './cross-hive-boundary';
import type { HiveDirectoryMeta } from './hive-publish';

const WS = 'default';
const B_SLUG = 'hive-b';

const HIVES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.pots (
    workspace_id text NOT NULL, pot_home_slug text NOT NULL, public_key bytea NOT NULL,
    keychain_id text NOT NULL, title text, description text,
    created_at bigint NOT NULL, updated_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, pot_home_slug))`;
const HIVE_SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.pot_settings (
    workspace_id text NOT NULL, harness_slug text NOT NULL, setting_key text NOT NULL,
    value text, author_pubkey text, origin text NOT NULL DEFAULT 'local', fed_ts bigint,
    fed_hlc text,
    created_at bigint NOT NULL, updated_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, harness_slug, setting_key))`;
// Mirrors migration 196 (minus psql directives + role grants the test DB lacks).
const OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.cross_pot_outbox (
    workspace_id text NOT NULL, pot_slug text NOT NULL, id text NOT NULL,
    from_hive_pubkey text NOT NULL, to_hive_pubkey text NOT NULL, kind text NOT NULL,
    subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
    correlation_id text, sig text NOT NULL,
    created_at bigint NOT NULL DEFAULT 0, attempt_count integer NOT NULL DEFAULT 0,
    last_attempt_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, pot_slug, id),
    CONSTRAINT cross_pot_outbox_kind_check CHECK (kind IN ('ask','work-request','answer','decline')))`;
// Mirrors migration 231 (the C-1 ask ledger) — the boot-wired boundary's default
// quota ledger records every ADMITTED inbound request as an `in` row (P-013).
const ASKS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.cross_pot_asks (
    workspace_id text NOT NULL, pot_slug text NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    peer_pubkey text NOT NULL, direction text NOT NULL DEFAULT 'out',
    kind text NOT NULL, subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
    correlation_id text NOT NULL, state text NOT NULL DEFAULT 'queued',
    reply_body text, reply_ts timestamptz,
    asked_by text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cross_pot_asks_pkey PRIMARY KEY (id),
    CONSTRAINT cross_pot_asks_workspace_nonempty CHECK (workspace_id <> ''),
    CONSTRAINT cross_pot_asks_direction_check CHECK (direction IN ('out','in')),
    CONSTRAINT cross_pot_asks_kind_check CHECK (kind IN ('ask','work-request')),
    CONSTRAINT cross_pot_asks_state_check CHECK (state IN ('queued','sent','answered','declined','expired')),
    CONSTRAINT cross_pot_asks_correlation_uniq UNIQUE (workspace_id, pot_slug, correlation_id))`;

let db: FreshPgDb;

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

function hiveIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubkey: rawPubkeyBase64(publicKey),
    signer: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

/** In-process paired mesh — close() unregisters, so a closed boundary goes dark. */
function makeTransportMesh() {
  const subs = new Map<string, (env: CrossHiveWireEnvelope) => void | Promise<unknown>>();
  const make = (selfPubkey: string): CrossHiveTransport & { close(): Promise<void> } => ({
    subscribe(handler) {
      subs.set(selfPubkey, handler);
    },
    async send(toHivePubkey, env) {
      const h = subs.get(toHivePubkey);
      if (!h) throw new Error(`mesh: no peer ${toHivePubkey}`);
      await h(env);
    },
    async close() {
      subs.delete(selfPubkey);
    },
  });
  return { make, subs };
}

const metaFor = (potId: string, visibility: HiveDirectoryMeta['visibility']): HiveDirectoryMeta => ({
  potId,
  title: potId,
  description: '',
  visibility,
  memberTopics: [],
  createdAt: 1,
  ...(visibility === 'invite' ? { inviteSecret: 'secret' } : {}),
});

beforeAll(async () => {
  db = await createFreshPgDb('xhive-boot');
  await db.sql.unsafe(HIVES_DDL);
  await db.sql.unsafe(HIVE_SETTINGS_DDL);
  await db.sql.unsafe(OUTBOX_DDL);
  await db.sql.unsafe(ASKS_DDL);
  await db.sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${B_SLUG}, ${Buffer.alloc(32)}, 'kc-b', 0)`;
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.pot_settings`;
  await db.sql`DELETE FROM harness_shared.cross_pot_outbox`;
});
afterEach(() => {
  __resetCrossHiveBoundaryBootForTests();
});

describe('boot ensure → the boundary is LIVE with PG-grant sovereignty intact', () => {
  it('wires the published hive at boot, admits a granted ask, rejects an ungranted kind, and a private flip goes dark', async () => {
    const A = hiveIdentity(); // the external peer Hive (its own plain wiring)
    const B = hiveIdentity(); // OUR hive — boot-wired via ensure
    const mesh = makeTransportMesh();

    // B's recording ports — what the boot-wired boundary admitted.
    const admitted = { asks: [] as CrossHiveEnvelope[], workRequests: [] as CrossHiveEnvelope[] };
    const recordingPorts: CrossHiveBoundaryPorts = {
      async openAsk(env) {
        admitted.asks.push(env);
        return { ref: `conv-${admitted.asks.length}` };
      },
      async createWorkRequest(env) {
        admitted.workRequests.push(env);
        return { ref: `wi-${admitted.workRequests.length}` };
      },
    };

    let metas = [metaFor(B_SLUG, 'public'), metaFor('hive-private', 'private')];
    const opts: EnsureCrossHiveBoundariesOpts = {
      listHives: async () => metas,
      loadPubkey: async (_ws, slug) => (slug === B_SLUG ? B.pubkey : null),
      makeTransport: ({ selfHivePubkey }) => mesh.make(selfHivePubkey),
      makeOutbox: (ws, slug) => new PgCrossHiveOutbox(ws, slug, db.sql),
      wireDeps: {
        requestPorts: recordingPorts,
        loadGrants: () => loadCrossHiveGrants(WS, B_SLUG, db.sql), // REAL PG grants drive admission
        signer: B.signer,
      },
      drainOnWire: false,
      sql: db.sql, // default wiring deps (ask ledger etc.) stay in the test DB
    };

    // ── BOOT: the ensure wires the published hive; the private one stays dark.
    const res = await ensureCrossHiveBoundariesWired(WS, opts);
    expect(res.wired).toEqual([B_SLUG]);
    expect(getCrossHiveBoundary(WS, B_SLUG)).toBeDefined();
    expect(getCrossHiveBoundary(WS, 'hive-private')).toBeUndefined();
    expect(mesh.subs.has(B.pubkey)).toBe(true); // B is subscribed = boundary LIVE

    // The external peer A wires itself directly (it is not ours to boot).
    const aWiring = wireCrossHiveBoundary({
      workspaceId: WS,
      potSlug: 'hive-a',
      hivePubkey: A.pubkey,
      transport: mesh.make(A.pubkey),
      signer: A.signer,
      requestPorts: {
        async openAsk() {
          return { ref: 'x' };
        },
        async createWorkRequest() {
          return { ref: 'x' };
        },
      },
      loadGrants: async () => [],
      // A's owner allows OUTBOUND traffic to B (egress default-deny, B-05).
      loadOutboundGrants: async () => [{ peerHivePubkey: B.pubkey, allowedKinds: ['ask', 'work-request'] }],
      outbox: new InMemoryCrossHiveOutbox(),
    });

    // B's owner grants A only 'ask' (inbound admission) — in REAL PG.
    await setCrossHiveGrant(WS, B_SLUG, A.pubkey, ['ask'], 'in', db.sql);

    // ── GRANTED ask → admitted + routed through the boot-wired boundary.
    const r1 = await aWiring.send(B.pubkey, { id: 'ask-1', kind: 'ask', subject: 'help?', body: 'with X' });
    expect(r1.delivered).toBe(true);
    expect(admitted.asks).toHaveLength(1);
    expect(admitted.asks[0]).toMatchObject({ fromHivePubkey: A.pubkey, kind: 'ask', subject: 'help?' });

    // ── UNGRANTED work-request → still rejected at admission (sovereignty).
    const r2 = await aWiring.send(B.pubkey, { id: 'wr-1', kind: 'work-request', subject: 'do', body: 'task' });
    expect(r2.delivered).toBe(true); // on the wire…
    expect(admitted.workRequests).toHaveLength(0); // …but never admitted

    // ── Republish (unchanged visibility) is a no-op.
    const res2 = await ensureCrossHiveBoundariesWired(WS, opts);
    expect(res2).toMatchObject({ wired: [], alreadyWired: [B_SLUG], closed: [] });

    // ── Visibility flip to private → the next ensure takes the boundary DARK.
    metas = [metaFor(B_SLUG, 'private')];
    const res3 = await ensureCrossHiveBoundariesWired(WS, opts);
    expect(res3.closed).toEqual([B_SLUG]);
    expect(getCrossHiveBoundary(WS, B_SLUG)).toBeUndefined();
    expect(mesh.subs.has(B.pubkey)).toBe(false); // unsubscribed — unreachable
    const r4 = await aWiring.send(B.pubkey, { id: 'ask-2', kind: 'ask', subject: 'still there?', body: '…' });
    expect(r4).toEqual({ delivered: false, queued: true }); // dark hive: peer's send store-and-forwards
    expect(admitted.asks).toHaveLength(1); // nothing new admitted
  });
});
