/** Real private HTTP control for the P-009 unrelated-write responsiveness bar. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { createWorkItem } from '../lib/work-items';
import { workItemScope } from '../lib/carry-note';
import { getWorkItemCheckpoint, setWorkItemCheckpointWithPrior } from '../lib/work-item-checkpoint';
import { assertPrivateUnrelatedCheckpointObservation, type PrivateUnrelatedCheckpointObservation } from './private-http-workspace-preflight';

type Options = {
  workspace: string;
  harness: string;
  base: string;
  headers: Record<string, string>;
  evidenceDir: string;
  expectedSha: string;
};

type Activity = PrivateUnrelatedCheckpointObservation['stallBefore'];
type ActivityRow = {
  pid: number;
  backendStart: string;
  queryStart: string;
  state: string;
  waitEventType: string;
  query: string;
};

function receiptFromEnvelope(envelope: any) {
  const structured = envelope.result?.structuredContent;
  if (structured) return structured;
  const json = envelope.result?.content?.filter((part: any) =>
    part.type === 'text' && typeof part.text === 'string' && part.text.trim().startsWith('{'));
  if (!json || json.length !== 1) return undefined;
  try { return JSON.parse(json[0].text); } catch { return undefined; }
}

export async function measurePrivateUnrelatedCheckpointScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  assert.ok(o.expectedSha, 'the scenario must be pinned to the initial health build');
  const { sql } = getOrgPg();
  const requests: Array<Record<string, unknown>> = [];
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', {
      method: 'POST', headers: o.headers,
      body: JSON.stringify({ name, args, harness: o.harness,
        callerSid: 'private-unrelated-write-' + o.workspace, confirmed: true }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = await response.json() as any;
    await writeFile(`${o.evidenceDir}/unrelated-request-${requests.length}.json`,
      JSON.stringify({ name, args, status: response.status, envelope }), { flag: 'wx' });
    const result = receiptFromEnvelope(envelope);
    requests.push({ name, status: response.status, result, isError: envelope.result?.isError === true });
    return { response, envelope, result };
  };

  const healthBeforeResponse = await fetch(o.base + '/api/health', { headers: o.headers, signal: AbortSignal.timeout(2_000) });
  const healthBefore = await healthBeforeResponse.json() as { service: string; sha: string; bundleStale?: unknown };
  assert.equal(healthBeforeResponse.status, 200, JSON.stringify(healthBefore));
  assert.equal(healthBefore.sha, o.expectedSha);

  const suffix = randomUUID();
  const stalled = await createWorkItem({ kind: 'feature', title: `P009 private stalled item ${suffix}`,
    summary: 'Disposable row used only to demonstrate an observed continuing lock wait.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const unrelated = await createWorkItem({ kind: 'feature', title: `P009 private unrelated item ${suffix}`,
    summary: 'Disposable row receiving the unrelated checkpoint write.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const stalledCheckpoint = `private stalled checkpoint ${suffix}`;
  const targetCheckpoint = `private unrelated checkpoint ${suffix}`;
  await setWorkItemCheckpointWithPrior({ workspaceId: o.workspace, harness: o.harness, workItemId: stalled.id }, stalledCheckpoint);

  const lock = await sql.reserve();
  let blocker: Promise<unknown> | undefined;
  try {
    await lock`BEGIN`;
    await lock`SELECT scope FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, stalled.id)} FOR UPDATE`;
    blocker = invoke('work_items:checkpoint', { id: stalled.id, harness: o.harness, checkpoint: `blocked ${suffix}` });

    const activity = async (): Promise<Activity | undefined> => {
      const rows = await sql<ActivityRow[]>`SELECT pid,
          backend_start::text AS "backendStart", query_start::text AS "queryStart",
          state, wait_event_type AS "waitEventType", query
        FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND query LIKE '%harness_shared.carry_notes%'
       ORDER BY query_start ASC LIMIT 1`;
      const row = rows[0];
      if (!row) return undefined;
      return { observedAtMs: performance.now(), itemId: stalled.id, pid: Number(row.pid),
        backendStart: row.backendStart, queryStart: row.queryStart, state: row.state,
        waitEventType: row.waitEventType };
    };
    const waitForActivity = async (limitMs: number) => {
      const deadline = performance.now() + limitMs;
      while (performance.now() < deadline) {
        const found = await activity();
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return undefined;
    };
    const stallBefore = await waitForActivity(5_000);
    assert.ok(stallBefore, 'blocked unrelated control must expose a real PostgreSQL lock wait');

    const startedAtMs = performance.now();
    const unrelatedResult = await invoke('work_items:checkpoint', {
      id: unrelated.id, harness: o.harness, checkpoint: targetCheckpoint,
    });
    const completedAtMs = performance.now();
    const stallAfter = await activity();
    assert.ok(stallAfter, 'the original blocked query must still be waiting after unrelated completion');
    const readbackCheckpoint = await getWorkItemCheckpoint({ workspaceId: o.workspace, harness: o.harness, workItemId: unrelated.id });
    const healthAfterResponse = await fetch(o.base + '/api/health', { headers: o.headers, signal: AbortSignal.timeout(2_000) });
    const healthAfter = await healthAfterResponse.json() as { service: string; sha: string; bundleStale?: unknown };
    const observation: PrivateUnrelatedCheckpointObservation = {
      workspace: o.workspace, base: o.base, expectedBuildSha: o.expectedSha,
      healthBefore, healthAfter, itemId: unrelated.id, harness: o.harness,
      checkpoint: targetCheckpoint, startedAtMs, completedAtMs,
      stallBefore, stallAfter, response: { status: unrelatedResult.response.status, envelope: unrelatedResult.envelope },
      readback: { observedAtMs: performance.now(), workspace: o.workspace, harness: o.harness,
        itemId: unrelated.id, checkpoint: readbackCheckpoint ?? '' },
    };
    assertPrivateUnrelatedCheckpointObservation(observation);
    await writeFile(`${o.evidenceDir}/unrelated-observation.json`, JSON.stringify(observation), { flag: 'wx' });
    return { workspace: o.workspace, stalledItemId: stalled.id, unrelatedItemId: unrelated.id,
      requests, observation, hostStopped: false };
  } finally {
    await lock`ROLLBACK`;
    lock.release();
    if (blocker) await blocker;
    await sql`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${o.workspace}
      AND scope IN (${workItemScope(o.harness, stalled.id)}, ${workItemScope(o.harness, unrelated.id)})`;
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${o.workspace}
      AND harness_slug = ${o.harness} AND feature_id IN (${stalled.id}, ${unrelated.id})`;
  }
}
