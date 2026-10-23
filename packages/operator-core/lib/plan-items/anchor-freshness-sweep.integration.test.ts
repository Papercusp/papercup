import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlanItemAnchorMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { writePlanItemAnchors } from './anchor-store';
import { declarationContentHash, unknownAnchor, type PlanItemAnchor } from './anchors';
import { sweepPlanItemAnchors, type PlanAnchorNotice, type PlanAnchorSweepOptions } from './anchor-freshness-sweep';

const WS = 'anchor-sweep-fixture';
const HARNESS = 'anchor-sweep';
const PLAN = 'freshness-fixture';
const source = 'export function linked() { return 1; }';
let db: FreshPgDb;
let root: string;
let anchor: PlanItemAnchor;
let sent: PlanAnchorNotice[];
const scope = { workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN };

beforeAll(async () => {
  db = await createFreshPgDb('plan-anchor-sweep');
  // The real anchor migration grants these runtime roles; a fresh container has neither.
  await db.sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='harness_app') THEN CREATE ROLE harness_app; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin; END IF;
  END $$`);
  await applyPlanItemAnchorMigrationsForTest(db.sql);
  await db.sql.unsafe(`CREATE TABLE harness_shared.plan_items (
    workspace_id text NOT NULL,harness_slug text NOT NULL,plan_slug text NOT NULL,item_id text NOT NULL,status text NOT NULL,
    PRIMARY KEY(workspace_id,harness_slug,plan_slug,item_id))`);
  root = await mkdtemp(join(tmpdir(), 'plan-anchor-sweep-'));
  anchor = { ...unknownAnchor({ symbol: 'linked' }, 'no-snapshot'), symbolId: 'linked-id', symbolName: 'linked',
    path: 'code.ts', line: 1, resolution: 'resolved', unknownReason: null, freshness: 'fresh',
    contentHash: await declarationContentHash(source, { id: 'linked-id', name: 'linked', path: 'code.ts',
      line: 1, column: 17, sha256: '', signature: '', aliases: [], callers: [] }) };
}, 180_000);
beforeEach(async () => {
  sent = [];
  await db.sql`TRUNCATE harness_shared.plan_item_anchors,harness_shared.plan_anchor_notices,harness_shared.plan_items RESTART IDENTITY`;
  await writeFile(join(root, 'code.ts'), source);
});
afterAll(async () => {
  if (db) await db.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});
const options = (extra: Partial<PlanAnchorSweepOptions> = {}): PlanAnchorSweepOptions => ({
  ...scope, root, sql: db.sql, budgetMs: 5000, holders: async () => ['holder-open','holder-open'],
  notify: async notice => { sent.push(notice); return `message:${notice.id}`; }, ...extra,
});
async function seed(itemId: string, status = 'todo', links = [anchor]) {
  await db.sql`INSERT INTO harness_shared.plan_items(workspace_id,harness_slug,plan_slug,item_id,status)
    VALUES (${WS},${HARNESS},${PLAN},${itemId},${status})`;
  await db.sql.begin(tx => writePlanItemAnchors(tx, scope, { itemId, anchors: links }, 'fixture'));
}
async function rows() {
  return db.sql`SELECT item_id,freshness,stale_notice_id,last_check_ok FROM harness_shared.plan_item_anchors ORDER BY item_id`;
}

describe('bounded plan-anchor sweep on real Postgres', () => {
  it('groups newly stale links into one recorded notice, excludes terminal/path links, and deduplicates repeats', async () => {
    await seed('P-001');
    await seed('P-002');
    await seed('P-003', 'done');
    await seed('P-004', 'dropped');
    await seed('P-005', 'todo', [{ ...anchor, anchorKind: 'path' }]);
    await writeFile(join(root, 'code.ts'), source.replace('return 1', 'return 2'));
    const first = await sweepPlanItemAnchors(options());
    expect(first).toMatchObject({ scanned: 2, checked: 2, noticesCreated: 1, noticesDelivered: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ planSlug: PLAN, audience: [`@plan:${PLAN}`,'holder-open'] });
    expect(sent[0]!.anchorIds).toHaveLength(2);
    expect(await rows()).toEqual([
      expect.objectContaining({ item_id: 'P-001', freshness: 'stale', last_check_ok: false, stale_notice_id: Number(sent[0]!.id) }),
      expect.objectContaining({ item_id: 'P-002', freshness: 'stale', last_check_ok: false, stale_notice_id: Number(sent[0]!.id) }),
      expect.objectContaining({ item_id: 'P-003', freshness: 'fresh', stale_notice_id: null }),
      expect.objectContaining({ item_id: 'P-004', freshness: 'fresh', stale_notice_id: null }),
      expect.objectContaining({ item_id: 'P-005', freshness: 'fresh', stale_notice_id: null }),
    ]);
    const [record] = await db.sql`SELECT plan_slug,anchor_ids,audience,coord_message_id FROM harness_shared.plan_anchor_notices`;
    expect(record).toEqual({ plan_slug: PLAN, anchor_ids: sent[0]!.anchorIds, audience: sent[0]!.audience,
      coord_message_id: `message:${sent[0]!.id}` });
    expect(await sweepPlanItemAnchors(options())).toMatchObject({ noticesCreated: 0, noticesDelivered: 0 });
    expect(sent).toHaveLength(1);
  });
  it('persists a retryable notice before delivery, then replays it without creating another record', async () => {
    await seed('P-001');
    await writeFile(join(root, 'code.ts'), 'export const other = 1;');
    await expect(sweepPlanItemAnchors(options({ notify: async () => { throw new Error('delivery unavailable'); } })))
      .rejects.toThrow('delivery unavailable');
    const [before] = await db.sql`SELECT id::text,coord_message_id FROM harness_shared.plan_anchor_notices`;
    expect(before!.coord_message_id).toBeNull();
    expect(await sweepPlanItemAnchors(options())).toMatchObject({ noticesCreated: 0, noticesDelivered: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe(before!.id);
    expect(await rows()).toEqual([expect.objectContaining({ freshness: 'missing' })]);
  });
  it('rechecks terminal status after source inspection instead of changing an item closed during the sweep', async () => {
    await seed('P-001');
    await writeFile(join(root, 'code.ts'), source.replace('return 1', 'return 2'));
    await sweepPlanItemAnchors(options({ holders: async () => {
      await db.sql`UPDATE harness_shared.plan_items SET status='done' WHERE item_id='P-001'`;
      return ['holder-open'];
    } }));
    expect(await rows()).toEqual([expect.objectContaining({ freshness: 'fresh', stale_notice_id: null })]);
    expect(sent).toHaveLength(0);
  });
  it('serializes concurrent passes so one stale set produces one notice and one delivery', async () => {
    await seed('P-001');
    await writeFile(join(root, 'code.ts'), source.replace('return 1', 'return 2'));
    await Promise.all([sweepPlanItemAnchors(options()),sweepPlanItemAnchors(options())]);
    const records = await db.sql`SELECT id FROM harness_shared.plan_anchor_notices`;
    expect(records).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
  it('honors the per-pass cap and leaves unavailable repositories unchanged', async () => {
    await seed('P-001');
    await seed('P-002');
    expect(await sweepPlanItemAnchors(options({ cap: 1, root: join(root, 'unavailable') })))
      .toMatchObject({ scanned: 1, checked: 0, deferred: 1, noticesCreated: 0 });
    expect((await rows()).map(row => row.freshness)).toEqual(['fresh','fresh']);
  });
});
