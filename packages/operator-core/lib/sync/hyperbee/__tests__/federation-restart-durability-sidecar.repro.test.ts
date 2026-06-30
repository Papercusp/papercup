/**
 * federation-restart-durability-sidecar.repro.test.ts
 *
 * Plan: shared-hive-member-content-federation-2026-06-20 (D-053, D-054).
 *
 * ## What this repro proves — DURABLE federation across a FULL PROCESS RESTART (sidecar mode)
 * Receive-side federation works in SUBSTRATE_SIDECAR mode (D-053): a fresh
 * TOPIC-bound member bootstrap-admits the owner, federates the roster, and applies
 * owner-authored content (origin='remote'). `federation-reconnect-catchup-sidecar`
 * proves the member survives a TRANSPORT loss (swarm close + rekey onto a fresh
 * swarm) WITHOUT tearing down its store / own-log / admitted-set / merge-cursor.
 *
 * This repro is the STRONGER variant the D-054 matrix did not yet cover: a real
 * PROCESS RESTART. The member's sidecar host is closed FULLY (`host.closeAll()` →
 * `booted.close()` → `closeHarnessStore` evicts the corestore from the process
 * cache + releases its on-disk file lock), then a FRESH sidecar host is booted on
 * the SAME on-disk corestore dir + the SAME (env-routed) PG — a COLD re-open from
 * disk, mirroring `cold-boot-resume.test.ts` but end-to-end across the sidecar
 * boot/swarm/admission/merge path + the outbox drain. NOTHING in-memory survives:
 *   - the own log is RE-DERIVED from disk (same key + length read back),
 *   - the admitted-set + merge cursor start EMPTY (createMergeCursor per boot), so
 *     the member must RE-ADMIT the owner from its PERSISTED state (the
 *     `hive_directory_cache` owner binding + the federated `hive_members` roster
 *     both live in PG, which survives the restart) and RE-FOLD the owner log,
 *   - the outbox `drained_at` watermark — the at-least-once dedup key — lives in
 *     PG, so a fresh process MUST NOT re-emit already-drained rows.
 *
 * Sequence:
 *   1. OWNER + MEMBER federate. The owner authors its roster + an INITIAL feature
 *      (drains to its log); the member bootstrap-admits, federates the roster, and
 *      applies F-init (origin=remote).
 *   2. The MEMBER authors its OWN local feature (M-pre) and DRAINS its outbox —
 *      one row appended to the member's own log, its outbox row stamped drained_at.
 *      (`skipOwnOps` on the features projection + the CDC `origin <> 'local'`
 *      echo-guard mean neither the own-log re-fold nor a remote apply re-captures,
 *      so the member's outbox holds exactly its own local writes — no echo loop.)
 *   3. RESTART the member: `host.closeAll()` (full close), then RE-BOOT a fresh
 *      sidecar host on the SAME corestore dir + SAME PG (cold re-open from disk) on
 *      a FRESH swarm. Asserts the own log survived (same key + length) and the
 *      drain RESUMES with NO double-append — a re-drain of the COLD-reopened member
 *      drains 0 (the `drained_at` watermark survived the restart) and the own log
 *      does not grow.
 *   4. The OWNER authors NEW content (F-post) during/after the restart and drains
 *      again — exactly the NEW row drains (the pre-restart rows are NOT re-emitted:
 *      they keep their original `drained_at`; the owner log grows by exactly one).
 *   5. The restarted member RE-ADMITS the owner, the merge RESUMES, and F-post
 *      applies (origin=remote) — with NO loss (F-init + M-pre intact) and NO
 *      duplicate PG rows (one row per (harness_slug, feature_id)).
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/federation-restart-durability-sidecar.repro.test.ts
 */

