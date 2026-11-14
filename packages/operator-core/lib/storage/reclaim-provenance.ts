/** Reclaim's view of the existing boot artifact and kernel process witness.
 * No checkout read can substitute for what the owning process actually loaded. */
import { z } from 'zod';
import type { OperatorArtifactIdentity } from '../release/operator-artifact';
import type { ServingHostIdentity } from '../serving-host-identity';

export const RECLAIM_SOURCE_PATHS = [
  'packages/operator-core/lib/storage/disk-reclaim.ts',
  'packages/operator-core/lib/storage/disk-consumer-census.ts',
  'packages/operator-core/lib/storage/retention-census-walk.ts',
  'packages/operator-core/lib/storage/retention-policy.ts',
  'packages/operator-core/lib/storage/reclaim-provenance.ts',
] as const;
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceBlobs = z.record(z.string(), objectId).refine(map =>
  Object.keys(map).length === RECLAIM_SOURCE_PATHS.length && RECLAIM_SOURCE_PATHS.every(path => Object.hasOwn(map, path)),
'The exact maintained reclaim input population is required.');

/** Stored on the governed instrument check, never accepted from a supplied score. */
export const durableHeadroomBindingSchema = z.object({
  readinessRunId: z.string().trim().min(1).max(512),
  runtimeHost: z.string().trim().min(1).max(253),
  sourceSha: objectId, sourceBlobs,
}).strict();
export type DurableHeadroomBinding = z.infer<typeof durableHeadroomBindingSchema>;
export const reclaimRuntimeSchema = z.object({
  service: z.string().trim().min(1), processId: z.string().trim().min(1),
  artifact: z.object({ sourceSha: objectId, sourceBlobs,
    bundleSha256: digest, manifestSha256: digest, evidenceRef: z.string().trim().min(1) }),
});
export type ReclaimRuntime = z.infer<typeof reclaimRuntimeSchema>;

export function selectReclaimRuntime(artifact: OperatorArtifactIdentity | null, serving: ServingHostIdentity): ReclaimRuntime | null {
  if (artifact?.status !== 'measured') return null;
  const parsed = reclaimRuntimeSchema.safeParse({ service: serving.host, processId: serving.processId,
    artifact: { ...artifact, sourceBlobs: Object.fromEntries(RECLAIM_SOURCE_PATHS.map(path => [path, artifact.sourceBlobs[path]])) } });
  return parsed.success ? parsed.data : null;
}

export async function captureReclaimRuntime(): Promise<ReclaimRuntime | null> {
  try {
    const [{ runtimeObservabilityHealth }, { getServingHostIdentity }] = await Promise.all([
      import('../observability/runtime'), import('../serving-host-identity'),
    ]);
    return selectReclaimRuntime(runtimeObservabilityHealth().artifact, getServingHostIdentity());
  } catch { return null; }
}

export function sameReclaimRuntime(a: ReclaimRuntime, b: ReclaimRuntime): boolean {
  return a.service === b.service && a.processId === b.processId &&
    a.artifact.sourceSha === b.artifact.sourceSha && a.artifact.bundleSha256 === b.artifact.bundleSha256 &&
    a.artifact.manifestSha256 === b.artifact.manifestSha256 && a.artifact.evidenceRef === b.artifact.evidenceRef &&
    RECLAIM_SOURCE_PATHS.every(path => a.artifact.sourceBlobs[path] === b.artifact.sourceBlobs[path]);
}

const completionBindingSchema = z.object({
  workspaceId: z.string().min(1), harnessSlug: z.string().min(1),
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/),
  runtime: reclaimRuntimeSchema.extend({ service: z.literal('port-3271'),
    processId: z.string().regex(/^linux:[a-f0-9-]{36}:[0-9]+$/) }),
  acceptedAt: z.string().datetime({ offset: true }),
  integrationTestRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  isolatedRunId: z.string().regex(/^\d{8}T\d{6}Z-\d+(?:\.\d+)?$/),
}).strict();
export type ReclaimCompletionBinding = z.infer<typeof completionBindingSchema>;

/** Generate R-6's governed SELECT from the accepted original runtime/proof.
 * This extends the existing audit/proof ledgers; it neither observes a checkout
 * nor performs reclaim. Publish the returned SQL through rubrics:amend, after
 * qualification. Generating it alone does not change the acceptance check.
 *
 * The original integration row must be clean at the accepted artifact commit.
 * A later successful test or later acceptance cannot qualify historical runs.
 */
