/**
 * The `acceptance.soak-24h` release receipt (D-391), written through the MAINTAINED journal writer
 * (`beginReleaseTaskStage` / `settleReleaseTaskStage`), never by hand-appending to the ledger.
 *
 * The stage identity is the RELEASE-level claim — "bundle B soaked under policy P" — so it names
 * the bundle and the policy only. Which host, incarnation and soak produced the evidence are
 * evidence refs, not identity: the journal pins one input per stage per operation, and keying the
 * identity on the host would make a failed soak impossible to retry on another machine.
 *
 * A receipt records a driver TRANSITION; it is not the outcome. The outcome is the evaluator over
 * the persisted samples (soak.ts / soak-store.ts), which is what an acceptance reader joins.
 */
import {
  beginReleaseTaskStage,
  inspectReleaseTaskStage,
  settleReleaseTaskStage,
  type ReleaseTaskStageContext,
  type ReleaseTaskStageInput,
} from '../../../../scripts/lib/release-task-journal';
import { appendTaskReleaseReceipt, getTask, taskReleaseJournalFromDetail } from '../task-manager/store';
import {
  WORKSPACE_HOST_SOAK_ACCEPTANCE_STAGE,
  type WorkspaceHostSoakEvaluation,
  type WorkspaceHostSoakPolicy,
  type WorkspaceHostSoakSubject,
} from './soak';

/** Journal channel label for workspace-host acceptance stages (part of the hash preimage only). */
export const WORKSPACE_HOST_SOAK_RELEASE_CHANNEL = 'workspace-host';

export class WorkspaceHostSoakReleaseBindingError extends Error {
  constructor(
    readonly reason:
      | 'task-not-found'
      | 'journal-missing'
      | 'bundle-unrecorded'
      | 'bundle-mismatch'
      | 'source-unrecorded'
      | 'stage-committed'
      | 'stage-refused',
    detail: string,
  ) {
    super(`Soak cannot record ${WORKSPACE_HOST_SOAK_ACCEPTANCE_STAGE}: ${detail}`);
    this.name = 'WorkspaceHostSoakReleaseBindingError';
  }
}

