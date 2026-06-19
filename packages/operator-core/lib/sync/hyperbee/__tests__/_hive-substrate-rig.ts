/**
 * _hive-substrate-rig.ts — a two-peer rig for the HIVE-LIFECYCLE federation suite
 * (shared-hive-federation-2026-06-08). Two REAL bootHarnessSubstrate Swarms of ONE
 * Hive on a loopback testnet DHT, each projecting the Hive's federated state
 * (`hive_members` admission + `hive_settings`) into its OWN throwaway PG via the
 * REAL projections + the REAL migration-189 / migration-186 capture triggers.
 *
 * This is the Hive-grain analog of `_cross-peer-rig.ts` (which federates presence)
 * and `feature-content-federation.integration.test.ts` (which federates feature/
 * issue content). It exists because the lifecycle gaps — dissolve / leave-hive
 * membership teardown (G24/G27), cross-hive grants (G25), hive_settings LWW (G26)
 * — all ride the SAME two federated tables (hive_members, hive_settings), and no
 * prior rig wires THOSE projections across two real peers.
 *
 * What is real vs stood-in is exactly the feature-content rig's boundary: two
 * corestores → two logs; real Hyperswarm/Noise over a local testnet DHT; real
 * verifyAnnounce; real capture triggers (mig 186 hive_settings + mig 189
 * hive_members); real outbox drain; real row→op mappers; real read-merge; real PG
 * projections on BOTH peers; two real Postgres databases. STOOD IN: the channel-2
 * GitHub-binding fetch → verifyBindingOverride admit-by-userId.
 */
import { expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHiveMembersProjection } from '../projections/hive-members';
import { buildHiveSettingsProjection } from '../projections/hive-settings';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../packages/operator-core/lib/sync/hyperbee/__tests__ → repo root is seven up.
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

// ── Shared identity / swarm constants. The Hive's home slug IS the projection
// demux scope — both peers project the SAME hive's ops. ──
export const WORKSPACE_ID = 'ws-hive-fed';
export const HIVE_SLUG = 'acme-hive'; // the Hive's home_slug
export const BINDING = {
  kind: 'local' as const,
  workspace_id: WORKSPACE_ID,
  harness_slug: HIVE_SLUG,
};

// ── Async resource teardown (newest-first). Drained by each file's afterEach. ──
export const cleanups: Array<() => void | Promise<void>> = [];
export async function rigAfterEach(): Promise<void> {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* a thrown assertion must never leak a swarm/dir/db/DHT node */
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
}

function makeWorkspaceRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

