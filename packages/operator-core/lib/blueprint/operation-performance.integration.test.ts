/** P-013 workload A fixture: the canonical direct create path and the public
 * blueprint operation admission path in one migrated throwaway org database.
 * This is the admission/invariant smoke, not a latency grade. The D-016 paired
 * matrix is run separately once the terminal and event probes are wired. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { runPairedBenchmark, type BenchmarkArm, type PhaseMarks } from '../../test/_paired-operation-benchmark';
import { projectBlueprintToPg } from './project-to-pg';
import type { BlueprintOperationHandle } from './operation-service';
import {
  PG_BIGINT_AS_NUMBER_TYPES, PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
  restoreRawDateSerializers, restoreRawJsonbSerializer,
} from '../../../../libs/papercusp/libs/db/src/raw-serializers';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../workspace-registry', async () => ({
  ...(await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry')),
  activeWorkspaceId: () => 'p013-benchmark',
}));
vi.mock('../harness-core', async () => ({
  ...(await vi.importActual<typeof import('../harness-core')>('../harness-core')),
  resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
vi.mock('../hive-federation', async () => ({
  ...(await vi.importActual<typeof import('../hive-federation')>('../hive-federation')),
  potHomeSlugForHarness: async (_workspace: string, slug: string) => slug,
}));

const { default: createWorkItemTool } = await import('../agent-tools/work_items/create');
const { default: claimWorkItemTool } = await import('../agent-tools/work_items/claim');
const { default: completeWorkItemTool } = await import('../agent-tools/work_items/complete');
const { default: getWorkItemTool } = await import('../agent-tools/work_items/get');
const { default: submitOperationTool } = await import('../agent-tools/blueprint/submit-operation');
const { default: operationEventsTool } = await import('../agent-tools/blueprint/events-operation');
const { default: operationResultTool } = await import('../agent-tools/blueprint/result-operation');
const warmTools = {
  createWorkItemTool, claimWorkItemTool, completeWorkItemTool, getWorkItemTool,
  submitOperationTool, operationEventsTool, operationResultTool,
};
type ToolSet = typeof warmTools;
async function loadFreshTools(): Promise<ToolSet> {
  vi.resetModules();
  const [create, claim, complete, get, submit, events, result] = await Promise.all([
    import('../agent-tools/work_items/create'),
    import('../agent-tools/work_items/claim'),
    import('../agent-tools/work_items/complete'),
    import('../agent-tools/work_items/get'),
    import('../agent-tools/blueprint/submit-operation'),
    import('../agent-tools/blueprint/events-operation'),
    import('../agent-tools/blueprint/result-operation'),
  ]);
  return {
    createWorkItemTool: create.default, claimWorkItemTool: claim.default,
    completeWorkItemTool: complete.default, getWorkItemTool: get.default,
    submitOperationTool: submit.default, operationEventsTool: events.default,
    operationResultTool: result.default,
  };
}
function openColdSql(): Sql {
  const sql = postgres(db.adminDsn, {
    max: 1, prepare: false, onnotice: () => {},
    connection: { search_path: 'harness_shared, public' },
    types: { ...PG_BIGINT_AS_NUMBER_TYPES, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
  });
  restoreRawDateSerializers(sql);
  restoreRawJsonbSerializer(sql);
  return sql;
}
const WS = 'p013-benchmark';
const HARNESS = 'p013-benchmark-fixture';
const PAYLOAD_1K = 'x'.repeat(1024);
type Arm = 'control' | 'candidate';
type PhaseSamples = { arm: Arm; phasesMs: number[]; eventLagMs: number; marks: PhaseMarks };
async function timed<T>(run: () => Promise<T>): Promise<{
  value: T; ms: number; startedAt: number; endedAt: number;
}> {
  const start = performance.now();
  const value = await run();
  const end = performance.now();
  return { value, ms: end - start,
    startedAt: performance.timeOrigin + start, endedAt: performance.timeOrigin + end };
}
const SOURCE = {
  id: 'p013-workload-a', workItem: { kind: 'feature' },
  roles: [{ id: 'worker' }],
  spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'P-013' } }] },
  operations: [{
    id: 'direct', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
    execution: { kind: 'agent', role: 'worker' },
    inputSchema: { type: 'object', required: ['value'],
      properties: { value: { type: 'string' } }, additionalProperties: false },
    acceptance: { resultSchema: { type: 'object', required: ['value'],
      properties: { value: { type: 'string' } }, additionalProperties: false } },
  }],
};

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  fixture.sql = db.adminSql;
  await db.adminSql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HARNESS}, ${Buffer.from([13])}, 'kc-p013-benchmark', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
  await projectBlueprintToPg(db.adminSql, {
    workspaceId: WS, harnessSlug: HARNESS,
    blueprint: BlueprintSchema.parse(SOURCE),
    specification: compileAgentSpecification({ source: SOURCE }),
  });
}, 120_000);
afterAll(async () => db?.cleanup(), 30_000);

describe('P-013 workload A fixture', () => {
  it('creates and completes matching 1 KiB direct items; blueprint arm leaves zero plan rows', async () => {
    const caller = {
      isSuperuser: true, uiClientId: 'su-p013', workspaceId: WS,
      principal: { slug: 'su-p013', workspaceId: WS },
    };
    const runArm = async (arm: Arm, sequence: number, tools: ToolSet = warmTools): Promise<PhaseSamples> => {
      const { createWorkItemTool, claimWorkItemTool, completeWorkItemTool, getWorkItemTool,
        submitOperationTool, operationEventsTool, operationResultTool } = tools;
      const phasesMs: number[] = [];
      let ingress: number;
      let accepted: number;
      let candidate: BlueprintOperationHandle | undefined;
      let id: string;
      if (arm === 'control') {
        const created = await timed(() => createWorkItemTool.handler({
          kind: 'feature', title: `P-013 direct control ${sequence}`, summary: PAYLOAD_1K,
          harness: HARNESS,
        } as never, caller as never));
        const result = (created.value as { data?: { results?: Array<{ ok: boolean; id: string }> } })
          .data?.results?.[0];
        expect(result).toMatchObject({ ok: true });
        id = result!.id;
        phasesMs.push(created.ms);
        ingress = created.startedAt;
        accepted = created.endedAt;
      } else {
        const submitted = await timed(() => submitOperationTool.handler({
          harness: HARNESS, operationId: 'direct', requestKey: `workload-a-${sequence}`,
          input: { value: PAYLOAD_1K }, title: `P-013 direct candidate ${sequence}`,
        } as never, caller as never));
        candidate = (submitted.value as { data: { handle: BlueprintOperationHandle } }).data.handle;
        expect(candidate.target.kind).toBe('work-item');
        if (candidate.target.kind !== 'work-item') throw new Error('expected direct work item');
        id = candidate.target.id;
        phasesMs.push(submitted.ms);
        ingress = submitted.startedAt;
        accepted = submitted.endedAt;
        const events = await operationEventsTool.handler({ handle: candidate } as never, caller as never);
        expect((events as { data: { events: unknown[] } }).data.events)
          .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'work-item', state: 'open' })]));
      }
      const worker = `su-p013-${arm}-worker-${sequence}`;
      if (candidate) {
        const [{ pin }] = await db.adminSql<Array<{ pin: Record<string, unknown> }>>`
          SELECT payload->'blueprintOperation' AS pin FROM harness_shared.work_items
           WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = ${id}
        `;
        const launchRevision = { specificationRevision: 'a'.repeat(64), stateRevision: 'p013-applied' };
        await db.adminSql`
          INSERT INTO harness_shared.adv_sessions
            (workspace_id, mode, feature, agent, session_id, coord_owner_id, role, launch_spec)
          VALUES (${WS}, 'console', ${id}, 'claude', ${`native-p013-${sequence}`}, ${worker}, 'worker',
            ${db.adminSql.json({ workspaceId: WS, harnessSlug: HARNESS, role: 'worker',
              ...launchRevision, specificationArtifact: { configuration: { grants: {} } },
              acceptedOperation: {
                kind: 'blueprint-operation-worker', workItemId: id,
                operationId: 'direct', specificationRevision: candidate.specificationRevision,
                pin, identity: { ref: 'worker', revision: '1', contentHash: 'b'.repeat(64) },
                requiredTools: ['work_items:complete'],
              },
            } as never)})
        `;
        await db.adminSql`
          INSERT INTO harness_shared.session_briefs (workspace_id, owner_id, control_state)
          VALUES (${WS}, ${worker}, ${db.adminSql.json({ activation: {
            schemaVersion: 1,
            attribution: { actorId: worker, principalId: worker, sessionId: worker },
            desired: launchRevision, prepared: null, applied: launchRevision, status: 'applied',
          } } as never)})
        `;
      }
      // Both public create paths are born pending duplicate screening. The isolated
      // deterministic fixture settles that shared pre-dispatch gate identically;
      // promoter latency is excluded from this small API pilot.
      await db.adminSql`
        UPDATE harness_shared.work_items SET admission = 'auto'
         WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
           AND feature_id = ${id} AND admission = 'pending'
      `;
      const claimed = await timed(() => claimWorkItemTool.handler({ id, harness: HARNESS, assignee: worker } as never,
        { ...caller, uiClientId: worker } as never));
      const claim = (claimed.value as { data?: { results?: Array<{ ok: boolean; error?: string }> } })
        .data?.results?.[0];
      expect(claim, claim?.error).toMatchObject({ ok: true });
      phasesMs.push(claimed.ms);
      const args = (completeWorkItemTool.args as { parse: (value: unknown) => unknown }).parse({
        id, harness: HARNESS, state: 'done', assumptions: 'none',
        outputPayload: { value: PAYLOAD_1K },
        completion: {
          summary: 'P-013 deterministic direct result',
          testsRun: 'deterministic provider fixture', testResult: '1 KiB value returned',
          verifiedHow: 'isolated integration fixture', filesChanged: [],
        },
      });
      const completed = await timed(() => completeWorkItemTool.handler(args as never,
        { ...caller, uiClientId: worker } as never));
      const completion = (completed.value as { data?: { results?: Array<{ ok: boolean; error?: string }> } })
        .data?.results?.[0];
      expect(completion, completion?.error).toMatchObject({ ok: true });
      phasesMs.push(completed.ms);
      const observed = await timed(async () => candidate
        ? {
            result: await operationResultTool.handler({ handle: candidate } as never, caller as never),
            events: await operationEventsTool.handler({ handle: candidate } as never, caller as never),
          }
        : getWorkItemTool.handler({ id, harness: HARNESS, threadLimit: 0 } as never, caller as never));
      if (candidate) {
        const { result, events } = observed.value as { result: { data: unknown }; events: { data: { events: unknown[] } } };
        expect(result.data).toMatchObject({ state: 'ready', output: { value: PAYLOAD_1K } });
        expect(events.data.events).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'work-item', state: 'done' }),
        ]));
        // The blueprint-operation projection event is written by the work-item
        // UPDATE trigger in the completion transaction. The id-scoped business
        // event is checked separately in event_key_fires below.
        const terminalEvents = await db.adminSql<Array<{ ts: Date }>>`
          SELECT ts FROM harness_shared.coord_event_log
           WHERE workspace_id = ${WS} AND surface = 'blueprint-operation'
             AND body->>'workItemId' = ${id} AND body->>'state' = 'done'
        `;
        expect(terminalEvents).toHaveLength(1);
        expect(Number.isFinite(new Date(terminalEvents[0]!.ts).getTime())).toBe(true);
      } else {
        expect((observed.value as { data?: { results?: Array<{ workItem?: { state: string } }> } })
          .data?.results?.[0]?.workItem?.state).toBe('done');
      }
      phasesMs.push(observed.ms);
      // Completion schedules the id-scoped business event after its terminal
      // transaction. Probe the durable fire latch for both arms rather than
      // mistaking the synchronous blueprint-operation event for that mark.
      const eventMark = await vi.waitFor(async () => {
        const rows = await db.adminSql<Array<{
          terminalAt: Date; eventAt: Date; eventIntentId: string | null;
        }>>`
          SELECT wi.state_changed_at AS "terminalAt",
                 fire.last_fired_at AS "eventAt",
                 fire.last_payload->>'completionIntentId' AS "eventIntentId"
            FROM harness_shared.work_items wi
            JOIN harness_shared.event_key_fires fire
              ON fire.workspace_id = ${DEFAULT_COORD_WORKSPACE}
             AND fire.event_key = ${`work-item:done:${id}`}
           WHERE wi.workspace_id = ${WS} AND wi.harness_slug = ${HARNESS}
             AND wi.feature_id = ${id} AND wi.status = 'done'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.eventIntentId).toBeTruthy();
        return rows[0]!;
      }, { timeout: 5_000, interval: 25 });
      const eventLagMs = new Date(eventMark.eventAt).getTime() - new Date(eventMark.terminalAt).getTime();
      expect(eventLagMs).toBeGreaterThanOrEqual(0);
      // Both timestamps share this host's wall clock. performance.timeOrigin
      // aligns API monotonic marks to that epoch without including fixture SQL.
      const marks: PhaseMarks = {
        ingress, accepted, dispatched: claimed.endedAt,
        terminal: new Date(eventMark.terminalAt).getTime(),
        businessEvent: new Date(eventMark.eventAt).getTime(),
      };
      expect(phasesMs).toHaveLength(4);
      expect(phasesMs.every((duration) => Number.isFinite(duration) && duration >= 0)).toBe(true);
      return { arm, phasesMs, eventLagMs, marks };
    };
    let sequence = 0;
    if (process.env.P013_COLD_PILOT === '1') {
      // A cold sample gets a new module graph and a new PostgreSQL client. Keep
      // this pilot at concurrency one: vi.resetModules and the test DB mock are
      // process-global, so a parallel cold matrix needs isolated processes.
      let activeColdSql: Sql | undefined;
      let coldStarts = 0;
      const benchmarkArm = (arm: Arm): BenchmarkArm => ({
        warmup: async () => { await runArm(arm, sequence++); },
        run: async () => (await runArm(arm, sequence++)).marks,
        coldStart: async () => {
          if (activeColdSql) throw new Error('P-013 in-process cold pilot supports concurrency one only');
          const sql = openColdSql();
          activeColdSql = sql;
          fixture.sql = sql;
          try {
            const freshTools = await loadFreshTools();
            expect(freshTools.createWorkItemTool).not.toBe(warmTools.createWorkItemTool);
            coldStarts++;
            return {
              run: async () => (await runArm(arm, sequence++, freshTools)).marks,
              close: async () => {
                fixture.sql = db.adminSql;
                activeColdSql = undefined;
                await sql.end({ timeout: 5 });
              },
            };
          } catch (error) {
            fixture.sql = db.adminSql;
            activeColdSql = undefined;
            await sql.end({ timeout: 5 });
            throw error;
          }
        },
      });
      const trials = await runPairedBenchmark({ control: benchmarkArm('control'),
        candidate: benchmarkArm('candidate') }, {
        warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1,
        concurrencies: [1], modes: ['cold'],
      });
      expect(coldStarts).toBe(2);
      expect(trials).toHaveLength(2);
      console.info('P-013 workload A in-process cold-boundary pilot; no D-016 grade',
        JSON.stringify(trials.map((trial) => ({ arm: trial.arm, mode: trial.mode,
          totalMs: +trial.phasesMs.total.p50.toFixed(2) }))));
    } else if (process.env.P013_PAIRED_SMOKE === '1') {
      const benchmarkArm = (arm: Arm): BenchmarkArm => ({
        warmup: async () => { await runArm(arm, sequence++); },
        run: async () => (await runArm(arm, sequence++)).marks,
      });
      const trials = await runPairedBenchmark({ control: benchmarkArm('control'),
        candidate: benchmarkArm('candidate') }, {
        warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1, concurrencies: [1], modes: ['warm'],
      });
      expect(trials).toHaveLength(2);
      expect(trials.every((trial) => trial.persistence.dbRoundTrips === null &&
        trial.persistence.dbBytes === null && trial.persistence.durableSteps === null)).toBe(true);
      console.info('P-013 workload A warm-only paired-runner instrumentation smoke; no grade',
        JSON.stringify(trials.map((trial) => ({ arm: trial.arm, mode: trial.mode,
          totalMs: +trial.phasesMs.total.p50.toFixed(2) }))));
    } else {
      const pilot = process.env.P013_PILOT === '1';
      const order: Arm[] = pilot
        ? ['control', 'candidate', 'candidate', 'control']
        : ['control', 'candidate'];
      const samples: PhaseSamples[] = [];
      for (const arm of order) samples.push(await runArm(arm, sequence++));
      if (pilot) {
        console.info('P-013 workload A non-grading API-phase pilot (promoter excluded)', JSON.stringify({
          phases: ['create-or-submit', 'claim', 'complete', 'observe-terminal'],
          samples: samples.map(({ arm, phasesMs, eventLagMs }) => ({
            arm, ms: phasesMs.map((ms) => +ms.toFixed(2)), eventLagMs: +eventLagMs.toFixed(2),
          })),
        }));
      }
    }
    const [{ items, plans, runs }] = await db.adminSql<Array<{ items: number; plans: number; runs: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS items,
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS plans,
        (SELECT count(*)::int FROM harness_shared.plan_runs
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS runs
    `;
    expect({ items, plans, runs }).toEqual({ items: sequence, plans: 0, runs: 0 });
  }, 180_000);
});
