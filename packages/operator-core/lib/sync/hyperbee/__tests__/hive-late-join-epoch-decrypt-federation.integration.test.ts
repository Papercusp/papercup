/**
 * hive-late-join-epoch-decrypt-federation.integration.test.ts — WI-894 (Lane C).
 *
 * THE PERMANENT REGRESSION GUARD for the shared-hive content-federation break:
 * "a member that joins a hive AFTER an epoch has advanced must still end with the
 * owner's pre-join plan + work_item rows DECRYPTED in its own Postgres."
 *
 * This is the hermetic, testcontainer-PG witness of the exact chain the live
 * 2-machine rig surfaced (plan shared-hive-member-content-federation-2026-06-20,
 * D-018: a joiner held only epoch 0 and dropped all current-epoch content). It
 * needs NO VM rig — it composes the REAL production op-path against two SEPARATE
 * throwaway Postgres databases:
 *
 *   1. OWNER authors a plan + a work_item, ENCRYPTED-on-write under the current
 *      epoch (the real `buildEpochEncryptCapability` over the real
 *      XChaCha20-Poly1305 + sealed-box crypto, `resolveHiveEpochCrypto(true)`).
 *   2. The epoch ADVANCES (real `advanceHiveEpoch`, federated hive_settings).
 *   3. A MEMBER joins AFTER the advance — so it missed the boundary wrap and holds
 *      NO epoch keys. The owner's ciphertext replicates to the joiner first; the
 *      real decrypt gate (`buildEpochDecryptGate`) DEFERS it (no key yet) →
 *      the joiner's PG is empty. THIS IS THE REGRESSION STATE (asserted as a
 *      negative control, so the test has teeth).
 *   4. WI-887 SELF-HEAL: `reconcileEpochKeysForCurrentMembers` (which delegates to
 *      the grant-on-join `grantEpochKeysToMembers`) reads the CURRENT member set
 *      (the operator member view, `listHiveMembers`) and wraps every epoch key
 *      [0..current] to each live member's device. Those wrapped rows FEDERATE to
 *      the joiner through the REAL `hive-epoch-keys` projection, whose
 *      `onEpochKeyApplied` hook queues the (hive, epoch) for the drain.
 *   5. `drainQueuedEpochContent` re-runs the joiner's DEFERRED content ops through
 *      the SAME decrypt gate — now the joiner can unwrap its epoch-0 key, decrypt,
 *      and the REAL plan + work_item projections land the PLAINTEXT rows in the
 *      joiner's PG.
 *
 * The acceptance assertion reads the JOINER's PG and confirms the decrypted plan
 * (title/content) + work_item (title/summary/status) rows are there with
 * origin='remote'. A regression in grant-on-join, the WI-887 reconcile, the
 * epoch-key projection's drain hook, or the decrypt gate flips this RED.
 *
 * WHY COMPOSE (not boot two real swarms): the transport (announce → admission →
 * Hyperswarm replication → read-merge) is independently proven by
 * feature-content-federation.integration.test.ts + the *-swarm tests. THIS test
 * targets the post-transport chain — epoch-key-after-late-join DECRYPTION into PG
 * — so it hand-pipes the (already-proven-to-cross) ciphertext op directly into the
 * receiving peer's REAL apply path. That keeps the guard deterministic + fast (no
 * DHT timing) while exercising every link the regression lives in.
 *
 * REAL here: XChaCha20-Poly1305 + Ed25519→X25519 sealed-box crypto; the encrypt
 * capability; the decrypt gate + pending-epoch-content defer/drain; the member
 * EpochKeyProvider + PG wrapped-key loader; grant-on-join + the WI-887 reconcile
 * self-heal; the hive-epoch-keys / harness-plans / engineer-issues PG projections;
 * the operator member view (listHiveMembers); two real Postgres databases.
 * STOOD IN (in-memory, exactly as the read-cut witness): the OS keychain.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

// In-memory keychain (vi.mock factories are hoisted) — the SAME stand-in the
// read-cut witness uses, so the real crypto runs without OS secret I/O. Namespaced
// by serviceName, so device keypairs (papercusp-device-keypair) and the per-(hive,
// epoch) content keys (papercusp-hive-epoch-key) coexist without collision.
const { mem } = vi.hoisted(() => ({ mem: new Map<string, Buffer>() }));
const DEVICE_SVC = 'papercusp-device-keypair';
vi.mock('../../../identity/keychain', () => ({
  keychainStore: async (id: string, der: Buffer, serviceName: string = DEVICE_SVC) => {
    mem.set(serviceName + ':' + id, Buffer.from(der));
  },
  keychainLoad: async (id: string, serviceName: string = DEVICE_SVC) => {
    const v = mem.get(serviceName + ':' + id);
    return v ? { kind: 'ok', value: v } : { kind: 'error', error: { kind: 'not_found' } };
  },
  keychainDelete: async (id: string, serviceName: string = DEVICE_SVC) => {
    mem.delete(serviceName + ':' + id);
  },
}));

import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { WORKSPACE_ID, HIVE_SLUG, setupHivePeerSchema, seedHive } from './_hive-substrate-rig';
import { resolveHiveEpochCrypto } from '../hive-epoch-serving';
import {
  buildEpochEncryptCapability,
  buildEpochDecryptGate,
  buildEpochKeyResolver,
  drainQueuedEpochContent,
  type DrainedEpoch,
} from '../hive-epoch-op-gate';
import { createEpochKeyProvider } from '../hive-epoch-key-provider';
import { createPgWrappedKeyLoader } from '../hive-epoch-keys-store';
import { PendingEpochContent } from '../pending-epoch-content';
import { reconcileEpochKeysForCurrentMembers } from '../hive-epoch-boundary-wiring';
import { advanceHiveEpoch, getHiveEpoch } from '../hive-epoch-state';
import { listHiveMembers, upsertHiveMember } from '../../../hive-membership-store';
import { buildHarnessPlansProjection, type HarnessPlanRow } from '../projections/harness-plans';
import { buildEngineerIssuesProjection, type EngineerIssueRow } from '../projections/engineer-issues';
import { buildHiveEpochKeysProjection } from '../projections/hive-epoch-keys';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import type { OpEnvelope } from '../op-envelope-types';
import type { LocalWriteOp } from '../boot';

const { generateEd25519KeypairDer } = await import('../../../identity/ed25519');

// Two distinct synthetic log-core keys: the owner's log (source of the federated
// ops) and the joiner's own log. `applyOpVia` derives origin by comparing
// op.sourceLogKeyHex against the bound ownLogKeyHex — owner-source ⇒ origin='remote'
// on the joiner, and the skipOwnOps echo-breaker never fires (source ≠ own).
const OWNER_LOG_HEX = 'a'.repeat(64);
const JOINER_LOG_HEX = 'b'.repeat(64);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort teardown — a thrown assertion must not leak a db */
    }
  }
  mem.clear();
});

