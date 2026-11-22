import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from '@papercusp/hash-chain';
import { z } from 'zod';
import { gitBlobId } from './agent-tools/plans/evidence-measurement-pin';
import type { BlockerEvidenceContext } from './blocker-resolution-evidence';
import type { BlockerEvidenceRef, BlockerSourceObservation } from './blocker-resolution-decision';
import { dispatchReadOnlyTool, getPredicateTimeoutContext } from './events/await/predicate-watch';
import { repoRelativePathUnderRoot } from './git-trackedness';
import { SERVING_RUNTIMES } from './serving-runtimes';
import { activeWorkspaceId } from './workspace-registry';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[a-f0-9]{40}$/);
// These are the original operands of the read-only pipeline tool. In particular,
// dropping an unknown argument could silently select a different revision or scope.
const originalArgs = z.object({
  path: z.string().min(1).max(400), sourceRuntimeOnly: z.literal(true), expectedSourceSha256: digest,
}).strict();
const buildSha = z.string().regex(/^[a-f0-9]{4,40}$/);
const pipelineEvidence = z.object({
  repoRoot: z.string(), submodule: z.string().nullable(),
  acceptedSource: z.object({ expectedSha256: digest, observedSha256: digest, matches: z.literal(true),
    runtimeContainment: z.record(z.string(), z.boolean().nullable()) }),
  servingRuntimes: z.array(z.object({ runtime: z.string(), buildSha: buildSha.nullable(),
    method: z.string().nullable(), containsChange: z.boolean().nullable() })),
  observingRuntime: z.object({ host: z.string(), processId: z.string().min(1), buildSha,
    artifact: z.object({ status: z.literal('measured'), sourceSha: oid, manifestSha256: digest, bundleSha256: digest,
      evidenceRef: z.string().min(1), sourceBlobs: z.record(z.string(), oid) }) }),
});

/** Measure only an original positive containment predicate on the operator that is
 * actually answering. No replay of a registrant's tool, role, or delivery policy.
 * Null leaves the ordinary event reader's unknown/refusal in force. */
