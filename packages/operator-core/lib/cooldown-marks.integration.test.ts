/**
 * cooldown-marks.integration.test.ts — the per-key cooldown ledger
 * (`harness_shared.cooldown_marks`, migration 032) against REAL testcontainer
 * Postgres. The unit test (cooldown-marks.test.ts) mocks the Drizzle `db`; this
 * pins the DURABLE round-trip the production code actually runs.
 *
 * The SUT reads/writes through `getOrgPg().db` (a Drizzle instance) — so we mock
 * db-org's getOrgPg to a real drizzle() over the org-fixture's admin client
 * (RLS-bypass, the same choice as user-actions.integration.test.ts). Each test
 * uses a fresh key so cases don't collide.
 *
 * Pins: read-miss → null; write→read round-trip; ON CONFLICT (key) upsert
 * (last write wins, distinct timestamps); explicit vs default markedAtMs; that
 * keys are independent (no cross-key bleed).
 *
 * Part of whole-app-test-coverage-breadth (integration tier).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ db: null as unknown }));

// readCooldownMark / writeCooldownMark both destructure `db` (drizzle) from
// getOrgPg. Point it at the fixture admin client.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ db: h.db }) };
});

const { readCooldownMark, writeCooldownMark } = await import('./cooldown-marks');
const { createOrgTestDb } = await import('../test/_org-test-db');

let n = 0;
const freshKey = () => `cd_${++n}_${randomBytes(3).toString('hex')}`;

describe('cooldown-marks (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.db = drizzle(db.adminSql);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('readCooldownMark returns null for an unknown key', async () => {
    expect(await readCooldownMark(freshKey())).toBeNull();
  });

  it('writes a mark and reads the exact millisecond timestamp back', async () => {
    const key = freshKey();
    const at = 1_700_000_000_123;
    await writeCooldownMark(key, at);
    expect(await readCooldownMark(key)).toBe(at);
  });

  it('defaults markedAtMs to "now" when not given', async () => {
    const key = freshKey();
    const before = Date.now();
    await writeCooldownMark(key);
    const got = await readCooldownMark(key);
    const after = Date.now();
    expect(got).not.toBeNull();
    expect(got!).toBeGreaterThanOrEqual(before);
    expect(got!).toBeLessThanOrEqual(after);
  });

  it('ON CONFLICT (key) upserts — the last write wins', async () => {
    const key = freshKey();
    await writeCooldownMark(key, 1000);
    expect(await readCooldownMark(key)).toBe(1000);
    // Re-stamp the same key with a later mark → overwrite.
    await writeCooldownMark(key, 2000);
    expect(await readCooldownMark(key)).toBe(2000);
    // A re-stamp to an EARLIER value also wins (unconditional overwrite, not a max()).
    await writeCooldownMark(key, 500);
    expect(await readCooldownMark(key)).toBe(500);
    // Still exactly one row for the key.
    const rows = await db.adminSql`
      SELECT 1 FROM harness_shared.cooldown_marks WHERE key = ${key}`;
    expect(rows).toHaveLength(1);
  });

  it('keys are independent — a write to one never bleeds into another', async () => {
    const a = freshKey();
    const b = freshKey();
    await writeCooldownMark(a, 111);
    await writeCooldownMark(b, 222);
    expect(await readCooldownMark(a)).toBe(111);
    expect(await readCooldownMark(b)).toBe(222);
  });
});
