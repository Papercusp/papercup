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
  const value = result as { data?: unknown; content?: Array<{ text: string }> };
  if (value.data !== undefined) return value.data;
  if (!value.content?.[0]?.text) throw new Error('Schedule fixture expected canonical data or MCP text content');
  return JSON.parse(value.content[0].text);
}

async function policy(maxAgeMs: number, includeErrorProbe = false) {
  const criterion = (key: string, sql: string) => ({
    key, title: key, model: `Measure ${key}.`, method: `Run ${key}.`, driftMarkers: `A failed ${key} check.`,
    check: { kind: 'probe', maxAgeMs, probe: { kind: 'sql', sql,
      schemaRevision: continuityProbeRevision(SQL_PROBE_TOOL)!, expect: { path: '$.rows[0].value', op: 'eq', value: 1 } } },
  });
  await proposeRubric({ rubricId: REF, title: 'Private cadence policy', characteristic: 'cadence',
    status: 'active', by: 'su-fixture', criteria: [
      criterion('health', 'SELECT 1 AS value'),
      ...(includeErrorProbe ? [criterion('unavailable', 'SELECT 1 / 0 AS value')] : []),
    ] });
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

    // One complete system-action cycle: persist both the passing probe and a real SQL error,
    // then publish a full ledger-filled card whose failed check stays explicitly unknown.
    await policy(60_050, true);
    const scheduledInput = (routine.payload_template as { input: Record<string, unknown> }).input;
    const dispatchTool = async (name: string, args: Record<string, unknown>) => {
      if (name !== SQL_PROBE_TOOL || typeof args.sql !== 'string') {
        throw new Error(`Unexpected rubric probe dispatch: ${name}`);
      }
      return { data: { rows: await h.sql.unsafe(args.sql) } };
    };
    const fired = await runRubricRescoreAction({ workspaceId: WS,
      triggerConfig: routine.trigger_config, payloadTemplate: { input: scheduledInput } } as never, { dispatchTool });
    expect(fired.softError).toContain('1 of 2 probe criteria unjudged');
    const scorecard = (fired.diagnostics as { rubricRescore: { scorecardPublication: { status: string; issueId?: string } } })
      .rubricRescore.scorecardPublication;
    expect(scorecard).toMatchObject({ status: 'created', issueId: expect.any(String) });

    const cardRows = await h.sql`SELECT payload FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND feature_id=${scorecard.issueId}`;
    expect(cardRows).toHaveLength(1);
    const payload = cardRows[0]!.payload as Record<string, any>;
    const observation = payload.observation as { ledgerFilled?: boolean; ratings: Record<string, Record<string, any>> };
    expect(payload._ei?.created_by).toBe('system:rubric-rescore');
    expect(observation.ledgerFilled).toBe(true);
    expect(Object.keys(observation.ratings).sort()).toEqual(['health', 'unavailable']);
    expect(observation.ratings.health).toMatchObject({ rating: 'healthy', ratedFrom: 'ledger' });
    expect(observation.ratings.unavailable).toMatchObject({ rating: 'unknown', ratedFrom: 'ledger', evidenceKind: 'test-run' });
    expect(observation.ratings.unavailable.evidenceRef)
      .toBe(`test_runs:${observation.ratings.unavailable.ledgerResult.testRunId}`);

    const checkRows = await h.sql`SELECT execution_details->'check'->>'criterionKey' AS criterion_key, status
      FROM harness_shared.test_runs
      WHERE workspace_id=${WS} AND framework='rubric-check'
        AND execution_details->'check'->>'rubricRef'=${REF}`;
    expect(checkRows).toHaveLength(2);
    expect(checkRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterion_key: 'health', status: 'pass' }),
      expect.objectContaining({ criterion_key: 'unavailable', status: 'error' }),
    ]));
  });
});