export async function measureParkedPredicateSource(
  ref: BlockerEvidenceRef, context: BlockerEvidenceContext,
  park: NonNullable<BlockerEvidenceContext['parkedSource']>, repositoryRoot: () => Promise<string | null>,
): Promise<BlockerSourceObservation | null> {
  const { original, caller } = park;
  const { workspaceId, harnessSlug, workItemId, ownerId } = context;
  const blockers = context.blockers.filter(blocker => blocker.ref === ref.ref && blocker.status === 'active');
  if (!workspaceId || workspaceId !== activeWorkspaceId() || !harnessSlug || !ownerId || ownerId !== context.custodianId ||
      caller.workspaceId !== workspaceId || caller.principal?.workspaceId !== workspaceId ||
      caller.harnessSlug !== harnessSlug || !context.role || caller.role !== context.role ||
      original.workItemId !== workItemId || original.revision !== 1 || original.sessionId !== original.authorId ||
      original.decision.disposition !== 'defer' || !isDeepStrictEqual(original.decision.deferral.recheckRef, ref) ||
      !original.decision.deferral.reasonEvidenceRefs.some(reason => isDeepStrictEqual(reason, ref)) ||
      blockers.length !== 1 || blockers[0].kind !== 'event' || blockers[0].createdBy !== original.authorId) return null;

  const watch = await getPredicateTimeoutContext({ eventKey: ref.ref, subscriberId: original.authorId });
  if (!watch || watch.active !== false || watch.id !== ref.ref.slice('predicate:'.length) || watch.eventKey !== ref.ref ||
      watch.workspaceId !== workspaceId || watch.harnessSlug !== harnessSlug || watch.ownerId !== original.authorId ||
      watch.tool !== 'dev:pipeline_position' || watch.op !== 'eq' || watch.value !== true ||
      !(Date.parse(watch.createdAt) <= Date.parse(blockers[0].createdAt) &&
        Date.parse(blockers[0].createdAt) <= Date.parse(original.recordedAt)) ||
      (watch.boundTo !== null && !isDeepStrictEqual(watch.boundTo, { kind: 'work-item', ref: workItemId }))) return null;
  const runtime = (['staging-operator', 'release-operator'] as const).find(
    id => watch.path === 'acceptedSource.runtimeContainment.' + id);
  const args = originalArgs.safeParse(watch.args);
  if (!runtime || !args.success) return null;
  const { path, expectedSourceSha256 } = args.data;
  const root = await repositoryRoot();
  if (!root || path.includes('\\') || path.includes('\0') || repoRelativePathUnderRoot(path, root) !== path) return null;
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot) return null;
  const file = resolve(canonicalRoot, path);
  if (await realpath(file).catch(() => null) !== file || !(await stat(file).catch(() => null))?.isFile()) return null;

  const raw = await dispatchReadOnlyTool('dev:pipeline_position', args.data, {
    workspaceId, harnessSlug, role: context.role, onBehalfOf: ownerId, callerContext: caller,
    signal: context.signal, spawnId: 'blocker-source-remeasurement',
  });
  const parsed = pipelineEvidence.safeParse(raw);
  if (!parsed.success) return null;
  const { repoRoot, submodule, acceptedSource, servingRuntimes, observingRuntime } = parsed.data;
  const { artifact } = observingRuntime;
  const targets = servingRuntimes.filter(entry => entry.runtime === runtime);
  const contains = acceptedSource.runtimeContainment[runtime];
  if (await realpath(repoRoot).catch(() => null) !== canonicalRoot || (submodule !== null && !path.startsWith(submodule + '/')) ||
      acceptedSource.expectedSha256 !== expectedSourceSha256 || acceptedSource.observedSha256 !== expectedSourceSha256 ||
      observingRuntime.host !== 'port-' + SERVING_RUNTIMES[runtime].healthPort ||
      !artifact.sourceSha.startsWith(observingRuntime.buildSha) || typeof contains !== 'boolean' ||
      targets.length !== 1 || targets[0].method !== 'blob' || !targets[0].buildSha ||
      !artifact.sourceSha.startsWith(targets[0].buildSha) || targets[0].containsChange !== contains) return null;

  // Join the frozen SHA-256 and the boot manifest's Git OID using the SAME
  // bytes. A moved file, absent entry, or disagreeing process stays unmeasured.
  const bytes = await readFile(file).catch(() => null);
  if (!bytes || await realpath(file).catch(() => null) !== file ||
      createHash('sha256').update(bytes).digest('hex') !== expectedSourceSha256) return null;
  const observedBlob = gitBlobId(bytes);
  if (!Object.hasOwn(artifact.sourceBlobs, path)) return null;
  const artifactBlob = artifact.sourceBlobs[path];
  if (!artifactBlob || (artifactBlob === observedBlob) !== contains) return null;
  return { kind: 'pinned-operator-source', eventKey: ref.ref, workspaceId, harness: harnessSlug, workItemId,
    priorDecisionId: original.id, priorRequestHash: original.requestHash, registeredAt: watch.createdAt,
    registrantId: original.authorId, custodianId: ownerId, repositoryRoot: canonicalRoot, submodule,
    filePath: path, expectedSourceSha256, observedBlob, runtime, host: observingRuntime.host,
    processId: observingRuntime.processId, artifactCommit: artifact.sourceSha, artifactBlob,
    manifestSha256: artifact.manifestSha256, bundleSha256: artifact.bundleSha256, artifactRef: artifact.evidenceRef,
    responseSha256: createHash('sha256').update(canonicalJson(raw)).digest('hex'),
    observedAt: new Date().toISOString(), condition: contains ? 'satisfied' : 'pending' };
}
