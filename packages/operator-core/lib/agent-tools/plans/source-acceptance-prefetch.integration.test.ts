import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, calls: 0, failNext: false }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  withWorkspace: async <T>(workspace: string, fn: (sql: Sql) => Promise<T>) => {
    h.calls++;
    if (h.failNext) { h.failNext = false; throw new Error('prefetch unavailable'); }
    return h.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return fn(tx as unknown as Sql);
    });
  },
}));

import { readPlanBySlug } from './source';
import { gatherPlanLifecycleSignals, readActiveAcceptanceRubrics } from './plan-lifecycle-derivation';

let db: OrgTestDb;
const slug = 'prefetch-subject';
beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.appSql;
  for (const workspace of ['prefetch-a', 'prefetch-b']) {
    const content = `---\nslug: ${slug}\ntitle: Prefetch subject\nstatus: ready\n---\n\n## Now\n\nReady.\n`;
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, content, content_hash, status)
      VALUES (${workspace}, 'papercusp', ${slug}, ${content}, md5(${content}), 'ready')`;
    for (const [suffix, status, archived, templateSlug] of [
      ['live', 'active', false, null], ['draft', 'draft', false, null],
      ['archived', 'active', true, null], ['instance', 'active', false, 'parent'],
    ] as const) {
      await db.adminSql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, content, content_hash, status, archived, template, template_slug, template_data)
        VALUES (${workspace}, 'papercusp', ${`${workspace}-${suffix}`}, '', '', ${status}, ${archived},
          'rubric', ${templateSlug}, ${JSON.stringify({ kind: 'acceptance', subjectPlan: slug })}::jsonb)`;
    }
  }
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(() => { h.calls = 0; h.failNext = false; });

describe('source acceptance prefetch under the app role', () => {
  it.each(['prefetch-a', 'prefetch-b'])('reuses one scoped source transaction for %s and preserves lifecycle semantics', async (workspaceId) => {
    const expected = await readActiveAcceptanceRubrics({ workspaceId, planSlugs: [slug] });
    const ordinary = await readPlanBySlug(slug, { workspaceId });
    h.calls = 0;
    const result = await readPlanBySlug(slug, { workspaceId, prefetchAcceptance: true });
    expect(result?.row.activeAcceptanceRubricRef).toBe(`${workspaceId}-live`);
    expect(result?.row.activeAcceptanceRubricRef).toBe(expected.get(slug));
    const unexpectedLookup = vi.fn(async () => { throw new Error('duplicate transaction'); });
    const signals = await gatherPlanLifecycleSignals({ workspaceId, planSlug: slug,
      acceptanceRubricRef: result!.row.activeAcceptanceRubricRef, readAcceptance: unexpectedLookup });
    expect(signals.acceptance).toEqual({ rubricActive: true, rubricRef: `${workspaceId}-live` });
    expect(unexpectedLookup).not.toHaveBeenCalled();
    expect(h.calls).toBe(1);
    const { activeAcceptanceRubricRef: _ref, ...row } = result!.row;
    expect({ ...result, row }).toEqual(ordinary);
  });

  it('reports measured absence without querying again', async () => {
    await db.adminSql`UPDATE harness_shared.harness_plans SET archived = true
      WHERE workspace_id = 'prefetch-a' AND plan_slug = 'prefetch-a-live'`;
    const result = await readPlanBySlug(slug, { workspaceId: 'prefetch-a', prefetchAcceptance: true });
    expect(result?.row.activeAcceptanceRubricRef).toBeNull();
    expect(h.calls).toBe(1);
  });

  it('falls back to an ordinary source read without inventing a measured absence', async () => {
    h.failNext = true;
    const result = await readPlanBySlug(slug, { workspaceId: 'prefetch-b', prefetchAcceptance: true });
    expect(result?.row.activeAcceptanceRubricRef).toBeUndefined();
    expect(h.calls).toBe(2);
    const signals = await gatherPlanLifecycleSignals({ workspaceId: 'prefetch-b', planSlug: slug,
      acceptanceRubricRef: result!.row.activeAcceptanceRubricRef });
    expect(signals.acceptance).toEqual({ rubricActive: true, rubricRef: 'prefetch-b-live' });
    expect(h.calls).toBe(3);
  });
});
