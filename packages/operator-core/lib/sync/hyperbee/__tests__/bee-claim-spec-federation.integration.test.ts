/**
 * cup_claim_specs federation integration (real PG) — closes the coverage gap
 * left by bee-claim-spec.test.ts (pure decode/guard unit tests only): the M6
 * comms-tier STEER gate (audit D-013), the PG-level LWW guard (fed_order_key,
 * EI-1698), the `id_only` denormalized tripwire recompute, and the full
 * capture → reshape → decode → project two-peer convergence chain for the
 * Queen's per-bee claim-spec surface
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-016 / mig 438;
 * p2p-parity-parallel-lanes-2026-07-09 P-007 — claim-spec federation tests).
 *
 * Pattern mirrors coord-message-federation.integration.test.ts (the richest
 * existing federation-projection suite) and presence-gossip-wiring
 * .integration.test.ts (real PG, hand-provisioned schema, no dev DB touched).
 * Scope per P-007: in-process green only — no live-rig runs, no
 * wake-executor.ts edits, no vm-rig script edits.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, applyMigrationForTest, FED_ORDER_KEY_DDL, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import { buildBeeClaimSpecProjection, type BeeClaimSpecRow } from '../projections/bee-claim-spec';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');
const OUTBOX_MIGRATION = resolve(SQL_DIR, 'archive/102-substrate-outbox.sql');
const CLAIM_SPEC_TABLE = resolve(SQL_DIR, '372-bee-claim-specs.sql');
const ID_ONLY_MIGRATION = resolve(SQL_DIR, '389-bee-claim-spec-id-only.sql');
const FED_MIGRATION = resolve(SQL_DIR, '438-bee-claim-specs-federation.sql');

const WS = 'ws_bcs';
const HIVE = 'hive-bcs';

interface OutboxDbRow {
  table_name: string;
  op: string;
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
  harness_slug: string;
}

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { specVersion: 1, specId: 's1', view: { filter: null }, rank: [], ...overrides };
}

function row(over?: Partial<BeeClaimSpecRow>): BeeClaimSpecRow {
  return {
    harness_slug: HIVE,
    bee_id: 'su-bee-1',
    spec: spec(),
    revision: 1,
    updated_by: 'su-queen-1',
    ...over,
  };
}

/** Provision a second throwaway DB (peer B) with the SAME schema as peer A's
 *  beforeAll below. Migration 438 CREATEs a trigger that EXECUTEs
 *  harness_shared.capture_substrate_outbox() — Postgres validates that
 *  function exists at CREATE TRIGGER time, so the outbox migration (which
 *  defines it, and needs the two consolidated tables + roles it ALTERs/GRANTs)
 *  must land here too, even though peer B never captures its own outbox in
 *  these tests. */
