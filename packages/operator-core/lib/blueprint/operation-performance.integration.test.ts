/** P-013 workload A fixture: the canonical direct create path and the public
 * blueprint operation admission path in one migrated throwaway org database.
 * This is the admission/invariant smoke, not a latency grade. The D-016 paired
 * matrix is run separately once the terminal and event probes are wired. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from './project-to-pg';
import type { BlueprintOperationHandle } from './operation-service';

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
const WS = 'p013-benchmark';
const HARNESS = 'p013-benchmark-fixture';
const PAYLOAD_1K = 'x'.repeat(1024);
async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
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
    const controlMs: number[] = [];
    const candidateMs: number[] = [];
    const controlCreated = await timed(() => createWorkItemTool.handler({
      kind: 'feature', title: 'P-013 direct control', summary: PAYLOAD_1K,
      harness: HARNESS,
    } as never, caller as never));
    const controlResponse = controlCreated.value;
    const controlData = (controlResponse as { data?: { results?: Array<{ ok: boolean; id: string }> } }).data;
    expect(controlData?.results?.[0]?.ok).toBe(true);
    controlMs.push(controlCreated.ms);
    const candidateSubmitted = await timed(() => submitOperationTool.handler({
      harness: HARNESS, operationId: 'direct', requestKey: 'workload-a-1',
      input: { value: PAYLOAD_1K }, title: 'P-013 direct candidate',
    } as never, caller as never));
    const submitted = candidateSubmitted.value;
    const candidate = (submitted as { data: { handle: BlueprintOperationHandle } }).data.handle;
    expect(candidate.target.kind).toBe('work-item');
    candidateMs.push(candidateSubmitted.ms);
    const events = await operationEventsTool.handler({ handle: candidate } as never, caller as never);
    expect((events as { data: { events: unknown[] } }).data.events)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'work-item', state: 'open' })]));
    if (candidate.target.kind !== 'work-item') throw new Error('expected direct work item');
    const worker = 'su-p013-worker';
    const controlWorker = 'su-p013-control-worker';
    const [{ pin }] = await db.adminSql<Array<{ pin: Record<string, unknown> }>>`
      SELECT payload->'blueprintOperation' AS pin FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = ${candidate.target.id}
    `;
    const launchRevision = { specificationRevision: 'a'.repeat(64), stateRevision: 'p013-applied' };
    await db.adminSql`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, feature, agent, session_id, coord_owner_id, role, launch_spec)
      VALUES (${WS}, 'console', ${candidate.target.id}, 'claude', 'native-p013-worker', ${worker}, 'worker',
        ${db.adminSql.json({ workspaceId: WS, harnessSlug: HARNESS, role: 'worker',
          ...launchRevision, specificationArtifact: { configuration: { grants: {} } },
          acceptedOperation: {
            kind: 'blueprint-operation-worker', workItemId: candidate.target.id,
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
    // Both public create paths are born pending duplicate screening. The isolated
    // deterministic fixture settles that shared pre-dispatch gate identically;
    // promoter latency is not part of this small API pilot.
    await db.adminSql`
      UPDATE harness_shared.work_items SET admission = 'auto'
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND feature_id IN (${controlData!.results![0]!.id}, ${candidate.target.id})
         AND admission = 'pending'
    `;
    for (const id of [controlData!.results![0]!.id, candidate.target.id]) {
      const assignee = id === candidate.target.id ? worker : controlWorker;
      const claimed = await timed(() => claimWorkItemTool.handler({ id, harness: HARNESS, assignee } as never,
        { ...caller, uiClientId: assignee } as never));
      const claim = claimed.value;
      const result = (claim as { data?: { results?: Array<{ ok: boolean; error?: string }> } }).data?.results?.[0];
      expect(result, result?.error).toMatchObject({ ok: true });
      (id === candidate.target.id ? candidateMs : controlMs).push(claimed.ms);
    }
    for (const id of [controlData!.results![0]!.id, candidate.target.id]) {
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
        { ...caller, uiClientId: id === candidate.target.id ? worker : controlWorker } as never));
      const response = completed.value;
      const completion = (response as { data?: { results?: Array<{ ok: boolean }> } }).data?.results?.[0];
      expect(completion, completion?.error).toMatchObject({ ok: true });
      (id === candidate.target.id ? candidateMs : controlMs).push(completed.ms);
    }
    const controlObserved = await timed(() => getWorkItemTool.handler({ id: controlData!.results![0]!.id,
      harness: HARNESS, threadLimit: 0 } as never, caller as never));
    const controlEvent = controlObserved.value;
    expect((controlEvent as { data?: { results?: Array<{ workItem?: { state: string } }> } }).data
      ?.results?.[0]?.workItem?.state).toBe('done');
    controlMs.push(controlObserved.ms);
    const candidateObserved = await timed(async () => {
      const result = await operationResultTool.handler({ handle: candidate } as never, caller as never);
      const terminalEvents = await operationEventsTool.handler({ handle: candidate } as never, caller as never);
      return { result, terminalEvents };
    });
    const { result, terminalEvents } = candidateObserved.value;
    expect((result as { data: unknown }).data).toMatchObject({
      state: 'ready', output: { value: PAYLOAD_1K },
    });
    expect((terminalEvents as { data: { events: unknown[] } }).data.events)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'work-item', state: 'done' })]));
    candidateMs.push(candidateObserved.ms);
    for (const durations of [controlMs, candidateMs]) {
      expect(durations).toHaveLength(4);
      expect(durations.every((duration) => Number.isFinite(duration) && duration >= 0)).toBe(true);
    }
    if (process.env.P013_PILOT === '1') {
      console.info('P-013 workload A non-grading API-phase pilot (promoter excluded)', JSON.stringify({
        phases: ['create-or-submit', 'claim', 'complete', 'observe-terminal'],
        controlMs: controlMs.map((ms) => +ms.toFixed(2)),
        candidateMs: candidateMs.map((ms) => +ms.toFixed(2)),
      }));
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
    expect({ items, plans, runs }).toEqual({ items: 2, plans: 0, runs: 0 });
  });
});