import { afterEach, describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import {
  bootHarnessSubstrate,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import { deriveSwarmTopic, type SwarmBinding } from '../derive-swarm-topic';
import {
  createSubstrateSidecarHost,
  type SubstrateSidecarHost,
} from '../substrate-sidecar-host';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
import { buildIssuesProjection } from '../projections/issues';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  FILL_WORKSPACE_ID_DDL,
  HARNESS_ISSUES_CONSOLIDATED_FED_DDL,
} from '../../../../test/_work-items-schema';
import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { mutateHarnessRegistry } from '../../../harness-registry';
import { _clearHiveMemberDeviceSetCacheForTest } from '../hive-member-identity-set';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const WORKSPACE_ID = 'ws-sidecar-restart';

const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
  END $pg$;
`;

/** Strip psql meta + bare BEGIN/COMMIT so a migration file applies via sql.unsafe(). */
function stripMig(s: string): string {
  return s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('\\') && !/^(begin|commit);$/i.test(t);
    })
    .join('\n');
}

/**
 * The OWNER author's content-origin schema: harness_features_consolidated + the
 * CDC capture (375) PLUS the Hive schema (184 hives + 185 hive_members + 189
 * federation-cols) so the owner can author its ROSTER + features and have them
 * drain to its log (the member federates from there).
 */
async function setupOwnerSchema(sql: postgres.Sql, hiveHome: string, hivePubkeyB64: string): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, slug TEXT,
      workspace_id TEXT, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL
    );
  `);
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-fed', 'Fed', 'active', ${hiveHome}, ${WORKSPACE_ID}, 0, 0)
  `;
  await sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  await sql.unsafe(FILL_WORKSPACE_ID_DDL);
  await sql.unsafe(HARNESS_ISSUES_CONSOLIDATED_FED_DDL);
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '375-work-items-cdc-capture.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '184-hives-table.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '185-hive-members-admission.sql'), 'utf8')));
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '189-hive-members-federation-cols.sql'), 'utf8')));
  await sql`
    INSERT INTO harness_shared.hives
      (workspace_id, home_slug, public_key, keychain_id, title, description, created_at, updated_at)
    VALUES (${WORKSPACE_ID}, ${hiveHome}, decode(${hivePubkeyB64}, 'base64'),
            'kc-owner-home', 'Owner Home', null, 1, 1)
  `;
}

/** The OWNER's throwaway per-peer apply (its own content origin DB). */
function buildOwnerApply(sql: postgres.Sql, hiveHome: string, ownLogKeyHex: string): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: hiveHome, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [buildHarnessFeaturesProjection(opts), buildIssuesProjection(opts)] as TableProjection<unknown>[]) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a swarm/dir/db
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

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
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

function makeIdentityOverride(login: string, userId: number, keychainId: string) {
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

/** Build a fresh Hyperswarm on the testnet bootstrap, registered for cleanup. */
function makeSwarm(bootstrap: unknown): HyperswarmLike & { destroy(): Promise<void> } {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
  };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

async function pollUntil<T>(
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

interface PeerControl {
  host: SubstrateSidecarHost;
  handle: BootedHarnessHandle;
  storeId: string;
  mergeNow(): Promise<number>;
}

/**
 * Boot one peer THROUGH a dedicated substrate sidecar HOST (its own "process").
 * Returns the HOST too so a RESTART can `closeAll()` it and a fresh host can be
 * booted on the same on-disk store. The close is NOT auto-registered for cleanup
 * — the caller owns the lifecycle (the restart closes it mid-test; the final host
 * is torn down via the returned host pushed onto `cleanups`).
 */
async function bootViaSidecarHost(args: {
  root: string;
  swarm: HyperswarmLike;
  harnessSlug: string;
  binding: SwarmBinding;
  bootExtra: Partial<BootHarnessOpts>;
}): Promise<PeerControl> {
  let captured: BootedHarnessHandle | undefined;
  const host: SubstrateSidecarHost = createSubstrateSidecarHost({
    bootHarnessImpl: async (bootOpts: BootHarnessOpts) => {
      const handle = await bootHarnessSubstrate({
        ...bootOpts,
        swarmOverride: args.swarm,
        mergePollMs: 0,
        pendingRetryMs: 0,
        swarmJoinRetryMs: 0,
        reverifyIntervalMs: 0,
        loadRevokedOverride: async () => new Set(),
        ...args.bootExtra,
      });
      captured = handle;
      return handle;
    },
    wireOutbox: async () => {},
    wirePresence: async () => {},
  });

  const booted = (await host.methods['substrate:bootHarness']({
    workspaceId: WORKSPACE_ID,
    harnessSlug: args.harnessSlug,
    workspaceRoot: args.root,
    swarmBinding: args.binding,
  })) as { storeId: string };
  if (!captured) throw new Error('bootHarnessImpl did not run (host boot failed)');

  return {
    host,
    handle: captured,
    storeId: booted.storeId,
    mergeNow: async () => {
      const r = (await host.methods['substrate:triggerMergeNow']({
        storeId: booted.storeId,
      })) as { mergedOps: number };
      return r.mergedOps;
    },
  };
}

/** Read one feature row for a slug from the member's (admin/RLS-bypass) org DB. */
async function readFeature(orgSql: postgres.Sql, slug: string, featureId: string) {
  const rows = await orgSql<
    Array<{ feature_id: string; title: string | null; status: string | null; origin: string }>
  >`
    SELECT feature_id, title, status, origin
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${slug} AND feature_id = ${featureId}
  `;
  return rows[0];
}

/** Outbox row census for a (workspace, slug) — total / drained / undrained. */
async function outboxCounts(
  sql: postgres.Sql,
  slug: string,
): Promise<{ total: number; drained: number; undrained: number }> {
  const [r] = await sql<Array<{ total: number; drained: number; undrained: number }>>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE drained_at IS NOT NULL)::int AS drained,
           count(*) FILTER (WHERE drained_at IS NULL)::int AS undrained
      FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${slug}`;
  return r;
}