async function provisionPeer(db: FreshPgDb): Promise<void> {
  await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await db.sql.unsafe(`
    DO $r$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
    END $r$;
  `);
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      feature_id TEXT NOT NULL, author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (harness_slug, feature_id));
    CREATE TABLE harness_shared.harness_issues_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL, author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (harness_slug, issue_id));
  `);
  await applyMigrationForTest(db.sql, OUTBOX_MIGRATION);
  await applyMigrationForTest(db.sql, CLAIM_SPEC_TABLE);
  await applyMigrationForTest(db.sql, ID_ONLY_MIGRATION);
  await applyMigrationForTest(db.sql, FED_MIGRATION);
  // P-009 Phase 2 (WI-3954): rename bee_claim_specs → cup_claim_specs so this rig
  // matches the live post-555 schema the projection (bee-claim-spec.ts) writes.
  // Inline (not the full 555 file, whose unconditional beekeeper_* compat VIEWs
  // target cup_keeper_* tables absent from this claim-spec-only rig → 42P01).
  await db.sql.unsafe('ALTER TABLE harness_shared.bee_claim_specs RENAME TO cup_claim_specs');
  await db.sql.unsafe(FED_ORDER_KEY_DDL);
}

describe('cup_claim_specs federation (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('cup_claim_specs_fed');
    await provisionPeer(db);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function fetchRow(beeId: string) {
    const rows = await db.sql<
      { revision: number; updated_by: string | null; id_only: boolean; origin: string; author_pubkey: string | null }[]
    >`SELECT revision, updated_by, id_only, origin, author_pubkey FROM harness_shared.cup_claim_specs
       WHERE workspace_id=${WS} AND bee_id=${beeId}`;
    return rows[0] ?? null;
  }

  it('writeToPg no-ops when row.harness_slug does not match the projection scope (demux guard)', async () => {
    const proj = buildBeeClaimSpecProjection({ workspaceId: WS, harnessSlug: HIVE, sql: db.sql });
    await proj.writeToPg(row({ harness_slug: 'other-hive', bee_id: 'su-bee-guard' }));
    expect(await fetchRow('su-bee-guard')).toBeNull();
  });

  it('non-hive-bound projection: a REMOTE op applies unconditionally — the tier resolver is never consulted', async () => {
    const resolver = vi.fn(async () => ({ tier: 'observe' as const, githubUserId: 1 }));
    const proj = buildBeeClaimSpecProjection({ workspaceId: WS, harnessSlug: HIVE, sql: db.sql, resolveCommsTier: resolver });
    await proj.writeToPg(row({ bee_id: 'su-bee-nonhive' }), { authorPubkey: 'peerA', origin: 'remote' });
    expect(await fetchRow('su-bee-nonhive')).not.toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('hive-bound projection: a LOCAL-origin write applies without consulting the tier resolver', async () => {
    const resolver = vi.fn(async () => ({ tier: 'observe' as const, githubUserId: 1 }));
    const proj = buildBeeClaimSpecProjection({
      workspaceId: WS, harnessSlug: HIVE, sql: db.sql, potHomeSlug: HIVE, resolveCommsTier: resolver,
    });
    await proj.writeToPg(row({ bee_id: 'su-bee-local' }), { authorPubkey: 'ownDevice', origin: 'local' });
    expect(await fetchRow('su-bee-local')).not.toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("hive-bound + REMOTE at 'steer': the redirect applies", async () => {
    const proj = buildBeeClaimSpecProjection({
      workspaceId: WS, harnessSlug: HIVE, sql: db.sql, potHomeSlug: HIVE,
      resolveCommsTier: async () => ({ tier: 'steer' as const, githubUserId: 42 }),
    });
    await proj.writeToPg(row({ bee_id: 'su-bee-steer', revision: 9 }), { authorPubkey: 'peerSteer', origin: 'remote' });
    const r = await fetchRow('su-bee-steer');
    expect(r?.revision).toBe(9);
  });

  it.each(['wake', 'message', 'observe'] as const)(
    "hive-bound + REMOTE at '%s' (below steer): dropped silently — the bee keeps its prior spec (no quarantine rail for specs)",
    async (tier) => {
      const proj = buildBeeClaimSpecProjection({
        workspaceId: WS, harnessSlug: HIVE, sql: db.sql, potHomeSlug: HIVE,
        resolveCommsTier: async () => ({ tier, githubUserId: 42 }),
      });
      const beeId = `su-bee-drop-${tier}`;
      await proj.writeToPg(row({ bee_id: beeId }), { authorPubkey: 'peerBelow', origin: 'remote' });
      expect(await fetchRow(beeId)).toBeNull();
    },
  );

  it('an unresolvable author device (no admitted match) falls back to message tier — below steer, dropped', async () => {
    const proj = buildBeeClaimSpecProjection({
      workspaceId: WS, harnessSlug: HIVE, sql: db.sql, potHomeSlug: HIVE,
      resolveAuthorDevice: () => null,
    });
    await proj.writeToPg(row({ bee_id: 'su-bee-noauthor' }), { authorPubkey: 'unmatchedSourceLog', origin: 'remote' });
    expect(await fetchRow('su-bee-noauthor')).toBeNull();
  });

  it('a tier-resolve error fails CLOSED (fallback tier, below steer) — never applies a REMOTE hive-bound spec on ambiguity', async () => {
    const proj = buildBeeClaimSpecProjection({
      workspaceId: WS, harnessSlug: HIVE, sql: db.sql, potHomeSlug: HIVE,
      resolveCommsTier: async () => {
        throw new Error('tier store down');
      },
    });
    await proj.writeToPg(row({ bee_id: 'su-bee-tiererr' }), { authorPubkey: 'peerErr', origin: 'remote' });
    expect(await fetchRow('su-bee-tiererr')).toBeNull();
  });

  describe('id_only denormalized tripwire (recomputed from `spec` locally, never carried on the wire)', () => {
    const proj = () => buildBeeClaimSpecProjection({ workspaceId: WS, harnessSlug: HIVE, sql: db.sql });

    it('a spec whose view.filter selects on id ALONE → id_only=true', async () => {
      await proj().writeToPg(
        row({ bee_id: 'su-bee-idonly', spec: spec({ view: { filter: { field: 'id', op: 'in', value: ['WI-1', 'WI-2'] } } }) }),
      );
      expect((await fetchRow('su-bee-idonly'))?.id_only).toBe(true);
    });

    it('a spec with a property selector (e.g. plan) ALONGSIDE id → id_only=false', async () => {
      await proj().writeToPg(
        row({
          bee_id: 'su-bee-broad',
          spec: spec({
            view: {
              filter: {
                all: [
                  { field: 'id', op: 'in', value: ['WI-1'] },
                  { field: 'plan', op: 'eq', value: 'p' },
                ],
              },
            },
          }),
        }),
      );
      expect((await fetchRow('su-bee-broad'))?.id_only).toBe(false);
    });

    it('no filter at all → id_only=false (the whole ready frontier)', async () => {
      await proj().writeToPg(row({ bee_id: 'su-bee-nofilter', spec: spec({ view: { filter: null } }) }));
      expect((await fetchRow('su-bee-nofilter'))?.id_only).toBe(false);
    });

    it('re-versioning a bee OFF an id-pin back to the default flips id_only back to false', async () => {
      const beeId = 'su-bee-unpin';
      await proj().writeToPg(row({ bee_id: beeId, revision: 1, spec: spec({ view: { filter: { field: 'id', op: 'in', value: ['WI-9'] } } }) }));
      expect((await fetchRow(beeId))?.id_only).toBe(true);
      await proj().writeToPg(row({ bee_id: beeId, revision: 2, spec: spec({ view: { filter: null } }) }));
      const r = await fetchRow(beeId);
      expect(r?.revision).toBe(2);
      expect(r?.id_only).toBe(false);
    });
  });

  describe('PG-level LWW guard (fed_order_key, ts-only ops — EI-1698)', () => {
    const proj = () => buildBeeClaimSpecProjection({ workspaceId: WS, harnessSlug: HIVE, sql: db.sql });

    it('a strictly OLDER op never clobbers an already-applied NEWER op', async () => {
      const beeId = 'su-bee-lww-1';
      await proj().writeToPg(row({ bee_id: beeId, revision: 5, updated_by: 'newer' }), { authorPubkey: 'p', origin: 'remote', ts: 2000 });
      await proj().writeToPg(row({ bee_id: beeId, revision: 1, updated_by: 'older' }), { authorPubkey: 'p', origin: 'remote', ts: 1000 });
      const r = await fetchRow(beeId);
      expect(r?.revision).toBe(5);
      expect(r?.updated_by).toBe('newer');
    });

    it('a NEWER op after an older one applies normally (forward progress)', async () => {
      const beeId = 'su-bee-lww-2';
      await proj().writeToPg(row({ bee_id: beeId, revision: 1, updated_by: 'older' }), { authorPubkey: 'p', origin: 'remote', ts: 1000 });
      await proj().writeToPg(row({ bee_id: beeId, revision: 2, updated_by: 'newer' }), { authorPubkey: 'p', origin: 'remote', ts: 2000 });
      const r = await fetchRow(beeId);
      expect(r?.revision).toBe(2);
      expect(r?.updated_by).toBe('newer');
    });

    it('re-applying the SAME op (identical ts) is idempotent — exactly one row', async () => {
      const beeId = 'su-bee-lww-idem';
      await proj().writeToPg(row({ bee_id: beeId, revision: 3 }), { authorPubkey: 'p', origin: 'remote', ts: 5000 });
      await proj().writeToPg(row({ bee_id: beeId, revision: 3 }), { authorPubkey: 'p', origin: 'remote', ts: 5000 });
      expect(await db.sql`SELECT 1 FROM harness_shared.cup_claim_specs WHERE workspace_id=${WS} AND bee_id=${beeId}`).toHaveLength(1);
    });
  });

  describe('deleteFromPg', () => {
    const proj = () => buildBeeClaimSpecProjection({ workspaceId: WS, harnessSlug: HIVE, sql: db.sql });

    it('removes the row', async () => {
      const beeId = 'su-bee-del-1';
      await proj().writeToPg(row({ bee_id: beeId }), { authorPubkey: 'p', origin: 'remote', ts: 1000 });
      await proj().deleteFromPg(beeId, 2000);
      expect(await fetchRow(beeId)).toBeNull();
    });

    it('an OLDER del never removes a row stamped with a NEWER fed_ts', async () => {
      const beeId = 'su-bee-del-2';
      await proj().writeToPg(row({ bee_id: beeId }), { authorPubkey: 'p', origin: 'remote', ts: 5000 });
      await proj().deleteFromPg(beeId, 1000);
      expect(await fetchRow(beeId)).not.toBeNull();
    });

    it('an empty key is a no-op', async () => {
      await expect(proj().deleteFromPg('')).resolves.toBeUndefined();
    });
  });

  describe('capture → reshape → two-peer convergence (real outbox + real reshape chain)', () => {
    async function outbox(): Promise<OutboxDbRow[]> {
      return db.sql<OutboxDbRow[]>`
        SELECT table_name, op, key, row, ts, harness_slug FROM harness_shared.substrate_outbox
        WHERE table_name = 'cup_claim_specs' ORDER BY id`;
    }
    async function clearOutbox() {
      await db.sql`DELETE FROM harness_shared.substrate_outbox WHERE table_name = 'cup_claim_specs'`;
    }
    async function insertLocal(beeId: string, revision = 1, harnessSlug: string | null = HIVE) {
      await db.sql`
        INSERT INTO harness_shared.cup_claim_specs (workspace_id, bee_id, spec, revision, updated_by, harness_slug, origin)
        VALUES (${WS}, ${beeId}, ${JSON.stringify(spec())}::text::jsonb, ${revision}, 'su-queen-1', ${harnessSlug}, 'local')
      `;
    }

    it('a HIVE-scoped local upsert enqueues one put outbox row keyed by bee_id', async () => {
      await clearOutbox();
      await insertLocal('su-bee-outbox-1');
      const rows = await outbox();
      expect(rows).toHaveLength(1);
      expect(rows[0].op).toBe('put');
      expect(rows[0].key).toBe('su-bee-outbox-1');
      expect(rows[0].harness_slug).toBe(HIVE);
    });

    it('an operator-scope spec (harness_slug NULL) enqueues NOTHING (D-006 demux)', async () => {
      await clearOutbox();
      await insertLocal('su-bee-operator-scope', 1, null);
      expect(await outbox()).toHaveLength(0);
    });

    it('a no-op re-upsert (identical spec/revision/updated_by/harness_slug) enqueues NOTHING (loop-termination guard)', async () => {
      await insertLocal('su-bee-noop');
      await clearOutbox();
      await db.sql`
        UPDATE harness_shared.cup_claim_specs SET spec = spec, revision = revision, updated_by = updated_by
        WHERE workspace_id = ${WS} AND bee_id = 'su-bee-noop'`;
      expect(await outbox()).toHaveLength(0);
    });

    it('two-peer convergence: a queen spec-bump on A lands on B (origin=remote) via the real reshape→decode→project chain', async () => {
      const dbB = await createFreshPgDb('cup_claim_specs_fed_b');
      try {
        await provisionPeer(dbB);
        const projB = buildBeeClaimSpecProjection({ workspaceId: WS, harnessSlug: HIVE, sql: dbB.sql });

        async function applyOnB(r: OutboxDbRow) {
          const op = outboxRowToLocalWriteOp({ table_name: r.table_name, op: r.op as 'put', key: r.key, ts: r.ts, row: r.row } as OutboxRow);
          if (op.type === 'del') return projB.deleteFromPg(op.hbKey, op.ts, (op as { hlc?: string }).hlc);
          const decoded = projB.decodeValue((op as { value: unknown }).value);
          expect(decoded, 'reshaped spec must satisfy the projection decoder').not.toBeNull();
          await projB.writeToPg(decoded!, { authorPubkey: 'peerA', origin: 'remote' });
        }

        await clearOutbox();
        await insertLocal('su-bee-conv', 7);
        for (const r of await outbox()) await applyOnB(r);
        const [onB] = await dbB.sql<{ revision: number; updated_by: string }[]>`
          SELECT revision, updated_by FROM harness_shared.cup_claim_specs WHERE workspace_id=${WS} AND bee_id='su-bee-conv'`;
        expect(onB.revision).toBe(7);
        expect(onB.updated_by).toBe('su-queen-1');

        // DELETE on A converges to absent on B.
        await clearOutbox();
        await db.sql`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id=${WS} AND bee_id='su-bee-conv'`;
        for (const r of await outbox()) await applyOnB(r);
        expect(await dbB.sql`SELECT 1 FROM harness_shared.cup_claim_specs WHERE workspace_id=${WS} AND bee_id='su-bee-conv'`).toHaveLength(0);
      } finally {
        await dbB.cleanup();
      }
    }, 120_000);
  });
});
