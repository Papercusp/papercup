import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { createWorkItem, getWorkItem, type WorkItem } from '../../work-items';
import { DEFAULT_CLAIM_SPEC, FILTERABLE_ITEM_FIELDS, RANKABLE_ITEM_FIELDS, validateClaimSpec, type FilterNode } from '../../scheduler/claim-spec';
import { matchesWorkItemClaimSpec } from '../../scheduler/claim-spec-match';
import { compileFilter } from '../../scheduler/get-next';
import createTool from './create';
import getTool from './get';
import listTool, { shapeWorkItemsList } from './list';
import { bindSessionOutsidePlanRef } from '../../session-outside-plan';

const store = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: store.sql }),
  withWorkspace: (workspace: string, callback: (sql: postgres.Sql) => unknown) =>
    store.sql.begin(async tx => {
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
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));

let database: OrgTestDb;
beforeAll(async () => {
  database = await createOrgTestDb({ adminPoolMax: 4 });
  store.sql = database.adminSql;
  await store.sql`CREATE TABLE harness_shared.outside_creation_receipts (id text PRIMARY KEY)`;
}, 240_000);
afterAll(async () => { await database?.cleanup(); });

describe('outside-plan creation persistence', () => {
  it('shows each outside reference on compact lists while omitting the raw payload', async () => {
    const title = `Compact outside label ${randomUUID()}`;
    const ref = '  tracker:\n😀  ';
    const tagged = await Promise.all((['task', 'feature'] as const).map(kind =>
      createWorkItem({ kind, title, harness: 'papercusp', externalPlanRef: ref, payload: { other: 'private fixture marker' } })));
    const untagged = await createWorkItem({ kind: 'task', title, harness: 'papercusp' });
    for (const tier of ['trimmed', 'standard'] as const) {
      const read = await listTool.handler(listTool.args.parse({ harness: 'papercusp', q: title, audience: 'any' }), {
        workspaceId: 'default', harnessSlug: 'papercusp', uiClientId: 'su-outside-list', isSuperuser: true, contextTier: tier,
      } as Parameters<typeof listTool.handler>[1]);
      if (!('data' in read)) throw new Error('public list must return structured data');
      const rows = read.data as WorkItem[];
      expect(rows).toHaveLength(3);
      expect(rows.every(row => row.payload === null)).toBe(true);
      const shaped = shapeWorkItemsList(rows, tier);
      for (const { id } of tagged) expect(shaped).toContainEqual(expect.objectContaining({ id, external_plan_ref: ref }));
      expect(shaped).toContainEqual(expect.objectContaining({ id: untagged.id, external_plan_ref: null }));
    }
  });

  it('preserves selected references on bulk reads across both storage families', async () => {
    const refs = ['  issue\n😀  ', ' feature\tref '];
    const items = await Promise.all((['task', 'feature'] as const).map((kind, i) =>
      createWorkItem({ kind, title: `Projected ${kind} ${randomUUID()}`, harness: 'papercusp', externalPlanRef: refs[i] })));
    const ids = items.map(item => item.id);
    const args = getTool.args.parse({ ids, harness: 'papercusp' });
    const refPath = 'results[].workItem.externalPlanRef';
    const completionPath = 'results[].workItem.terminalCompletionEvidence';
    for (const fields of [[refPath], [refPath, completionPath], [completionPath, refPath]]) {
      const read = await getTool.handler(args, { workspaceId: 'default', harnessSlug: 'papercusp',
        uiClientId: 'su-outside-projection', isSuperuser: true,
        sourceProjection: { pick: ['results[].id', ...fields] } } as Parameters<typeof getTool.handler>[1]);
      if (!('data' in read)) throw new Error('public get must return structured data');
      const { results } = read.data as { results: Array<{ id: string; workItem: WorkItem }> };
      expect(results.map(row => [row.id, row.workItem.externalPlanRef])).toEqual(ids.map((id, i) => [id, refs[i]]));
    }
  });

  it.each(['   ', '\t\n', '😀'.repeat(200)])('round-trips inherited opaque reference through public create/read and claim filtering: %j', async ref => {
    const ownerId = `su-opaque-${randomUUID()}`;
    const [session] = await store.sql<{ id: number }[]>`INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, coord_owner_id, agent) VALUES ('default', 'console', ${ownerId}, 'codex') RETURNING id`;
    await bindSessionOutsidePlanRef({ ownerId, advSessionId: Number(session.id), workspaceId: 'default', planRef: ref });
    const ctx = { workspaceId: 'default', harnessSlug: 'papercusp', uiClientId: ownerId, isSuperuser: true };
    const args = createTool.args.parse({ kind: 'change', title: `Opaque public ${randomUUID()}`, harness: 'papercusp', force: true });
    const created = await createTool.handler(args, ctx as Parameters<typeof createTool.handler>[1]);
    if (!('data' in created)) throw new Error('public create must return structured data');
    const createdData = created.data as { results: Array<{ ok: boolean; id?: string; error?: string }> };
    expect(createdData.results[0].ok, JSON.stringify(createdData)).toBe(true);
    const id = createdData.results[0].id!;
    const read = await getTool.handler(getTool.args.parse({ id, harness: 'papercusp', detail: true }),
      ctx as Parameters<typeof getTool.handler>[1]);
    if (!('data' in read)) throw new Error('public get must return structured data');
    const data = read.data as { results: Array<{ workItem: WorkItem }> };
    expect(data.results[0].workItem.externalPlanRef).toBe(ref);
    const item = data.results[0].workItem;
    const spec = { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'external_plan_ref', op: '=' as const, value: ref } } };
    expect(matchesWorkItemClaimSpec(item, spec)).toBe(true);
    const rows = await store.sql<{ id: string }[]>`SELECT feature_id AS id FROM harness_shared.work_items
      WHERE feature_id = ${id} AND ${compileFilter(store.sql as never, spec.view.filter)}`;
    expect(rows.map(row => row.id)).toEqual([id]);
    const restarted = postgres(database.adminDsn, { max: 1, prepare: false });
    try {
      const [row] = await restarted<{ ref: string }[]>`SELECT payload->>'externalPlanRef' AS ref
        FROM harness_shared.work_items WHERE feature_id = ${id}`;
      expect(row.ref).toBe(ref);
    } finally { await restarted.end(); }
  });

  it.each(['task', 'feature'] as const)('commits %s and its dependent enrollment write together', async kind => {
    const ref = `tracker:${randomUUID()}`;
    const created = await createWorkItem({ kind, title: `Outside atomic ${randomUUID()}`, harness: 'papercusp',
      externalPlanRef: ref, onCreatedInTransaction: async (id, tx) => {
        // The new row is visible on this connection, and has not committed on another.
        expect(await tx`SELECT feature_id FROM harness_shared.work_items WHERE feature_id = ${id}`).toHaveLength(1);
        expect(await store.sql`SELECT feature_id FROM harness_shared.work_items WHERE feature_id = ${id}`).toHaveLength(0);
        await tx`INSERT INTO harness_shared.outside_creation_receipts (id) VALUES (${id})`;
      } });
    const restarted = postgres(database.adminDsn, { max: 1, prepare: false });
    try {
      expect(await restarted`SELECT id FROM harness_shared.outside_creation_receipts WHERE id = ${created.id}`).toHaveLength(1);
      const [row] = await restarted<{ ref: string }[]>`SELECT payload->>'externalPlanRef' AS ref
        FROM harness_shared.work_items WHERE feature_id = ${created.id}`;
      expect(row.ref).toBe(ref);
    } finally { await restarted.end(); }
    expect((await getWorkItem(created.id, 'papercusp'))?.externalPlanRef).toBe(ref);
  });

  it.each(['task', 'feature'] as const)('rolls back %s and the dependent write on failure, allowing a safe retry', async kind => {
    const title = `Outside rollback ${randomUUID()}`;
    let attemptedId = '';
    await expect(createWorkItem({ kind, title, harness: 'papercusp', externalPlanRef: 'tracker:X',
      onCreatedInTransaction: async (id, tx) => {
        attemptedId = id;
        await tx`INSERT INTO harness_shared.outside_creation_receipts (id) VALUES (${id})`;
        throw new Error('enrollment failed');
      } })).rejects.toThrow('enrollment failed');
    expect(attemptedId).not.toBe('');
    expect(await store.sql`SELECT feature_id FROM harness_shared.work_items WHERE title = ${title}`).toHaveLength(0);
    expect(await store.sql`SELECT id FROM harness_shared.outside_creation_receipts WHERE id = ${attemptedId}`).toHaveLength(0);
    const retry = await createWorkItem({ kind, title, harness: 'papercusp', externalPlanRef: 'tracker:X' });
    expect((await getWorkItem(retry.id, 'papercusp'))?.externalPlanRef).toBe('tracker:X');
  });

  it('filters both families by full opaque reference with matching SQL/JS and no stray claims', async () => {
    expect(FILTERABLE_ITEM_FIELDS).toContain('external_plan_ref');
    expect(RANKABLE_ITEM_FIELDS).not.toContain('external_plan_ref');
    const label = `Outside filter ${randomUUID()}`;
    const items: WorkItem[] = [];
    const refs = ['X'.repeat(199), 'X'.repeat(200), 'X'.repeat(201), '   ', '😀'.repeat(200), `  tracker/組織\n${'segment/'.repeat(100)}  `];
    for (const kind of ['task', 'feature'] as const) {
      for (const ref of refs) {
        const created = await createWorkItem({ kind, title: label, harness: 'papercusp', externalPlanRef: ref });
        items.push((await getWorkItem(created.id, 'papercusp'))!);
      }
      for (const ref of [undefined, 42, '', '\t\n', '\u00a0\ufeff']) {
        const created = await createWorkItem({ kind, title: label, harness: 'papercusp', payload: { externalPlanRef: ref } });
        items.push((await getWorkItem(created.id, 'papercusp'))!);
      }
    }
    const filters: FilterNode[] = [
      ...refs.map(ref => ({ field: 'external_plan_ref', op: '=' as const, value: ref })),
      { field: 'external_plan_ref', op: 'in', value: [refs[1], refs[3]] },
      { not: { field: 'external_plan_ref', op: '=', value: refs[1] } },
      { field: 'external_plan_ref', op: '!=', value: refs[3] },
    ];
    for (const filter of filters) {
      const spec = { ...DEFAULT_CLAIM_SPEC, view: { filter } };
      expect(validateClaimSpec(spec).ok).toBe(true);
      const rows = await store.sql<{ id: string }[]>`SELECT feature_id AS id FROM harness_shared.work_items
        WHERE title = ${label} AND ${compileFilter(store.sql as never, filter)}`;
      const expected = items.filter(item => matchesWorkItemClaimSpec(item, spec)).map(item => item.id).sort();
      expect(rows.map(row => row.id).sort()).toEqual(expected);
      if ('field' in filter && filter.op === '=') expect(rows).toHaveLength(2);
    }
  });
});
