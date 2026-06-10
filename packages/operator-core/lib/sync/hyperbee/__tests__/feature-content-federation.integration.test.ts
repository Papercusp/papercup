/**
 * feature-content-federation.integration.test.ts — Stage 6 of the feature-content
 * federation plan (papercusp-feature-content-federation-2026-06-01): the
 * END-TO-END ACCEPTANCE that proves a feature/issue written on one peer actually
 * lands in ANOTHER peer's Postgres, through the REAL CDC-outbox send-side.
 *
 * ## What this proves (the whole send→swarm→receive→PG chain, no shortcuts)
 * For peer A → peer B, the test exercises EVERY link the plan built (Stages 1-5):
 *
 *   1. A local `INSERT … origin='local'` into A's `harness_features_consolidated`
 *      fires the REAL migration-102 AFTER trigger →
 *   2. a `harness_shared.substrate_outbox` row in A's DB →
 *   3. `drainOutboxOnce(handleA, pgA)` maps it (`outboxRowToLocalWriteOp`) and
 *      `handle.append`s it to A's OWN Hypercore log →
 *   4. the REAL in-process Hyperswarm (local testnet DHT, mirror of
 *      `two-peer-swarm-bidi.test.ts`) replicates A's log to B, which has ADMITTED
 *      A via the `verifyBindingOverride` channel-2 stand-in →
 *   5. B's read-merge picks up the op and the REAL `harness-features` projection
 *      (the exact `buildHarnessFeaturesProjection` write SQL, bound to B's pg via
 *      the new `sql` seam) writes the row into B's `harness_features_consolidated`
 *      with `origin='remote'`.
 *
 * The acceptance assertion reads B's PG and confirms the actual row (title /
 * status / etc.) is there. This is strictly MORE than the bidi test, which
 * stopped at a capturing `apply` spy — here the RECEIVING peer runs real PG
 * projections, so we prove the row genuinely lands in the database.
 *
 * ## Two SEPARATE databases (the meaningfulness precondition)
 * `createFreshPgDb` makes a distinct throwaway DATABASE per peer (pgA, pgB) on
 * the shared testcontainer. The projections are bound to each peer's `sql`
 * client via the Stage-6 `HarnessFeaturesProjectionOpts.sql` /
 * `IssuesProjectionOpts.sql` seam, so A's writes go ONLY to pgA and B's
 * projection writes go ONLY to pgB. The test asserts A's insert is absent from
 * pgB until federation delivers it — without separate DBs the whole test would
 * be a tautology (a row "appearing in B" that is really A's own row).
 *
 * ## What is real vs stood-in (same boundary as the bidi test)
 * - REAL: two corestores → two distinct logs; real Hyperswarm/Noise over a local
 *   testnet DHT; real `verifyAnnounce` signature check; real capture trigger;
 *   real outbox drain; real row→op mappers; real read-merge; real PG projections
 *   on BOTH peers; two real Postgres databases.
 * - STOOD IN (offline-deterministic, exactly as the bidi test): the channel-2
 *   GitHub-binding fetch → `verifyBindingOverride` admit-by-userId. Channel-2 is
 *   proven offline + live-verified separately.
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
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { drainOutboxOnce } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
import { buildIssuesProjection } from '../projections/issues';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../apps/operator/lib/sync/hyperbee/__tests__ → repo root is six levels up.
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

// ── Shared identity / swarm constants. Same binding on both peers → same topic. ──
const WORKSPACE_ID = 'ws-fed-stage6';
const HARNESS_SLUG = 'sheets';
const BINDING = {
  kind: 'local' as const,
  workspace_id: WORKSPACE_ID,
  harness_slug: HARNESS_SLUG,
};

// ── Async resource teardown (newest-first, mirrors the bidi test). ──
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

/** A `bootHarnessSubstrate` announce-identity override for a peer with a
 *  self-generated Ed25519 keypair (no OS keychain / gh) — mirrors the bidi test. */
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
        // Bypass the real ensureAttestationGist (it signs with the OS keychain
        // key for `keychainId`, which this test never seeds → AttestationError
        // → swallowed swarm-join failure → handle.swarm null). The announce
        // doesn't need a real gist for the in-process testnet swarm.
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

