/**
 * `release:byoc_readiness` — computed, read-only BYOC acceptance evidence.
 *
 * Unregistered draft. The exact task-ledger journal supplies identity and
 * negative evidence only: committed receipts cannot prove acceptance outcomes.
 * Until the source observation joins are implemented this reader reports the
 * unresolved proof obligations and can never return a positive verdict.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import type { Sql } from 'postgres';
import {
  deriveWorkspaceHostCanonicalArtifactUrls,
} from '@papercusp/deployment-driver';
import { taskReleaseJournalFromDetail, type TaskReleaseJournal } from '../../task-manager/store';
import { releaseStageInputHash } from '../../../../../scripts/lib/release-task-journal';
import {
  projectByocReleaseCarry,
  type ByocReleaseCarrySnapshot,
  type ByocReleaseMilestoneKey,
} from '../../byoc-release-carry';
import {
  workspaceHostPublicationManifestFailures,
  WORKSPACE_HOST_PUBLICATION_KIND,
  WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION,
  WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS,
  WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
  WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME,
  type WorkspaceHostPublicationManifest,
  type WorkspaceHostPublicationManifestInput,
} from '../../workspace-host/publication-manifest';

export type ByocAcceptanceBar = 'R-4' | 'R-5' | 'R-6';
export type ByocReadinessVerdict = 'pass' | 'fail' | 'unknown';

const BAR_MILESTONES: Record<ByocAcceptanceBar, readonly ByocReleaseMilestoneKey[]> = {
  'R-4': ['build', 'publication'],
  'R-5': ['root-bootstrap', 'fixed-agent-initialization', 'customer-acceptance'],
  // Shipment consumes acceptance; it cannot be a prerequisite for grading it.
  'R-6': ['soak-24h', 'resource-census', 'billing-closure', 'cleanup'],
};

/**
 * Open proof obligations, NOT a schema agents can populate with `verified:true`.
 * A release receipt proves a driver transition, not any of these outcomes.
 * Keep this draft incapable of passing until maintained readers actually join
 * and validate the source observations. Do not register it as a grading probe.
 */
const UNJOINED_EVIDENCE: Record<ByocAcceptanceBar, readonly string[]> = {
  'R-4': ['public-bytes', 'manifest-archive-digest', 'signature', 'sbom', 'executable-identity'],
  'R-5': ['clean-gcp-controller', 'claude-execution', 'omp-execution', 'credentials', 'acl', 'data', 'customer-desktop'],
  'R-6': ['five-live-journeys', '24h-soak', 'budget', 'billing', 'destroy', 'provider-absence', 'eight-kind-residue'],
};

export interface ByocPublicationProbeInput {
  bundleSha256: string;
  manifestSha256: string;
  taskId?: string;
  operationId?: string;
  expectedArtifactIdentity?: {
    sourceSha?: string;
    version?: string;
  };
}

export interface ByocPublicationProbeResult {
  verdict: 'pass' | 'fail' | 'unknown';
  /** Only checks actually discharged by this reader, never claims copied from the manifest. */
  verified: string[];
  missing: string[];
  failed: string[];
  evidenceRefs: string[];
}

type PublicationProbeResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'body'>;

