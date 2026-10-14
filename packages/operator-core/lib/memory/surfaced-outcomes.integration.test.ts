import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { stampSurfaced, _resetSessionEpochLedgerForTests } from './session-epoch-ledger';
import { loadOutcomeCounts, recordSurfacedOutcome } from './surfaced-outcomes';

describe('surfaced outcomes on PostgreSQL', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    // Until the whole feature is ready to arm, exercise its draft migration in
    // this isolated database, never the shared runtime schema.
    const migration = readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1514-governed-memory-anchors-and-outcomes.sql.DRAFT', import.meta.url), 'utf8');
    await db.adminSql.unsafe(migration.replace(/^\\set.*$/gm, '').replace(/^(BEGIN|COMMIT);$/gm, ''));
    _resetSessionEpochLedgerForTests();
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  it('records used only after surfacing in the same session and keeps repeated fetches idempotent', async () => {
    const id = randomUUID();
    await db.adminSql`INSERT INTO harness_shared.memory_canonical(id, payload) VALUES (${id}, '{}'::jsonb)`;
    await recordSurfacedOutcome(db.adminSql, 'reader', [id], 'used');
    expect((await loadOutcomeCounts(db.adminSql, [id])).get(id)).toEqual({ used: 0, contradicted: 0 });
    expect(await stampSurfaced(db.adminSql, 'reader', 0, [id], 'test')).toBe(true);
    await recordSurfacedOutcome(db.adminSql, 'another-session', [id], 'contradicted');
    await Promise.all(Array.from({ length: 4 }, () => recordSurfacedOutcome(db.adminSql, 'reader', [id], 'used')));
    expect((await loadOutcomeCounts(db.adminSql, [id])).get(id)).toEqual({ used: 1, contradicted: 0 });
  });

  it('records contradicted after same-session supersession/update/forget and never lets a fetch erase it', async () => {
    for (const action of ['supersedes', 'updates', 'forgets']) {
      const id = randomUUID();
      await db.adminSql`INSERT INTO harness_shared.memory_canonical(id, payload) VALUES (${id}, '{}'::jsonb)`;
      await stampSurfaced(db.adminSql, action, 0, [id], 'test');
      await recordSurfacedOutcome(db.adminSql, action, [id], 'used');
      await Promise.all(Array.from({ length: 3 }, () => recordSurfacedOutcome(db.adminSql, action, [id], 'contradicted')));
      await recordSurfacedOutcome(db.adminSql, action, [id], 'used');
      expect((await loadOutcomeCounts(db.adminSql, [id])).get(id)).toEqual({ used: 0, contradicted: 1 });
      const rows = await db.adminSql`SELECT outcome FROM harness_shared.memory_session_surfaced WHERE memory_id = ${id}`;
      expect(rows[0]?.outcome).toBe('contradicted');
    }
  });

  it('keeps cumulative per-memory counts after ledger GC', async () => {
    const id = randomUUID();
    await db.adminSql`INSERT INTO harness_shared.memory_canonical(id, payload) VALUES (${id}, '{}'::jsonb)`;
    for (const session of ['one', 'two']) {
      await stampSurfaced(db.adminSql, session, 0, [id], 'test');
      await recordSurfacedOutcome(db.adminSql, session, [id], 'contradicted');
    }
    await db.adminSql`DELETE FROM harness_shared.memory_session_surfaced WHERE memory_id = ${id}`;
    expect((await loadOutcomeCounts(db.adminSql, [id])).get(id)).toEqual({ used: 0, contradicted: 2 });
  });
});
