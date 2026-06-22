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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const { setClaimSpec, getClaimSpec } = await import('./claim-spec-store');
const { DEFAULT_CLAIM_SPEC } = await import('./claim-spec');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const mig = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l))
    .join('\n');

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('beespecs');
  h.sql = db.sql;
  await db.sql.unsafe(mig('372-bee-claim-specs.sql'));
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