export function makeIdentity(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & { destroy(): Promise<void> };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

export async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Cluster-global framework roles the archive-102 outbox GRANTs reference. */
const FRAMEWORK_ROLES_DDL = `
  DO $r$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
  END $r$;
`;

function stripMeta(sqlText: string): string {
  return sqlText
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

/**
 * Build the federation schema in a peer's DB from the REAL migrations: the
 * archive-102 outbox + generic capture fn, then 184 (hives) + 185 (hive_members
 * admission, FK→hives) + 189 (hive_members federation cols + custom capture) + 186
 * (hive_settings + its capture trigger). Both consolidated tables that mig 102's
 * generic triggers attach to are stubbed (column-faithful) first, exactly as the
 * hive_members-federation-trigger integration test does, so 102 loads.
 */
export async function setupHivePeerSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      feature_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE IF NOT EXISTS harness_shared.harness_issues_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, issue_id)
    );
  `);
  await sql.unsafe(readFileSync(resolve(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));
  for (const m of [
    '184-hives-table.sql',
    '185-hive-members-admission.sql',
    '189-hive-members-federation-cols.sql',
    '186-hive-settings.sql',
  ]) {
    await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, m), 'utf8')));
  }
  // D-001 (mig 314): the fed_hlc ordering column the hive projections now write.
  await sql.unsafe(`ALTER TABLE harness_shared.hive_members  ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
  await sql.unsafe(`ALTER TABLE harness_shared.hive_settings ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
}

/** Per-peer apply over the REAL hive_members + hive_settings projections bound to
 *  THIS peer's `sql`, demuxed to HIVE_SLUG (the Hive home scope). */
export function buildHivePeerApply(sql: postgres.Sql, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql };
  const projections = [
    buildHiveMembersProjection(opts) as TableProjection<unknown>,
    buildHiveSettingsProjection(opts) as TableProjection<unknown>,
  ];
  const scoped = new Map<string, TableProjection<unknown>>(projections.map((p) => [p.tableTag, p]));
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

export interface HivePeer {
  handle: BootedHarnessHandle;
  pg: postgres.Sql;
  identity: ReturnType<typeof makeIdentity>;
  drain: () => Promise<number>;
}

async function bootHivePeer(opts: {
  testnetBootstrap: unknown;
  rootPrefix: string;
  identity: ReturnType<typeof makeIdentity>;
  pg: postgres.Sql;
  verify: (userId: number) => 'verified' | 'pending' | 'fail';
}): Promise<HivePeer> {
  const root = makeWorkspaceRoot(opts.rootPrefix);
  let handle: BootedHarnessHandle | undefined;
  let apply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
  handle = await bootHarnessSubstrate({
    workspaceRoot: root,
    workspaceId: WORKSPACE_ID,
    harnessSlug: HIVE_SLUG,
    swarmBinding: BINDING,
    swarmOverride: makeSwarm(opts.testnetBootstrap),
    verifyBindingOverride: async (_pk, _login, userId) => opts.verify(userId),
    applyOverride: (op) => {
      apply ??= buildHivePeerApply(opts.pg, handle!.ownLog.keyHex);
      return apply(op);
    },
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    loadRevokedOverride: async () => new Set(),
    announceIdentityOverride: opts.identity.override,
  });
  cleanups.push(async () => {
    await handle?.close();
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: HIVE_SLUG });
  });
  return { handle, pg: opts.pg, identity: opts.identity, drain: () => drainOutboxOnce(handle!, opts.pg) };
}

/** Insert the Hive identity row (FK parent for hive_members) into a peer's DB. */
export async function seedHive(sql: postgres.Sql, slug = HIVE_SLUG): Promise<void> {
  await sql`
    INSERT INTO harness_shared.hives (workspace_id, home_slug, public_key, keychain_id, created_at)
    VALUES (${WORKSPACE_ID}, ${slug}, ${Buffer.from([0])}, ${'kc-' + slug}, 0)
    ON CONFLICT (workspace_id, home_slug) DO NOTHING
  `;
}

/** Read the github_user_ids currently in a peer's hive_members for HIVE_SLUG. */
export async function memberUserIds(sql: postgres.Sql, slug = HIVE_SLUG): Promise<Set<number>> {
  const rows = await sql<Array<{ github_user_id: number }>>`
    SELECT github_user_id FROM harness_shared.hive_members
     WHERE workspace_id = ${WORKSPACE_ID} AND hive_home_slug = ${slug}
  `;
  return new Set(rows.map((r) => Number(r.github_user_id)));
}

/** Read the JSON-decoded hive_settings value for a key on a peer (null if unset). */
export async function settingValue(sql: postgres.Sql, key: string, slug = HIVE_SLUG): Promise<unknown> {
  const rows = await sql<Array<{ value: string | null }>>`
    SELECT value FROM harness_shared.hive_settings
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${slug} AND setting_key = ${key}
  `;
  const raw = rows[0]?.value;
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Boot two Swarms of ONE Hive over the real wire, with the Hive identity seeded on
 * both. Returns both peers + DBs. The Hive members / settings are seeded by the
 * caller (each gap seeds what it needs), then federated via drainBoth + mergeBoth.
 */
export async function bootTwoHivePeers() {
  const dbA: FreshPgDb = await createFreshPgDb('hiveFedA');
  cleanups.push(() => dbA.cleanup());
  const dbB: FreshPgDb = await createFreshPgDb('hiveFedB');
  cleanups.push(() => dbB.cleanup());
  await setupHivePeerSchema(dbA.sql);
  await setupHivePeerSchema(dbB.sql);
  await seedHive(dbA.sql);
  await seedHive(dbB.sql);

  // Confirm they are genuinely different databases (the meaningfulness precondition).
  const [nameA] = await dbA.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
  const [nameB] = await dbB.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
  expect(nameA.d).not.toBe(nameB.d);

  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });

  const idA = makeIdentity('alice', 42, 'kc-alice');
  const idB = makeIdentity('bob', 7, 'kc-bob');

  // Each Swarm admits the OTHER's userId (mutual admission).
  const peerB = await bootHivePeer({
    testnetBootstrap: testnet.bootstrap,
    rootPrefix: 'hivefed-B-',
    identity: idB,
    pg: dbB.sql,
    verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
  });
  const peerA = await bootHivePeer({
    testnetBootstrap: testnet.bootstrap,
    rootPrefix: 'hivefed-A-',
    identity: idA,
    pg: dbA.sql,
    verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
  });

  expect(peerA.handle.swarm).not.toBeNull();
  expect(peerB.handle.swarm).not.toBeNull();
  expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

  const mergeBoth = () => Promise.all([peerA.handle.mergeNow(), peerB.handle.mergeNow()]);
  const drainBoth = async () => (await peerA.drain()) + (await peerB.drain());

  return { dbA, dbB, idA, idB, peerA, peerB, mergeBoth, drainBoth };
}