/** Minimal, prod-faithful DDL for the three content/key tables this test writes —
 *  exactly the columns the projections + wrapped-key store touch, no RLS / triggers
 *  / generated cols (the same superset-only stance as test/_work-items-schema.ts).
 *  The hive_* tables (hives / hive_members / hive_settings) come from the rig's
 *  setupHivePeerSchema (the real migrations). */
const CONTENT_AND_KEY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.hive_epoch_keys (
    workspace_id         text NOT NULL,
    harness_slug         text NOT NULL,
    epoch                integer NOT NULL,
    member_device_pubkey text NOT NULL,
    wrapped_key          text NOT NULL,
    author_pubkey        text,
    origin               text NOT NULL DEFAULT 'local',
    fed_ts               bigint,
    fed_hlc              text,
    created_at           bigint,
    updated_at           bigint,
    PRIMARY KEY (workspace_id, harness_slug, epoch, member_device_pubkey)
  );
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
    workspace_id   text NOT NULL,
    harness_slug   text NOT NULL,
    plan_slug      text NOT NULL,
    content        text,
    content_hash   text,
    version        bigint DEFAULT 0,
    title          text,
    status         text,
    created        text,
    updated        text,
    owner          text,
    initiative     text,
    template       text,
    template_data  jsonb,
    promote_policy jsonb,
    supersedes     text[] DEFAULT '{}'::text[],
    superseded_by  text,
    archived       boolean DEFAULT false,
    is_legacy      boolean DEFAULT false,
    author_pubkey  text,
    owner_author_pubkey text,
    origin         text DEFAULT 'local',
    fed_ts         bigint,
    fed_hlc        text,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug)
  );
  CREATE TABLE IF NOT EXISTS harness_shared.work_items (
    harness_slug  text NOT NULL,
    feature_id    text NOT NULL,
    item_kind     text,
    title         text,
    summary       text,
    status        text,
    taken_by      text,
    taken_at      timestamptz,
    payload       jsonb,
    author_pubkey text,
    origin        text DEFAULT 'local',
    fed_ts        bigint,
    fed_hlc       text,
    workspace_id  text,
    created_ts    bigint,
    updated_ts    bigint,
    ts            bigint,
    PRIMARY KEY (harness_slug, feature_id)
  );
