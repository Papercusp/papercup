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
 *     `pot_directory_cache` owner binding + the federated `pot_members` roster
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

import { afterEach, describe, it, expect, vi } from 'vitest';
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
import { applyPot557RenameAndFixups } from './_hive-substrate-rig';

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
 * CDC capture (375) PLUS the Hive schema (184 hives + 185 pot_members + 189
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
  await applyPot557RenameAndFixups(sql);
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
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
      // directory-cache owner binding. NO pot_members rows → EMPTY roster (fresh join).
      // BOTH survive the restart (PG is durable) → the re-booted member re-admits.
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_directory_cache (workspace_id, payload, updated_at)
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
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idOwner.userId}, 'owner', ${memberAtt('owner', idOwner.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
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
            SELECT COUNT(*)::int AS n FROM harness_shared.pot_members
             WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${HIVE_HOME}
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

/**
 * WI-5481 rig-independent repro: OWNER+MEMBER ALTERNATING RESTART SOAK.
 *
 * The live-fed-gate `replication_soak` scenario (bin/lib/scenarios/b8-replication-soak.sh,
 * order 87) does N cold-restart cycles ALTERNATING which side restarts (odd cycle →
 * MEMBER, even cycle → OWNER — see `scenario_replication_liveness_soak` in
 * bin/deb-hetzner-restart.sh) and asserts a fresh owner→member write lands within an
 * SLA after EVERY cycle. It fails on essentially every live gate run (WI-5481), while
 * the sibling `restart_durability` (order 80, ONE restart) and `reconnect_catchup`
 * (order 85, transport-loss-only) scenarios are merely flaky/load-correlated — the
 * soak's failure is a DISTINCT, isolated, near-deterministic bug (cross-run evidence
 * on WI-5481: 4/4 gate runs).
 *
 * Two concrete gaps meant NO existing rig-independent test could ever have caught
 * this (WI-5481 16:17 checkpoint):
 *   1. The sibling `federation-restart-durability-sidecar.repro` test above only ever
 *      restarts the MEMBER — the OWNER is never killed+rebooted anywhere in-process.
 *   2. Every test in this file boots with `mergePollMs: 0` and drives merges by hand
 *      via `owner.mergeNow()` / `member.mergeNow()` — so the REAL production
 *      reconnect+merge path (a fresh swarm join → `onAnnounce` → `admitPeer` →
 *      `mergeNow()`, PLUS the `mergePollMs` poll-timer fallback for content authored
 *      after the initial admit — boot.ts:2663-2677) is never actually exercised. A
 *      regression in re-establishing that path after a RAPID, REPEATED, ALTERNATING
 *      restart cycle would be invisible to every test that manually drives merges.
 *
 * This test closes BOTH gaps at once: it restarts BOTH sides, alternating exactly
 * like the live soak, with a small NONZERO `mergePollMs` and NO manual mergeNow()
 * call anywhere past the initial setup — if replication stalls here, it is the same
 * production path the live soak exercises, in-process and rig-independent.
 *
 * SCOPE NOTE: only the owner→member direction is asserted (the leg the live evidence
 * shows fails 100% of the time, independent of which side restarted — su-6ffd5ea8's
 * WI-5481 finding). The reverse (member-authored content landing on the OWNER, which
 * the b8 script also polls for) depends on the WI-259 cross-member membership-guard
 * wiring (harness-features.ts `hiveHomeSlug`/membership guard) that this test's
 * `buildOwnerApply` does not configure — left for a follow-up rather than risking an
 * incorrectly-modeled assertion on unfamiliar wiring.
 */
describe('OWNER+MEMBER ALTERNATING restart SOAK (WI-5481 rig-independent repro) — real onAnnounce/poll-driven reconnect (mergePollMs>0), NO manual mergeNow anywhere past initial setup, N cycles alternating restart target exactly like b8-replication-soak.sh', () => {
  it(
    'N alternating member/owner restarts: a fresh owner-authored feature must land on the member within the leg timeout EVERY cycle, using only the real production reconnect+merge path',
    async () => {
      const HIVE_HOME = 'soak-owner-hive';
      const MEMBER_SLUG = 'soak-joined-hive';
      // The ACTUAL production default (boot.ts MERGE_POLL_MS) — nonzero, so the
      // poll-timer + onAnnounce path actually drive every merge, never a manual
      // mergeNow() call from this test.
      const MERGE_POLL_MS = 1000;
      // b8's default is 5 cycles (odd=MEMBER, even=OWNER); match it exactly.
      const CYCLES = 5;
      const LEG_TIMEOUT_MS = 25_000;

      // ── env-route getOrgPg (identical pattern to the sibling repro above) ──
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
      // directory-cache owner binding — the D-053 owner-bootstrap admission path
      // (ownerDeviceForHive) needs this to resolve which device is the verified
      // owner for this hive_pubkey. Without it the member cannot bootstrap-admit
      // the owner (this was missing on the first attempt — see WI-5481 checkpoint).
      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_directory_cache (workspace_id, payload, updated_at)
        VALUES (${WORKSPACE_ID}, ${JSON.stringify({
          hives: [{ hivePubkey: hivePubkeyB64, ownerDevicePubkey: idOwner.devicePubkey }],
        })}::text::jsonb, 1)
      `;

      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/soak-owner-hive', harness_kind: 'hive', remote_hive: true },
            { slug: MEMBER_SLUG, path: '/tmp/soak-member', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );

      const dbOwner: FreshPgDb = await createFreshPgDb('ownerRestartSoak');
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

      const rootOwner = makeWorkspaceRoot('soak-owner-');
      const rootMember = makeWorkspaceRoot('soak-member-');

      const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: hivePubkeyB64 };
      const memberBinding: SwarmBinding = {
        kind: 'topic',
        topic_hex: deriveSwarmTopic(hiveBinding).toString('hex'),
      };

      let ownerApply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let owner: PeerControl;
      const bootOwner = (swarm: HyperswarmLike) =>
        bootViaSidecarHost({
          root: rootOwner,
          swarm,
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
            mergePollMs: MERGE_POLL_MS,
          },
        });
      const bootMember = (swarm: HyperswarmLike) =>
        bootViaSidecarHost({
          root: rootMember,
          swarm,
          harnessSlug: MEMBER_SLUG,
          binding: memberBinding,
          bootExtra: { announceIdentityOverride: idMember.override, mergePollMs: MERGE_POLL_MS },
        });

      let swarmOwnerCur = makeSwarm(testnet.bootstrap);
      let swarmMemberCur = makeSwarm(testnet.bootstrap);
      owner = await bootOwner(swarmOwnerCur);
      let member = await bootMember(swarmMemberCur);
      cleanups.push(async () => {
        await owner.host.closeAll();
        await closeHarnessStore({ workspaceRoot: rootOwner, harnessSlug: HIVE_HOME });
      });
      cleanups.push(async () => {
        await member.host.closeAll();
        await closeHarnessStore({ workspaceRoot: rootMember, harnessSlug: MEMBER_SLUG });
      });

      expect(owner.handle.swarm, 'owner did not join a swarm').not.toBeNull();
      expect(member.handle.swarm, 'member did not join a swarm').not.toBeNull();
      expect(owner.handle.swarm!.topicHex).toBe(member.handle.swarm!.topicHex);

      const ownerLogKey = owner.handle.ownLog.keyHex;

      // ── Roster + initial content, via the REAL poll-driven merge only — no
      // manual mergeNow() anywhere in this test. MERGE_POLL_MS + the onAnnounce
      // admit-triggered merge drive everything, same as production. ──
      const memberAtt = (login: string, pk: string) =>
        JSON.stringify([
          { device_pubkey: pk, gist_id: `gist-${login}`, gist_url: `https://gist.github.com/${login}`, device_label: `${login}-dev`, created_at: 1, signature_by_device: 'sig' },
        ]);
      await dbOwner.sql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idOwner.userId}, 'owner', ${memberAtt('owner', idOwner.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idMember.userId}, 'member', ${memberAtt('member', idMember.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HIVE_HOME}, 'F-init', 'Initial owner feature', 'soak init', 'todo', 0, 'local', 6001, 6001, 6001)
      `;
      // The sidecar host stubs wireOutbox as a no-op (bootViaSidecarHost) — nothing
      // reaches the owner's OWN LOG (and therefore the wire) without an explicit
      // drain. This is the AUTHOR-side app boundary (CDC capture → outbox → own log),
      // a distinct concern from the RECEIVE-side merge this test deliberately leaves
      // to the real poll+onAnnounce path — draining here is not a "manual merge".
      const initDrained = await drainOutboxOnce(owner.handle, dbOwner.sql);
      expect(initDrained, 'owner outbox (roster + F-init) did not drain to its own log').toBeGreaterThanOrEqual(3);

      const initOk = await pollUntil(
        async () => {
          const admitted = member.handle.admitted.has(ownerLogKey);
          const feat = await readFeature(orgDb.adminSql, HIVE_HOME, 'F-init');
          return admitted && feat ? true : undefined;
        },
        { timeoutMs: LEG_TIMEOUT_MS, intervalMs: 300 },
      );
      expect(initOk, 'initial roster+feature federation never completed via the real poll-driven path').toBe(true);

      // ── The soak: N cycles, alternating restart target exactly like
      // b8-replication-soak.sh (odd cycle → MEMBER, even cycle → OWNER). Each
      // cycle the owner authors a FRESH feature and it must land on the member
      // within LEG_TIMEOUT_MS — using ONLY the real reconnect (fresh swarm join +
      // onAnnounce admit) + poll-driven merge (MERGE_POLL_MS). If this stalls, it
      // is the SAME production path WI-5481's live soak exercises. ──
      const results: Array<{ cycle: number; restarted: 'member' | 'owner'; landedMs: number | null }> = [];
      for (let cycle = 1; cycle <= CYCLES; cycle++) {
        const restartOwner = cycle % 2 === 0;
        if (restartOwner) {
          await owner.host.closeAll();
          await closeHarnessStore({ workspaceRoot: rootOwner, harnessSlug: HIVE_HOME });
          await swarmOwnerCur.destroy();
          swarmOwnerCur = makeSwarm(testnet.bootstrap);
          owner = await bootOwner(swarmOwnerCur);
        } else {
          await member.host.closeAll();
          await closeHarnessStore({ workspaceRoot: rootMember, harnessSlug: MEMBER_SLUG });
          await swarmMemberCur.destroy();
          swarmMemberCur = makeSwarm(testnet.bootstrap);
          member = await bootMember(swarmMemberCur);
        }

        const fidOM = `F-SOAK-${cycle}-OM`;
        const t0 = Date.now();
        await dbOwner.sql`
          INSERT INTO harness_shared.harness_features_consolidated
            (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
          VALUES (${HIVE_HOME}, ${fidOM}, ${'soak cycle ' + cycle + ' owner->member'}, 'soak', 'todo', 0, 'local', ${7000 + cycle}, ${7000 + cycle}, ${7000 + cycle})
        `;
        // Author-side drain (see the initOk comment above) — NOT a receive-side
        // merge; the owner is the one authoring this op regardless of which side
        // restarted this cycle.
        await drainOutboxOnce(owner.handle, dbOwner.sql);

        const landedOM = await pollUntil(
          async () => (await readFeature(orgDb.adminSql, HIVE_HOME, fidOM)) ?? undefined,
          { timeoutMs: LEG_TIMEOUT_MS, intervalMs: 300 },
        );
        results.push({
          cycle,
          restarted: restartOwner ? 'owner' : 'member',
          landedMs: landedOM ? Date.now() - t0 : null,
        });
        expect(
          landedOM,
          `cycle ${cycle} (restarted ${restartOwner ? 'OWNER' : 'MEMBER'}): owner->member ${fidOM} did not land within ${LEG_TIMEOUT_MS}ms via the real reconnect+poll-merge path — cycle history: ${JSON.stringify(results)}`,
        ).toBeTruthy();
      }
    },
    240_000,
  );
});

/**
 * WI-5579 (EI-13317/WI-5481 validation): a GENUINE connected_never_replicated
 * ("zombie socket") repro — the member's transport connects to the owner (swarm
 * shows a live connection, admission/roster federate normally over the announce
 * channel, which rides the SAME socket unconditionally — see swarm.ts), but the
 * owner's log is deliberately withheld from `corestore.replicate(socket)` on the
 * member's FIRST connection via the `sidecarOffloadOverride` test seam (boot.ts's
 * authoritative "claim this socket, do not corestore.replicate it" hook — the
 * SAME seam production's sidecar-offload feature uses; "An explicit test
 * override is authoritative" per boot.ts). This models a dead-but-connected data
 * path WITHOUT faking any wire-level behavior — no real network partition, no
 * Docker/testcontainer rig, just the real replication-liveness detector + repair
 * ladder running against a real swarm connection that genuinely never replicates.
 *
 * Proves TWO things end-to-end:
 *   1. The zombie is REAL — content authored while zombied does NOT land within
 *      a window well short of the detector's grace period (if it did, the
 *      override failed to prevent replication and this test would be lying
 *      about what it covers).
 *   2. EI-13317's fix RECOVERS it — `connected_never_replicated` escalates
 *      PROMPTLY (no 3-attempt/~540s ladder wait) to `forceRejoin` (swarm.ts:
 *      leave()+join()), which opens a FRESH connection; the override's 2nd
 *      invocation lets that connection replicate normally, and the
 *      already-authored content lands shortly after — with NO process restart,
 *      NO manual intervention, using only the real onAnnounce/poll-driven path
 *      (mergePollMs>0, no manual mergeNow() anywhere, matching the
 *      ALTERNATING-SOAK test above).
 *
 * `replicationStallGraceMs` is shrunk from its 3-minute production default so
 * the detector fires in seconds, not minutes — this changes ONLY the wait, not
 * the code path (the exact same grace-then-escalate logic boot.ts runs in
 * production).
 */
describe('connected_never_replicated ZOMBIE-SOCKET repro (EI-13317/WI-5481) — a live swarm connection that genuinely never replicates, detected + evicted + recovered via the REAL repair ladder (no manual intervention)', () => {
  it(
    "member's FIRST connection never replicates (sidecarOffloadOverride) — content does not land while zombied, then the real connected_never_replicated -> forceRejoin path recovers it on the very next (fresh) connection",
    async () => {
      const HIVE_HOME = 'zombie-owner-hive';
      const MEMBER_SLUG = 'zombie-joined-hive';
      const MERGE_POLL_MS = 250;
      const GRACE_MS = 1_500; // shrunk from the 3min production default — same code path, faster wait

      // replication-liveness.ts's default episode/recovery reporters use
      // console.error as their (intentional, production) grep-able log channel
      // — this suite runs under vitest-fail-on-console, so silence it the same
      // way boot.test.ts's EI-13317 tests do (this test's own expect()s judge
      // success/failure, not the console output).
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      cleanups.push(() => errorSpy.mockRestore());

      // ── env-route getOrgPg (identical pattern to the sibling repros above) ──
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

      await orgDb.adminSql`
        INSERT INTO harness_shared.pots
          (workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, decode(${hivePubkeyB64}, 'base64'),
                'kc-owner-home', 'Owner Home', null, 1, 1)
      `;
      await orgDb.adminSql`
        INSERT INTO harness_shared.pot_directory_cache (workspace_id, payload, updated_at)
        VALUES (${WORKSPACE_ID}, ${JSON.stringify({
          hives: [{ hivePubkey: hivePubkeyB64, ownerDevicePubkey: idOwner.devicePubkey }],
        })}::text::jsonb, 1)
      `;
      await mutateHarnessRegistry(
        (r) => ({
          ...r,
          projects: [
            ...r.projects,
            { slug: HIVE_HOME, path: '/tmp/zombie-owner-hive', harness_kind: 'hive', remote_hive: true },
            { slug: MEMBER_SLUG, path: '/tmp/zombie-member', hive_slug: HIVE_HOME },
          ],
        }),
        WORKSPACE_ID,
      );

      const dbOwner: FreshPgDb = await createFreshPgDb('zombieOwner');
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
      const swarmMember = makeSwarm(testnet.bootstrap);
      const rootOwner = makeWorkspaceRoot('zombie-owner-');
      const rootMember = makeWorkspaceRoot('zombie-member-');

      const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: hivePubkeyB64 };
      const memberBinding: SwarmBinding = {
        kind: 'topic',
        topic_hex: deriveSwarmTopic(hiveBinding).toString('hex'),
      };

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
          mergePollMs: MERGE_POLL_MS,
        },
      });
      cleanups.push(async () => {
        await owner.host.closeAll();
        await closeHarnessStore({ workspaceRoot: rootOwner, harnessSlug: HIVE_HOME });
      });

      // The zombie seam: the member's FIRST connection is "claimed" (offloaded)
      // without ever calling corestore.replicate() on it — a REAL live swarm
      // connection (admission/announce still work) that genuinely never
      // replicates any log. The 2nd+ connection (the fresh join a forced rejoin
      // opens) replicates normally, modeling "this one connection's data path
      // was dead; a fresh reconnect works" — the exact WI-183/EI-13317 shape.
      let memberConnAttempts = 0;
      const sidecarOffloadOverride = () => {
        memberConnAttempts += 1;
        return memberConnAttempts === 1;
      };

      const member = await bootViaSidecarHost({
        root: rootMember,
        swarm: swarmMember,
        harnessSlug: MEMBER_SLUG,
        binding: memberBinding,
        bootExtra: {
          announceIdentityOverride: idMember.override,
          mergePollMs: MERGE_POLL_MS,
          replicationStallGraceMs: GRACE_MS,
          sidecarOffloadOverride,
        },
      });
      cleanups.push(async () => {
        await member.host.closeAll();
        await closeHarnessStore({ workspaceRoot: rootMember, harnessSlug: MEMBER_SLUG });
      });

      expect(owner.handle.swarm, 'owner did not join a swarm').not.toBeNull();
      expect(member.handle.swarm, 'member did not join a swarm').not.toBeNull();
      expect(owner.handle.swarm!.topicHex).toBe(member.handle.swarm!.topicHex);

      // Owner authors its roster + ONE feature, drains to its own log (author
      // side — see the sibling tests' identical comment on why this isn't a
      // "manual merge": it's the CDC→outbox→own-log boundary, not receive-side).
      const memberAtt = (login: string, pk: string) =>
        JSON.stringify([
          { device_pubkey: pk, gist_id: `gist-${login}`, gist_url: `https://gist.github.com/${login}`, device_label: `${login}-dev`, created_at: 1, signature_by_device: 'sig' },
        ]);
      await dbOwner.sql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idOwner.userId}, 'owner', ${memberAtt('owner', idOwner.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.pot_members
          (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status)
        VALUES (${WORKSPACE_ID}, ${HIVE_HOME}, ${idMember.userId}, 'member', ${memberAtt('member', idMember.devicePubkey)}::text::jsonb, '{}'::text[], 'verified')
      `;
      await dbOwner.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HIVE_HOME}, 'F-zombie', 'Authored while member zombied', 'zombie repro', 'todo', 0, 'local', 6001, 6001, 6001)
      `;
      const t0 = Date.now();
      await drainOutboxOnce(owner.handle, dbOwner.sql);

      // (1) The zombie is REAL: content must NOT land within a window well
      // short of GRACE_MS — if it did, the offload override failed to prevent
      // replication and this test is not exercising what it claims to.
      const landedEarly = await pollUntil(
        async () => (await readFeature(orgDb.adminSql, HIVE_HOME, 'F-zombie')) ?? undefined,
        { timeoutMs: Math.floor(GRACE_MS * 0.6), intervalMs: 100 },
      );
      expect(
        landedEarly,
        'F-zombie landed BEFORE the grace window elapsed — the sidecarOffloadOverride zombie seam did not actually prevent replication (this test is not exercising a genuine stall)',
      ).toBeUndefined();
      expect(memberConnAttempts, 'member should still be on its first (zombie) connection at this point').toBe(1);

      // (2) EI-13317's fix recovers it: connected_never_replicated escalates
      // PROMPTLY (no 3-attempt ladder wait) to a forced rejoin once GRACE_MS
      // elapses — a fresh connection opens, the override's 2nd call lets it
      // replicate normally, and F-zombie lands shortly after. Bound generously
      // (GRACE_MS + rejoin/reconnect overhead + a few poll cycles) but far
      // short of the ladder's ~540s production worst case this fix collapses.
      const landed = await pollUntil(
        async () => (await readFeature(orgDb.adminSql, HIVE_HOME, 'F-zombie')) ?? undefined,
        { timeoutMs: 30_000, intervalMs: 200 },
      );
      expect(
        landed,
        `F-zombie never landed on the member — the connected_never_replicated -> forceRejoin recovery path did not fire/heal within 30s (memberConnAttempts=${memberConnAttempts}, elapsed=${Date.now() - t0}ms)`,
      ).toMatchObject({ feature_id: 'F-zombie', origin: 'remote', title: 'Authored while member zombied' });
      expect(
        memberConnAttempts,
        'recovery must have opened a FRESH (2nd) connection — the forced rejoin, not a fluke on the same zombie connection',
      ).toBeGreaterThanOrEqual(2);
      expect(
        member.handle.admitted.has(owner.handle.ownLog.keyHex),
        'the member must have (re-)admitted the owner log on the recovered connection',
      ).toBe(true);
    },
    60_000,
  );
});
