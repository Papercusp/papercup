/**
 * brain-pin.integration.test.ts — the canonical BRAIN session pointer
 * (`harness_shared.operator_settings` key `brain_session_id`) against real
 * Postgres. The desktop chat dock resumes exactly this native uuid on launch,
 * so the upsert-one-row / read-or-null contract is worth a real-schema test.
 *
 * Routes through `getOrgPg().sql` (raw postgres-js), mocked to the fixture's
 * admin client — the established org-fixture pattern.
 *
 * Validates: set→get round-trip, upsert (last write wins, one row), unset reads
 * null, and a whitespace-only / empty value reads back as null (the `.trim() || null`).
 *
 * Part of whole-app-test-coverage-breadth-2026-06-14 P-006 (integration tier).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));

const { setBrainSession, getBrainSession, BRAIN_SESSION_KEY } = await import('./brain-pin');
const { createOrgTestDb } = await import('../test/_org-test-db');

describe('brain-pin (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // Each test re-keys via the same single row; clear between for isolation.
  async function clearPin() {
    await db.adminSql`DELETE FROM harness_shared.operator_settings WHERE key = ${BRAIN_SESSION_KEY}`;
  }

  it('reads null when no brain is pinned', async () => {
    await clearPin();
    expect(await getBrainSession()).toBeNull();
  });

  it('pins a native session uuid and reads it back', async () => {
    await clearPin();
    await setBrainSession('sess-abc-123');
    expect(await getBrainSession()).toBe('sess-abc-123');
  });

  it('upsert is last-write-wins on the single row', async () => {
    await clearPin();
    await setBrainSession('sess-first');
    await setBrainSession('sess-second');
    expect(await getBrainSession()).toBe('sess-second');
    const rows = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.operator_settings WHERE key = ${BRAIN_SESSION_KEY}`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('a whitespace-only pinned value reads back as null', async () => {
    await clearPin();
    await setBrainSession('   ');
    expect(await getBrainSession()).toBeNull();
  });
});
