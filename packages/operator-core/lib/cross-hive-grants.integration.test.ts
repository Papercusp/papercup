/**
 * cross-hive-grants.integration.test.ts — owner-set cross-Hive capability grants
 * persisted in pot_settings (cross-hive-boundary-2026-06-08 P-002;
 * hive-network-surface-2026-06-11 P-004 brief B-05 directed grants), against real PG.
 *
 * Proves, through the federating pot_settings store:
 *   · INBOUND grants round-trip + drive admitCrossHiveEnvelope (allow-list / default-deny);
 *   · OUTBOUND grants round-trip + drive assertOutboundGrant (egress default-deny);
 *   · the two directions are independent (granting `in` never grants `out`);
 *   · a LEGACY flat value (written before B-05) reads as INBOUND-only, and the first
 *     directed write migrates the stored value to `{ in, out }` without losing it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  loadCrossHiveGrants,
  loadOutboundCrossHiveGrants,
  loadDirectedCrossHiveGrants,
  setCrossHiveGrant,
  revokeCrossHiveGrant,
  assertOutboundGrant,
  CROSS_HIVE_GRANTS_KEY,
} from './cross-hive-grants';
import { admitCrossHiveEnvelope, type CrossHiveEnvelope } from './cross-hive-boundary';
import { getHiveSetting, setHiveSetting } from './hive-settings-store';

const WS = 'default';
const HIVE = 'my-hive'; // the home slug
const PEER_A = 'peer-hive-A-pubkey';
const PEER_B = 'peer-hive-B-pubkey';

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
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HIVE}, ${Buffer.alloc(32)}, 'kc-1', 0)`;
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql`DELETE FROM harness_shared.pot_settings`; });

describe('inbound grant persistence round-trip', () => {
  it('starts empty', async () => {
    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([]);
  });

  it('sets, updates, and lists inbound grants per peer-Hive', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'in', db.sql);
    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([{ peerHivePubkey: PEER_A, allowedKinds: ['ask'] }]);

    // widen A's grant + add a second peer
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask', 'work-request'], 'in', db.sql);
    await setCrossHiveGrant(WS, HIVE, PEER_B, ['ask'], 'in', db.sql);
    const loaded = await loadCrossHiveGrants(WS, HIVE, db.sql);
    expect(loaded).toHaveLength(2);
    expect([...(loaded.find((g) => g.peerHivePubkey === PEER_A)?.allowedKinds ?? [])].sort()).toEqual(['ask', 'work-request']);
    expect(loaded.find((g) => g.peerHivePubkey === PEER_B)?.allowedKinds).toEqual(['ask']);
  });

  it('revokes an inbound peer entirely', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'in', db.sql);
    await setCrossHiveGrant(WS, HIVE, PEER_B, ['ask'], 'in', db.sql);
    await revokeCrossHiveGrant(WS, HIVE, PEER_A, 'in', db.sql);
    const loaded = await loadCrossHiveGrants(WS, HIVE, db.sql);
    expect(loaded.map((g) => g.peerHivePubkey)).toEqual([PEER_B]);
  });

  it('setting empty kinds clears the grant', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'in', db.sql);
    await setCrossHiveGrant(WS, HIVE, PEER_A, [], 'in', db.sql);
    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([]);
  });
});

describe('loaded inbound grants drive admission (default-deny)', () => {
  it('admits a granted peer for a granted kind; denies the ungranted', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'in', db.sql);
    const grants = await loadCrossHiveGrants(WS, HIVE, db.sql);

    expect(admitCrossHiveEnvelope(env(PEER_A, 'ask'), { selfHivePubkey: 'self', grants }).admitted).toBe(true);
    // PEER_A granted only 'ask' → a work-request is denied
    expect(admitCrossHiveEnvelope(env(PEER_A, 'work-request'), { selfHivePubkey: 'self', grants }).admitted).toBe(false);
    // PEER_B has no grant at all → denied
    expect(admitCrossHiveEnvelope(env(PEER_B, 'ask'), { selfHivePubkey: 'self', grants }).admitted).toBe(false);
  });
});

describe('outbound (egress) grants — direction is independent of inbound', () => {
  it('round-trips outbound grants separately from inbound', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'in', db.sql);
    await setCrossHiveGrant(WS, HIVE, PEER_B, ['ask', 'work-request'], 'out', db.sql);

    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([{ peerHivePubkey: PEER_A, allowedKinds: ['ask'] }]);
    expect(await loadOutboundCrossHiveGrants(WS, HIVE, db.sql)).toEqual([
      { peerHivePubkey: PEER_B, allowedKinds: ['ask', 'work-request'] },
    ]);

    const directed = await loadDirectedCrossHiveGrants(WS, HIVE, db.sql);
    expect(directed.in).toEqual([{ peerHivePubkey: PEER_A, allowedKinds: ['ask'] }]);
    expect(directed.out).toEqual([{ peerHivePubkey: PEER_B, allowedKinds: ['ask', 'work-request'] }]);
  });

  it('granting INBOUND never authorizes OUTBOUND for the same peer', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'in', db.sql);
    expect(await loadOutboundCrossHiveGrants(WS, HIVE, db.sql)).toEqual([]);
    expect((await assertOutboundGrant(WS, HIVE, PEER_A, 'ask', db.sql)).admitted).toBe(false);
  });

  it('assertOutboundGrant: default-deny unknown peer; admit after grant; deny wrong kind', async () => {
    // unknown peer — default-deny
    const denied = await assertOutboundGrant(WS, HIVE, PEER_B, 'ask', db.sql);
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toMatch(/no outbound grant/i);

    // owner grants outbound 'ask' → admitted for ask, still denied for work-request
    await setCrossHiveGrant(WS, HIVE, PEER_B, ['ask'], 'out', db.sql);
    expect((await assertOutboundGrant(WS, HIVE, PEER_B, 'ask', db.sql)).admitted).toBe(true);
    expect((await assertOutboundGrant(WS, HIVE, PEER_B, 'work-request', db.sql)).admitted).toBe(false);
  });

  it('revoking outbound leaves inbound intact', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'in', db.sql);
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'out', db.sql);
    await revokeCrossHiveGrant(WS, HIVE, PEER_A, 'out', db.sql);
    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([{ peerHivePubkey: PEER_A, allowedKinds: ['ask'] }]);
    expect(await loadOutboundCrossHiveGrants(WS, HIVE, db.sql)).toEqual([]);
  });

  it('persists the DIRECTED { in, out } shape under the federating key', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'in', db.sql);
    await setCrossHiveGrant(WS, HIVE, PEER_B, ['ask'], 'out', db.sql);
    const rec = await getHiveSetting(WS, HIVE, CROSS_HIVE_GRANTS_KEY, db.sql);
    // The federated value is the directed envelope — the shape every Swarm
    // enforces. P-013: entries persist as { kinds, …quota } objects.
    expect(rec?.value).toEqual({ in: { [PEER_A]: { kinds: ['ask'] } }, out: { [PEER_B]: { kinds: ['ask'] } } });
  });
});

describe('back-compat — a legacy flat value reads as inbound-only', () => {
  it('loads a pre-B-05 flat grant map as INBOUND grants with no outbound', async () => {
    // Simulate a value written before directions existed: the flat { peer: kinds[] } shape.
    await setHiveSetting(
      { workspaceId: WS, potHomeSlug: HIVE, settingKey: CROSS_HIVE_GRANTS_KEY, value: { [PEER_A]: ['ask', 'work-request'] } },
      db.sql,
    );
    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([
      { peerHivePubkey: PEER_A, allowedKinds: ['ask', 'work-request'] },
    ]);
    expect(await loadOutboundCrossHiveGrants(WS, HIVE, db.sql)).toEqual([]);
  });

  it('the first directed write migrates the stored value to { in, out } without losing the legacy inbound grants', async () => {
    await setHiveSetting(
      { workspaceId: WS, potHomeSlug: HIVE, settingKey: CROSS_HIVE_GRANTS_KEY, value: { [PEER_A]: ['ask'] } },
      db.sql,
    );
    // Add an outbound grant for a different peer — must preserve the legacy inbound grant.
    await setCrossHiveGrant(WS, HIVE, PEER_B, ['ask'], 'out', db.sql);

    const rec = await getHiveSetting(WS, HIVE, CROSS_HIVE_GRANTS_KEY, db.sql);
    expect(rec?.value).toEqual({ in: { [PEER_A]: { kinds: ['ask'] } }, out: { [PEER_B]: { kinds: ['ask'] } } });
    expect(await loadCrossHiveGrants(WS, HIVE, db.sql)).toEqual([{ peerHivePubkey: PEER_A, allowedKinds: ['ask'] }]);
    expect(await loadOutboundCrossHiveGrants(WS, HIVE, db.sql)).toEqual([{ peerHivePubkey: PEER_B, allowedKinds: ['ask'] }]);
  });
});

describe('P-013 — quota knobs round-trip + drive assertOutboundGrant', () => {
  it('persists maxPerHour / maxBodyBytes / expiresAt on the grant and loads them back', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'out', db.sql, {
      maxPerHour: 5,
      maxBodyBytes: 2048,
      expiresAt: 1_900_000_000_000,
    });
    expect(await loadOutboundCrossHiveGrants(WS, HIVE, db.sql)).toEqual([
      { peerHivePubkey: PEER_A, allowedKinds: ['ask'], maxPerHour: 5, maxBodyBytes: 2048, expiresAt: 1_900_000_000_000 },
    ]);
  });

  it('a re-grant WITHOUT quota fields preserves the tuned quota (merge semantics)', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'out', db.sql, { maxPerHour: 5 });
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask', 'work-request'], 'out', db.sql);
    const [g] = await loadOutboundCrossHiveGrants(WS, HIVE, db.sql);
    expect([...g.allowedKinds].sort()).toEqual(['ask', 'work-request']);
    expect(g.maxPerHour).toBe(5);
  });

  it('an EXPIRED outbound grant is denied; size + rate caps gate via the opts context', async () => {
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'out', db.sql, {
      maxPerHour: 2,
      maxBodyBytes: 10,
      expiresAt: 1_000,
    });
    // Expired (clock injected after the expiry).
    const expired = await assertOutboundGrant(WS, HIVE, PEER_A, 'ask', db.sql, { nowMs: 2_000 });
    expect(expired.admitted).toBe(false);
    expect(expired.reason).toMatch(/expired/i);

    // Un-expire by re-granting with a future expiry; size cap then trips.
    await setCrossHiveGrant(WS, HIVE, PEER_A, ['ask'], 'out', db.sql, { expiresAt: 9_999_999_999_999 });
    const oversize = await assertOutboundGrant(WS, HIVE, PEER_A, 'ask', db.sql, { bodyBytes: 11 });
    expect(oversize.admitted).toBe(false);
    expect(oversize.reason).toMatch(/exceeds the 10B cap/);

    // Rate cap via an injected counter (the PG default counts cross_pot_asks).
    const atCap = await assertOutboundGrant(WS, HIVE, PEER_A, 'ask', db.sql, {
      countRecentToPeer: async () => 2,
    });
    expect(atCap.admitted).toBe(false);
    expect(atCap.reason).toMatch(/rate cap/i);
    const underCap = await assertOutboundGrant(WS, HIVE, PEER_A, 'ask', db.sql, {
      countRecentToPeer: async () => 1,
    });
    expect(underCap.admitted).toBe(true);
  });
});