interface PublicationProbeFetcher {
  (
    input: string,
    init?: {
      method?: string;
      redirect?: 'error';
      credentials?: 'omit';
      signal?: AbortSignal;
    },
  ): Promise<PublicationProbeResponse>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isPublicationManifestShape(value: unknown): value is WorkspaceHostPublicationManifest {
  if (!isRecord(value)) return false;
  const files = value.files;
  const artifact = value.artifact;
  const trustReport = value.trustReport;
  return (
    isRecord(artifact) &&
    isRecord(artifact.release) &&
    isRecord(files) &&
    isRecord(files.bundle) &&
    isRecord(files.signature) &&
    isRecord(trustReport) &&
    isRecord(trustReport.subject) &&
    isRecord(trustReport.policy) &&
    Array.isArray(trustReport.evidence) &&
    trustReport.evidence.every(isRecord) &&
    Array.isArray(trustReport.failures)
  );
}

// Match the publisher's object limits. In particular, real bundles use multipart (up to
// 1024 * 32 MiB), not its much smaller direct-PUT limit. Bundle bytes are hashed, never retained.
const MAX_PUBLICATION_MANIFEST_BYTES = 1024 * 1024;
const MAX_PUBLICATION_BUNDLE_BYTES = 1024 * 32 * 1024 * 1024;
const MAX_PUBLICATION_SIGNATURE_BYTES = 64 * 1024;
const PUBLICATION_FETCH_TIMEOUT_MS = 300_000;

async function readPublicationObject(
  response: PublicationProbeResponse,
  maxBytes: number,
  retain = false,
): Promise<{ sha256: string; bytes: number; payload: Uint8Array | null }> {
  const rawSize = response.headers.get('content-length');
  const declaredBytes = rawSize === null ? null : Number(rawSize);
  if (declaredBytes !== null && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes)) {
    await response.body?.cancel();
    throw new Error('invalid-or-excessive-content-length');
  }
  if (!response.body) throw new Error('missing-body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error('bytes-exceed-bound');
      hash.update(next.value);
      if (retain) chunks.push(next.value);
    }
  } catch (error) {
    // Stop a rejected transfer rather than leave a multi-GB body downloading in the background.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('empty-body');
  // Fetch may decode Content-Encoding; only compare wire length for an identity transfer.
  if (!response.headers.get('content-encoding') && declaredBytes !== null && total !== declaredBytes) {
    throw new Error('content-length-mismatch');
  }
  let payload: Uint8Array | null = null;
  if (retain) {
    payload = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  return { sha256: hash.digest('hex'), bytes: total, payload };
}

/**
 * Independently read the immutable public publication named by the selected release receipt.
 * The task journal contributes only the expected digest; public bytes and descriptors come from
 * the consumer-facing artifact origin. A manifest's own `files` object is not trusted until its
 * bytes, bundle bytes and signature bytes all agree.
 */
export async function probeByocPublication(
  input: ByocPublicationProbeInput,
  fetcher: PublicationProbeFetcher = globalThis.fetch,
): Promise<ByocPublicationProbeResult> {
  // Hashing signature bytes is not cryptographic verification; a trust report is not an SBOM.
  const missing: string[] = ['signature', 'sbom', 'executable-identity'];
  const failed: string[] = [];
  const refs: string[] = [];
  const verified: string[] = [];
  const result = (): ByocPublicationProbeResult => ({
    verdict: failed.length > 0 ? 'fail' : 'unknown',
    verified,
    missing: [...new Set(missing)],
    failed: [...new Set(failed)],
    evidenceRefs: [...new Set(refs)],
  });
  if (!/^[a-f0-9]{64}$/.test(input.bundleSha256) || !/^[a-f0-9]{64}$/.test(input.manifestSha256)) {
    failed.push('publication:invalid-digest');
    return result();
  }
  let urls: ReturnType<typeof deriveWorkspaceHostCanonicalArtifactUrls>;
  try {
    urls = deriveWorkspaceHostCanonicalArtifactUrls(input.bundleSha256);
  } catch (error) {
    failed.push(`publication-url:${error instanceof Error ? error.message : String(error)}`);
    return result();
  }

  const requestInit = (): Parameters<PublicationProbeFetcher>[1] => ({
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(PUBLICATION_FETCH_TIMEOUT_MS),
  });
  if (input.taskId) refs.push(`publication:task:${input.taskId}`);
  if (input.operationId) refs.push(`publication:operation:${input.operationId}`);

  const manifestResponse = await fetcher(urls.manifestUrl, requestInit()).catch(() => null);
  if (!manifestResponse || !manifestResponse.ok) {
    await manifestResponse?.body?.cancel().catch(() => undefined);
    missing.push('public-manifest', 'manifest-archive-digest', 'public-bytes');
    return result();
  }
  let manifestBytes: Uint8Array;
  try {
    const observed = await readPublicationObject(manifestResponse, MAX_PUBLICATION_MANIFEST_BYTES, true);
    manifestBytes = observed.payload!;
  } catch (error) {
    failed.push(`public-manifest:${error instanceof Error ? error.message : String(error)}`);
    return result();
  }
  const observedManifestSha = sha256(manifestBytes);
  if (observedManifestSha !== input.manifestSha256) {
    failed.push('manifest-archive-digest:mismatch');
  } else {
    refs.push(`publication:manifest:${observedManifestSha}`);
  }

  let manifest: unknown = null;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    failed.push('manifest:invalid-json');
  }
  if (!isPublicationManifestShape(manifest)) {
    failed.push('manifest:incomplete');
    return result();
  }
  if (
    manifest.schemaVersion !== WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION ||
    manifest.kind !== WORKSPACE_HOST_PUBLICATION_KIND ||
    Object.keys(manifest).some((key) => !(WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS as readonly string[]).includes(key)) ||
    manifest.files.bundle.name !== WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME ||
    manifest.files.signature.name !== WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME
  ) {
    failed.push('manifest:invalid-envelope');
    return result();
  }
  if (failed.length > 0) return result();

  const fetchObject = async (url: string, maxBytes: number, label: string) => {
    try {
      const response = await fetcher(url, requestInit());
      if (!response.ok) {
        await response.body?.cancel();
        missing.push(label);
        return null;
      }
      return await readPublicationObject(response, maxBytes);
    } catch (error) {
      missing.push(label);
      failed.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const [bundle, signature] = await Promise.all([
    fetchObject(urls.bundleUrl, MAX_PUBLICATION_BUNDLE_BYTES, 'public-bytes'),
    fetchObject(urls.signatureUrl, MAX_PUBLICATION_SIGNATURE_BYTES, 'signature'),
  ]);
  if (bundle && signature) {
    const publicationInput: WorkspaceHostPublicationManifestInput = {
      artifact: manifest.artifact,
      trustReport: manifest.trustReport,
      bundle,
      signature,
    };
    try {
      const failures = workspaceHostPublicationManifestFailures(publicationInput);
      failed.push(...failures.map(({ code }) => `publication:${code}`));
    } catch {
      failed.push('publication:malformed-manifest');
      return result();
    }
    if (manifest.files.bundle.sha256 !== input.bundleSha256 || manifest.artifact.release.bundleSha256 !== input.bundleSha256) {
      failed.push('public-bytes:digest-mismatch');
    }
    const expectedSourceSha = input.expectedArtifactIdentity?.sourceSha;
    const expectedVersion = input.expectedArtifactIdentity?.version;
    if (expectedSourceSha && manifest.artifact.buildManifest?.source?.revision !== expectedSourceSha) {
      failed.push('publication:source-identity-mismatch');
    }
    if (
      expectedVersion &&
      (manifest.artifact.release.version !== expectedVersion ||
        manifest.artifact.image?.version !== expectedVersion)
    ) {
      failed.push('publication:version-identity-mismatch');
    }
    if (bundle.sha256 !== input.bundleSha256) {
      failed.push('public-bytes:content-digest-mismatch');
    }
    if (signature.sha256 !== manifest.files.signature.sha256) {
      failed.push('signature:content-digest-mismatch');
    }
    if (manifest.files.bundle.sizeBytes !== bundle.bytes) failed.push('public-bytes:size-mismatch');
    if (manifest.files.signature.sizeBytes !== signature.bytes) failed.push('signature:size-mismatch');
    refs.push(`publication:bundle:${bundle.sha256}:${bundle.bytes}`);
    refs.push(`publication:signature:${signature.sha256}:${signature.bytes}`);
    if (failed.length === 0) verified.push('public-bytes', 'manifest-archive-digest');
  }

  return result();
}

function nonEmptyObject(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' && value[key].trim().length > 0
    ? value[key] as string
    : undefined;
}

/**
 * Receipt strings locate an input tuple; they are NOT acceptance proof. Bind that tuple to
 * publish.finalize's actual input hash before using it for independent public reads.
 * The publisher currently permits logical source/version identity before bundle bytes exist.
 */
export function publicationProbeInputFromJournal(
  journal: TaskReleaseJournal,
): ByocPublicationProbeInput | null {
  const finalizations = journal.receipts.filter(({ stage }) => stage === 'publish.finalize');
  const finalized = finalizations.at(-1);
  if (
    !finalized || finalized.state !== 'committed' ||
    journal.receipts.some(({ operationId }) => operationId !== journal.operationId) ||
    finalizations.some(({ inputHash }) => inputHash !== finalized.inputHash)
  ) return null;
  const manifestDigests = new Set(finalized.evidenceRefs.flatMap((ref) => {
    const match = /^provider:finalization:([a-f0-9]{64})$/.exec(ref);
    return match ? [match[1]] : [];
  }));
  const bundleDigests = new Set(journal.receipts.flatMap((receipt) =>
    receipt.stage === 'publish.multipart.complete' && receipt.state === 'committed'
      ? receipt.evidenceRefs.flatMap((ref) => {
        const match = /^provider:bundle:([a-f0-9]{64})$/.exec(ref);
        return match ? [match[1]] : [];
      })
      : [],
  ));
  const pinnedBundle = stringField(journal.artifactIdentity, 'bundleSha256');
  if (pinnedBundle) {
    if (!/^[a-f0-9]{64}$/.test(pinnedBundle)) return null;
    bundleDigests.add(pinnedBundle);
  }
  // A deduplicated multipart initiation has no separate completion stage.
  for (const receipt of journal.receipts) {
    if (receipt.stage !== 'publish.multipart.initiate' || receipt.state !== 'committed') continue;
    for (const ref of receipt.evidenceRefs) {
      const match = /^provider:bundle:([a-f0-9]{64})$/.exec(ref);
      if (match) bundleDigests.add(match[1]);
    }
  }
  if (bundleDigests.size !== 1 || manifestDigests.size !== 1) return null;
  const bundleSha256 = [...bundleDigests][0];
  const manifestSha256 = [...manifestDigests][0];
  if (releaseStageInputHash({ bundleSha256, manifestSha256 }) !== finalized.inputHash) return null;
  const sourceSha = stringField(journal.source, 'sha');
  const version = stringField(journal.artifactIdentity, 'version');
  if (!sourceSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha)) return null;
  if (!pinnedBundle && (!version || stringField(journal.artifactIdentity, 'sourceSha') !== sourceSha)) return null;
  return {
    bundleSha256,
    manifestSha256,
    operationId: journal.operationId,
    expectedArtifactIdentity: { sourceSha, version },
  };
}

function milestoneFor(snapshot: ByocReleaseCarrySnapshot, key: ByocReleaseMilestoneKey) {
  return snapshot.milestoneProjection.milestones.find((milestone) => milestone.key === key) ?? null;
}

export interface ByocReadinessResult {
  verdict: ByocReadinessVerdict;
  bar: ByocAcceptanceBar;
  workItemId: string;
  measuredAt: string;
  taskIds: string[];
  evidenceRefs: string[];
  missingMilestones: string[];
  failedMilestones: string[];
  contradictions: string[];
  unverifiedEvidence: string[];
  artifactIdentityPresent: boolean;
  releaseTaskSelection: 'explicit' | 'ambiguous' | 'absent';
}

export interface ByocReleaseSubject {
  workspaceId: string;
  workItemId: string;
  taskId: string;
}

export interface ByocReleaseSubjectSnapshot extends ByocReleaseCarrySnapshot {
  publicationInput: ByocPublicationProbeInput | null;
}

/**
 * Acceptance is about one explicitly selected task, not a recent carry window.
 * Scope the SQL itself: an exact task belonging to another workspace or work
 * item must neither supply evidence nor disclose its journal.
 */
export async function readByocReleaseSubject(
  input: ByocReleaseSubject,
  sql: Sql,
): Promise<ByocReleaseSubjectSnapshot | null> {
  if (![input.workspaceId, input.workItemId, input.taskId].every((value) => value.trim().length > 0)) {
    throw new Error('BYOC acceptance requires a non-empty workspace, work item, and explicit task');
  }
  const rows = await sql<Array<{
    task_id: string;
    workspace_id: string;
    work_item_id: string;
    class: string;
    detail: Record<string, unknown> | null;
  }>>`
    SELECT task_id, workspace_id, work_item_id, class, detail
      FROM harness_shared.task_ledger
     WHERE task_id = ${input.taskId}
       AND workspace_id = ${input.workspaceId}
       AND work_item_id = ${input.workItemId}
       AND class = 'deploy'
  `;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.task_id !== input.taskId ||
    row.workspace_id !== input.workspaceId ||
    row.work_item_id !== input.workItemId ||
    row.class !== 'deploy'
  ) return null;
  const journal = taskReleaseJournalFromDetail(row.detail);
  if (!journal || !journal.operationId.trim()) return null;
  // The carry parser validates shape/sequence, not receipt-to-operation identity.
  if (journal.receipts.some((receipt) => receipt.operationId !== journal.operationId)) return null;
  const publicationInput = publicationProbeInputFromJournal(journal);
  return {
    ...projectByocReleaseCarry(row.task_id, row.work_item_id, journal),
    publicationInput: publicationInput ? { ...publicationInput, taskId: row.task_id } : null,
  };
}