function makeSwarm(bootstrap: unknown): HyperswarmLike {
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

/** Cluster-global framework roles the migration GRANTs reference. Roles are
 *  cluster-wide in Postgres, so creating them once on either DB suffices for
 *  every throwaway DB on the reused testcontainer. Idempotent. */
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

/**
 * Build the minimal-but-faithful federation schema in a peer's DB, then apply
 * the REAL migration-102 (capture trigger + outbox) and migration-103
 * (workspace_id fill trigger) SQL files verbatim — so the send-side this test
 * exercises is the production trigger, not a re-implementation.
 *
 * The consolidated tables carry exactly the columns the trigger reads
 * (`origin`, `workspace_id`, key column) + the columns the projections
 * INSERT/SELECT. A `projects` row maps `harness_slug → WORKSPACE_ID` so the
 * migration-103 BEFORE-INSERT fill trigger stamps the SAME workspace_id the
 * booted harness drains on (otherwise the drain's `workspace_id` filter misses).
 */
async function setupPeerSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);

  // The two consolidated tables — full column set the projections write, plus
  // the G1 provenance columns (097) the trigger + projections rely on. NOT NULL
  // workspace_id DEFAULT '' mirrors migration 102's ALTER on issues; features
  // get workspace_id from migration 009. We create both with the column present.
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id        TEXT NOT NULL DEFAULT '',
      harness_slug        TEXT NOT NULL,
      feature_id          TEXT NOT NULL,
      title               TEXT,
      summary             TEXT,
      status              TEXT,
      attempts            INT,
      claims              TEXT,
      notes               TEXT,
      metadata            JSONB,
      kind                TEXT,
      project_id          TEXT,
      expected_cost_cents INT,
      tags                JSONB,
      needs_human_review  BOOLEAN,
      ts                  BIGINT,
      created_ts          BIGINT,
      updated_ts          BIGINT,
      parent_id           TEXT,
      goal_id             TEXT,
      taken_by            TEXT,
      taken_at            TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      item_kind           TEXT NOT NULL DEFAULT 'feature', -- dispatch columns (migs 136/178/191/195)
      feature_order       INTEGER,
      swarm_affinity      TEXT,
      redundancy          INTEGER,
      payload             JSONB,
      author_pubkey       TEXT,
      origin              TEXT NOT NULL DEFAULT 'local',
      fed_ts              BIGINT, -- EI-79 step 2 (mig 181): PG-level LWW guard column
      PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.harness_issues_consolidated (
      harness_slug      TEXT NOT NULL,
      issue_id          TEXT NOT NULL,
      title             TEXT NOT NULL,
      severity          TEXT NOT NULL,
      source            TEXT NOT NULL,
      status            TEXT NOT NULL,
      found_at          TIMESTAMPTZ NOT NULL,
      found_during      TEXT,
      repro             TEXT,
      evidence          TEXT,
      suggested_fix     TEXT,
      code_pointer      TEXT,
      linked_feature_id TEXT,
      attempts          INT NOT NULL DEFAULT 0,
      notes             JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_ts        BIGINT NOT NULL,
      updated_ts        BIGINT NOT NULL,
      author_pubkey     TEXT,
      origin            TEXT NOT NULL DEFAULT 'local',
      fed_ts            BIGINT, -- EI-79 step 2 (mig 181): PG-level LWW guard column
      PRIMARY KEY (harness_slug, issue_id)
    );
    CREATE TABLE harness_shared.projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      status       TEXT NOT NULL,
      slug         TEXT,
      workspace_id TEXT,
      created_ts   BIGINT NOT NULL,
      updated_ts   BIGINT NOT NULL
    );
  `);

  // Map the harness slug → the workspace_id the booted handle drains on, so the
  // migration-103 fill trigger stamps the matching value.
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-fed', 'Fed', 'active', ${HARNESS_SLUG}, ${WORKSPACE_ID}, 0, 0)
  `;

  // Apply the REAL send-side migrations verbatim (102 outbox+capture trigger,
  // 103 workspace_id fill trigger). These reference the framework roles created
  // above and the consolidated tables created above.
  for (const file of ['archive/102-substrate-outbox.sql', 'archive/103-issues-workspace-id-fill-trigger.sql']) {
    const sqlText = readFileSync(join(SQL_DIR, file), 'utf8');
    await sql.unsafe(sqlText);
  }

  // EI-79 step 2 (mig 181): the consolidated tables grow a `fed_ts` LWW-guard
  // column, and the broad `OLD.* IS DISTINCT FROM NEW.*` capture trigger must
  // MASK it (fed_ts is capture-wall-clock bookkeeping; left in the compare it
  // re-enqueues every own-log merge-back forever — the convergence guard below).
  await sql.unsafe(`
    ALTER TABLE harness_shared.harness_features_consolidated ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
    ALTER TABLE harness_shared.harness_issues_consolidated   ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
      AFTER UPDATE ON harness_shared.harness_features_consolidated
      FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
      EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
      AFTER UPDATE ON harness_shared.harness_issues_consolidated
      FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
      EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
  `);
}

