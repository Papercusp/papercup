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
  blockingPids: number[];
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
  let requestIndex = 0;
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const index = requestIndex++;
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', {
      method: 'POST', headers: o.headers,
      body: JSON.stringify({ name, args, harness: o.harness,
        callerSid: 'private-unrelated-write-' + o.workspace, confirmed: true }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = await response.json() as any;
    await writeFile(`${o.evidenceDir}/unrelated-request-${index}.json`,
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
  const decoy = await createWorkItem({ kind: 'feature', title: `P009 private decoy item ${suffix}`,
    summary: 'An older competing wait must not qualify as the selected stalled item.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const stalledCheckpoint = `private stalled checkpoint ${suffix}`;
  const targetCheckpoint = `private unrelated checkpoint ${suffix}`;
  await setWorkItemCheckpointWithPrior({ workspaceId: o.workspace, harness: o.harness, workItemId: stalled.id }, stalledCheckpoint);
  await setWorkItemCheckpointWithPrior({ workspaceId: o.workspace, harness: o.harness, workItemId: decoy.id }, 'decoy');

  const lock = await sql.reserve();
  const decoyLock = await sql.reserve();
  const decoyWaiter = await sql.reserve();
  let blocker: Promise<{ value?: unknown; error?: unknown }> | undefined;
  let decoyPending: Promise<unknown> | undefined;
  try {
    await lock`BEGIN`;
    const lockedRows = await lock`SELECT scope FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, stalled.id)} FOR UPDATE`;
    assert.equal(lockedRows.length, 1, 'the selected private carry row must actually be locked');
    assert.equal(lockedRows[0].scope, workItemScope(o.harness, stalled.id));
    const [holder] = await lock`SELECT pg_backend_pid() AS pid`;
    const [decoyBackend] = await decoyWaiter`SELECT pg_backend_pid() AS pid`;
    await decoyLock`BEGIN`;
    const decoyRows = await decoyLock`SELECT scope FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, decoy.id)} FOR UPDATE`;
    assert.equal(decoyRows.length, 1);
    decoyPending = decoyWaiter`SELECT scope FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, decoy.id)} FOR UPDATE`
      .then(value => ({ value }), error => ({ error }));
    const waitUntil = async <T>(read: () => Promise<T | undefined>, label: string) => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const found = await read();
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(label);
    };
    const decoyWait = await waitUntil(async () => {
      const rows = await sql<{ pid: number; queryStart: string }[]>`SELECT pid, query_start::text AS "queryStart"
        FROM pg_stat_activity WHERE pid = ${decoyBackend.pid} AND state = 'active' AND wait_event_type = 'Lock'`;
      return rows[0];
    }, 'older competing wait must be observed before dispatching the selected blocked request');
    blocker = invoke('work_items:checkpoint', { id: stalled.id, harness: o.harness, checkpoint: `blocked ${suffix}` })
      .then(value => ({ value }), error => ({ error }));

    const activity = async (): Promise<Activity | undefined> => {
      const rows = await sql<ActivityRow[]>`SELECT pid,
          backend_start::text AS "backendStart", query_start::text AS "queryStart",
          state, wait_event_type AS "waitEventType", query, pg_blocking_pids(pid) AS "blockingPids"
        FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND query LIKE '%harness_shared.carry_notes%'
         AND ${Number(holder.pid)} = ANY(pg_blocking_pids(pid))
       ORDER BY query_start ASC LIMIT 2`;
      assert.ok(rows.length <= 1, 'multiple queries blocked by the selected holder are ambiguous');
      const row = rows[0];
      if (!row) return undefined;
      assert.ok(row.blockingPids.includes(Number(holder.pid)),
        'observed query must be blocked by the exact selected row-lock holder, not the older decoy');
      return { observedAtMs: performance.now(), itemId: stalled.id, pid: Number(row.pid),
        backendStart: row.backendStart, queryStart: row.queryStart, state: row.state,
        waitEventType: row.waitEventType };
    };
    const stallBefore = await waitUntil(activity, 'selected lock wait must be observed');
    assert.ok(stallBefore, 'blocked unrelated control must expose a real PostgreSQL lock wait');
    assert.notEqual(stallBefore.pid, Number(decoyWait.pid));

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
      correlation: { holderPid: Number(holder.pid), lockedScope: lockedRows[0].scope,
        decoyPid: Number(decoyWait.pid), decoyQueryStart: decoyWait.queryStart,
        selectedPid: stallBefore.pid, selectedQueryStart: stallBefore.queryStart },
      requests, observation, hostStopped: false };
  } finally {
    try {
      try { await lock`ROLLBACK`; } finally { lock.release(); }
    } finally {
      try { await decoyLock`ROLLBACK`; } finally { decoyLock.release(); }
      try { await decoyPending; } finally { decoyWaiter.release(); }
      if (blocker) await blocker;
      await sql`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${o.workspace}
        AND scope IN (${workItemScope(o.harness, stalled.id)}, ${workItemScope(o.harness, unrelated.id)}, ${workItemScope(o.harness, decoy.id)})`;
      await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${o.workspace}
        AND harness_slug = ${o.harness} AND feature_id IN (${stalled.id}, ${unrelated.id}, ${decoy.id})`;
    }
  }
}
