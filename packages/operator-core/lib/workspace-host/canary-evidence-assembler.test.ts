import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  planWorkspaceHostCredentialLifecycle,
  type WorkspaceHostAgentVerificationReport,
  type WorkspaceHostCredentialChannel,
  type WorkspaceHostCredentialDeliverySet,
  type WorkspaceHostCredentialEvidence,
  type WorkspaceHostCredentialFamily,
  type WorkspaceHostCredentialLifecyclePlan,
  type WorkspaceHostCredentialRefs,
} from '@papercusp/deployment-driver';

import {
  WorkspaceHostCanaryObservationError,
  assembleWorkspaceHostCanaryEvidence,
  deriveWorkspaceHostCanaryChannelObservations,
  type WorkspaceHostCanaryLifecycleRun,
} from './canary-evidence-assembler';

const REQUESTED_AT = '2026-08-22T10:00:00Z';
const OBSERVED_AT = '2026-08-22T10:30:00Z';

function refs(suffix = 'v1'): WorkspaceHostCredentialRefs {
  return {
    cloudCredentialRef: { kind: 'cloud', ref: `cloud-resolver:${suffix}` },
    gitCredentialRef: { kind: 'git', ref: `git-resolver:${suffix}` },
    agentCredentialRef: { kind: 'agent', ref: `agent-resolver:${suffix}` },
  };
}

function delivery(generation = 1): WorkspaceHostCredentialDeliverySet {
  return {
    cloud: {
      kind: 'provider-identity',
      generation,
      audience: 'host-1',
      revocationRef: `revoke-cloud-${generation}`,
    },
    git: {
      kind: 'forwarded-agent',
      generation,
      audience: 'host-1',
      revocationRef: `revoke-git-${generation}`,
    },
    agent: {
      kind: 'short-lived-delegation',
      generation,
      audience: 'host-1',
      revocationRef: `revoke-agent-${generation}`,
      expiresAt: '2026-08-22T11:00:00Z',
    },
  };
}

const common = {
  contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  requestedAt: REQUESTED_AT,
  deliveryCapabilities: { fileTransfer: true },
} as const;

function rotatePlan(): WorkspaceHostCredentialLifecyclePlan {
  return planWorkspaceHostCredentialLifecycle({
    ...common,
    operationId: 'rotate-1',
    action: 'rotate',
    currentCredentialRefs: refs('old'),
    currentDelivery: delivery(1),
    nextCredentialRefs: refs('new'),
    nextDelivery: delivery(2),
  });
}

function reconnectPlan(): WorkspaceHostCredentialLifecyclePlan {
  return planWorkspaceHostCredentialLifecycle({
    ...common,
    operationId: 'reconnect-1',
    action: 'reconnect',
    currentCredentialRefs: refs('new'),
    currentDelivery: delivery(2),
  });
}

function revokePlan(): WorkspaceHostCredentialLifecyclePlan {
  return planWorkspaceHostCredentialLifecycle({
    ...common,
    operationId: 'revoke-1',
    action: 'revoke',
    currentCredentialRefs: refs('new'),
    currentDelivery: delivery(2),
    channels: [...WORKSPACE_HOST_CREDENTIAL_CHANNELS],
  });
}

const FAMILY_BY_CHANNEL = {
  cloud: 'cloud-workload-identity',
  git: 'git-short-lived-delegation',
  agent: 'agent-forwarded-reference',
} as const satisfies Record<WorkspaceHostCredentialChannel, WorkspaceHostCredentialFamily>;

/**
 * Build the evidence a real resolver would return for a step.
 *
 * Deliberately a full, well-typed `WorkspaceHostCredentialEvidence` rather than a stub cast into
 * place: the derivation under test joins receipts to plan steps, so a loosely-typed fixture
 * would let the test keep passing if that contract changed underneath it.
 */
function evidenceFor(step: WorkspaceHostCredentialLifecyclePlan['steps'][number]): WorkspaceHostCredentialEvidence {
  return {
    namespaceVersion: WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
    channel: step.channel,
    family: FAMILY_BY_CHANNEL[step.channel],
    operation: step.kind,
    deliveryKind: step.delivery.kind,
    generation: step.delivery.generation,
    audience: step.delivery.audience,
    revocationRef: step.delivery.revocationRef,
    referenceDigest: `digest-${step.channel}-${step.delivery.generation}`,
    detail: {},
  };
}

/** A run in which the host answered every planned step. */
function fullyObserved(plan: WorkspaceHostCredentialLifecyclePlan): WorkspaceHostCanaryLifecycleRun {
  return {
    plan,
    receipts: plan.steps.map((step) => ({ stepId: step.id, evidence: evidenceFor(step) })),
  };
}

function agentsReport(): WorkspaceHostAgentVerificationReport {
  const evidence = (agent: 'claude' | 'codex' | 'omp') =>
    ({
      contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
      agent,
      ready: true,
      // WI-10002402: the kind each agent's probe table can actually emit.
      verificationKind: agent === 'omp' ? 'local-inference' : 'live-inference',
      endpoint: `https://example.invalid/${agent}`,
      exitStatus: 0,
      observedAt: OBSERVED_AT,
      proofDigest: `digest-${agent}`,
      subjectDisclosure: 'digest',
    }) as const;
  return {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    observedAt: OBSERVED_AT,
    allReady: true,
    agents: { claude: evidence('claude'), codex: evidence('codex'), omp: evidence('omp') },
  };
}

