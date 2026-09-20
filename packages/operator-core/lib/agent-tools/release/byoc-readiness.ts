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
import { taskReleaseJournalFromDetail } from '../../task-manager/store';
import {
  projectByocReleaseCarry,
  type ByocReleaseCarrySnapshot,
  type ByocReleaseMilestoneKey,
} from '../../byoc-release-carry';
import {
  workspaceHostPublicationManifestFailures,
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
}

export interface ByocPublicationProbeResult {
  verdict: 'pass' | 'fail' | 'unknown';
  missing: string[];
  failed: string[];
  evidenceRefs: string[];
}

interface PublicationProbeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface PublicationProbeFetcher {
  (input: string, init?: { method?: string }): Promise<PublicationProbeResponse>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function headerSize(response: PublicationProbeResponse, label: string): number | null {
  const raw = response.headers.get('content-length');
  const size = raw === null ? Number.NaN : Number(raw);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

/**
 * Independently read the immutable public publication named by the selected release receipt.
 * The task journal contributes only the expected digest; public bytes and descriptors come from
 * the consumer-facing artifact origin. A manifest's own `files` object is not trusted until its
 * bytes, bundle HEAD and signature HEAD all agree.
 */
export async function probeByocPublication(
  input: ByocPublicationProbeInput,
  fetcher: PublicationProbeFetcher = globalThis.fetch as unknown as PublicationProbeFetcher,
): Promise<ByocPublicationProbeResult> {
  const missing: string[] = [];
  const failed: string[] = [];
  const refs: string[] = [];
  let urls: ReturnType<typeof deriveWorkspaceHostCanonicalArtifactUrls>;
  try {
    urls = deriveWorkspaceHostCanonicalArtifactUrls(input.bundleSha256);
  } catch (error) {
    return {
      verdict: 'fail',
      missing,
      failed: [`publication-url:${error instanceof Error ? error.message : String(error)}`],
      evidenceRefs: refs,
    };
  }

  const manifestResponse = await fetcher(urls.manifestUrl, { method: 'GET' }).catch((error) => null);
  if (!manifestResponse || !manifestResponse.ok) {
    missing.push('public-manifest');
    return { verdict: 'unknown', missing, failed, evidenceRefs: refs };
  }
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  const observedManifestSha = sha256(manifestBytes);
  if (observedManifestSha !== input.manifestSha256) {
    failed.push('manifest-archive-digest:mismatch');
  } else {
    refs.push(`publication:manifest:${observedManifestSha}`);
  }

  let manifest: WorkspaceHostPublicationManifest | null = null;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as WorkspaceHostPublicationManifest;
  } catch {
    failed.push('manifest:invalid-json');
  }

  const [bundleResponse, signatureResponse] = await Promise.all([
    fetcher(urls.bundleUrl, { method: 'GET' }).catch(() => null),
    fetcher(urls.signatureUrl, { method: 'HEAD' }).catch(() => null),
  ]);
  let bundlePayload: Uint8Array | null = null;
  if (bundleResponse?.ok) {
    try {
      bundlePayload = new Uint8Array(await bundleResponse.arrayBuffer());
    } catch {
      failed.push('public-bytes:unreadable');
    }
  }
  const bundleBytes = bundlePayload?.byteLength ?? null;
  const signatureBytes = signatureResponse && signatureResponse.ok ? headerSize(signatureResponse, 'signature') : null;
  if (bundleBytes === null) missing.push('public-bytes');
  if (signatureBytes === null) missing.push('signature');

  if (
    manifest === null ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    !manifest.files.bundle ||
    !manifest.files.signature ||
    !manifest.trustReport ||
    !Array.isArray(manifest.trustReport.failures)
  ) {
    failed.push('manifest:incomplete');
  } else if (bundleBytes !== null && signatureBytes !== null) {
    const publicationInput: WorkspaceHostPublicationManifestInput = {
      artifact: manifest.artifact,
      trustReport: manifest.trustReport,
      bundle: { sha256: input.bundleSha256, bytes: bundleBytes },
      signature: {
        sha256: manifest.files.signature.sha256,
        bytes: signatureBytes,
      },
    };
    const failures = workspaceHostPublicationManifestFailures(publicationInput);
    failed.push(...failures.map(({ code }) => `publication:${code}`));
    if (manifest.files.bundle.sha256 !== input.bundleSha256 || manifest.artifact.release.bundleSha256 !== input.bundleSha256) {
      failed.push('public-bytes:digest-mismatch');
    }
    if (bundlePayload && sha256(bundlePayload) !== input.bundleSha256) {
      failed.push('public-bytes:content-digest-mismatch');
    }
    if (manifest.files.bundle.sizeBytes !== bundleBytes) failed.push('public-bytes:size-mismatch');
    refs.push(`publication:bundle:${input.bundleSha256}:${bundleBytes}`);
    refs.push(`publication:signature:${manifest.files.signature.sha256}:${signatureBytes}`);
  }

  // The public HEAD/manifest joins do not inspect archive members. Keep this explicit rather
  // than treating a manifest's executable=true declarations as proof of executable bytes.
  missing.push('executable-identity');
  return {
    verdict: failed.length > 0 ? 'fail' : missing.length > 0 ? 'unknown' : 'pass',
    missing: [...new Set(missing)],
    failed: [...new Set(failed)],
    evidenceRefs: [...new Set(refs)],
  };
}

function nonEmptyObject(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
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

/**
 * Acceptance is about one explicitly selected task, not a recent carry window.
 * Scope the SQL itself: an exact task belonging to another workspace or work
 * item must neither supply evidence nor disclose its journal.
 */
export async function readByocReleaseSubject(
  input: ByocReleaseSubject,
  sql: Sql,
): Promise<ByocReleaseCarrySnapshot | null> {
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
  return projectByocReleaseCarry(row.task_id, row.work_item_id, journal);
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

export default defineTool({
  name: 'release:byoc_readiness',
  description:
    'Unregistered BYOC diagnostic draft: read one exactly scoped task journal and report unresolved acceptance evidence. ' +
    'Receipt presence never produces a pass; operational evidence joins are not yet implemented.',
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
    workItemId: z.string().min(1).max(120),
    taskId: z.string().trim().min(1).max(120),
  }),
  async handler(args) {
    const selected = await readByocReleaseSubject(
      {
        workspaceId: activeWorkspaceId(),
        workItemId: args.workItemId,
        taskId: args.taskId,
      },
      getOrgPg().sql,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(evaluateByocReadiness(args.bar, args.workItemId, selected ? [selected] : [])),
        },
      ],
    };
  },
});
