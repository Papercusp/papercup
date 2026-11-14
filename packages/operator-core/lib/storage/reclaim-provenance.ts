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
