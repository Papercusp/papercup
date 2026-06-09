/**
 * work-items-priority.integration.test.ts — the Queen's steer-don't-dispatch BACKLOG
 * priority lever against real Postgres (autoloop-pot-operator-rebuild B7 /
 * decentralized-dispatch-scaling D-003/D-004, P-009/P-010).
 *
 * Proves:
 *   • setWorkItemPriority / getWorkItemPriority round-trip `feature_order` (set, read, clear).
 *   • bumpWorkItemPriority { 'top' | 'bottom' } moves an item just past the current
 *     extreme; an empty/all-null backlog ⇒ 0.
 *   • claimNextWorkItem RESPECTS a just-set priority WHEN swarmId is passed (the
 *     per-Hive-lease path), and IGNORES it on the single-instance default — the
 *     steering→dispatch wiring (P-010), mirroring the affinity test.
 *   • issue-family items (bugs/changes) are a no-op (`applicable: false`) — they aren't
 *     the dispatched backlog.
 *   • the work_items:set_priority tool: read / explicit-set / clear / bump / not-found.
 *
 * Mirrors work-items-swarm-affinity.integration.test.ts's schema bootstrap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// HFC with feature_order (the backlog priority column) baked in.
const HFC_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    harness_slug text NOT NULL, feature_id text NOT NULL, title text, summary text,
    status text NOT NULL DEFAULT 'todo', attempts bigint DEFAULT 0,
    item_kind text NOT NULL DEFAULT 'feature', payload jsonb, parent_id text,
    taken_by text, taken_at timestamptz, workspace_id text NOT NULL DEFAULT 'default',
    swarm_affinity text,
    feature_order integer,
    ts bigint, created_ts bigint, updated_ts bigint,
    PRIMARY KEY (harness_slug, feature_id))`;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');
const setPriorityTool = (await import('./agent-tools/work_items/set_priority')).default;
const runSetPriority = async (args: Record<string, unknown>) =>
  JSON.parse(
    (
      await (
        setPriorityTool as unknown as {
          handler: (a: unknown, c: unknown) => Promise<{ content: { text: string }[] }>;
        }
      ).handler(args, { log() {}, workspaceId: 'default', role: 'operator' })
    ).content[0].text,
  );
const H = 'papercup';
let db: FreshPgDb;

async function seedFeature(
  id: string,
  opts: { createdTs?: number; order?: number | null; takenBy?: string | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, feature_order, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', 'todo', ${opts.takenBy ?? null}, ${opts.order ?? null}, 'default', ${opts.createdTs ?? 0}, 0)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-priority');
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  await db.sql.unsafe(readMigration('131-engineer-issues.sql')).simple();
  await db.sql.unsafe(readMigration('142-work-items-unify.sql')).simple();
  await db.sql.unsafe(readMigration('152-delegate-task-workitems.sql')).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.harness_features_consolidated
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    ALTER TABLE harness_shared.engineer_issues
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;`).simple();
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.harness_features_consolidated`;
  await db.sql`DELETE FROM harness_shared.engineer_issues`;
});

describe('setWorkItemPriority / getWorkItemPriority', () => {
  it('round-trips feature_order: set → read → clear', async () => {
    await seedFeature('F-1', { createdTs: 100 });
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBeNull();

    const set = await wi.setWorkItemPriority('F-1', 5, { harness: H });
    expect(set).toMatchObject({ id: 'F-1', priority: 5, applicable: true });
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBe(5);

    const cleared = await wi.setWorkItemPriority('F-1', null, { harness: H });
    expect(cleared).toMatchObject({ priority: null, applicable: true });
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBeNull();
  });

  it('returns null for a missing item', async () => {
    expect(await wi.setWorkItemPriority('F-nope', 1, { harness: H })).toBeNull();
    expect(await wi.getWorkItemPriority('F-nope', { harness: H })).toBeNull();
  });
});

describe('bumpWorkItemPriority', () => {
  it("'top'/'bottom' on an empty backlog ⇒ 0", async () => {
    await seedFeature('F-1', { createdTs: 100 });
    expect((await wi.bumpWorkItemPriority('F-1', 'top', { harness: H }))?.priority).toBe(0);
    // F-1 is now the only item with an order (0); 'bottom' relative to NO OTHERS ⇒ 0 again.
    expect((await wi.bumpWorkItemPriority('F-1', 'bottom', { harness: H }))?.priority).toBe(0);
  });

  it("'top' = min−1, 'bottom' = max+1 over the OTHER items", async () => {
    await seedFeature('F-1', { createdTs: 100, order: 10 });
    await seedFeature('F-2', { createdTs: 200, order: 20 });
    await seedFeature('F-3', { createdTs: 300 });

    const top = await wi.bumpWorkItemPriority('F-3', 'top', { harness: H });
    expect(top?.priority).toBe(9); // min(10,20) − 1

    const bottom = await wi.bumpWorkItemPriority('F-3', 'bottom', { harness: H });
    expect(bottom?.priority).toBe(21); // max(10,20) + 1 (F-3 itself excluded)
  });
});

describe('claimNextWorkItem honours the Queen priority only under the lease (P-010)', () => {
  it('IGNORES feature_order on the single-instance default (no swarmId) — oldest-first', async () => {
    await seedFeature('F-1', { createdTs: 100 }); // oldest, unprioritized
    await seedFeature('F-2', { createdTs: 200, order: -5 }); // newer but top-priority
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x' });
    expect(got?.id).toBe('F-1'); // priority NOT consulted without a swarmId
  });

  it('RESPECTS feature_order when swarmId is set (the per-Hive lease path)', async () => {
    await seedFeature('F-1', { createdTs: 100 }); // oldest, unprioritized (sorts last)
    await seedFeature('F-2', { createdTs: 200, order: -5 }); // newer but promoted
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x', swarmId: 's1' });
    expect(got?.id).toBe('F-2'); // lower feature_order wins over older created_ts
  });

  it('a claim now picks up an item the Queen just bumped to the top', async () => {
    await seedFeature('F-old', { createdTs: 100 });
    await seedFeature('F-hot', { createdTs: 999 }); // newest, would normally be claimed last
    await wi.bumpWorkItemPriority('F-hot', 'top', { harness: H });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x', swarmId: 's1' });
    expect(got?.id).toBe('F-hot');
  });
});

describe('issue-family is a no-op (not the dispatched backlog)', () => {
  it('returns applicable:false and writes nothing', async () => {
    await db.sql`
      INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, title)
      VALUES ('default', 'EI-1', 'a bug')`;
    const set = await wi.setWorkItemPriority('EI-1', 3, { harness: H });
    expect(set).toMatchObject({ id: 'EI-1', priority: null, applicable: false });
    const read = await wi.getWorkItemPriority('EI-1', { harness: H });
    expect(read).toMatchObject({ priority: null, applicable: false });
  });
});

describe('work_items:set_priority tool', () => {
  it('read mode reports the current backlog priority without writing', async () => {
    await seedFeature('F-1', { createdTs: 100, order: 7 });
    const r = await runSetPriority({ workItem: 'F-1', harness: H });
    expect(r).toMatchObject({ ok: true, mode: 'read', workItem: 'F-1', priority: 7, applicable: true });
  });

  it('explicit mode sets the order, and null clears it', async () => {
    await seedFeature('F-1', { createdTs: 100 });
    const set = await runSetPriority({ workItem: 'F-1', harness: H, priority: 3 });
    expect(set).toMatchObject({ ok: true, mode: 'set', action: 'set', priority: 3 });
    expect((await wi.getWorkItemPriority('F-1', { harness: H }))?.priority).toBe(3);

    const cleared = await runSetPriority({ workItem: 'F-1', harness: H, priority: null });
    expect(cleared).toMatchObject({ ok: true, action: 'clear', priority: null });
  });

  it('bump mode moves to the head of the backlog', async () => {
    await seedFeature('F-1', { createdTs: 100, order: 0 });
    await seedFeature('F-2', { createdTs: 200 });
    const r = await runSetPriority({ workItem: 'F-2', harness: H, position: 'top' });
    expect(r).toMatchObject({ ok: true, mode: 'bump', action: 'top', priority: -1 });
  });

  it('reports not-found for a missing item', async () => {
    const r = await runSetPriority({ workItem: 'F-nope', harness: H, priority: 1 });
    expect(r.ok).toBe(false);
  });
});