`;

interface TestDevice {
  keychainId: string;
  pubkeyBase64: string;
}
/** Register a device: a fresh Ed25519 keypair with its private key in the (mocked)
 *  keychain — the same construction as the read-cut witness's makeDevice. */
async function makeDevice(keychainId: string): Promise<TestDevice> {
  const { keychainStore } = await import('../../../identity/keychain');
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  await keychainStore(keychainId, privateKeyDer);
  return { keychainId, pubkeyBase64 };
}

async function freshDb(name: string): Promise<FreshPgDb> {
  const db = await createFreshPgDb(name);
  cleanups.push(() => db.cleanup());
  await setupHivePeerSchema(db.sql); // hives / hive_members / hive_settings (real migrations)
  await db.sql.unsafe(CONTENT_AND_KEY_DDL); // + the three tables this test writes
  return db;
}

const PLAN_SLUG = 'lane-c-federation-demo';
const WI_ID = 'WI-lanec-demo-1';

function planValue(): HarnessPlanRow {
  return {
    harness_slug: HIVE_SLUG,
    plan_slug: PLAN_SLUG,
    content: '# Lane C demo plan\n\nSecret pre-join plan body the joiner must decrypt.',
    content_hash: 'hash-lanec-1',
    title: 'Lane C demo plan',
    status: 'active',
    created: '2026-06-26',
    updated: '2026-06-26',
    owner: 'alice',
    initiative: null,
    supersedes: [],
    superseded_by: null,
    archived: false,
    is_legacy: false,
  };
}
function workItemValue(): EngineerIssueRow {
  return {
    harness_slug: HIVE_SLUG,
    issue_id: WI_ID,
    scope: `harness:${HIVE_SLUG}`,
    kind: 'task',
    title: 'Lane C demo task',
    body: 'Secret pre-join work-item body the joiner must decrypt.',
    severity: 'minor',
    source: 'test',
    state: 'todo',
    assignee: null,
    assigned_by: null,
    assigned_at: null,
    payload: {},
    found_during: null,
    linked_feature_id: null,
    created_by: 'alice',
    created_at: '2026-06-26T00:00:00.000Z',
  };
}

describe('WI-894 — late-join epoch-key decryption: a member joining AFTER an epoch advance ends with the owner’s decrypted plan + work_item (hermetic, testcontainer PG)', () => {
  it(
    'owner encrypts plan+work_item @epoch0 → epoch advances → member joins (no keys, content DEFERS) → WI-887 reconcile grants [0..current] → drain decrypts both rows into the joiner PG',
    async () => {
      const crypto = await resolveHiveEpochCrypto(true); // the prod flip’s real crypto
      const dbOwner = await freshDb('wi894Owner');
      const dbJoiner = await freshDb('wi894Joiner');

      // Genuinely different databases — the meaningfulness precondition (a decrypted
      // row "appearing on the joiner" must be the joiner's own projection write).
      const [{ d: nameO }] = await dbOwner.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
      const [{ d: nameJ }] = await dbJoiner.sql<Array<{ d: string }>>`SELECT current_database() AS d`;
      expect(nameO).not.toBe(nameJ);

      const ownerDevice = await makeDevice('device-owner');
      const joinerDevice = await makeDevice('device-joiner');

      await seedHive(dbOwner.sql); // the hives row hive_settings/hive_members attach to

      // ── 1. OWNER authors a plan + work_item, ENCRYPTED under the current epoch (0). ──
      const ownerResolveKey = buildEpochKeyResolver({
        crypto,
        provider: { keyForEpoch: async () => { throw new Error('owner never unwraps'); } },
        isOwner: async () => true, // owner DERIVES (holds the hive key)
      });
      const ownerEncrypt = buildEpochEncryptCapability({
        crypto,
        resolveKey: ownerResolveKey,
        hiveId: HIVE_SLUG,
        getCurrentEpoch: () => getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, dbOwner.sql),
      });
      expect(await getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, dbOwner.sql)).toBe(0); // baseline

      const planLocal: LocalWriteOp = {
        type: 'put', table: 'plans-by-slug', hbKey: PLAN_SLUG, value: planValue(),
        ts: 1000, schema_version: 1, writerPubkey: ownerDevice.pubkeyBase64,
      } as LocalWriteOp;
      const wiLocal: LocalWriteOp = {
        type: 'put', table: 'engineer-issues', hbKey: WI_ID, value: workItemValue(),
        ts: 1001, schema_version: 1, writerPubkey: ownerDevice.pubkeyBase64,
      } as LocalWriteOp;

      const encPlan = await ownerEncrypt.encryptOp(planLocal);
      const encWi = await ownerEncrypt.encryptOp(wiLocal);
      expect(encPlan, 'plan op is selected for encryption').not.toBeNull();
      expect(encWi).not.toBeNull();
      expect(encPlan!.epoch).toBe(0);
      // Genuinely ciphertext — the federated bytes do NOT carry the plaintext.
      expect(JSON.stringify(encPlan!.value)).not.toContain('Secret pre-join plan body');

      // The federated ops the joiner replicates: encrypted value + epoch stamp, the
      // SAME (table, hbKey, writerPubkey) as encrypt (the AAD must match), source =
      // the owner's log (⇒ origin='remote' on the joiner).
      const fedPlan: OpEnvelope = {
        type: 'put', table: 'plans-by-slug', hbKey: PLAN_SLUG, writerPubkey: ownerDevice.pubkeyBase64,
        value: encPlan!.value, epoch: encPlan!.epoch, ts: 1000, sourceLogKeyHex: OWNER_LOG_HEX,
      } as OpEnvelope;
      const fedWi: OpEnvelope = {
        type: 'put', table: 'engineer-issues', hbKey: WI_ID, writerPubkey: ownerDevice.pubkeyBase64,
        value: encWi!.value, epoch: encWi!.epoch, ts: 1001, sourceLogKeyHex: OWNER_LOG_HEX,
      } as OpEnvelope;

      // ── 2. The epoch ADVANCES (a membership/visibility boundary). 0 → 1. ──
      const advanced = await advanceHiveEpoch(WORKSPACE_ID, HIVE_SLUG, dbOwner.sql);
      expect(advanced).toBe(1);

      // ── 3. The MEMBER joins AFTER the advance — owner + joiner are now in the hive
      //       (the operator member view). Seeded as upsertHiveMember writes the row
      //       (workspace_id concrete; device_attestations carry each device pubkey). ──
      for (const [uid, login, dev, status] of [
        [42, 'alice', ownerDevice, 'verified'],
        [7, 'bob', joinerDevice, 'verified'],
      ] as const) {
        await dbOwner.sql.unsafe(
          `INSERT INTO harness_shared.hive_members
             (workspace_id, hive_home_slug, github_user_id, github_username,
              device_attestations, revoked_pubkeys, binding_status)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::text[],$7)`,
          [WORKSPACE_ID, HIVE_SLUG, uid, login,
           JSON.stringify([{ device_pubkey: dev.pubkeyBase64 }]), [], status],
        );
      }

      // Operator member view == raw rows (the WI-892 invariant: the view must not
      // silently return fewer members than exist).
      const members = await listHiveMembers(WORKSPACE_ID, HIVE_SLUG, dbOwner.sql);
      const [{ n: rawCount }] = await dbOwner.sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM harness_shared.hive_members
         WHERE workspace_id = ${WORKSPACE_ID} AND hive_home_slug = ${HIVE_SLUG}`;
      expect(members.length).toBe(2);
      expect(members.length).toBe(Number(rawCount));

      // ── The JOINER's REAL apply path: decrypt gate → plan/work_item projections (BPG). ──
      const pending = new PendingEpochContent();
      const joinerResolveKey = buildEpochKeyResolver({
        crypto,
        provider: createEpochKeyProvider(
          crypto,
          createPgWrappedKeyLoader(WORKSPACE_ID, HIVE_SLUG, dbJoiner.sql),
          joinerDevice,
        ),
        isOwner: async () => false, // a member UNWRAPS its wrapped row
      });
      const plansProj = buildHarnessPlansProjection({
        workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql: dbJoiner.sql,
        isFlagOn: async () => false, // exercise the authoritative whole-blob upsert path
      });
      const issuesProj = buildEngineerIssuesProjection({
        workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql: dbJoiner.sql,
      });
      const contentLookup: ProjectionLookup = (tag) =>
        tag === 'plans-by-slug'
          ? (plansProj as TableProjection<unknown>)
          : tag === 'engineer-issues'
            ? (issuesProj as TableProjection<unknown>)
            : null;
      const joinerGate = buildEpochDecryptGate({ crypto, resolveKey: joinerResolveKey, hiveId: HIVE_SLUG, pending });
      const joinerApply = joinerGate((op) => applyOpVia(contentLookup, op, { ownLogKeyHex: JOINER_LOG_HEX }));

      // ── 3a. NEGATIVE CONTROL (the regression state): content arrives BEFORE the
      //       joiner holds any key → the gate DEFERS it; the joiner PG is empty. A
      //       current-epoch-only / no-backfill regression would leave it here forever. ──
      expect(await joinerApply(fedPlan), 'plan should defer (no epoch-0 key yet)').toBe(false);
      expect(await joinerApply(fedWi), 'work_item should defer (no epoch-0 key yet)').toBe(false);
      expect(pending.size()).toBe(2);
      expect(await readPlan(dbJoiner.sql)).toBeUndefined();
      expect(await readWorkItem(dbJoiner.sql)).toBeUndefined();

      // ── 4. WI-887 SELF-HEAL: reconcile the full current member set → wrap every epoch
      //       key [0..current] to each live device (delegates to grant-on-join). Owner
      //       derives; persisted to the owner PG. ──
      const reconcile = await reconcileEpochKeysForCurrentMembers(
        { workspaceId: WORKSPACE_ID, hiveHomeSlug: HIVE_SLUG, enabled: true, sql: dbOwner.sql },
        { resolveCrypto: async () => crypto, resolveAuthorPubkey: async () => ownerDevice.pubkeyBase64 },
      );
      expect(reconcile.applied, 'reconcile self-heal ran').toBe(true);
      // 2 epochs (0,1) × 2 live devices = 4 wrapped rows.
      expect(reconcile.distributed).toBe(4);
      const [{ n: keyRowCount }] = await dbOwner.sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM harness_shared.hive_epoch_keys
         WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_SLUG}
           AND member_device_pubkey = ${joinerDevice.pubkeyBase64}`;
      expect(Number(keyRowCount), 'joiner granted both epoch keys (0 and 1)').toBe(2);

      // ── 5. FEDERATE the wrapped-key rows to the joiner through the REAL hive-epoch-keys
      //       projection — its onEpochKeyApplied hook queues each (hive, epoch) for the drain. ──
      const drainQueue: DrainedEpoch[] = [];
      const keysProj = buildHiveEpochKeysProjection({
        workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql: dbJoiner.sql,
        onEpochKeyApplied: (h, e) => drainQueue.push({ hiveHomeSlug: h, epoch: e }),
      });
      const keysLookup: ProjectionLookup = (tag) =>
        tag === 'hive-epoch-keys' ? (keysProj as TableProjection<unknown>) : null;
      const keyRows = await dbOwner.sql<Array<{ epoch: number; member_device_pubkey: string; wrapped_key: string }>>`
        SELECT epoch, member_device_pubkey, wrapped_key FROM harness_shared.hive_epoch_keys
         WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_SLUG}`;
      for (const r of keyRows) {
        const keyOp: OpEnvelope = {
          type: 'put', table: 'hive-epoch-keys', hbKey: `${r.epoch}:${r.member_device_pubkey}`,
          writerPubkey: ownerDevice.pubkeyBase64, sourceLogKeyHex: OWNER_LOG_HEX, ts: 2000 + Number(r.epoch),
          value: {
            harness_slug: HIVE_SLUG, epoch: Number(r.epoch),
            member_device_pubkey: r.member_device_pubkey, wrapped_key: r.wrapped_key,
          },
        } as OpEnvelope;
        await applyOpVia(keysLookup, keyOp, { ownLogKeyHex: JOINER_LOG_HEX });
      }
      expect(drainQueue.length, 'each applied key row queued its (hive, epoch) for the drain').toBeGreaterThan(0);

      // ── 6. DRAIN: re-run the deferred content through the SAME gate — the joiner can
      //       now unwrap epoch-0 → decrypt → the real projections land the plaintext rows. ──
      const reapplied = await drainQueuedEpochContent({ pending, drainQueue, applyImpl: joinerApply });
      expect(reapplied, 'both deferred content ops re-applied + converged').toBe(2);
      expect(pending.size(), 'the defer buffer drained — no silent loss').toBe(0);

      // ── ACCEPTANCE: the joiner's PG holds the DECRYPTED plan + work_item. ──
      const plan = await readPlan(dbJoiner.sql);
      expect(plan, "joiner never decrypted the owner's plan").toBeTruthy();
      expect(plan).toMatchObject({
        plan_slug: PLAN_SLUG,
        title: 'Lane C demo plan',
        content: '# Lane C demo plan\n\nSecret pre-join plan body the joiner must decrypt.',
        status: 'active',
        origin: 'remote',
      });

      const wi = await readWorkItem(dbJoiner.sql);
      expect(wi, "joiner never decrypted the owner's work_item").toBeTruthy();
      expect(wi).toMatchObject({
        feature_id: WI_ID,
        item_kind: 'task',
        title: 'Lane C demo task',
        summary: 'Secret pre-join work-item body the joiner must decrypt.',
        status: 'todo',
        origin: 'remote',
      });
    },
    60_000,
  );

  it('WI-892/EI-3409 guard: a hive_members write under the unscoped-superuser sentinel workspace is refused LOUDLY (never silently invisible to concrete-workspace reads)', async () => {
    await expect(
      upsertHiveMember({
        workspaceId: '*', // the unscoped-superuser READ sentinel — never storable
        hiveHomeSlug: HIVE_SLUG,
        githubUserId: 9,
        githubUsername: 'ghost',
      }),
    ).rejects.toThrow(/read sentinel|WI-892|EI-3409/);
  });
});

async function readPlan(sql: postgres.Sql) {
  const rows = await sql<
    Array<{ plan_slug: string; title: string | null; content: string | null; status: string | null; origin: string }>
  >`
    SELECT plan_slug, title, content, status, origin FROM harness_shared.harness_plans
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_SLUG} AND plan_slug = ${PLAN_SLUG}`;
  return rows[0];
}
async function readWorkItem(sql: postgres.Sql) {
  const rows = await sql<
    Array<{ feature_id: string; item_kind: string; title: string; summary: string; status: string; origin: string }>
  >`
    SELECT feature_id, item_kind, title, summary, status, origin FROM harness_shared.work_items
     WHERE harness_slug = ${HIVE_SLUG} AND feature_id = ${WI_ID}`;
  return rows[0];
}