export function reclaimCompletionSql(input: ReclaimCompletionBinding): string {
  const binding = completionBindingSchema.parse(input);
  const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
  const runtime = literal(JSON.stringify(binding.runtime));
  return `WITH w AS (SELECT date_trunc('hour',now()-interval '15 minutes') AS e),
bounds AS (SELECT e-interval '24 hours' AS b,e FROM w),
accepted AS (SELECT ${runtime}::jsonb AS runtime,${literal(binding.acceptedAt)}::timestamptz AS at),
proof AS (SELECT t.id FROM harness_shared.test_runs t,accepted q,bounds w
 WHERE t.id=${binding.integrationTestRunId} AND t.workspace_id=${literal(binding.workspaceId)}
 AND t.harness_slug=${literal(binding.harnessSlug)}
 AND t.file_path='packages/operator-core/lib/storage/disk-reclaim-background-runtime.integration.test.ts'
 AND t.status='pass' AND t.worktree_dirty=false AND t.commit_sha=q.runtime->'artifact'->>'sourceSha'
 AND t.finished_at>=t.started_at AND t.finished_at<=q.at AND q.at<=w.b-interval '15 minutes'
 AND t.execution_details->>'testLayer'='integration'
 AND t.execution_details->'failed'='0'::jsonb AND t.execution_details->'collectionFailed'='false'::jsonb
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.execution_details->'isolatedRuntimeReceipts')='array'
 THEN t.execution_details->'isolatedRuntimeReceipts' ELSE '[]'::jsonb END) x
 WHERE x->>'runId'=${literal(binding.isolatedRunId)} AND x->>'resultSha256' ~ '^[a-f0-9]{64}$'
 AND x->>'sourceSha256' ~ '^[a-f0-9]{64}$' AND x->>'lifecycleSha256' ~ '^[a-f0-9]{64}$')),
a AS (SELECT l.id,l.ts,l.action,l.details d,
 CASE WHEN pg_input_is_valid(l.details->>'startedAt','timestamp with time zone') THEN (l.details->>'startedAt')::timestamptz END s,
 CASE WHEN pg_input_is_valid(l.details->>'finishedAt','timestamp with time zone') THEN (l.details->>'finishedAt')::timestamptz END f
 FROM harness_shared.audit_log l,bounds w WHERE l.workspace_id=${literal(binding.workspaceId)} AND l.actor='system:disk-retention'
 AND l.action IN ('disk-retention:started','disk-retention:receipt')
 AND l.ts>=extract(epoch FROM w.b-interval '15 minutes')*1000 AND l.ts<=extract(epoch FROM w.e+interval '15 minutes')*1000
 AND l.details->'dryRun' IS DISTINCT FROM 'true'::jsonb
 -- Only a positively identified foreign host is outside this population.
 AND (l.details->>'host'=${literal(binding.host)} OR jsonb_typeof(l.details->'host') IS DISTINCT FROM 'string'
 OR l.details->>'host' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$')),
s AS (SELECT a.* FROM a,bounds w WHERE action='disk-retention:started' AND ts<extract(epoch FROM w.e)*1000),
r AS (SELECT a.* FROM a,bounds w WHERE action='disk-retention:receipt'
 AND (ts>=extract(epoch FROM w.b)*1000 OR EXISTS(SELECT 1 FROM s WHERE s.d->>'id'=a.d->>'id'))),
invalid AS (SELECT 1 FROM s,bounds w,accepted q WHERE s.s IS NULL OR s.s<w.b-interval '15 minutes' OR s.s>=w.e OR s.s<q.at
 OR jsonb_typeof(d->'id') IS DISTINCT FROM 'string' OR COALESCE(btrim(d->>'id'),'')=''
 OR d->'dryRun' IS DISTINCT FROM 'false'::jsonb OR d->>'host' IS DISTINCT FROM ${literal(binding.host)}
 OR d->'runtime' IS DISTINCT FROM q.runtime
 OR (SELECT count(*) FROM r WHERE r.d->>'id'=s.d->>'id' AND r.d->>'startedAt'=s.d->>'startedAt' AND r.d->>'host'=s.d->>'host')<>1
 UNION ALL SELECT 1 FROM r,accepted q WHERE s IS NULL OR f IS NULL OR f<s OR f>s+interval '15 minutes' OR s<q.at
 OR d->'dryRun' IS DISTINCT FROM 'false'::jsonb OR d->'runtime' IS DISTINCT FROM q.runtime
 OR d->'complete' IS DISTINCT FROM 'true'::jsonb OR d->'policyExhausted' IS DISTINCT FROM 'true'::jsonb OR d->'errors' IS DISTINCT FROM '[]'::jsonb
 OR jsonb_typeof(d->'entries') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'delegates') IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d->'entries')='array' THEN d->'entries' ELSE '[]'::jsonb END) x WHERE x->>'status'='failed')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d->'delegates')='array' THEN d->'delegates' ELSE '[]'::jsonb END) x WHERE x->'ok' IS DISTINCT FROM 'true'::jsonb)
 OR NOT EXISTS(SELECT 1 FROM s WHERE s.d->>'id'=r.d->>'id' AND s.d->>'startedAt'=r.d->>'startedAt' AND s.d->>'host'=r.d->>'host')),
coverage AS (SELECT bool_and(EXISTS(SELECT 1 FROM s WHERE ts>=extract(epoch FROM w.b+h*interval '1 hour')*1000
 AND ts<extract(epoch FROM w.b+(h+1)*interval '1 hour')*1000)) ok FROM bounds w CROSS JOIN generate_series(0,23) h)
SELECT CASE WHEN EXISTS(SELECT 1 FROM proof) AND (SELECT ok FROM coverage)
 AND (SELECT count(*)=count(DISTINCT d->>'id') FROM s) AND (SELECT count(*)=count(DISTINCT d->>'id') FROM r)
 AND NOT EXISTS(SELECT 1 FROM invalid) THEN 'pass' ELSE 'unknown-or-failed' END verdict,
 (SELECT b FROM bounds) window_start,(SELECT e FROM bounds) window_end,
 (SELECT array_agg(id ORDER BY ts,id) FROM s) start_audit_ids,
 (SELECT array_agg(id ORDER BY ts,id) FROM r) receipt_audit_ids,
 ${binding.integrationTestRunId} integration_test_run_id,EXISTS(SELECT 1 FROM proof) proof_qualified`;
}