export function evaluateByocReadiness(
  bar: ByocAcceptanceBar,
  workItemId: string,
  snapshots: readonly ByocReleaseCarrySnapshot[],
  measuredAt = new Date().toISOString(),
): ByocReadinessResult {
  const taskIds = snapshots.map((snapshot) => snapshot.taskId);
  const evidenceRefs = [...new Set(snapshots.flatMap((snapshot) => snapshot.evidenceRefs))];
  const contradictions = [...new Set(snapshots.flatMap((snapshot) => snapshot.milestoneProjection.contradictions))];
  const missingMilestones: string[] = [];
  const failedMilestones: string[] = [];
  const unverifiedEvidence = [...UNJOINED_EVIDENCE[bar]];
  let artifactIdentityPresent = false;

  for (const snapshot of snapshots) {
    if (snapshot.workItemId !== workItemId) contradictions.push(`${snapshot.taskId}:work-item-identity-mismatch`);
    artifactIdentityPresent ||= nonEmptyObject(snapshot.artifactIdentity);
    for (const key of BAR_MILESTONES[bar]) {
      const milestone = milestoneFor(snapshot, key);
      if (!milestone || milestone.status === 'pending' || milestone.status === 'blocked') {
        missingMilestones.push(`${snapshot.taskId}:${key}`);
      } else if (milestone.status === 'failed') {
        failedMilestones.push(`${snapshot.taskId}:${key}`);
      }
      if (milestone && milestone.status === 'verified' && milestone.evidenceRefs.length === 0) {
        missingMilestones.push(`${snapshot.taskId}:${key}:evidence`);
      }
    }
  }

  if (snapshots.length === 0) {
    return {
      verdict: 'unknown',
      bar,
      workItemId,
      measuredAt,
      taskIds,
      evidenceRefs,
      missingMilestones: ['release-task'],
      failedMilestones,
      contradictions,
      unverifiedEvidence,
      artifactIdentityPresent,
      releaseTaskSelection: 'absent',
    };
  }

  // A work-item can retain multiple historical release tasks. Treating "any of
  // the latest three" as the acceptance subject would let an older successful
  // receipt launder a newer failed attempt. The caller must narrow to one task
  // before this reader can produce a positive verdict.
  if (snapshots.length !== 1) {
    return {
      verdict: 'unknown',
      bar,
      workItemId,
      measuredAt,
      taskIds,
      evidenceRefs,
      missingMilestones: ['release-task-selection'],
      failedMilestones,
      contradictions,
      unverifiedEvidence,
      artifactIdentityPresent,
      releaseTaskSelection: 'ambiguous',
    };
  }

  if (bar === 'R-4' && !artifactIdentityPresent) missingMilestones.push('artifact-identity');
  const verdict: ByocReadinessVerdict =
    failedMilestones.length > 0 || contradictions.length > 0
      ? 'fail'
      : missingMilestones.length > 0 || unverifiedEvidence.length > 0
        ? 'unknown'
        : 'pass';

  return {
    verdict,
    bar,
    workItemId,
    measuredAt,
    taskIds,
    evidenceRefs,
    missingMilestones: [...new Set(missingMilestones)],
    failedMilestones: [...new Set(failedMilestones)],
    contradictions,
    unverifiedEvidence,
    artifactIdentityPresent,
    releaseTaskSelection: 'explicit',
  };
}

