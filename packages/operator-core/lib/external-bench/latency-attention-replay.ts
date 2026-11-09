/** T06 trusted host lifecycle; never called by a solver tool. Uses the existing
 * assignment lease/result checkpoint and the real private-DB write/listen rail.
 * A failed or interrupted replay cannot be silently repeated in one assignment. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { canonicalJson } from './reproducibility/canonical-json';
import { resolveDb, type DbScope } from './reproducibility/db';
import { benchFixtureBoundarySchema, benchFixtureProductCall, benchFixtureResultSnapshot,
  requireBenchFixtureReadLease, requireBenchFixtureSourcePins, type BenchFixtureReadBoundary } from './private-fixture-reads';
import { observeLatencyAttentionCache } from './latency-attention-observer';
import { getOperatorCache, installOperatorCache, cacheLayerEnabled } from '../cache/instance';
import { l2TierEnabled } from '../cache/l2-tier';
import { snapshotCachedReadStats } from '../cache/cached-read';
import { coordSql } from '../agent-tools/coordination/log';
import { ADMIN_COORD_UI_OWNER } from '../agent-tools/coordination/identity';
import { ensureInvalidationListener } from '../sync-sse';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { runWithWorkspace } from '../workspace-als';
import { deriveAttentionRefs } from '../sync-resolver/attention-counts';
import attention from '../agent-tools/plans/attention';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';

let active = false;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export async function replayLatencyAttentionFixture(rawBoundary: BenchFixtureReadBoundary,
  scope: DbScope, host: { databaseName: string; context: PapercuspUnifiedToolContext }) {
  if (active) throw new Error('Private attention requires one exclusive leased T06 host.');
  active = true;
  try { return await replay(rawBoundary, scope, host); }
  finally { active = false; }
}

async function replay(rawBoundary: BenchFixtureReadBoundary,
  scope: DbScope, host: { databaseName: string; context: PapercuspUnifiedToolContext }) {
  const boundary = benchFixtureBoundarySchema.parse(rawBoundary);
  if (boundary.taskId !== 'LATENCY-M1:T06' || !boundary.lease)
    throw new Error('Private attention requires one exclusive leased T06 host.');
  const { sql, ws } = resolveDb(scope), input = boundary.cases.A.input;
  if (ws !== boundary.workspaceId || ws !== input.workspace || host.context.workspaceId !== ws ||
      canonicalJson(input) !== canonicalJson(boundary.cases.B.input) ||
      boundary.cases.A.viewWorkspaceId !== input.workspace || boundary.cases.B.viewWorkspaceId !== input.otherWorkspace)
    throw new Error('Private attention requires identical frozen inputs and the exact main/isolation views.');
  // Read-only identity checks precede ALL writes. Both real source pools and
  // the real sync listener must target the same owned throwaway database.
  if (!host.databaseName.startsWith('org_') ||
      decodeURIComponent(new URL(getHarnessAdminUrl()).pathname.slice(1)) !== host.databaseName)
    throw new Error('Private attention refuses a non-private listener database.');
  for (const client of [sql, getOrgPg().sql, coordSql()]) {
    const [row] = await client`SELECT current_database() AS name`;
    if (row?.name !== host.databaseName) throw new Error('Private attention source database differs.');
  }
  await requireBenchFixtureReadLease(boundary, scope);
  await requireBenchFixtureSourcePins(boundary, scope);
  const call = (which: 'A' | 'B') => benchFixtureProductCall(boundary, { operation: 'attention', case: which });
  const replayHash = digest(boundary);
  const retained = await sql.begin(async tx => {
    const [row] = await tx`SELECT config->'privateFixtureReads'->${boundary.assignmentId} AS slot
      FROM harness_shared.bench_runs WHERE workspace_id = ${ws} AND id = ${boundary.lease!.hostRunId} FOR UPDATE`;
    const prior = row?.slot?.attentionReplay;
    if (prior) {
      if (prior.boundarySha256 !== replayHash || prior.status !== 'complete')
        throw new Error('Private attention replay is already running, failed or changed; it cannot be repeated.');
      return true;
    }
    await requireBenchFixtureReadLease(boundary, { sql: tx as unknown as typeof sql, workspaceId: ws });
    await tx`UPDATE harness_shared.bench_runs SET config = jsonb_set(config,
      ${['privateFixtureReads', boundary.assignmentId, 'attentionReplay']}::text[],
      ${JSON.stringify({ status: 'running', boundarySha256: replayHash })}::text::jsonb)
      WHERE workspace_id = ${ws} AND id = ${boundary.lease!.hostRunId}`;
    return false;
  });
  if (retained) return { A: await benchFixtureResultSnapshot(boundary, call('A'), scope),
    B: await benchFixtureResultSnapshot(boundary, call('B'), scope) };

  const original = getOperatorCache(), observer = observeLatencyAttentionCache(original, snapshotCachedReadStats);
  const notifications: Array<{ atMs: number; payload: string }> = [];
  const phases: Array<Record<string, unknown>> = [], reads: Array<Record<string, unknown>> = [];
  const normalizedContents: Record<string, unknown> = {};
  let listener: Awaited<ReturnType<typeof sql.listen>> | undefined;
  const setStatus = async (status: 'complete' | 'failed', error?: unknown) => {
    await sql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config,
      ${['privateFixtureReads', boundary.assignmentId, 'attentionReplay']}::text[],
      ${JSON.stringify({ status, boundarySha256: replayHash, ...(error ? { error: String(error) } : {}) })}::text::jsonb)
      WHERE workspace_id = ${ws} AND id = ${boundary.lease!.hostRunId}
        AND config->'privateFixtureReads'->${boundary.assignmentId}->'attentionReplay'->>'boundarySha256' = ${replayHash}`;
  };
  try {
    const existing = await sql`SELECT msg_id FROM harness_shared.coord_event_log
      WHERE workspace_id = ANY(${[input.workspace, input.otherWorkspace]}) AND surface = 'messages' LIMIT 1`;
    if (existing.length) throw new Error('Private attention replay requires untouched private message sources.');
    const triggers = await sql`SELECT t.tgname, pg_get_triggerdef(t.oid) AS trigger_definition,
      pg_get_functiondef(t.tgfoid) AS function_definition FROM pg_trigger t
      WHERE t.tgrelid = 'harness_shared.coord_event_log'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`;
    if (!triggers.length) throw new Error('Private attention has no loaded coordination trigger.');
    listener = await sql.listen('sync_invalidate', payload => { notifications.push({ atMs: performance.now(), payload }); });
    if (!await ensureInvalidationListener({ attempts: 1 })) throw new Error('Private attention listener is not ready.');
    const listenerReadyAtMs = performance.now();
    installOperatorCache(observer.cache);
    const capturePhase = async (label: string) => {
      const rows = await sql`SELECT workspace_id, writer_key, msg_id, body, ts FROM harness_shared.coord_event_log
        WHERE workspace_id = ANY(${[input.workspace, input.otherWorkspace]}) AND surface = 'messages'
        ORDER BY workspace_id, msg_id`;
      phases.push({ label, atMs: performance.now(), rows, sha256: digest(rows) });
    };
    const insert = async (message: { msg_id: string; from: string; ts: string }) => {
      await requireBenchFixtureReadLease(boundary, scope);
      await sql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, ts)
        VALUES (${input.workspace}, 'messages', ${message.from}, ${message.msg_id},
          ${JSON.stringify(message)}::text::jsonb, ${message.ts}::timestamptz)`;
    };
    const read = async (label: string, workspaceId = input.workspace) => {
      await requireBenchFixtureReadLease(boundary, scope);
      const startedAtMs = performance.now();
      const response = await runWithWorkspace(workspaceId, () => attention.handler(
        { harnessSlug: input.harness, limit: null }, { ...host.context, workspaceId }));
      const completedAtMs = performance.now(); // Drain is explicitly outside handler time.
      if (!('data' in response)) throw new Error('Private attention handler returned no structured data.');
      const data = response.data as { groups: Parameters<typeof deriveAttentionRefs>[0] };
      // Preserve each complete JSON value once. Every sampled handler return
      // still has its own clock/key/ref; repeated content consumes no extra
      // multi-MB checkpoint budget. No source rows or fields are filtered.
      const normalized = JSON.parse(JSON.stringify(data)), normalizedContentsSha256 = digest(normalized);
      normalizedContents[normalizedContentsSha256] ??= normalized;
      const entry = { label, workspaceId, startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs,
        normalizedContentsSha256, ids: deriveAttentionRefs(data.groups).map(row => row.id).sort(),
        effectiveCacheConfiguration: { cacheLayerEnabled: cacheLayerEnabled(), l2TierEnabled: l2TierEnabled() } };
      reads.push(entry);
      await observer.drain();
      return entry;
    };
    const buildCount = () => observer.snapshot().factories.filter(row => row.workspaceId === input.workspace)
      .reduce((total, row) => total + (row.sourceBuilds ?? 0), 0);
    const afterEvent = async (label: string, eventAtMs: number, beforeBuilds: number) => {
      const configuration = observer.snapshot().lookups.find(row => row.workspaceId === input.workspace)?.options;
      const deadline = eventAtMs + Math.min(45_000, Math.max(1000, configuration?.softTtlMs ?? 0) + 5000);
      // Observe until an actual source build has completed, not until an oracle
      // matches. The frozen admin/UI-principal mismatch must survive this wait.
      do {
        await read(label);
        if (buildCount() > beforeBuilds) return read(label + ':settled');
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (performance.now() < deadline);
      throw new Error('Private attention did not observe a settled source build in its bounded phase.');
    };
    await capturePhase('empty');
    for (const message of input.seedMessages) await insert(message);
    await capturePhase('seeded');
    await read('before'); await read('before:isolation', input.otherWorkspace);
    for (const message of input.unrelatedMessages) { await insert(message); await read('unrelated:' + message.msg_id); }
    await capturePhase('after-unrelated');
    const beforeRelevant = buildCount(), relevantAtMs = performance.now();
    await insert(input.relevantMessage); await afterEvent('after-relevant', relevantAtMs, beforeRelevant);
    await capturePhase('after-relevant');
    const acknowledgment = { msg_id: input.acknowledgment.msgId + ':ack', from: input.acknowledgment.acker,
      kind: 'ack', to: [input.seedMessages.find(row => row.msg_id === input.acknowledgment.msgId)!.from],
      related_msg_id: input.acknowledgment.msgId, ts: new Date(input.acknowledgment.atMs).toISOString() };
    const beforeAck = buildCount(), acknowledgmentAtMs = performance.now();
    await insert(acknowledgment); await afterEvent('after-acknowledgment', acknowledgmentAtMs, beforeAck);
    await capturePhase('after-acknowledgment'); await read('after:isolation', input.otherWorkspace);
    const observation = observer.snapshot();
    if (observation.attribution === 'unavailable')
      throw new Error('Private attention source-build attribution is unavailable: ' + observation.issues.join(', '));
    const common = { phase: 'host-observation', inputSha256: digest(input), database: host.databaseName,
      listenerReadyAtMs, triggers, notifications, phaseSnapshots: phases,
      acknowledgmentEncoding: { input: input.acknowledgment, storedEnvelope: acknowledgment,
        readerPrincipal: ADMIN_COORD_UI_OWNER, matchesReaderPrincipal: input.acknowledgment.acker === ADMIN_COORD_UI_OWNER },
      cache: observation, relevantAtMs, acknowledgmentAtMs,
      normalizationEncoding: 'normalizedContentsSha256 references complete JSON values in normalizedContents',
      limitations: ['Host apparatus evidence; native/provider/runtime qualification and task acceptance are separate.',
        'Full normalized output retains static registry sources and observed-versus-reference differences.'] };
    await requireBenchFixtureSourcePins(boundary, scope);
    const view = (workspaceId: string) => {
      const selected = reads.filter(row => row.workspaceId === workspaceId);
      return { ...common, viewWorkspaceId: workspaceId, reads: selected,
        normalizedContents: Object.fromEntries([...new Set(selected.map(row => row.normalizedContentsSha256 as string))]
          .map(key => [key, normalizedContents[key]])) };
    };
    const A = await benchFixtureResultSnapshot(boundary, call('A'), scope,
      JSON.stringify(view(input.workspace)));
    const B = await benchFixtureResultSnapshot(boundary, call('B'), scope,
      JSON.stringify(view(input.otherWorkspace)));
    await requireBenchFixtureReadLease(boundary, scope);
    await setStatus('complete');
    return { A, B };
  } catch (error) {
    await setStatus('failed', error); throw error;
  } finally {
    try { await observer.drain(); } finally {
      installOperatorCache(original); await listener?.unlisten();
    }
  }
}
