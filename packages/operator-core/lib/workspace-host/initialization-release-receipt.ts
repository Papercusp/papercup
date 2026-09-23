/**
 * The `workspace.root-bootstrap` and `workspace.fixed-agent-initialization` release receipts (R-5,
 * WI-10002510): callers of the shared workspace-host release-stage writer (release-stage-receipt.ts,
 * D-394), recorded by the one run that OBSERVES both outcomes — workspace-host initialization.
 *
 * - Root bootstrap: the controller-authored bootstrap reached readiness. The initialization runner's
 *   bootstrap gate saw the remote-initializer conduit that bootstrap installs last (WI-10001677).
 * - Fixed-agent initialization: the run's `verify-initialization` step reported EVERY requested agent
 *   ready through the credentials it delivered. The stage identity names that agent set and the
 *   credential channels, so a receipt can never claim an agent nobody verified; whether the set
 *   satisfies D-338 (only funded direct-Codex skipped) is the grader's reading of that identity.
 *
 * Which host and initialization produced the evidence are evidence refs, not identity. The
 * initialization-operation ref doubles as the run's own mark: a durable step that re-executes the
 * same operation after its settle landed finds its committed receipt and does not refuse itself.
 */
import {
  resolveWorkspaceHostRequestedAgents,
  type WorkspaceHostBootstrapReadinessResult,
  type WorkspaceHostInitializationPlan,
  type WorkspaceHostInitializationStepReceipt,
} from '@papercusp/deployment-driver';
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal';
import type { WorkspaceHostAgentCredentialAdmissionEvidence } from './agent-credential-admission';
import {
  WorkspaceHostReleaseBindingError,
  beginWorkspaceHostReleaseStage,
  resolveWorkspaceHostReleaseBinding,
  settleWorkspaceHostReleaseStage,
  workspaceHostReleaseStageReadiness,
  type WorkspaceHostReleaseBinding,
  type WorkspaceHostReleaseStage,
} from './release-stage-receipt';
import { readWorkspaceHostRuntimeRelease } from './soak-store';

export const WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE = 'workspace.root-bootstrap';
export const WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE = 'workspace.fixed-agent-initialization';

export type WorkspaceHostInitializationReleaseSlot = 'root-bootstrap' | 'fixed-agents';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function workspaceHostRootBootstrapStage(): WorkspaceHostReleaseStage {
  return { stage: WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE, identity: { readiness: 'remote-initializer-conduit' } };
}

/** The stage the plan that actually runs can prove: its verify step's agents and credential channels. */
export function workspaceHostFixedAgentInitializationStage(
  plan: WorkspaceHostInitializationPlan,
): WorkspaceHostReleaseStage {
  const verify = plan.steps.find((step) => step.kind === 'verify-initialization');
  if (!verify) {
    throw new WorkspaceHostReleaseBindingError(
      'stage-unobservable',
      WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE,
      'the initialization plan has no verify-initialization step',
    );
  }
  const channels = Array.isArray(verify.input.requiredChannels)
    ? verify.input.requiredChannels.filter((channel): channel is string => typeof channel === 'string')
    : [];
  return {
    stage: WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE,
    identity: {
      agents: [...resolveWorkspaceHostRequestedAgents(verify.input.requestedAgents)],
      channels: [...channels].sort(),
    },
  };
}

export function workspaceHostRootBootstrapEvidenceRefs(
  subject: { workspaceId: string; hostId: string },
  readiness: WorkspaceHostBootstrapReadinessResult,
): string[] {
  return [
    `bootstrap-host:${subject.workspaceId}/${subject.hostId}`,
    `bootstrap-probes:${readiness.probes}`,
    `bootstrap-waited-ms:${Math.round(readiness.waitedMs)}`,
    `bootstrap-ready-immediately:${readiness.readyImmediately}`,
  ];
}

/**
 * Judge the fixed-agent stage from the verify step's OWN evidence, never from "nothing threw": the
 * receipt says every agent on its identity was observed ready, so each one must be.
 */
