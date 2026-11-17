/** Actual stale-claim writers against private migrated PG, with draft capture. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: null as unknown }));
const WS = 'ws-stale-claims-custody';
const HARNESS = 'papercup';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('./degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  observeFallback: vi.fn(() => true),
}));
// External cleanup is observed separately from the real SQL/capture transaction.
vi.mock('./work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: () => false,
  releaseWorkItemLease: vi.fn(),
  releaseIssueClaimLease: vi.fn(),
  gcOrphanIssueLeases: vi.fn(),
}));
vi.mock('./work-item-lock-release', () => ({
  releaseReclaimedWorkItemLocks: vi.fn(async () => ({ failures: 0 })),
}));

const { reclaimStaleWorkItemClaims, reclaimStaleIssueClaims } = await import('./work-items-stale-claims');
const { releaseReclaimedWorkItemLocks } = await import('./work-item-lock-release');
const { createOrgTestDb } = await import('../test/_org-test-db');
let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  fixture.sql = sql;
  // Only this disposable fixture receives the unarmed draft. These controls
  // establish neither historical continuity nor authenticated agent identity.
  await sql.unsafe(await readFile(new URL(
    '../../../libs/papercusp/libs/db/sql/1643-work-item-custody-audit-capture.sql.DRAFT', import.meta.url,
  ), 'utf8'));
}, 120_000);

afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.coord_presence`;
  vi.mocked(releaseReclaimedWorkItemLocks).mockClear();
});

async function seed(id: string, family: 'feature' | 'issue', owner: string, live = false, status = 'wip') {
  await sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at)
    VALUES (${owner}, now() - make_interval(secs => ${live ? 1 : 7200}))
    ON CONFLICT (owner_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`;
  await sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, taken_at,
     requeue_count, origin, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${id}, ${family === 'feature' ? 'feature' : 'bug'}, ${id},
      ${status}, ${owner}, now() - interval '2 hours', 0, 'local', ${Date.now()})`;
}

async function row(id: string) {
  const [result] = await sql<{ data: Record<string, unknown> }[]>`
    SELECT to_jsonb(w) - '_search' AS data FROM harness_shared.work_items w
    WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return result!.data;
}

async function receipts(id: string) {
  return sql<{
    details: {
      eventId: string;
      before: { taken_by: string | null } | null;
      after: { taken_by: string | null } | null;
    };
  }[]>`SELECT details FROM harness_shared.audit_log
    WHERE workspace_id = ${WS} AND subject = ${id}
      AND action = 'work_items:custody:capture' ORDER BY ts, id`;
}

function transitions(rows: Awaited<ReturnType<typeof receipts>>) {
  return rows.filter(r => r.details.before?.taken_by !== r.details.after?.taken_by)
    .map(r => [r.details.before?.taken_by, r.details.after?.taken_by]);
}

async function refuseCapture(id: string, run: () => Promise<unknown>) {
  await sql.unsafe(`ALTER TABLE harness_shared.audit_log ADD CONSTRAINT refuse_stale_custody_capture
    CHECK (action <> 'work_items:custody:capture' OR subject <> '${id.replaceAll("'", "''")}') NOT VALID`);
  try {
    await expect(run()).rejects.toThrow('refuse_stale_custody_capture');
  } finally {
    await sql`ALTER TABLE harness_shared.audit_log DROP CONSTRAINT refuse_stale_custody_capture`;
  }
}

describe('draft 1643 — actual stale-claim sweep custody capture', () => {
  it.each(['feature', 'issue'] as const)('%s: records release, preserves live custody and does not repeat it', async family => {
    const id = `${family}-stale-positive`;
    const peer = `${family}-live-control`;
    const owner = `su-stale-${family}`;
    await seed(id, family, owner);
    await seed(peer, family, 'su-live-control', true);
    const before = await receipts(id);
    const peerRow = await row(peer);
    const peerReceipts = await receipts(peer);

    const result = await reclaimStaleWorkItemClaims(sql);
    expect(result.released).toEqual([expect.objectContaining({
      feature_id: id, former_taken_by: owner, former_status: 'wip',
      new_status: 'open', action: 'requeued', reason: 'dead', requeue_count: 1,
    })]);
    expect(await row(id)).toMatchObject({ taken_by: null, taken_at: null, status: 'open',
      requeue_count: 1, last_released_by: 'reaper:dead' });
    const after = await receipts(id);
    expect(transitions(after.slice(before.length))).toEqual([[owner, null]]);
    expect(after.at(-1)?.details.eventId).toEqual(expect.any(String));
    expect(await row(peer)).toEqual(peerRow);
    expect(await receipts(peer)).toEqual(peerReceipts);
    expect((await reclaimStaleWorkItemClaims(sql)).released).toEqual([]);
    expect(await receipts(id)).toEqual(after);
  });

  it.each(['feature', 'issue'] as const)('%s: capture rejection rolls back the complete sweep before cleanup, then recovers', async family => {
    const id = `${family}-stale-refused`;
    const healthy = `${family}-stale-healthy`;
    const owner = `su-refused-${family}`;
    await seed(id, family, owner);
    await seed(healthy, family, owner);
    const ids = [id, healthy];
    const beforeRows = await Promise.all(ids.map(row));
    const beforeReceipts = await Promise.all(ids.map(receipts));

    await refuseCapture(id, () => reclaimStaleWorkItemClaims(sql));
    expect(await Promise.all(ids.map(row))).toEqual(beforeRows);
    expect(await Promise.all(ids.map(receipts))).toEqual(beforeReceipts);
    expect(releaseReclaimedWorkItemLocks).not.toHaveBeenCalled();

    const recovered = await reclaimStaleWorkItemClaims(sql);
    expect(recovered.released.map(r => r.feature_id).sort()).toEqual(ids.sort());
    for (const [index, subject] of [id, healthy].entries()) {
      expect(await row(subject)).toMatchObject({ taken_by: null, status: 'open', requeue_count: 1 });
      expect(transitions((await receipts(subject)).slice(beforeReceipts[index]!.length)))
        .toEqual([[owner, null]]);
    }
    expect(releaseReclaimedWorkItemLocks).toHaveBeenCalledTimes(2);
  });

  it('issue compatibility writer captures the same base custody edge and preserves a live assignee', async () => {
    const id = 'issue-compat-stale';
    await seed(id, 'issue', 'su-issue-compat', false, 'open');
    await seed('issue-compat-live', 'issue', 'su-compat-live', true, 'open');
    const before = await receipts(id);
    const liveRow = await row('issue-compat-live');
    const liveReceipts = await receipts('issue-compat-live');

    const result = await reclaimStaleIssueClaims(sql);
    expect(result.released.map(r => r.issue_id)).toEqual([id]);
    expect(await row(id)).toMatchObject({ taken_by: null, last_released_by: 'reaper:dead' });
    expect(transitions((await receipts(id)).slice(before.length))).toEqual([['su-issue-compat', null]]);
    expect(await row('issue-compat-live')).toEqual(liveRow);
    expect(await receipts('issue-compat-live')).toEqual(liveReceipts);
    const after = await receipts(id);
    expect((await reclaimStaleIssueClaims(sql)).released).toEqual([]);
    expect(await receipts(id)).toEqual(after);
  });

  it('issue compatibility writer rolls back rejected custody and records recovery', async () => {
    const id = 'issue-compat-refused';
    await seed(id, 'issue', 'su-compat-refused', false, 'open');
    const beforeRow = await row(id);
    const before = await receipts(id);
    await refuseCapture(id, () => reclaimStaleIssueClaims(sql));
    expect(await row(id)).toEqual(beforeRow);
    expect(await receipts(id)).toEqual(before);
    expect((await reclaimStaleIssueClaims(sql)).released.map(r => r.issue_id)).toEqual([id]);
    expect(transitions((await receipts(id)).slice(before.length))).toEqual([['su-compat-refused', null]]);
  });
});
