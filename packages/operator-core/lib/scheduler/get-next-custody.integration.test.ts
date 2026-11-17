/** Actual scheduler claim writers against private migrated PG and draft capture. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { FLAGS, FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';

const fixture = vi.hoisted(() => ({ sql: null as unknown }));
const WS = 'ws-scheduler-custody';
const HARNESS = 'papercup';
const OWNER = 'su-scheduler-custody';

vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<object>()), getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../workspace-registry', async (original) => ({
  ...(await original<object>()), activeWorkspaceId: () => WS,
}));
vi.mock('@papercusp/flags/server', async (original) => ({
  ...(await original<object>()),
  getFlag: async (key: FlagKey) => key === FLAGS.SCHEDULER_ISSUES_CLAIMABLE
    || key === FLAGS.ISSUES_PER_WORKSPACE ? true
    : key === FLAGS.SCHEDULER_MAINTAINED_READY ? false : (FLAG_DEFAULTS[key] ?? false),
}));

const { getNextWorkItem } = await import('./get-next');
const { DEFAULT_CLAIM_SPEC } = await import('./claim-spec');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { applyClaimPathReadDeps } = await import('../../test/_work-items-schema');
let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  fixture.sql = sql;
  await applyClaimPathReadDeps((ddl) => sql.unsafe(ddl).simple());
  // Apply only inside this disposable fixture; the production draft stays unarmed.
  await sql.unsafe(await readFile(new URL(
    '../../../../libs/papercusp/libs/db/sql/1643-work-item-custody-audit-capture.sql.DRAFT', import.meta.url,
  ), 'utf8'));
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
});

async function seed(id: string, family: 'feature' | 'issue', owner: string | null = null) {
  await sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by,
     created_ts, updated_ts, origin)
    VALUES (${WS}, ${HARNESS}, ${id}, ${family === 'feature' ? 'feature' : 'bug'},
      ${id}, 'open', ${owner}, 1, 1, 'local')`;
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

const claim = () => getNextWorkItem(DEFAULT_CLAIM_SPEC, { assignee: OWNER }, {
  harness: HARNESS, workspaceId: WS, client: sql,
});

describe('draft 1643 — actual scheduler caller capture', () => {
  it.each(['feature', 'issue'] as const)('%s: captures one claim and preserves peer custody', async family => {
    const id = `${family}-scheduler-positive`;
    const peer = `${family}-scheduler-held`;
    await seed(id, family);
    await seed(peer, family, 'su-existing-peer');
    const before = await receipts(id);
    const peerRow = await row(peer);
    const peerReceipts = await receipts(peer);

    const result = await claim();
    expect(result?.workItem.id).toBe(id);
    expect(await row(id)).toMatchObject({ taken_by: OWNER });
    const captured = (await receipts(id)).slice(before.length);
    expect(captured.filter(r => r.details.before?.taken_by !== r.details.after?.taken_by)
      .map(r => [r.details.before?.taken_by, r.details.after?.taken_by])).toEqual([[null, OWNER]]);
    expect(captured.at(-1)?.details.eventId).toEqual(expect.any(String));
    expect(await row(peer)).toEqual(peerRow);
    expect(await receipts(peer)).toEqual(peerReceipts);
    const after = await receipts(id);
    expect(await claim()).toBeNull();
    expect(await receipts(id)).toEqual(after);
  });

  it.each(['feature', 'issue'] as const)('%s: capture rejection rolls back claim and permits recovery', async family => {
    const id = `${family}-scheduler-refused`;
    await seed(id, family);
    const beforeRow = await row(id);
    const before = await receipts(id);
    await sql.unsafe(`ALTER TABLE harness_shared.audit_log ADD CONSTRAINT refuse_scheduler_capture
      CHECK (action <> 'work_items:custody:capture' OR subject <> '${id}') NOT VALID`);
    try {
      await expect(claim()).rejects.toThrow('refuse_scheduler_capture');
    } finally {
      await sql`ALTER TABLE harness_shared.audit_log DROP CONSTRAINT refuse_scheduler_capture`;
    }
    expect(await row(id)).toEqual(beforeRow);
    expect(await receipts(id)).toEqual(before);
    expect((await claim())?.workItem.id).toBe(id);
    expect(await row(id)).toMatchObject({ taken_by: OWNER });
    expect((await receipts(id)).slice(before.length)
      .filter(r => r.details.before?.taken_by !== r.details.after?.taken_by)
      .map(r => [r.details.before?.taken_by, r.details.after?.taken_by])).toEqual([[null, OWNER]]);
  });
});
