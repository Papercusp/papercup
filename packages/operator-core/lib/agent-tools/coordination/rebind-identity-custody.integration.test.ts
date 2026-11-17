/** Actual identity-rebind custody writes, with the unarmed draft in private PG. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { rebindIdentity } from './rebind-identity';

const WS = 'ws-rebind-custody';
const HARNESS = 'papercup';
const FROM = 'su-rebind-custody-predecessor';
const TO = 'su-rebind-custody-successor';
let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  // Fixture-only characterization; this neither arms production nor authenticates an agent.
  await sql.unsafe(await readFile(new URL(
    '../../../../../libs/papercusp/libs/db/sql/1643-work-item-custody-audit-capture.sql.DRAFT', import.meta.url,
  ), 'utf8'));
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
});

async function seed(id: string, family: 'feature' | 'issue', terminal = false) {
  await sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by,
     taken_at, origin, created_ts, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${id}, ${family === 'feature' ? 'feature' : 'bug'}, ${id},
      ${terminal ? (family === 'feature' ? 'done' : 'resolved') : 'wip'},
      ${FROM}, now(), 'local', 1, 1)`;
}

async function row(id: string) {
  const [result] = await sql<{ data: Record<string, unknown> }[]>`
    SELECT to_jsonb(w) - '_search' AS data FROM harness_shared.work_items w
    WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return result!.data;
}

async function receipts(id: string) {
  return sql<{ details: {
    eventId: string; before: { taken_by: string | null } | null;
    after: { taken_by: string | null } | null;
  } }[]>`SELECT details FROM harness_shared.audit_log
    WHERE workspace_id = ${WS} AND subject = ${id}
      AND action = 'work_items:custody:capture' ORDER BY ts, id`;
}

function edges(rows: Awaited<ReturnType<typeof receipts>>) {
  return rows.filter(r => r.details.before?.taken_by !== r.details.after?.taken_by)
    .map(r => [r.details.before?.taken_by, r.details.after?.taken_by]);
}
const rebind = () => rebindIdentity(FROM, TO, {
  sql, resolveLiveness: async () => ({ sessionState: 'ended', heartbeatFresh: true }),
});

describe('draft 1643 — actual identity rebind custody capture', () => {
  it('captures both compatibility and base writes, preserves terminal history, and is idempotent', async () => {
    for (const family of ['feature', 'issue'] as const) {
      await seed(`${family}-rebind-positive`, family);
      await seed(`${family}-rebind-terminal`, family, true);
    }
    const ids = ['feature-rebind-positive', 'issue-rebind-positive'];
    const terminalIds = ['feature-rebind-terminal', 'issue-rebind-terminal'];
    const before = await Promise.all(ids.map(receipts));
    const terminalRows = await Promise.all(terminalIds.map(row));
    const terminalReceipts = await Promise.all(terminalIds.map(receipts));

    const result = await rebind();
    expect(result.refused).toBeUndefined();
    expect(result.surfaces.find(s => s.surface === 'held-items')).toMatchObject({ moved: 1, error: undefined });
    expect(result.surfaces.find(s => s.surface === 'held-work-items')).toMatchObject({ moved: 1, error: undefined });
    for (const [index, id] of ids.entries()) {
      expect(await row(id)).toMatchObject({ taken_by: TO });
      const captured = (await receipts(id)).slice(before[index]!.length);
      expect(edges(captured)).toEqual([[FROM, TO]]);
      expect(captured.at(-1)?.details.eventId).toEqual(expect.any(String));
    }
    expect(await Promise.all(terminalIds.map(row))).toEqual(terminalRows);
    expect(await Promise.all(terminalIds.map(receipts))).toEqual(terminalReceipts);
    const after = await Promise.all(ids.map(receipts));
    const repeated = await rebind();
    expect(repeated.surfaces.filter(s => ['held-items', 'held-work-items'].includes(s.surface))
      .map(s => s.moved)).toEqual([0, 0]);
    expect(await Promise.all(ids.map(receipts))).toEqual(after);
  });

  it.each(['feature', 'issue'] as const)('%s: preserves rejected statements, reports partial surfaces, then recovers', async rejectedFamily => {
    const ids = ['feature-rebind-refused', 'issue-rebind-refused'];
    await seed(ids[0]!, 'feature');
    await seed(ids[1]!, 'issue');
    const refusedId = `${rejectedFamily}-rebind-refused`;
    const beforeRows = await Promise.all(ids.map(row));
    const before = await Promise.all(ids.map(receipts));
    await sql.unsafe(`ALTER TABLE harness_shared.audit_log ADD CONSTRAINT refuse_rebind_capture
      CHECK (action <> 'work_items:custody:capture' OR subject <> '${refusedId}') NOT VALID`);
    let result: Awaited<ReturnType<typeof rebind>>;
    try {
      result = await rebind();
    } finally {
      await sql`ALTER TABLE harness_shared.audit_log DROP CONSTRAINT refuse_rebind_capture`;
    }
    expect(result.ok).toBe(false);
    expect(result.surfaces.find(s => s.surface === 'held-work-items')?.error).toContain('refuse_rebind_capture');
    expect(await row(refusedId)).toEqual(beforeRows[rejectedFamily === 'feature' ? 0 : 1]);
    expect(await receipts(refusedId)).toEqual(before[rejectedFamily === 'feature' ? 0 : 1]);
    if (rejectedFamily === 'feature') {
      // The earlier compatibility statement commits independently of the base statement.
      expect(await row(ids[1]!)).toMatchObject({ taken_by: TO });
      expect(edges((await receipts(ids[1]!)).slice(before[1]!.length))).toEqual([[FROM, TO]]);
      expect(result.surfaces.find(s => s.surface === 'held-items')?.moved).toBe(1);
    } else {
      // Both statements touch the rejected issue, so each rolls back its complete batch.
      expect(await Promise.all(ids.map(row))).toEqual(beforeRows);
      expect(await Promise.all(ids.map(receipts))).toEqual(before);
      expect(result.surfaces.find(s => s.surface === 'held-items')?.error).toContain('refuse_rebind_capture');
    }
    const recovered = await rebind();
    for (const surface of ['held-items', 'held-work-items']) {
      expect(recovered.surfaces.find(s => s.surface === surface)?.error).toBeUndefined();
    }
    for (const [index, id] of ids.entries()) {
      expect(await row(id)).toMatchObject({ taken_by: TO });
      expect(edges((await receipts(id)).slice(before[index]!.length))).toEqual([[FROM, TO]]);
    }
  });

  it('refuses a live protected predecessor without emitting a custody edge', async () => {
    const id = 'feature-rebind-live';
    await seed(id, 'feature');
    const beforeRow = await row(id);
    const before = await receipts(id);
    const result = await rebindIdentity(FROM, TO, {
      sql, resolveLiveness: async () => ({ sessionState: 'live', heartbeatFresh: true }),
    });
    expect(result).toMatchObject({ ok: false, refused: 'from_appears_live', surfaces: [] });
    expect(await row(id)).toEqual(beforeRow);
    expect(await receipts(id)).toEqual(before);
  });
});