function assembleInput(lifecycleRuns: readonly WorkspaceHostCanaryLifecycleRun[]) {
  return {
    runId: 'canary-1',
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    observedAt: OBSERVED_AT,
    repository: { visibility: 'private', cloned: true },
    agents: agentsReport(),
    lifecycleRuns,
    backupRestore: {
      authorizationMaterialExcluded: true,
      credentialReferencesExcluded: true,
      reboundChannels: [...WORKSPACE_HOST_CREDENTIAL_CHANNELS],
    },
  } as const;
}

describe('deriveWorkspaceHostCanaryChannelObservations', () => {
  it('derives all four transitions per channel from a rotate followed by a reconnect', () => {
    const observations = deriveWorkspaceHostCanaryChannelObservations([
      fullyObserved(rotatePlan()),
      fullyObserved(reconnectPlan()),
    ]);

    for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
      expect(observations[channel]).toEqual({
        bound: true,
        rotated: true,
        previousBindingRevoked: true,
        reconnected: true,
      });
    }
  });

  // The attribution property. A rotate and a reconnect both produce `verify-bound` receipts,
  // and the receipts are indistinguishable on their own — only the plan's action separates
  // them. If this ever regresses to pooling receipts, a rotate alone would report a reconnect
  // that never happened, which is exactly the transition the canary is meant to prove.
  it('does not let a rotate satisfy `reconnected`', () => {
    const run = fullyObserved(rotatePlan());
    const observations = deriveWorkspaceHostCanaryChannelObservations([run]);

    // POSITIVE CONTROL, so this assertion cannot pass vacuously. A `reconnected: false` result
    // would also be produced by a run carrying no verify-bound receipts at all — in which case
    // the test would be asserting nothing about attribution. Pin that the data DOES contain the
    // receipts a naive pooled implementation would count, so the only thing standing between
    // this input and a false `reconnected` is the per-run attribution itself.
    const verifyBoundSteps = run.plan.steps.filter((step) => step.kind === 'verify-bound');
    expect(verifyBoundSteps.length).toBe(WORKSPACE_HOST_CREDENTIAL_CHANNELS.length);
    expect(run.receipts.filter((receipt) => verifyBoundSteps.some((step) => step.id === receipt.stepId)).length).toBe(
      verifyBoundSteps.length,
    );

    for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
      expect(observations[channel].rotated).toBe(true);
      expect(observations[channel].reconnected).toBe(false);
    }
  });

  it('does not let a reconnect satisfy `rotated`', () => {
    const observations = deriveWorkspaceHostCanaryChannelObservations([fullyObserved(reconnectPlan())]);

    for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
      expect(observations[channel].reconnected).toBe(true);
      expect(observations[channel].rotated).toBe(false);
      expect(observations[channel].previousBindingRevoked).toBe(false);
    }
  });

  // An attempted mutation is not a proven one. The planner always emits the verify as a
  // dependent step, so a run that answered only the bind/revoke steps means the verification
  // never came back — which must read as "not observed", not as success.
  it('treats an unverified mutation as unobserved', () => {
    const plan = rotatePlan();
    const observations = deriveWorkspaceHostCanaryChannelObservations([
      {
        plan,
        receipts: plan.steps
          .filter((step) => step.kind === 'bind' || step.kind === 'revoke')
          .map((step) => ({ stepId: step.id, evidence: evidenceFor(step) })),
      },
    ]);

    for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
      expect(observations[channel]).toEqual({
        bound: false,
        rotated: false,
        previousBindingRevoked: false,
        reconnected: false,
      });
    }
  });

  // Order-sensitivity. Every individual flag here is legitimately true, yet the channel ends
  // with no live binding. Pooled booleans cannot see this; comparing the last proving run of
  // each kind can.
  it('refuses a sequence that revokes a channel after it was last proven bound', () => {
    expect(() =>
      deriveWorkspaceHostCanaryChannelObservations([
        fullyObserved(rotatePlan()),
        fullyObserved(reconnectPlan()),
        fullyObserved(revokePlan()),
      ]),
    ).toThrow(WorkspaceHostCanaryObservationError);
  });

  it('reports a receipt that does not correspond to any step in its own plan', () => {
    const plan = reconnectPlan();
    expect(() =>
      deriveWorkspaceHostCanaryChannelObservations([
        {
          plan,
          receipts: [{ stepId: 'not-a-planned-step', evidence: evidenceFor(plan.steps[0]) }],
        },
      ]),
    ).toThrow(/not in its own plan/);
  });
});

describe('assembleWorkspaceHostCanaryEvidence', () => {
  it('produces validating canary evidence from a complete rotate + reconnect canary', () => {
    const assembly = assembleWorkspaceHostCanaryEvidence(
      assembleInput([fullyObserved(rotatePlan()), fullyObserved(reconnectPlan())]),
    );

    expect(assembly.validation).toEqual({ ok: true, errors: [] });
    expect(assembly.evidence.kind).toBe('live');
    expect(assembly.evidence.repository).toEqual({ visibility: 'private', cloned: true });
    for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
      expect(assembly.evidence.channels[channel]).toEqual({
        bound: true,
        rotated: true,
        previousBindingRevoked: true,
        reconnected: true,
      });
    }
  });

  // The end-to-end honesty property, and the reason this seam exists rather than an object
  // literal: an incomplete canary cannot become evidence that merely fails validation later.
  // It cannot become evidence at all.
  it('refuses to build evidence when a transition was never observed', () => {
    expect(() => assembleWorkspaceHostCanaryEvidence(assembleInput([fullyObserved(rotatePlan())]))).toThrow(
      /reconnected/,
    );
  });
});