export interface WorkspaceHostSoakReleaseBinding {
  taskId: string;
  operationId: string;
  bundleSha256: string;
  sourceSha: string;
  gitlinks: Record<string, string>;
  version: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Bind a soak to the release task it is evidence for. The host must be RUNNING that release's
 * exact bundle: soaking a machine that runs other bytes says nothing about this release.
 */
export async function resolveWorkspaceHostSoakReleaseBinding(input: {
  releaseTaskId: string;
  hostRuntimeRelease: unknown;
}): Promise<WorkspaceHostSoakReleaseBinding> {
  const task = await getTask(input.releaseTaskId);
  if (!task) throw new WorkspaceHostSoakReleaseBindingError('task-not-found', `no task '${input.releaseTaskId}'`);
  const journal = taskReleaseJournalFromDetail(task.detail);
  if (!journal) {
    throw new WorkspaceHostSoakReleaseBindingError('journal-missing', `task '${input.releaseTaskId}' has no release journal`);
  }
  const bundleSha256 = record(journal.artifactIdentity)?.bundleSha256;
  if (typeof bundleSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(bundleSha256)) {
    throw new WorkspaceHostSoakReleaseBindingError('bundle-unrecorded', 'the release journal names no bundle digest');
  }
  const runtime = record(input.hostRuntimeRelease);
  if (runtime?.bundleSha256 !== bundleSha256) {
    throw new WorkspaceHostSoakReleaseBindingError(
      'bundle-mismatch',
      `the host runs bundle ${String(runtime?.bundleSha256 ?? 'unknown')}, the release is ${bundleSha256}`,
    );
  }
  const source = record(journal.source);
  const gitlinks = record(source?.gitlinks);
  if (typeof source?.sha !== 'string' || !gitlinks) {
    throw new WorkspaceHostSoakReleaseBindingError('source-unrecorded', 'the release journal records no source identity');
  }
  return {
    taskId: input.releaseTaskId,
    operationId: journal.operationId,
    bundleSha256,
    sourceSha: source.sha,
    gitlinks: Object.fromEntries(
      Object.entries(gitlinks).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    version: typeof runtime.version === 'string' ? runtime.version : 'unknown',
  };
}

function stageContext(binding: WorkspaceHostSoakReleaseBinding): ReleaseTaskStageContext {
  return {
    taskId: binding.taskId,
    operationId: binding.operationId,
    ledger: { getTask: (taskId) => getTask(taskId), taskReleaseJournalFromDetail, appendTaskReleaseReceipt },
    identity: {
      sourceSha: binding.sourceSha,
      gitlinks: binding.gitlinks,
      version: binding.version,
      channel: WORKSPACE_HOST_SOAK_RELEASE_CHANNEL,
      // Workspace-host releases are identified by bundle digest; the writer matches it exactly.
      bundleSha256: binding.bundleSha256,
    },
  };
}

function stageInput(binding: WorkspaceHostSoakReleaseBinding, policy: WorkspaceHostSoakPolicy): ReleaseTaskStageInput {
  return {
    stage: WORKSPACE_HOST_SOAK_ACCEPTANCE_STAGE,
    sourceScope: 'stage',
    identity: { bundleSha256: binding.bundleSha256, policy: { ...policy } },
  };
}

function refusal(action: string, state: string): WorkspaceHostSoakReleaseBindingError {
  return action === 'reuse'
    ? new WorkspaceHostSoakReleaseBindingError('stage-committed', 'this release operation already committed its soak')
    : new WorkspaceHostSoakReleaseBindingError('stage-refused', `the stage is ${state} and not retryable`);
}

/**
 * Refuse a soak whose receipt could never be written, BEFORE a day is spent sampling. Read-only.
 */
export async function assertWorkspaceHostSoakReceiptWritable(
  binding: WorkspaceHostSoakReleaseBinding,
  policy: WorkspaceHostSoakPolicy,
): Promise<void> {
  const inspection = await inspectReleaseTaskStage(stageContext(binding), stageInput(binding, policy));
  if (inspection.action === 'reuse' || inspection.action === 'refused') {
    throw refusal(inspection.action, inspection.state);
  }
}

/**
 * Record the soak's intent and return the request it must settle.
 *
 * A PENDING intent for this same stage input is ADOPTED, not refused. The step that calls this can
 * re-execute after its append landed but before DBOS checkpointed it; refusing then would reject
 * the soak's own intent. Adoption is also sound for an intent a cancelled soak left behind: a soak
 * changes nothing at the provider, the intent names only the stage input, and the settling
 * receipt's evidence names the soak that actually produced the verdict.
 */
export async function beginWorkspaceHostSoakReceipt(
  binding: WorkspaceHostSoakReleaseBinding,
  policy: WorkspaceHostSoakPolicy,
): Promise<{ requestIdentity: string; adopted: boolean }> {
  const begun = await beginReleaseTaskStage(stageContext(binding), stageInput(binding, policy));
  if ((begun.action === 'run' || begun.action === 'reconcile') && begun.requestIdentity) {
    return { requestIdentity: begun.requestIdentity, adopted: begun.action === 'reconcile' };
  }
  throw refusal(begun.action, begun.state);
}

/** Evidence refs naming exactly which soak, machine and window produced the verdict. */
export function workspaceHostSoakEvidenceRefs(
  subject: WorkspaceHostSoakSubject,
  evaluation: WorkspaceHostSoakEvaluation,
): string[] {
  return [
    `soak:${subject.soakId}`,
    `soak-host:${subject.workspaceId}/${subject.hostId}`,
    `soak-incarnation:${subject.instanceId}`,
    `soak-image:${subject.image}`,
    `soak-window:${evaluation.window.first ?? 'none'}/${evaluation.window.last ?? 'none'}`,
    `soak-samples:${evaluation.samples}/${evaluation.expectedSamples}`,
    `soak-measured:${evaluation.measuredSamples}`,
    `soak-verdict:${evaluation.verdict}`,
    ...evaluation.reasons.slice(0, 8).map((reason) => `soak-reason:${reason.slice(0, 900)}`),
  ];
}

/**
 * Settle the receipt from the evaluator's verdict. A failed soak is settled `refused` WITH
 * `reconcile:confirmed-absent`: the soak changed nothing at the provider, so a new attempt is safe
 * and the journal lets the next soak mint a fresh request identity instead of wedging the stage.
 */
export async function settleWorkspaceHostSoakReceipt(input: {
  binding: WorkspaceHostSoakReleaseBinding;
  policy: WorkspaceHostSoakPolicy;
  requestIdentity: string;
  subject: WorkspaceHostSoakSubject;
  evaluation: WorkspaceHostSoakEvaluation;
}): Promise<void> {
  const passed = input.evaluation.verdict === 'pass';
  await settleReleaseTaskStage(stageContext(input.binding), {
    ...stageInput(input.binding, input.policy),
    requestIdentity: input.requestIdentity,
    state: passed ? 'committed' : 'refused',
    evidenceRefs: [
      ...(passed ? [] : ['reconcile:confirmed-absent']),
      ...workspaceHostSoakEvidenceRefs(input.subject, input.evaluation),
    ],
  });
}
