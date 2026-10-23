/** Live evidence acquisition for rubric checks; fixture validators remain tree controls. */
import { getOrgPg } from '@papercusp/db-org';
import { getServingHostIdentity } from '../serving-host-identity';
import { gitPipelinePosition } from '../git-pipeline-position';
import { runtimeObservabilityHealth } from './runtime';
import { readConfiguredTraceProject, type ObservedProjectEvent } from './project-readback';
import { OBSERVABILITY_INSTRUMENT_KEYS } from './instrument-keys';
const COMPOSITION_PATHS = [
  'packages/operator-core/lib/observability/runtime.ts',
  'packages/operator-core/lib/observability/tracing.ts',
  'packages/operator-core/lib/observability/posthog-exporter.ts',
  'packages/operator-core/lib/projected-tool-deps.ts',
  'packages/operator-core/lib/inference-gateway/gateway.ts',
  'apps/operator/bin/host-bootstrap.ts',
];
interface InvocationObservation {
  id: string; callId: string; traceId: string; spanId: string;
  status: string; startedAt: number; endedAt: number;
}
type Verdict = { verdict: 'pass' | 'fail' | 'unknown'; detail: string };

/** The input scopes a query; it cannot supply observations, identities or a pass.
 * Run on the current-build operator. A background/release process cannot stand
 * in for staging. No consent changes or synthetic capture happen in this read. */