export function workspaceHostFixedAgentInitializationOutcome(input: {
  subject: { workspaceId: string; hostId: string };
  stage: WorkspaceHostReleaseStage;
  receipts: readonly WorkspaceHostInitializationStepReceipt[];
  credentialAdmissions?: readonly WorkspaceHostAgentCredentialAdmissionEvidence[];
}): { outcome: 'committed' | 'refused'; evidenceRefs: string[] } {
  const agents = Array.isArray(input.stage.identity.agents) ? (input.stage.identity.agents as string[]) : [];
  const verify = input.receipts.find((receipt) => receipt.stepId === 'verify');
  const reported = record(record(verify?.publicEvidence)?.agents);
  const evidenceRefs = [
    `initialize-host:${input.subject.workspaceId}/${input.subject.hostId}`,
    `initialize-steps:${input.receipts.length}`,
  ];
  const contract = record(verify?.publicEvidence)?.agentContractVersion;
  if (typeof contract === 'string') evidenceRefs.push(`initialize-agent-contract:${contract}`);
  let allReady = agents.length > 0;
  for (const agent of agents) {
    const evidence = record(reported?.[agent]);
    const ready = evidence?.ready === true;
    allReady &&= ready;
    const kind = typeof evidence?.verificationKind === 'string' ? evidence.verificationKind : 'unreported';
    evidenceRefs.push(`initialize-agent:${agent}:${ready ? 'ready' : 'unready'}:${kind}`);
    if (ready && typeof evidence?.proofDigest === 'string') {
      evidenceRefs.push(`initialize-agent-proof:${agent}:${evidence.proofDigest}`);
    }
  }
  for (const admission of input.credentialAdmissions ?? []) {
    evidenceRefs.push(`credential-admission:${admission.binding.family}:${admission.binding.generation}`);
  }
  return { outcome: allReady ? 'committed' : 'refused', evidenceRefs };
}

/**
 * The two stages one initialization run records. Opened read-only BEFORE the run touches anything,
 * so a receipt that could never be written refuses the request instead of surfacing after the work.
 */
export class WorkspaceHostInitializationReleaseRecorder {
  private readonly open = new Map<WorkspaceHostInitializationReleaseSlot, string>();

  constructor(
    readonly binding: WorkspaceHostReleaseBinding,
    private readonly stages: Readonly<Record<WorkspaceHostInitializationReleaseSlot, WorkspaceHostReleaseStage>>,
    private readonly recorded: ReadonlySet<WorkspaceHostInitializationReleaseSlot>,
    private readonly operationRef: string,
    private readonly ledger?: ReleaseTaskLedger,
  ) {}

  stage(slot: WorkspaceHostInitializationReleaseSlot): WorkspaceHostReleaseStage {
    return this.stages[slot];
  }

  /** Record the stage's intent. A stage this operation already committed is left alone. */
  async begin(slot: WorkspaceHostInitializationReleaseSlot): Promise<void> {
    if (this.recorded.has(slot) || this.open.has(slot)) return;
    const begun = await beginWorkspaceHostReleaseStage(this.binding, this.stages[slot], this.ledger);
    this.open.set(slot, begun.requestIdentity);
  }

  async settle(
    slot: WorkspaceHostInitializationReleaseSlot,
    outcome: 'committed' | 'refused',
    evidenceRefs: readonly string[],
  ): Promise<void> {
    const requestIdentity = this.open.get(slot);
    if (!requestIdentity) return;
    await settleWorkspaceHostReleaseStage({
      binding: this.binding,
      stage: this.stages[slot],
      requestIdentity,
      outcome,
      evidenceRefs: [this.operationRef, ...evidenceRefs],
      ...(this.ledger ? { ledger: this.ledger } : {}),
    });
    this.open.delete(slot);
  }

  /**
   * Settle every still-open stage `refused` after the run failed. Best effort by design: a settle
   * that cannot land leaves a pending intent, which the next attempt of this operation adopts.
   */
  async refuseOpen(evidenceRefs: readonly string[]): Promise<void> {
    for (const slot of [...this.open.keys()]) {
      await this.settle(slot, 'refused', evidenceRefs).catch(() => undefined);
    }
  }
}

export async function openWorkspaceHostInitializationRelease(input: {
  releaseTaskId: string;
  workspaceId: string;
  hostId: string;
  operationId: string;
  plan: WorkspaceHostInitializationPlan;
  ledger?: ReleaseTaskLedger;
  readHostRuntimeRelease?: (workspaceId: string, hostId: string) => Promise<unknown>;
}): Promise<WorkspaceHostInitializationReleaseRecorder> {
  const stages = {
    'root-bootstrap': workspaceHostRootBootstrapStage(),
    'fixed-agents': workspaceHostFixedAgentInitializationStage(input.plan),
  } as const;
  const binding = await resolveWorkspaceHostReleaseBinding({
    releaseTaskId: input.releaseTaskId,
    stage: WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE,
    hostRuntimeRelease: await (input.readHostRuntimeRelease ?? readWorkspaceHostRuntimeRelease)(
      input.workspaceId,
      input.hostId,
    ),
    ...(input.ledger ? { ledger: input.ledger } : {}),
  });
  const operationRef = `initialize-operation:${input.operationId}`;
  const recorded = new Set<WorkspaceHostInitializationReleaseSlot>();
  for (const slot of ['root-bootstrap', 'fixed-agents'] as const) {
    const readiness = await workspaceHostReleaseStageReadiness(binding, stages[slot], {
      recordedBy: operationRef,
      ...(input.ledger ? { ledger: input.ledger } : {}),
    });
    if (readiness === 'recorded') recorded.add(slot);
  }
  return new WorkspaceHostInitializationReleaseRecorder(binding, stages, recorded, operationRef, input.ledger);
}