/** Snapshot (id → drained_at) for every drained row of a (workspace, slug). */
async function drainedStamps(sql: postgres.Sql, slug: string): Promise<Map<string, string>> {
  const rows = await sql<Array<{ id: string | number; drained_at: string | number }>>`
    SELECT id, drained_at FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${slug} AND drained_at IS NOT NULL`;
  return new Map(rows.map((r) => [String(r.id), String(r.drained_at)]));
}

describe('SIDECAR restart-durability federation (D-053/D-054) — member sidecar RESTARTS (cold re-open from disk), owner authors NEW content, member re-admits + drain resumes (no double-append) + content applies (no loss/dup)', () => {
  it(
    'member federates an initial owner op + its own local op, FULLY RESTARTS its sidecar host (cold re-open same corestore dir + same PG), and: own log survives, drain resumes with NO re-emit, owner NEW content applies (origin=remote), pre-restart content intact, no duplicate PG rows',
    async () => {
      const HIVE_HOME = 'owner-hive';
      const MEMBER_SLUG = 'joined-owner-hive';

      // ── env-route getOrgPg at a migrated org DB = the MEMBER's PG view. ──
      const orgDb: OrgTestDb = await createOrgTestDb();
      const prev = {
        adminUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
        appUrl: process.env.HARNESS_DATABASE_URL,
        ws: process.env.PAPERCUSP_WORKSPACE_ID,
        skip: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
        pgb: process.env.PAPERCUSP_PGBOUNCER,
      };
      process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
      process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
      process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE_ID;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      process.env.PAPERCUSP_PGBOUNCER = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      await resetDbOrgPools();
      _clearHiveMemberDeviceSetCacheForTest();
      cleanups.push(async () => {
        if (prev.adminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL; else process.env.HARNESS_ADMIN_DATABASE_URL = prev.adminUrl;
        if (prev.appUrl === undefined) delete process.env.HARNESS_DATABASE_URL; else process.env.HARNESS_DATABASE_URL = prev.appUrl;
        if (prev.ws === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID; else process.env.PAPERCUSP_WORKSPACE_ID = prev.ws;
        if (prev.skip === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY; else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prev.skip;
        if (prev.pgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER; else process.env.PAPERCUSP_PGBOUNCER = prev.pgb;
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        _clearHiveMemberDeviceSetCacheForTest();
        await resetDbOrgPools();
        await orgDb.cleanup();
      });

      const idOwner = makeIdentityOverride('owner', 99, 'kc-owner');
      const idMember = makeIdentityOverride('member', 7, 'kc-member');
      const { publicKey: hivePub } = generateKeyPairSync('ed25519');
      const hivePubkeyB64 = rawPubkeyBase64(hivePub);

      // MEMBER's PG: a hives row for HIVE_HOME (home resolution) + the VERIFIED
      // directory-cache owner binding. NO hive_members rows → EMPTY roster (fresh join).
      // BOTH survive the restart (PG is durable) → the re-booted member re-admits.
      await orgDb.adminSql`
        INSERT INTO harness_shared.hives
          (workspace_id, home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;
      await orgDb.adminSql`
        INSERT INTO harness_shared.hive_directory_cache (workspace_id, payload, updated_at)
        VALUES (${WORKSPACE_ID}, ${JSON.stringify({
          hives: [{ hivePubkey: hivePubkeyB64, ownerDevicePubkey: idOwner.devicePubkey }],
        })}::text::jsonb, 1)
      `;
      // Registry: HIVE_HOME is a remote_hive VIEW; MEMBER_SLUG is its member harness.
      // (The member's own local feature is inserted WITH an explicit workspace_id, so
      // the work_items fill trigger never consults harness_shared.projects — no
      // projects row for MEMBER_SLUG is needed.)
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/owner-hive', harness_kind: 'hive', remote_hive: true },
            { slug: MEMBER_SLUG, path: '/tmp/member', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );

      // OWNER's content-origin DB (its slug IS the hive home) + the hive schema.
      const dbOwner: FreshPgDb = await createFreshPgDb('restartOwner');
      cleanups.push(() => dbOwner.cleanup());
      await setupOwnerSchema(dbOwner.sql, HIVE_HOME, hivePubkeyB64);

      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const swarmOwner = makeSwarm(testnet.bootstrap);
      const swarmMember1 = makeSwarm(testnet.bootstrap); // member's FIRST (pre-restart) transport
      const rootOwner = makeWorkspaceRoot('restart-owner-');
      const rootMember = makeWorkspaceRoot('restart-member-');

      const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: hivePubkeyB64 };
      // The MEMBER boots on a TOPIC binding (the real invite/link join, D-053).
      const memberBinding: SwarmBinding = {
        kind: 'topic',
        topic_hex: deriveSwarmTopic(hiveBinding).toString('hex'),
      };

      // OWNER = AUTHOR: real per-peer apply on its own content-origin DB (its
      // own-log re-fold is skipOwnOps so the merge never re-captures to its outbox).
      let ownerApply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let owner: PeerControl;
      owner = await bootViaSidecarHost({
        root: rootOwner,
        swarm: swarmOwner,
        harnessSlug: HIVE_HOME,
        binding: hiveBinding,
        bootExtra: {
          announceIdentityOverride: idOwner.override,
          verifyBindingOverride: async (_pk, _login, userId) =>
            userId === idMember.userId ? 'verified' : 'fail',
          applyOverride: (op) => {
            ownerApply ??= buildOwnerApply(dbOwner.sql, HIVE_HOME, owner.handle.ownLog.keyHex);
            return ownerApply(op);
          },
        },
      });
      cleanups.push(async () => {
        await owner.host.closeAll();
        await closeHarnessStore({ workspaceRoot: rootOwner, harnessSlug: HIVE_HOME });
      });

      // Boot (or RE-BOOT) the MEMBER sidecar host on a given transport. Re-callable
      // on the SAME on-disk root to model a process restart (cold re-open). REAL
      // apply (no applyOverride → getOrgPg/orgDb), TOPIC binding, EMPTY in-memory
      // roster → real bootstrap-admit (D-053).
      const bootMember = (swarm: HyperswarmLike) =>
        bootViaSidecarHost({
          root: rootMember,
          swarm,
          harnessSlug: MEMBER_SLUG,
          binding: memberBinding,
          bootExtra: { announceIdentityOverride: idMember.override },
        });

      let member = await bootMember(swarmMember1);

      expect(owner.handle.swarm, 'owner did not join a swarm').not.toBeNull();
      expect(member.handle.swarm, 'member did not join a swarm').not.toBeNull();
      expect(owner.handle.swarm!.topicHex).toBe(member.handle.swarm!.topicHex);

      const ownerLogKey = owner.handle.ownLog.keyHex;

      // ── STEP 1: OWNER authors its ROSTER (owner + member) + an INITIAL feature →
      //    outbox → drain → owner log. ──
      const memberAtt = (login: string, pk: string) =>
        JSON.stringify([
          { device_pubkey: pk, gist_id: `gist-${login}`, gist_url: `https://gist.github.com/${login}`, device_label: `${login}-dev`, created_at: 1, signature_by_device: 'sig' },
        ]);
      await dbOwner.sql`
        INSERT INTO harness_shared.hive_members
          (workspace_id, hive_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idOwner.userId}, 'owner', ${memberAtt('owner', idOwner.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.hive_members
          (workspace_id, hive_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idMember.userId}, 'member', ${memberAtt('member', idMember.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HIVE_HOME}, 'F-init', 'Initial owner feature', 'before restart', 'todo', 0, 'local', 6001, 6001, 6001)
      `;
      const drained1 = await drainOutboxOnce(owner.handle, dbOwner.sql);
      expect(drained1, 'owner outbox (roster + initial feature) did not drain to its log').toBeGreaterThanOrEqual(3);
      const ownerLogLenAfterDrain1 = owner.handle.ownLog.length;
      const ownerOutboxAfterDrain1 = await outboxCounts(dbOwner.sql, HIVE_HOME);
      const ownerDrainedStampsPre = await drainedStamps(dbOwner.sql, HIVE_HOME);
      expect(ownerOutboxAfterDrain1.undrained, 'all owner rows drained pre-restart').toBe(0);
      expect(ownerLogLenAfterDrain1, 'owner log holds exactly the drained ops (no dup)').toBe(
        ownerOutboxAfterDrain1.drained,
      );

      // Member catches up: ADMIT owner → FEDERATE roster → APPLY F-init (origin=remote).
      const caughtUpInitial = await pollUntil(
        async () => {
          await Promise.all([owner.mergeNow(), member.mergeNow()]);
          const admitted = member.handle.admitted.has(ownerLogKey);
          const members = await orgDb.adminSql<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM harness_shared.hive_members
             WHERE workspace_id = ${WORKSPACE_ID} AND hive_home_slug = ${HIVE_HOME}
          `;
          const feat = await readFeature(orgDb.adminSql, HIVE_HOME, 'F-init');
          return admitted && Number(members[0]?.n ?? 0) >= 2 && feat ? { feat } : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 300 },
      );
      expect(
        caughtUpInitial?.feat,
        'STEP 1: the member never admitted + federated + applied the INITIAL owner feature',
      ).toMatchObject({ feature_id: 'F-init', origin: 'remote', title: 'Initial owner feature' });

      // ── STEP 2: the MEMBER authors its OWN local feature (M-pre) → CDC capture →
      //    member outbox → DRAIN → member own log. This is the row whose drained_at
      //    watermark must survive the restart (no re-emit on cold re-open). The CDC
      //    echo-guard skips the federated owner rows (origin='remote'), so the member
      //    outbox holds EXACTLY this one local write. ──
      await orgDb.adminSql`
        INSERT INTO harness_shared.harness_features_consolidated
          (workspace_id, harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${WORKSPACE_ID}, ${MEMBER_SLUG}, 'M-pre', 'Member local feature', 'authored on member', 'todo', 0, 'local', 6500, 6500, 6500)
      `;
      const memberDrained1 = await drainOutboxOnce(member.handle, orgDb.adminSql);
      expect(memberDrained1, 'member outbox (its own local feature) drained exactly one row').toBe(1);
      const memberLogKeyBefore = member.handle.ownLog.keyHex;
      const memberLogLenBefore = member.handle.ownLog.length;
      expect(memberLogLenBefore, 'member own log holds its one local op').toBe(1);
      const memberDrainedStampsPre = await drainedStamps(orgDb.adminSql, MEMBER_SLUG);
      expect(memberDrainedStampsPre.size, 'exactly one member outbox row is drained pre-restart').toBe(1);

      // ── STEP 3: RESTART the member's sidecar host. closeAll() runs booted.close()
      //    (close-hooks → swarm leave → closeHarnessStore: EVICTS the corestore from
      //    the process cache + releases its on-disk file lock), so the re-boot must
      //    COLD re-open from disk. Destroy the old transport (the "process" is gone)
      //    + drop in-process caches so the re-booted member re-reads PG fresh. ──
      await member.host.closeAll();
      await closeHarnessStore({ workspaceRoot: rootMember, harnessSlug: MEMBER_SLUG });
      _resetCacheForTests();
      _clearHiveMemberDeviceSetCacheForTest();
      await swarmMember1.destroy();

      const swarmMember2 = makeSwarm(testnet.bootstrap); // FRESH transport for the re-booted "process"
      member = await bootMember(swarmMember2);
      cleanups.push(async () => {
        await member.host.closeAll();
        await closeHarnessStore({ workspaceRoot: rootMember, harnessSlug: MEMBER_SLUG });
      });

      // (a) The own log SURVIVED the restart: SAME identity (key) + SAME length, read
      //     back from disk. The member resumes its persisted log — it does not start a
      //     fresh one (which would orphan M-pre + change its log identity).
      expect(member.handle.ownLog.keyHex, 'member own-log key must survive the restart (cold re-open)').toBe(
        memberLogKeyBefore,
      );
      expect(member.handle.ownLog.length, 'member own-log length must survive the restart').toBe(
        memberLogLenBefore,
      );

      // (b) The outbox DRAIN RESUMES with NO double-append. The drained_at watermark
      //     lives in PG, so the COLD-reopened member's re-drain reads 0 undrained rows
      //     → appends NOTHING → the own log does not grow, and M-pre's drained_at is
      //     unchanged (it was not re-emitted).
      const memberRedrain = await drainOutboxOnce(member.handle, orgDb.adminSql);
      expect(memberRedrain, 'cold-reopened member must NOT re-emit its already-drained row').toBe(0);
      expect(
        member.handle.ownLog.length,
        'member own log must not grow on re-drain after restart (no double-append)',
      ).toBe(memberLogLenBefore);
      const memberDrainedStampsPost = await drainedStamps(orgDb.adminSql, MEMBER_SLUG);
      expect(memberDrainedStampsPost, 'member drained_at watermark is identical across the restart').toEqual(
        memberDrainedStampsPre,
      );

      // Member re-pairs onto the topic after the re-boot (fresh swarm joins; the owner
      // discovers it via the DHT). Topic must match the owner's.
      expect(member.handle.swarm, 'member did not rejoin a swarm after restart').not.toBeNull();
      expect(member.handle.swarm!.topicHex).toBe(owner.handle.swarm!.topicHex);

      // ── STEP 4: OWNER authors NEW content (F-post) during/after the restart →
      //    drain again. EXACTLY the new row drains; the pre-restart rows are NOT
      //    re-emitted (their drained_at is unchanged) and the owner log grows by
      //    exactly one (no double-append on the author side either). ──
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HIVE_HOME}, 'F-post', 'Authored after member restart', 'restart-window content', 'todo', 0, 'local', 7001, 7001, 7001)
      `;
      const drained2 = await drainOutboxOnce(owner.handle, dbOwner.sql);
      expect(drained2, 'owner drain resumes: exactly the ONE new (F-post) row drains').toBe(1);
      expect(
        owner.handle.ownLog.length,
        'owner log grew by exactly one (the pre-restart rows were NOT re-appended)',
      ).toBe(ownerLogLenAfterDrain1 + 1);
      const ownerDrainedStampsPost = await drainedStamps(dbOwner.sql, HIVE_HOME);
      for (const [id, stamp] of ownerDrainedStampsPre) {
        expect(
          ownerDrainedStampsPost.get(id),
          `owner pre-restart outbox row ${id} must keep its original drained_at (not re-emitted)`,
        ).toBe(stamp);
      }
      // An immediate re-drain is idempotent — nothing left to emit.
      expect(await drainOutboxOnce(owner.handle, dbOwner.sql), 'owner re-drain is a no-op (no re-emit)').toBe(0);

      // ── STEP 5: the RESTARTED member RE-ADMITS the owner, the merge RESUMES, and
      //    F-post applies (origin=remote). No loss (F-init + M-pre intact), no dup. ──
      const caughtUpPost = await pollUntil(
        async () => {
          await Promise.all([owner.mergeNow(), member.mergeNow()]);
          const admitted = member.handle.admitted.has(ownerLogKey);
          const feat = await readFeature(orgDb.adminSql, HIVE_HOME, 'F-post');
          return admitted && feat ? { feat } : undefined;
        },
        { timeoutMs: 40_000, intervalMs: 300 },
      );
      expect(
        member.handle.admitted.has(ownerLogKey),
        'STEP 5: the restarted member never RE-ADMITTED the owner log (cold-reopen re-admission via persisted directory/roster)',
      ).toBe(true);
      expect(
        caughtUpPost?.feat,
        'STEP 5: the owner NEW content (F-post) never applied on the restarted member — restart broke the admit→merge→apply chain',
      ).toMatchObject({ feature_id: 'F-post', origin: 'remote', title: 'Authored after member restart' });

      // NO LOSS: the pre-restart owner content (F-init) is still present (origin=remote).
      expect(
        await readFeature(orgDb.adminSql, HIVE_HOME, 'F-init'),
        'pre-restart owner content (F-init) must survive the restart',
      ).toMatchObject({ feature_id: 'F-init', origin: 'remote', title: 'Initial owner feature' });
      // The member's own local content (M-pre) is intact (origin=local — its own write).
      expect(
        await readFeature(orgDb.adminSql, MEMBER_SLUG, 'M-pre'),
        'pre-restart member-local content (M-pre) must survive the restart',
      ).toMatchObject({ feature_id: 'M-pre', origin: 'local', title: 'Member local feature' });

      // NO DUPLICATE PG ROWS: exactly one row per (harness_slug, feature_id) for all
      // three features across both slugs (the PK + the idempotent LWW upsert dedup
      // the fresh-cursor re-fold's re-apply of F-init on the cold re-open).
      const census = await orgDb.adminSql<Array<{ harness_slug: string; feature_id: string; n: number }>>`
        SELECT harness_slug, feature_id, COUNT(*)::int AS n
          FROM harness_shared.harness_features_consolidated
         WHERE (harness_slug = ${HIVE_HOME} AND feature_id IN ('F-init', 'F-post'))
            OR (harness_slug = ${MEMBER_SLUG} AND feature_id = 'M-pre')
         GROUP BY harness_slug, feature_id`;
      expect(census.length, 'all three federated/local features are present exactly once').toBe(3);
      for (const row of census) {
        expect(row.n, `feature ${row.harness_slug}/${row.feature_id} must have exactly one PG row`).toBe(1);
      }
    },
    180_000,
  );
});