export async function measureOperationalObservability(
  mode: keyof typeof OBSERVABILITY_INSTRUMENT_KEYS,
  scope: { workspaceId: string; harnessSlug?: string },
): Promise<Verdict> {
  const unknown = (reason: string): Verdict => ({ verdict: 'unknown', detail: reason });
  const fail = (reason: string): Verdict => ({ verdict: 'fail', detail: reason });
  if (!scope.workspaceId || !scope.harnessSlug) return unknown('Concrete workspace and harness required.');
  try {
    const host = getServingHostIdentity();
    if (host.host !== 'port-3170' || !host.processId || !host.buildSha) return unknown('Current-build staging process identity unavailable; run on :3170.');
    const health = runtimeObservabilityHealth();
    if (!health.initialized || !health.globalProviderRegistered) return fail('Current staging process lacks the registered tracing provider.');
    // Inspect source/runtime containment, without acting on or grading the gate.
    for (const path of COMPOSITION_PATHS) {
      const position = await gitPipelinePosition({ path });
      const runtime = position.servingRuntimes.find(row => row.runtime === 'staging-operator');
      if (!runtime || runtime.containsChange === null || !runtime.buildSha) return unknown('Source/runtime containment unreadable: ' + path);
      if (runtime.containsChange !== true || !(runtime.buildSha.startsWith(host.buildSha) || host.buildSha.startsWith(runtime.buildSha))) {
        return fail('Serving source/build mismatch: ' + path);
      }
    }
    const { sql } = getOrgPg();
    // Select only identity/timing fields, never args, output, prompts or errors.
    const rows = await sql<InvocationObservation[]>`
      SELECT id::text AS id, metadata_json->'otel'->>'callId' AS "callId",
        metadata_json->'otel'->>'traceId' AS "traceId", metadata_json->'otel'->>'spanId' AS "spanId", status,
        (extract(epoch FROM invoked_at) * 1000 - duration_ms)::float8 AS "startedAt",
        (extract(epoch FROM invoked_at) * 1000)::float8 AS "endedAt"
      FROM harness_shared.tool_invocations
      WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
        AND serving_process_id = ${host.processId} AND serving_build_sha = ${host.buildSha}
        AND invoked_at >= now() - interval '240 seconds' AND metadata_json->'otel' IS NOT NULL
      ORDER BY id DESC LIMIT 16`;
    const valid = rows.filter(row => typeof row.callId === 'string' && row.callId.length > 0 &&
      /^[a-f0-9]{32}$/.test(row.traceId) && !/^0+$/.test(row.traceId) &&
      /^[a-f0-9]{16}$/.test(row.spanId) && !/^0+$/.test(row.spanId) &&
      Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt) && row.endedAt >= row.startedAt);
    if (!valid.length) return unknown('No fresh invocation identity with persisted call/trace/span metadata.');
    const project = await readConfiguredTraceProject([...new Set(valid.map(row => row.traceId))]);
    if (project.status !== 'available') return { verdict: project.status === 'broken' ? 'fail' : 'unknown', detail: project.reason };
    const now = project.queriedAt;
    const measured: Array<{ row: InvocationObservation; generation: boolean; error: boolean }> = [];
    for (const row of valid) {
      const events = project.events.filter(event => event.traceId === row.traceId);
      const tools = events.filter(event => event.spanId === row.spanId && event.event !== '$exception');
      if (!tools.length) {
        if (now - row.endedAt >= 120_000) return fail('Fresh tool event absent after ingestion bound; invocation=' + row.id);
        continue;
      }
      if (tools.some(event => event.callId !== row.callId)) return fail('Persisted invocation and project call identity differ; invocation=' + row.id);
      const reachable = (event: ObservedProjectEvent): boolean => {
        const seen = new Set<string>();
        let parent = event.parentSpanId;
        while (parent && !seen.has(parent)) {
          if (parent === row.spanId) return true;
          seen.add(parent);
          const edges = events.filter(edge => edge.spanId === parent && edge.event !== '$exception');
          const signatures = new Set(edges.map(edge => JSON.stringify([edge.parentSpanId, edge.callId])));
          if (!edges.length || signatures.size !== 1 || edges[0]!.callId !== row.callId) return false;
          parent = edges[0]!.parentSpanId;
        }
        return false;
      };
      const generations = events.filter(event => event.event === '$ai_generation');
      if (generations.some(event => event.spanId === row.spanId || !reachable(event))) return fail('Model ancestry differs from persisted tool span; invocation=' + row.id);
      if (mode === 'staging' && generations.some(event => event.parentSpanId === row.spanId)) return fail('Current-build model journey lacks its HTTP child span; invocation=' + row.id);
      const exceptions = events.filter(event => event.event === '$exception');
      if (exceptions.some(event => event.spanId !== row.spanId && !reachable(event))) return fail('Exception ancestry differs from persisted tool span; invocation=' + row.id);
      if (now - row.startedAt > 120_000 || row.startedAt > now || row.endedAt > now) continue;
      if (events.some(event => event.timestamp < row.startedAt || event.timestamp > now)) return fail('Project event lies outside the measured journey; invocation=' + row.id);
      measured.push({ row, generation: row.status === 'ok' && generations.some(event => !event.isError),
        error: row.status !== 'ok' && exceptions.some(event => event.isError) });
    }
    let selected: typeof measured;
    if (mode === 'project') {
      const success = measured.find(item => item.generation);
      const error = measured.find(item => item.error && item.row.callId !== success?.row.callId && item.row.traceId !== success?.row.traceId);
      if (!success || !error) return unknown('Functioning project query; fresh success-model and error observations are not both established.');
      selected = [success, error];
    } else {
      const models = measured.filter(item => item.generation);
      const left = models.find((a, i) => models.slice(i + 1).some(b => a.row.callId !== b.row.callId &&
        a.row.traceId !== b.row.traceId && a.row.spanId !== b.row.spanId && a.row.startedAt < b.row.endedAt && b.row.startedAt < a.row.endedAt));
      const right = left && models.find(b => b !== left && left.row.callId !== b.row.callId && left.row.traceId !== b.row.traceId &&
        left.row.spanId !== b.row.spanId && left.row.startedAt < b.row.endedAt && b.row.startedAt < left.row.endedAt);
      if (!left || !right) return unknown('Two fresh concurrent, disjoint tool/model journeys are not established.');
      selected = [left, right];
    }
    return { verdict: 'pass', detail: JSON.stringify({ detector: OBSERVABILITY_INSTRUMENT_KEYS[mode], version: 1,
      observedAt: now, host, projectId: project.projectId, projectQuery: project.evidenceRef,
      invocations: selected.map(({ row }) => ({ id: row.id, callId: row.callId, traceId: row.traceId, spanId: row.spanId })),
      replay: 'plans:rescore-rubric on :3170 with the same rubric; scorecards:emit fromLedger:true' }) };
  } catch {
    return unknown('Runtime, source or invocation authority unavailable; no acceptance inferred.');
  }
}
