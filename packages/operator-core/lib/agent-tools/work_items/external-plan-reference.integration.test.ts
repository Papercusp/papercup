import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { buildWorkItemsPredicate, normalizeWorkItemsListArgs, readWorkItemsPageFromStore } from '../../sync-resolver/work-items-list-query';
import { projectWorkItemsListForUi } from '../../sync-resolver/work-items-ui-projection';
import { CREATE_RECEIPT, COMPLETE_RECEIPT, toWorkItemReceipt } from './receipt';
import { shapeWorkItemsList } from './list';
import { createWorkItem, getWorkItem } from '../../work-items';
import createTool from './create';
import { hydrateHandoffItemBodies } from '../coordination/tools/handoff';

const privateStore = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: privateStore.sql }),
  withWorkspace: (workspace: string, callback: (sql: postgres.Sql) => unknown) =>
    privateStore.sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(tx as unknown as postgres.Sql);
    }),
}));
vi.mock('../../workspace-registry', async original => ({
  ...await original<typeof import('../../workspace-registry')>(), activeWorkspaceId: () => 'default',
}));
vi.mock('../../events', async original => ({
  ...await original<typeof import('../../events')>(), fireReactionInProcess: async () => ({ ok: true }),
}));

let database: OrgTestDb;
beforeAll(async () => {
  database = await createOrgTestDb({ adminPoolMax: 4 });
  privateStore.sql = database.adminSql;
}, 240_000);
afterAll(async () => { await database?.cleanup(); });

describe('external plan item references', () => {
  it('round-trips both work-item families through the store, receipts and list views', async () => {
    for (const kind of ['task', 'feature'] as const) {
      const ref = `  Planner/組織#${randomUUID()}\n${'segment/'.repeat(25)}  `;
      const title = `External plan ${kind} ${randomUUID()}`;
      expect(createTool.args.parse({ kind, title, external_plan_ref: ref })).toMatchObject({ external_plan_ref: ref });
      expect(createTool.args.parse({ items: [{ kind, title, external_plan_ref: ref }] })).toMatchObject({
        items: [{ external_plan_ref: ref }],
      });
      const created = await createWorkItem({ kind, title, harness: 'papercusp', workspaceId: 'default',
        externalPlanRef: ref, payload: { fixture: 'retained' } });
      const item = await getWorkItem(created.id, 'papercusp');
      expect(item).toMatchObject({ externalPlanRef: ref, payload: { fixture: 'retained', externalPlanRef: ref } });
      expect(item?.sourcePlanSlug).toBeNull();
      for (const format of [CREATE_RECEIPT, COMPLETE_RECEIPT]) {
        expect(toWorkItemReceipt(item!, format)).toMatchObject({ externalPlanRef: ref });
      }
      for (const tier of ['standard', 'trimmed'] as const) {
        expect(shapeWorkItemsList([item], tier)).toMatchObject([{ external_plan_ref: ref, plan_ref: null }]);
      }
    }
    const bare = await createWorkItem({ kind: 'task', title: `Ordinary item ${randomUUID()}`, harness: 'papercusp' });
    expect((await getWorkItem(bare.id, 'papercusp'))?.externalPlanRef).toBeUndefined();
    expect(() => createTool.args.parse({ kind: 'task', title: 'Invalid', external_plan_ref: '  ' })).toThrow();
  });

  it('delivers intact external identities through a planless work-item handoff beyond the first batch', async () => {
    const items = [];
    for (let i = 0; i < 4; i++) {
      items.push(await createWorkItem({ kind: 'task', harness: 'papercusp', title: `Handoff ${randomUUID()}`,
        externalPlanRef: `outside/${i}/"quoted"\n${'segment/'.repeat(40)}` }));
    }
    const handoff = await hydrateHandoffItemBodies({ harness: 'papercusp', items: items.map(item => item.id) });
    expect(handoff.itemsHydrated).toBe(items.length);
    for (const item of items) {
      expect(handoff.body).toContain(item.id);
      expect(handoff.body).toContain(`externalPlanRef=${JSON.stringify(item.externalPlanRef)}`);
    }
  });

  it.each([1, 2, 3, 7])('recovers all %i opaque references across restarted two-row page reads', async count => {
    const label = `External page ${randomUUID()}`;
    const expected = new Map<string, string>();
    for (let i = 0; i < count; i++) {
      const ref = `tracker:item/路径/${count - i}\n${'long-ref/'.repeat(120)}`;
      const item = await createWorkItem({ kind: 'task', title: `${label} ${i}`, harness: 'papercusp', externalPlanRef: ref });
      expected.set(item.id, ref);
    }
    const seen = new Map<string, string>();
    let cursor: string | null = null;
    do {
      // Reopen the database client for every page. Only the wire cursor crosses the boundary.
      const sql = postgres(database.adminDsn, { max: 1, prepare: false });
      try {
        const args = normalizeWorkItemsListArgs({ harnessSlug: 'papercusp', q: label, limit: 2, cursor });
        const page = await readWorkItemsPageFromStore(sql, 'default', buildWorkItemsPredicate(args));
        expect(page.rows.length).toBeGreaterThan(0);
        expect(page.rows.length).toBeLessThanOrEqual(2);
        const projected = projectWorkItemsListForUi(page.rows);
        for (const [index, row] of page.rows.entries()) {
          expect(seen.has(row.id)).toBe(false);
          expect(row.externalPlanRef).toBe(expected.get(row.id));
          expect(projected[index]).toMatchObject({ id: row.id, externalPlanRef: row.externalPlanRef });
          seen.set(row.id, row.externalPlanRef!);
        }
        expect(page.hasMore).toBe(seen.size < expected.size);
        expect(Boolean(page.nextCursor)).toBe(page.hasMore);
        cursor = page.nextCursor;
      } finally {
        await sql.end();
      }
    } while (cursor);
    expect(seen).toEqual(expected);
  });
});