export async function readByocReadiness(
  input: ByocReleaseSubject & { bar: ByocAcceptanceBar },
  sql: Sql,
  fetcher: PublicationProbeFetcher = globalThis.fetch,
): Promise<ByocReadinessResult> {
  const selected = await readByocReleaseSubject(input, sql);
  const readiness = evaluateByocReadiness(input.bar, input.workItemId, selected ? [selected] : []);
  if (input.bar === 'R-4' && selected?.publicationInput) {
    const publication = await probeByocPublication(selected.publicationInput, fetcher);
    readiness.evidenceRefs = [...new Set([...readiness.evidenceRefs, ...publication.evidenceRefs])];
    if (publication.failed.length > 0) {
      readiness.failedMilestones = [
        ...new Set([...readiness.failedMilestones, ...publication.failed.map((failure) => `publication:${failure}`)]),
      ];
      readiness.verdict = 'fail';
    } else {
      const joined = new Set(publication.verified);
      readiness.unverifiedEvidence = readiness.unverifiedEvidence.filter(
        (evidence) => !joined.has(evidence) || publication.missing.includes(evidence),
      );
      if (readiness.failedMilestones.length === 0 && readiness.contradictions.length === 0) {
        readiness.verdict =
          readiness.missingMilestones.length > 0 || readiness.unverifiedEvidence.length > 0
            ? 'unknown'
            : 'pass';
      }
    }
  }
  return readiness;
}

export default defineTool({
  name: 'release:byoc_readiness',
  description:
    'Unregistered BYOC diagnostic draft: read one exactly scoped task journal and independently inspect its public bytes. ' +
    'Receipt presence never produces a pass; signature, SBOM, executable and live operational joins remain unresolved.',
  guidance: {
    when: 'Developing the BYOC acceptance reader against an explicitly identified release task.',
    notWhen: 'Grading or shipping: this draft is incomplete, unregistered, and not an acceptance probe.',
    chaining:
      'Supply bar, workItemId, and taskId; inspect unverifiedEvidence. Do not bind this draft into a rubric.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({
    bar: z.enum(['R-4', 'R-5', 'R-6']),
    workItemId: z.string().trim().min(1).max(120),
    taskId: z.string().trim().min(1).max(120),
  }),
  async handler(args) {
    const readiness = await readByocReadiness({ ...args, workspaceId: activeWorkspaceId() }, getOrgPg().sql);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(readiness),
        },
      ],
    };
  },
});
