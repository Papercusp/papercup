/**
 * claim-spec-store.integration.test.ts — the per-bee claim-spec store (mig 372 bee_claim_specs)
 * that makes get_next usable (hybrid-bee-scheduler-work-stealing-2026-06-22 spec-handoff).
 *
 * setClaimSpec validates (validateClaimSpec) + upserts a bee's spec (bumping the revision on
 * re-steer); getClaimSpec loads it, falling back to DEFAULT_CLAIM_SPEC when absent or invalid.
 * Real Postgres (testcontainer; Docker required); the store fns take a DI `sql`.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *   lib/scheduler/claim-spec-store.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

// Keep the import chain (claim-spec-store → get-next → work-items) safe at module load.
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { setClaimSpec, getClaimSpec, getClaimSpecHeadsForBees } = await import('./claim-spec-store');
const { DEFAULT_CLAIM_SPEC } = await import('./claim-spec');
const { buildBeeClaimSpecProjection } = await import('../sync/hyperbee/projections/bee-claim-spec');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const mig = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l))
    // strip standalone BEGIN;/COMMIT; — sql.unsafe on a pooled conn rejects them.
    .filter((l) => !/^\s*(begin|commit);\s*$/i.test(l))
    .join('\n');

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('beespecs');
  h.sql = db.sql;
  // Minimal consolidated tables FIRST — mig 102 attaches its capture triggers to
  // them (and ALTERs harness_issues_consolidated), so they must pre-exist.
  await db.sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    harness_slug text NOT NULL, feature_id text NOT NULL, item_kind text NOT NULL DEFAULT 'feature',
    status text NOT NULL DEFAULT 'todo', taken_by text, taken_at timestamptz,
    last_progress_at timestamptz, workspace_id text NOT NULL DEFAULT 'default',
    PRIMARY KEY (harness_slug, feature_id))`);
  await db.sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.harness_issues_consolidated (
    harness_slug text NOT NULL, issue_id text NOT NULL, workspace_id text NOT NULL DEFAULT 'default',
    PRIMARY KEY (harness_slug, issue_id))`);
  // P-016 (cross-machine-coord-parity): substrate_outbox + capture fn (mig 102),
  // the spec table (372/389), then its federation columns + capture triggers (438).
  await db.sql.unsafe(mig('archive/102-substrate-outbox.sql'));
  await db.sql.unsafe(mig('372-bee-claim-specs.sql'));
  await db.sql.unsafe(mig('389-bee-claim-spec-id-only.sql')); // id-pin tripwire column
  await db.sql.unsafe(mig('438-bee-claim-specs-federation.sql'));
}, 180_000);
afterAll(async () => {
  await db?.cleanup?.();
});

describe('bee_claim_specs store (mig 372)', () => {
  it('stores a valid spec, returns it, and bumps the revision on re-steer', async () => {
    const r1 = await setClaimSpec({ beeId: 'su-bee-1', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen' }, db.sql);
    expect(r1.ok).toBe(true);
    expect(r1.revision).toBe(DEFAULT_CLAIM_SPEC.revision);

    const got = await getClaimSpec({ beeId: 'su-bee-1' }, db.sql);
    expect(got.specVersion).toBe(DEFAULT_CLAIM_SPEC.specVersion);
    expect(got.specId).toBe(DEFAULT_CLAIM_SPEC.specId);

    const r2 = await setClaimSpec({ beeId: 'su-bee-1', spec: DEFAULT_CLAIM_SPEC }, db.sql);
    expect(r2.ok).toBe(true);
    expect(r2.revision).toBe((r1.revision ?? 0) + 1);
  });

  it('returns DEFAULT_CLAIM_SPEC for a bee with no stored spec', async () => {
    expect(await getClaimSpec({ beeId: 'no-such-bee' }, db.sql)).toEqual(DEFAULT_CLAIM_SPEC);
  });

  it('rejects an invalid spec (the validation gate) and stores nothing', async () => {
    const r = await setClaimSpec({ beeId: 'su-bee-2', spec: { garbage: true } }, db.sql);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(await getClaimSpec({ beeId: 'su-bee-2' }, db.sql)).toEqual(DEFAULT_CLAIM_SPEC);
  });
});

describe('getClaimSpecHeadsForBees (the bee-runs spec join, P-001)', () => {
  it('returns specId@revision per bee with a stored spec (highest revision), absent otherwise', async () => {
    await setClaimSpec({ beeId: 'su-h1', spec: DEFAULT_CLAIM_SPEC }, db.sql); // revision 0
    await setClaimSpec({ beeId: 'su-h2', spec: DEFAULT_CLAIM_SPEC }, db.sql);
    await setClaimSpec({ beeId: 'su-h2', spec: DEFAULT_CLAIM_SPEC }, db.sql); // re-steer → revision 1

    const heads = await getClaimSpecHeadsForBees(['su-h1', 'su-h2', 'su-no-spec'], undefined, db.sql);
    expect(heads.get('su-h1')).toEqual({ specId: DEFAULT_CLAIM_SPEC.specId, revision: 0 });
    expect(heads.get('su-h2')).toEqual({ specId: DEFAULT_CLAIM_SPEC.specId, revision: 1 }); // highest revision wins
    expect(heads.has('su-no-spec')).toBe(false); // no stored spec ⇒ absent (⇒ DEFAULT ordering)
  });

  it('returns an empty map for no bees', async () => {
    expect(await getClaimSpecHeadsForBees([], undefined, db.sql)).toEqual(new Map());
  });
  it('P-016: a hive-scoped spec ENQUEUES a federation outbox row; operator-scope stays LOCAL', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    // operator-scope (hiveSlug null) — no capture (the mig-438 WHEN gate).
    await setClaimSpec({ beeId: 'su-bee-local', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen' }, db.sql);
    expect(
      await db.sql`SELECT 1 FROM harness_shared.substrate_outbox WHERE table_name='bee_claim_specs' AND key='su-bee-local'`,
    ).toHaveLength(0);
    // hive-scoped — one put outbox row keyed by bee_id, tagged with the hive home slug.
    await setClaimSpec(
      { beeId: 'su-bee-fed', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen', hiveSlug: 'my-hive' },
      db.sql,
    );
    const rows = await db.sql<{ op: string; key: string; harness_slug: string }[]>`
      SELECT op, key, harness_slug FROM harness_shared.substrate_outbox WHERE table_name='bee_claim_specs' AND key='su-bee-fed'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: 'put', key: 'su-bee-fed', harness_slug: 'my-hive' });
    // a re-steer (revision bump) of the hive-scoped spec captures again (UPDATE gate).
    await setClaimSpec(
      { beeId: 'su-bee-fed', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen', hiveSlug: 'my-hive' },
      db.sql,
    );
    expect(
      (await db.sql`SELECT 1 FROM harness_shared.substrate_outbox WHERE table_name='bee_claim_specs' AND key='su-bee-fed'`).length,
    ).toBeGreaterThanOrEqual(1);
  });

});

describe('L9 (P-058) — tombstone on scope-downgrade (bee_claim_specs re-home)', () => {
  it('re-homing a spec to a DIFFERENT hive scope federates a TOMBSTONE (del) to the OLD scope + a put to the NEW', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await setClaimSpec({ beeId: 'su-rehome', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen', hiveSlug: 'hiveA' }, db.sql);
    const r = await setClaimSpec({ beeId: 'su-rehome', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen', hiveSlug: 'hiveB' }, db.sql);
    expect(r.ok).toBe(true);
    const ops = await db.sql<{ op: string; harness_slug: string }[]>`
      SELECT op, harness_slug FROM harness_shared.substrate_outbox
       WHERE table_name='bee_claim_specs' AND key='su-rehome' ORDER BY id`;
    // put(hiveA) from the first author, then the re-home: del(hiveA) = the tombstone
    // to the OLD scope's peers, put(hiveB) = the spec under the NEW scope.
    expect(ops).toEqual([
      { op: 'put', harness_slug: 'hiveA' },
      { op: 'del', harness_slug: 'hiveA' },
      { op: 'put', harness_slug: 'hiveB' },
    ]);
    // The LOCAL row now lives under hive B, revision preserved-and-bumped.
    const [row] = await db.sql<{ harness_slug: string; revision: number }[]>`
      SELECT harness_slug, revision FROM harness_shared.bee_claim_specs WHERE bee_id='su-rehome'`;
    expect(row.harness_slug).toBe('hiveB');
    expect(row.revision).toBe(DEFAULT_CLAIM_SPEC.revision + 1);
    // get_next reads the live row — one spec, under the new scope (no strand).
    expect(await getClaimSpec({ beeId: 'su-rehome' }, db.sql)).toMatchObject({ specId: DEFAULT_CLAIM_SPEC.specId });
  });

  it('DOWNGRADING a hive-scoped spec to operator-scope (null) still tombstones the old scope; the new local row is not federated', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await setClaimSpec({ beeId: 'su-downgrade', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen', hiveSlug: 'hiveA' }, db.sql);
    await setClaimSpec({ beeId: 'su-downgrade', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen', hiveSlug: null }, db.sql);
    const ops = await db.sql<{ op: string; harness_slug: string | null }[]>`
      SELECT op, harness_slug FROM harness_shared.substrate_outbox
       WHERE table_name='bee_claim_specs' AND key='su-downgrade' ORDER BY id`;
    // put(hiveA), then del(hiveA) tombstone; the re-insert is operator-scope (null
    // harness_slug) so its INSERT never trips the mig-438 WHEN gate → not captured.
    expect(ops).toEqual([
      { op: 'put', harness_slug: 'hiveA' },
      { op: 'del', harness_slug: 'hiveA' },
    ]);
    const [row] = await db.sql<{ harness_slug: string | null }[]>`
      SELECT harness_slug FROM harness_shared.bee_claim_specs WHERE bee_id='su-downgrade'`;
    expect(row.harness_slug).toBeNull();
  });

  it('a SAME-scope re-steer does NOT tombstone (only the in-place UPDATE capture)', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await setClaimSpec({ beeId: 'su-samescope', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen', hiveSlug: 'hiveA' }, db.sql);
    await setClaimSpec({ beeId: 'su-samescope', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'queen', hiveSlug: 'hiveA' }, db.sql);
    const ops = await db.sql<{ op: string }[]>`
      SELECT op FROM harness_shared.substrate_outbox
       WHERE table_name='bee_claim_specs' AND key='su-samescope' ORDER BY id`;
    expect(ops.map((o) => o.op)).toEqual(['put', 'put']); // no 'del' — no re-home
  });
});

describe('M6 (P-055) — federated claim-spec steer-tier authz gate (bee-claim-spec projection)', () => {
  const HIVE = 'my-hive';
  type Tier = 'observe' | 'message' | 'wake' | 'steer';
  const specRow = (beeId: string) =>
    ({ harness_slug: HIVE, bee_id: beeId, spec: { ...DEFAULT_CLAIM_SPEC }, revision: 0, updated_by: 'queen' }) as never;
  const proj = (tier: Tier) =>
    buildBeeClaimSpecProjection({
      workspaceId: 'default',
      harnessSlug: HIVE, // hive-home-grained binding (== the federation slug)
      sql: db.sql,
      hiveHomeSlug: HIVE, // ⇒ enforcement active
      resolveCommsTier: async () => ({ tier, githubUserId: 4242 }),
    });
  const applied = async (beeId: string) =>
    (await db.sql`SELECT 1 FROM harness_shared.bee_claim_specs WHERE workspace_id='default' AND bee_id=${beeId}`).length > 0;

  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.bee_claim_specs WHERE bee_id LIKE 'm6-%'`;
  });

  it('a REMOTE spec from a BELOW-steer author (observe/message/wake) is NOT applied', async () => {
    for (const tier of ['observe', 'message', 'wake'] as Tier[]) {
      const bee = `m6-below-${tier}`;
      await proj(tier).writeToPg(specRow(bee), { authorPubkey: 'devA', origin: 'remote' });
      expect(await applied(bee)).toBe(false);
    }
  });

  it('a REMOTE spec from a STEER author IS applied (a claim spec is a steer-class action)', async () => {
    await proj('steer').writeToPg(specRow('m6-steer'), { authorPubkey: 'devA', origin: 'remote' });
    expect(await applied('m6-steer')).toBe(true);
  });

  it('a LOCAL-origin spec applies regardless of tier (the queen on THIS machine, ungated)', async () => {
    await proj('observe').writeToPg(specRow('m6-local'), { authorPubkey: 'devA', origin: 'local' });
    expect(await applied('m6-local')).toBe(true);
  });

  it('a NON-hive-bound projection stays full-passthrough (no gate — today\'s behavior)', async () => {
    const plain = buildBeeClaimSpecProjection({ workspaceId: 'default', harnessSlug: HIVE, sql: db.sql }); // no hiveHomeSlug
    await plain.writeToPg(specRow('m6-plain'), { authorPubkey: 'devA', origin: 'remote' });
    expect(await applied('m6-plain')).toBe(true);
  });

  it('a tier-resolve ERROR fails CLOSED (a steer-class action must not apply on doubt)', async () => {
    const errProj = buildBeeClaimSpecProjection({
      workspaceId: 'default',
      harnessSlug: HIVE,
      sql: db.sql,
      hiveHomeSlug: HIVE,
      resolveCommsTier: async () => {
        throw new Error('tier store down');
      },
    });
    await errProj.writeToPg(specRow('m6-err'), { authorPubkey: 'devA', origin: 'remote' });
    expect(await applied('m6-err')).toBe(false);
  });
});
