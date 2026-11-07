/** R-2: canonical schedule admission against a disposable, migrated Postgres. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown as Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(workspace: string, fn: (sql: Sql) => Promise<T>) => h.sql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
    return fn(tx as unknown as Sql);
  }),
}));
vi.mock('./agent-tools/plans/_ctx-opts', () => ({
  ctxToPlanSourceOpts: async () => ({ workspaceId: 'grading-cadence-private', harnessSlug: 'papercusp' }),
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...(await original<typeof import('@papercusp/flags/server')>()), getFlag: async () => true,
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const { proposeRubric, getRubric } = await import('./rubrics');
const { runWithWorkspace } = await import('./workspace-als');
const { SQL_PROBE_TOOL, continuityProbeRevision } = await import('./continuity-probes');
await import('./agent-tools/dev/pg_query');
const setSchedule = (await import('./agent-tools/plans/set-schedule')).default;
const armSchedule = (await import('./agent-tools/plans/arm-schedule')).default;
const { runRubricRescoreAction } = await import('./harness/routines/rubric-rescore-action');

const WS = 'grading-cadence-private';
const SLUG = 'private-grading-cadence';
const REF = 'private-grading-cadence-policy';
let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); h.sql = db.adminSql; });
afterAll(async () => { await db?.cleanup(); });

function body(result: unknown): any {
  const value = result as { content: Array<{ text: string }> };
  return JSON.parse(value.content[0]!.text);
}

async function policy(maxAgeMs: number) {
  await proposeRubric({ rubricId: REF, title: 'Private cadence policy', characteristic: 'cadence',
    status: 'active', by: 'su-fixture', criteria: [{ key: 'health', title: 'Health',
      model: 'A current private database reading.', method: 'Read one private row.', driftMarkers: 'Expired evidence.',
      check: { kind: 'probe', maxAgeMs, probe: { kind: 'sql', sql: 'SELECT 1 AS value',
        schemaRevision: continuityProbeRevision(SQL_PROBE_TOOL)!, expect: { path: '$.rows[0].value', op: 'eq', value: 1 } } } }] });
}

it('grading schedule set arm and fire revalidate current persisted policy', async () => {
  await runWithWorkspace(WS, async () => {
    await h.sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash)
      VALUES (${WS}, 'papercusp', ${SLUG}, 'Private cadence', 'active', '# Private cadence', 'private')`;
    await policy(60_050);
    const schedule = { kind: 'rrule' as const, rrule: 'FREQ=MINUTELY',
      action: { system: 'rubric-rescore', input: { rubricRef: REF, maxRuntimeMs: 40, maxSchedulingDelayMs: 10 } } };
    expect(body(await setSchedule.handler({ harness: 'papercusp', slug: SLUG, schedule }, {} as never)).ok).toBe(true);
    const saved = await h.sql`SELECT schedule, schedule_active FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND plan_slug=${SLUG}`;
    expect(saved[0]?.schedule).toEqual(schedule);
    expect(saved[0]?.schedule_active).toBe(false);
    const original = await getRubric(REF);
    await policy(60_049);
    expect((await getRubric(REF))!.revision).toBeGreaterThan(original!.revision!);
    const refused = body(await armSchedule.handler({ harness: 'papercusp', slug: SLUG }, {} as never));
    expect(refused.results[0].ok).toBe(false);
    expect(await h.sql`SELECT id FROM harness_shared.routines WHERE workspace_id=${WS}`).toHaveLength(0);
    expect(body(await setSchedule.handler({ harness: 'papercusp', slug: SLUG, schedule }, {} as never)).error)
      .toBe('rubric_rescore_schedule_incompatible');
    await policy(60_050);
    const armed = body(await armSchedule.handler({ harness: 'papercusp', slug: SLUG }, {} as never));
    expect(armed.results[0].ok).toBe(true);
    const routines = await h.sql`SELECT trigger_config, payload_template FROM harness_shared.routines WHERE workspace_id=${WS}`;
    expect(routines).toHaveLength(1);
    const routine = routines[0]!;
    await policy(60_049);
    const before = await h.sql`SELECT id FROM harness_shared.test_runs`;
    await expect(runRubricRescoreAction({ workspaceId: WS, installSlug: 'papercusp',
      triggerConfig: routine.trigger_config, payloadTemplate: routine.payload_template }))
      .rejects.toThrow('rubric_rescore_cadence_incompatible');
    expect(await h.sql`SELECT id FROM harness_shared.test_runs`).toEqual(before);
    expect((await h.sql`SELECT schedule FROM harness_shared.harness_plans WHERE workspace_id=${WS} AND plan_slug=${SLUG}`)[0]?.schedule)
      .toEqual(schedule);
  });
});