/**
 * Build a PER-PEER scoped projection apply bound to THIS peer's `sql` (NOT the
 * process-global getOrgPg). Contains exactly the two federated projections
 * (features + issues) — the only tables this test's ops touch. Mirrors
 * `buildHarnessProjectionApply`'s structure (the 2-entry lookup + `applyOpVia`),
 * but threads the per-peer `sql` seam so the receiving peer's REAL projection SQL
 * writes into the receiving peer's REAL database. `ownLogKeyHex` is threaded so
 * `applyOpVia` derives origin from log-source (own → 'local', admitted-remote →
 * 'remote') — exactly as production does.
 */
function buildPeerApply(
  sql: postgres.Sql,
  ownLogKeyHex: string,
): (op: OpEnvelope) => Promise<boolean> {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of [
    buildHarnessFeaturesProjection(opts),
    buildIssuesProjection(opts),
  ] as TableProjection<unknown>[]) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

/** Read one feature row out of a peer's PG as the projection shape (epoch-ms
 *  timestamps, origin), so assertions compare real persisted columns. */
async function readFeature(sql: postgres.Sql, featureId: string) {
  const rows = await sql<
    Array<{ feature_id: string; title: string | null; status: string | null; origin: string; workspace_id: string }>
  >`
    SELECT feature_id, title, status, origin, workspace_id
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = ${featureId}
  `;
  return rows[0];
}

async function readIssue(sql: postgres.Sql, issueId: string) {
  const rows = await sql<
    Array<{ issue_id: string; title: string; severity: string; status: string; origin: string }>
  >`
    SELECT issue_id, title, severity, status, origin
      FROM harness_shared.harness_issues_consolidated
     WHERE harness_slug = ${HARNESS_SLUG} AND issue_id = ${issueId}
  `;
  return rows[0];
}

async function countOutbox(sql: postgres.Sql, table: string, key: string): Promise<number> {
  const rows = await sql<Array<{ n: string | number }>>`
    SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE table_name = ${table} AND key = ${key}
  `;
  return Number(rows[0]?.n ?? 0);
}

interface BootedPeer {
  handle: BootedHarnessHandle;
  pg: postgres.Sql;
  identity: ReturnType<typeof makeIdentityOverride>;
}

