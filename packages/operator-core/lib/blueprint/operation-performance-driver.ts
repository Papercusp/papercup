/** Shared P-013 workload A driver. Both the Vitest parent and fresh Node child
 * execute these same public calls against the same migrated throwaway database. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { BlueprintOperationHandle } from './operation-service';
import type { PhaseMarks } from '../../test/_paired-operation-benchmark';

export const P013_WORKSPACE = 'p013-benchmark';
export const P013_HARNESS = 'p013-benchmark-fixture';
export const P013_PAYLOAD = 'x'.repeat(1024);
export type P013Arm = 'control' | 'candidate';
export type P013Tools = {
  createWorkItemTool: { handler: (...args: never[]) => Promise<unknown> };
  claimWorkItemTool: { handler: (...args: never[]) => Promise<unknown> };
  completeWorkItemTool: { args: { parse: (value: unknown) => unknown }; handler: (...args: never[]) => Promise<unknown> };
  getWorkItemTool: { handler: (...args: never[]) => Promise<unknown> };
  submitOperationTool: { handler: (...args: never[]) => Promise<unknown> };
  operationEventsTool: { handler: (...args: never[]) => Promise<unknown> };
  operationResultTool: { handler: (...args: never[]) => Promise<unknown> };
};
export type P013Sample = { arm: P013Arm; phasesMs: number[]; eventLagMs: number; marks: PhaseMarks };

async function timed<T>(run: () => Promise<T>): Promise<{
  value: T; ms: number; startedAt: number; endedAt: number;
}> {
  const start = performance.now();
  const value = await run();
  const end = performance.now();
  return { value, ms: end - start,
    startedAt: performance.timeOrigin + start, endedAt: performance.timeOrigin + end };
}

async function waitForTerminalEvent(sql: Sql, id: string): Promise<{
  terminalAt: Date; eventAt: Date; eventIntentId: string;
}> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const rows = await sql<Array<{
      terminalAt: Date; eventAt: Date; eventIntentId: string | null;
    }>>`
      SELECT wi.state_changed_at AS "terminalAt",
             fire.last_fired_at AS "eventAt",
             fire.last_payload->>'completionIntentId' AS "eventIntentId"
        FROM harness_shared.work_items wi
        JOIN harness_shared.event_key_fires fire
          ON fire.workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND fire.event_key = ${`work-item:done:${id}`}
       WHERE wi.workspace_id = ${P013_WORKSPACE} AND wi.harness_slug = ${P013_HARNESS}
         AND wi.feature_id = ${id} AND wi.status = 'done'
    `;
    if (rows.length === 1 && rows[0]!.eventIntentId) {
      return rows[0] as { terminalAt: Date; eventAt: Date; eventIntentId: string };
    }
    if (performance.now() >= deadline) throw new Error(`P-013 missing terminal business event for ${id}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function runP013WorkloadA(
  sql: Sql, tools: P013Tools, arm: P013Arm, sequence: number,
): Promise<P013Sample> {
  const { createWorkItemTool, claimWorkItemTool, completeWorkItemTool, getWorkItemTool,
    submitOperationTool, operationEventsTool, operationResultTool } = tools;
  const caller = {
    isSuperuser: true, uiClientId: 'su-p013', workspaceId: P013_WORKSPACE,
    principal: { slug: 'su-p013', workspaceId: P013_WORKSPACE },
  };
  const phasesMs: number[] = [];
  let ingress: number;
  let accepted: number;
  let candidate: BlueprintOperationHandle | undefined;
  let id: string;
  if (arm === 'control') {
    const created = await timed(() => createWorkItemTool.handler({
      kind: 'feature', title: `P-013 direct control ${sequence}`, summary: P013_PAYLOAD,
      harness: P013_HARNESS,
    } as never, caller as never));
    const result = (created.value as { data?: { results?: Array<{ ok: boolean; id: string; error?: string }> } })
      .data?.results?.[0];
    assert.equal(result?.ok, true, result?.error);
    id = result!.id;
    phasesMs.push(created.ms);
    ingress = created.startedAt;
    accepted = created.endedAt;
  } else {
    const submitted = await timed(() => submitOperationTool.handler({
      harness: P013_HARNESS, operationId: 'direct', requestKey: `workload-a-${sequence}`,
      input: { value: P013_PAYLOAD }, title: `P-013 direct candidate ${sequence}`,
    } as never, caller as never));
    candidate = (submitted.value as { data: { handle: BlueprintOperationHandle } }).data.handle;
    assert.equal(candidate.target.kind, 'work-item');
    if (candidate.target.kind !== 'work-item') throw new Error('expected direct work item');
    id = candidate.target.id;
    phasesMs.push(submitted.ms);
    ingress = submitted.startedAt;
    accepted = submitted.endedAt;
    const events = await operationEventsTool.handler({ handle: candidate } as never, caller as never);
    assert.ok((events as { data: { events: Array<{ kind: string; state: string }> } }).data.events
      .some((event) => event.kind === 'work-item' && event.state === 'open'));
  }
  const worker = `su-p013-${arm}-worker-${sequence}`;
  if (candidate) {
    const [{ pin }] = await sql<Array<{ pin: Record<string, unknown> }>>`
      SELECT payload->'blueprintOperation' AS pin FROM harness_shared.work_items
       WHERE workspace_id = ${P013_WORKSPACE} AND harness_slug = ${P013_HARNESS} AND feature_id = ${id}
    `;
    const launchRevision = { specificationRevision: 'a'.repeat(64), stateRevision: 'p013-applied' };
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, feature, agent, session_id, coord_owner_id, role, launch_spec)
      VALUES (${P013_WORKSPACE}, 'console', ${id}, 'claude', ${`native-p013-${sequence}`}, ${worker}, 'worker',
        ${sql.json({ workspaceId: P013_WORKSPACE, harnessSlug: P013_HARNESS, role: 'worker',
          ...launchRevision, specificationArtifact: { configuration: { grants: {} } },
          acceptedOperation: {
            kind: 'blueprint-operation-worker', workItemId: id,
            operationId: 'direct', specificationRevision: candidate.specificationRevision,
            pin, identity: { ref: 'worker', revision: '1', contentHash: 'b'.repeat(64) },
            requiredTools: ['work_items:complete'],
          },
        } as never)})
    `;
    await sql`
      INSERT INTO harness_shared.session_briefs (workspace_id, owner_id, control_state)
      VALUES (${P013_WORKSPACE}, ${worker}, ${sql.json({ activation: {
        schemaVersion: 1,
        attribution: { actorId: worker, principalId: worker, sessionId: worker },
        desired: launchRevision, prepared: null, applied: launchRevision, status: 'applied',
      } } as never)})
    `;
  }
  // The isolated fixture settles the shared duplicate-screening gate identically.
  await sql`
    UPDATE harness_shared.work_items SET admission = 'auto'
     WHERE workspace_id = ${P013_WORKSPACE} AND harness_slug = ${P013_HARNESS}
       AND feature_id = ${id} AND admission = 'pending'
  `;
  const claimed = await timed(() => claimWorkItemTool.handler({
    id, harness: P013_HARNESS, assignee: worker,
  } as never, { ...caller, uiClientId: worker } as never));
  const claim = (claimed.value as { data?: { results?: Array<{ ok: boolean; error?: string }> } })
    .data?.results?.[0];
  assert.equal(claim?.ok, true, claim?.error);
  phasesMs.push(claimed.ms);
  const args = completeWorkItemTool.args.parse({
    id, harness: P013_HARNESS, state: 'done', assumptions: 'none',
    outputPayload: { value: P013_PAYLOAD },
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
  assert.equal(completion?.ok, true, completion?.error);
  phasesMs.push(completed.ms);
  const observed = await timed(async () => candidate
    ? {
        result: await operationResultTool.handler({ handle: candidate } as never, caller as never),
        events: await operationEventsTool.handler({ handle: candidate } as never, caller as never),
      }
    : getWorkItemTool.handler({ id, harness: P013_HARNESS, threadLimit: 0 } as never, caller as never));
  if (candidate) {
    const { result, events } = observed.value as {
      result: { data: { state: string; output: { value: string } } };
      events: { data: { events: Array<{ kind: string; state: string }> } };
    };
    assert.equal(result.data.state, 'ready');
    assert.equal(result.data.output.value, P013_PAYLOAD);
    assert.ok(events.data.events.some((event) => event.kind === 'work-item' && event.state === 'done'));
    const terminalEvents = await sql<Array<{ ts: Date }>>`
      SELECT ts FROM harness_shared.coord_event_log
       WHERE workspace_id = ${P013_WORKSPACE} AND surface = 'blueprint-operation'
         AND body->>'workItemId' = ${id} AND body->>'state' = 'done'
    `;
    assert.equal(terminalEvents.length, 1);
    assert.ok(Number.isFinite(new Date(terminalEvents[0]!.ts).getTime()));
  } else {
    assert.equal((observed.value as { data?: { results?: Array<{ workItem?: { state: string } }> } })
      .data?.results?.[0]?.workItem?.state, 'done');
  }
  phasesMs.push(observed.ms);
  const eventMark = await waitForTerminalEvent(sql, id);
  const eventLagMs = new Date(eventMark.eventAt).getTime() - new Date(eventMark.terminalAt).getTime();
  assert.ok(eventLagMs >= 0);
  const marks: PhaseMarks = {
    ingress, accepted, dispatched: claimed.endedAt,
    terminal: new Date(eventMark.terminalAt).getTime(),
    businessEvent: new Date(eventMark.eventAt).getTime(),
  };
  assert.equal(phasesMs.length, 4);
  assert.ok(phasesMs.every((duration) => Number.isFinite(duration) && duration >= 0));
  return { arm, phasesMs, eventLagMs, marks };
}
