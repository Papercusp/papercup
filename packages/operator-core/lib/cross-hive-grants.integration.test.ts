/**
 * cross-hive-grants.integration.test.ts — owner-set cross-Hive capability grants
 * persisted in hive_settings (cross-hive-boundary-2026-06-08 P-002), against real PG.
 * Proves the grant map round-trips, revoke works, empty-kinds clears, and the loaded
 * grants drive admitCrossHiveEnvelope (allow-list / default-deny).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  loadCrossHiveGrants,
  setCrossHiveGrant,
  revokeCrossHiveGrant,
} from './cross-hive-grants';
import { admitCrossHiveEnvelope, type CrossHiveEnvelope } from './cross-hive-boundary';

const WS = 'default';
const HIVE = 'my-hive'; // the home slug
const PEER_A = 'peer-hive-A-pubkey';
const PEER_B = 'peer-hive-B-pubkey';

const HIVES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.hives (
    workspace_id text NOT NULL, home_slug text NOT NULL, public_key bytea NOT NULL,
    keychain_id text NOT NULL, title text, description text,
    created_at bigint NOT NULL, updated_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, home_slug))`;
const HIVE_SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.hive_settings (
    workspace_id text NOT NULL, harness_slug text NOT NULL, setting_key text NOT NULL,
    value text, author_pubkey text, origin text NOT NULL DEFAULT 'local', fed_ts bigint,
    created_at bigint NOT NULL, updated_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, harness_slug, setting_key))`;

let db: FreshPgDb;

const env = (fromHivePubkey: string, kind: CrossHiveEnvelope['kind'] = 'ask'): CrossHiveEnvelope => ({
  fromHivePubkey,
  toHivePubkey: 'self',
  kind,
  subject: 's',
  body: 'b',
  sig: 'sig',
});

beforeAll(async () => {
  db = await createFreshPgDb('xhive-grants');
  await db.sql.unsafe(HIVES_DDL);
  await db.sql.unsafe(HIVE_SETTINGS_DDL);
  // A Hive must exist for settings to attach to (setHiveSetting enforces it).
  await db.sql`
    INSERT INTO harness_shared.hives (workspace_id, home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HIVE}, ${Buffer.alloc(32)}, 'kc-1', 0)`;
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql`DELETE FROM harness_shared.hive_settings`; });

describe('grant persistence round-trip', () => {
  it('starts empty', async () => {
    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([]);
  });

  it('sets, updates, and lists grants per peer-Hive', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], db.sql);
    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([{ peerHivePubkey: PEER_A, allowedKinds: ['ask'] }]);

    // widen A's grant + add a second peer
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask', 'work-request'], db.sql);
    await setCrossHiveGrant(WS, HIVE, PEER_B, ['ask'], db.sql);
    const loaded = await loadCrossHiveGrants(WS, HIVE, db.sql);
    expect(loaded).toHaveLength(2);
    expect([...(loaded.find((g) => g.peerHivePubkey === PEER_A)?.allowedKinds ?? [])].sort()).toEqual(['ask', 'work-request']);
    expect(loaded.find((g) => g.peerHivePubkey === PEER_B)?.allowedKinds).toEqual(['ask']);
  });

  it('revokes a peer entirely', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], db.sql);
    await setCrossHiveGrant(WS, HIVE, PEER_B, ['ask'], db.sql);
    await revokeCrossHiveGrant(WS, HIVE, PEER_A, db.sql);
    const loaded = await loadCrossHiveGrants(WS, HIVE, db.sql);
    expect(loaded.map((g) => g.peerHivePubkey)).toEqual([PEER_B]);
  });

  it('setting empty kinds clears the grant', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], db.sql);
    await setCrossHiveGrant(WS, HIVE, PEER_A, [], db.sql);
    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([]);
  });
});

describe('loaded grants drive admission (default-deny)', () => {
  it('admits a granted peer for a granted kind; denies the ungranted', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], db.sql);
    const grants = await loadCrossHiveGrants(WS, HIVE, db.sql);

    expect(admitCrossHiveEnvelope(env(PEER_A, 'ask'), { selfHivePubkey: 'self', grants }).admitted).toBe(true);
    // PEER_A granted only 'ask' → a work-request is denied
    expect(admitCrossHiveEnvelope(env(PEER_A, 'work-request'), { selfHivePubkey: 'self', grants }).admitted).toBe(false);
    // PEER_B has no grant at all → denied
    expect(admitCrossHiveEnvelope(env(PEER_B, 'ask'), { selfHivePubkey: 'self', grants }).admitted).toBe(false);
  });
});