describe('Stage 6 — feature/issue content federates A↔B end-to-end through the REAL CDC-outbox + swarm (testcontainer PG)', () => {
  it(
    'a feature written on A lands in B (and vice versa), issues federate, and the echo-loop terminates',
    async () => {
      // ── Two SEPARATE databases — peer A's DB and peer B's DB. ──
      const dbA: FreshPgDb = await createFreshPgDb('fedA');
      cleanups.push(() => dbA.cleanup());
      const dbB: FreshPgDb = await createFreshPgDb('fedB');
      cleanups.push(() => dbB.cleanup());
      await setupPeerSchema(dbA.sql);
      await setupPeerSchema(dbB.sql);

      // Confirm separateness up front: they are genuinely different databases.
      const [nameA] = await dbA.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
      const [nameB] = await dbB.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
      expect(nameA.d).not.toBe(nameB.d);

      // ── Local testnet DHT (offline) + two real swarms (mirror bidi). ──
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const idA = makeIdentityOverride('alice', 42, 'kc-alice');
      const idB = makeIdentityOverride('bob', 7, 'kc-bob');
      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);
      const rootA = makeWorkspaceRoot('fed-A-');
      const rootB = makeWorkspaceRoot('fed-B-');

      // ── Boot A: admits B; real PG projection apply bound to A's DB. ──
      // applyOverride is built AFTER boot needs ownLog.keyHex; resolve via a
      // late-bound holder so the per-peer apply can reference each handle's own
      // log key (origin determination). We pass a thunk-backed apply: build it
      // lazily on first call using the captured handle's ownLog.keyHex.
      let handleA: BootedHarnessHandle | undefined;
      let handleB: BootedHarnessHandle | undefined;
      let applyA: ((op: OpEnvelope) => Promise<boolean>) | undefined;
      let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;

      handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
        swarmBinding: BINDING,
        swarmOverride: swarmA,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idB.userId ? 'verified' : 'fail',
        applyOverride: (op) => {
          applyA ??= buildPeerApply(dbA.sql, handleA!.ownLog.keyHex);
          return applyA(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug: HARNESS_SLUG });
      });

      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId: WORKSPACE_ID,
        harnessSlug: HARNESS_SLUG,
        swarmBinding: BINDING,
        swarmOverride: swarmB,
        verifyBindingOverride: async (_pk, _login, userId) =>
          userId === idA.userId ? 'verified' : 'fail',
        applyOverride: (op) => {
          applyB ??= buildPeerApply(dbB.sql, handleB!.ownLog.keyHex);
          return applyB(op);
        },
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: HARNESS_SLUG });
      });

      const peerA: BootedPeer = { handle: handleA, pg: dbA.sql, identity: idA };
      const peerB: BootedPeer = { handle: handleB, pg: dbB.sql, identity: idB };

      // Both must have joined the swarm on the same topic.
      expect(peerA.handle.swarm).not.toBeNull();
      expect(peerB.handle.swarm).not.toBeNull();
      expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

      // ── (1) A→B FEATURE: local insert on A → real trigger → outbox → drain → log. ──
      await peerA.pg`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-fed-1', 'Federated feature one', 'from A', 'todo', 0, 'local', 1001, 1001, 1001)
      `;
      // The capture trigger should have enqueued exactly one outbox row in A's DB.
      expect(await countOutbox(peerA.pg, 'harness_features_consolidated', 'F-fed-1')).toBe(1);
      // Sanity: it is NOT in B yet (separate DBs; federation hasn't run).
      expect(await readFeature(peerB.pg, 'F-fed-1')).toBeUndefined();

      // Drain A's outbox → appends to A's own log. (A background boot-time
      // mergeNow may re-apply the own log and settle author_pubkey NULL→'', so a
      // drain can carry a small bounded number of settling rows in addition to
      // the new one — assert it drained AT LEAST the new feature, and that the
      // append actually reached A's log.)
      const lenA0 = peerA.handle.ownLog.length;
      const drainedA = await drainOutboxOnce(peerA.handle, peerA.pg);
      expect(drainedA, "A's F-fed-1 was not drained to its log").toBeGreaterThanOrEqual(1);
      expect(peerA.handle.ownLog.length).toBeGreaterThan(lenA0);

      // ── (2) B→A FEATURE (symmetric). ──
      await peerB.pg`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-fed-2', 'Federated feature two', 'from B', 'in-progress', 0, 'local', 1002, 1002, 1002)
      `;
      expect(await countOutbox(peerB.pg, 'harness_features_consolidated', 'F-fed-2')).toBe(1);
      const drainedB = await drainOutboxOnce(peerB.handle, peerB.pg);
      expect(drainedB).toBeGreaterThanOrEqual(1);

      // ── (4) ISSUE A→B: local issue insert on A → real fill+capture triggers → outbox → drain. ──
      await peerA.pg`
        INSERT INTO harness_shared.harness_issues_consolidated
          (harness_slug, issue_id, title, severity, source, status, found_at, attempts, notes, created_ts, updated_ts, origin)
        VALUES (${HARNESS_SLUG}, 'I-fed-1', 'Federated issue one', 'high', 'test', 'open',
                to_timestamp(1003 / 1000.0), 0, '[]'::jsonb, 1003, 1003, 'local')
      `;
      // The migration-103 fill trigger must have stamped the REAL workspace_id
      // (so the drain's workspace filter matches) — assert it, since '' would
      // silently break issue federation.
      const issWs = await peerA.pg<Array<{ workspace_id: string }>>`
        SELECT workspace_id FROM harness_shared.harness_issues_consolidated
         WHERE harness_slug = ${HARNESS_SLUG} AND issue_id = 'I-fed-1'
      `;
      expect(issWs[0]?.workspace_id).toBe(WORKSPACE_ID);
      expect(await countOutbox(peerA.pg, 'harness_issues_consolidated', 'I-fed-1')).toBe(1);
      const drainedIssue = await drainOutboxOnce(peerA.handle, peerA.pg);
      expect(drainedIssue, "A's I-fed-1 was not drained to its log").toBeGreaterThanOrEqual(1);

      // ── THE ACCEPTANCE: poll both peers' real merge, assert real PG rows. ──
      // Each tick drives mergeNow() on both peers (real swarm replication has
      // already crossed A↔B logs; merge reads them into each peer's PG via the
      // real projections). Resolves once all three cross-peer rows have landed.
      const result = await pollUntil(
        async () => {
          await Promise.all([peerA.handle.mergeNow(), peerB.handle.mergeNow()]);
          const fAonB = await readFeature(peerB.pg, 'F-fed-1');
          const fBonA = await readFeature(peerA.pg, 'F-fed-2');
          const iAonB = await readIssue(peerB.pg, 'I-fed-1');
          return fAonB && fBonA && iAonB ? { fAonB, fBonA, iAonB } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );

      // (1) A→B feature — the core proof.
      expect(result?.fAonB, "A's feature F-fed-1 never reached B's PG (A→B failed)").toBeTruthy();
      expect(result!.fAonB).toMatchObject({
        feature_id: 'F-fed-1',
        title: 'Federated feature one',
        status: 'todo',
        origin: 'remote', // B received it from A's log → stamped remote
        workspace_id: WORKSPACE_ID,
      });

      // (2) B→A feature — bidirectional.
      expect(result?.fBonA, "B's feature F-fed-2 never reached A's PG (B→A failed)").toBeTruthy();
      expect(result!.fBonA).toMatchObject({
        feature_id: 'F-fed-2',
        title: 'Federated feature two',
        status: 'in-progress',
        origin: 'remote',
      });

      // (4) issue A→B.
      expect(result?.iAonB, "A's issue I-fed-1 never reached B's PG (issue A→B failed)").toBeTruthy();
      expect(result!.iAonB).toMatchObject({
        issue_id: 'I-fed-1',
        title: 'Federated issue one',
        severity: 'high',
        status: 'open',
        origin: 'remote',
      });

      // ── (3) ECHO-GUARD at integration level ──
      // (3a) A remote-origin write does NOT enqueue an outbox row. B's projection
      // just wrote F-fed-1 into B's PG with origin='remote' (the merge above).
      // Assert B did NOT re-enqueue it — the capture trigger's origin filter
      // dropped it, so the loop terminates (no echo back to A).
      expect(
        await countOutbox(peerB.pg, 'harness_features_consolidated', 'F-fed-1'),
        "B re-enqueued A's federated feature → echo loop would amplify forever",
      ).toBe(0);
      expect(
        await countOutbox(peerB.pg, 'harness_issues_consolidated', 'I-fed-1'),
        "B re-enqueued A's federated issue → echo loop",
      ).toBe(0);
      // And A did not echo B's F-fed-2 back into A's outbox either.
      expect(await countOutbox(peerA.pg, 'harness_features_consolidated', 'F-fed-2')).toBe(0);

      // (3b) Directly insert an origin='remote' feature on A → assert NO outbox
      // row is produced (the trigger filter, exercised in isolation).
      await peerA.pg`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, status, attempts, origin, ts, created_ts, updated_ts)
        VALUES (${HARNESS_SLUG}, 'F-remote-direct', 'should not federate', 'todo', 0, 'remote', 2000, 2000, 2000)
      `;
      expect(
        await countOutbox(peerA.pg, 'harness_features_consolidated', 'F-remote-direct'),
        'a remote-origin local insert must NOT enqueue (echo guard)',
      ).toBe(0);

      // (3c) INTRA-PEER self-amplification guard CONVERGES (a Stage-6 finding,
      // now fixed). The substrate's read-merge re-applies the OWN log's ops
      // (origin='local') every pass — re-UPSERTing each local feature/issue.
      // Migration 102's capture UPDATE trigger carries a `WHEN (OLD.* IS DISTINCT
      // FROM NEW.*)` guard so an IDENTICAL re-upsert does NOT re-enqueue. Without
      // it the outbox grows by one row PER local feature PER merge pass forever
      // (verified: an identical origin='local' re-upsert grows the outbox 1→2),
      // and the drain re-appends those to the own log unboundedly.
      //
      // A bounded one-time settling is still expected: the test's manual INSERTs
      // leave author_pubkey NULL, and the first own-log merge-back upserts it to
      // '' (a REAL change → enqueues once), after which every further merge-back
      // is identical (guarded → no enqueue). So the invariant under test is
      // CONVERGENCE: repeatedly merge + drain and confirm the system reaches a
      // FIXED POINT (a drain that returns 0) and STAYS there — proving no
      // unbounded amplification. A missing/ineffective guard never converges
      // (every drain keeps returning rows).
      let converged = false;
      for (let pass = 0; pass < 8; pass++) {
        await Promise.all([peerA.handle.mergeNow(), peerB.handle.mergeNow()]);
        const a = await drainOutboxOnce(peerA.handle, peerA.pg);
        const b = await drainOutboxOnce(peerB.handle, peerB.pg);
        if (a === 0 && b === 0) {
          // Confirm it STAYS at the fixed point across one more full cycle.
          await Promise.all([peerA.handle.mergeNow(), peerB.handle.mergeNow()]);
          const a2 = await drainOutboxOnce(peerA.handle, peerA.pg);
          const b2 = await drainOutboxOnce(peerB.handle, peerB.pg);
          if (a2 === 0 && b2 === 0) {
            converged = true;
            break;
          }
        }
      }
      expect(
        converged,
        'outbox never reached a fixed point under repeated merge+drain — the migration-102 ' +
          'IS-DISTINCT-FROM guard is missing/ineffective (unbounded intra-peer self-amplification)',
      ).toBe(true);
    },
    60_000,
  );
});
