import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  WORKSPACE_HOST_CREDENTIAL_NAMESPACE_VERSION,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  planWorkspaceHostCredentialLifecycle,
  planWorkspaceHostInitialization,
  workspaceHostCredentialReferenceDigest,
  workspaceHostAgentAllowedVerificationKinds,
  type WorkspaceHostAgentVerificationReport,
  type WorkspaceHostAgentVerificationEvidence,
  type WorkspaceHostCredentialDeliverySet,
  type WorkspaceHostCredentialEvidence,
  type WorkspaceHostCredentialFamily,
  type WorkspaceHostCredentialLifecycleRequest,
  type WorkspaceHostCredentialRefs,
  type WorkspaceHostInitializationHostOperations,
} from '@papercusp/deployment-driver';
import type { WorkspaceHostCredentialLifecycleRunInput } from './credential-lifecycle-runner';
import {
  WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
  type WorkspaceHostAgentCredentialAdmissionEvidence,
  type WorkspaceHostAgentCredentialAdmissionInput,
} from './agent-credential-admission';
import type { WorkspaceHostCredentialMaterialSource } from './credential-material-source';
import type { WorkspaceHostInitializationRunInput } from './initialization-runner';
import {
  WorkspaceHostCanaryRunError,
  runWorkspaceHostCanary,
  workspaceHostCanaryOperationIds,
  type WorkspaceHostCanaryDestroyFinalizationInput,
  type WorkspaceHostCanaryRunInput,
} from './canary-runner';

const REQUESTED_AT = '2026-08-26T20:00:00.000Z';
const OBSERVED_AT = '2026-08-26T21:00:00.000Z';

function refs(generation: number): WorkspaceHostCredentialRefs {
  return {
    cloudCredentialRef: { kind: 'cloud', ref: `cloud-resolver:g${generation}` },
    gitCredentialRef: { kind: 'git', ref: `git-resolver:g${generation}` },
    agentCredentialRef: { kind: 'agent', ref: `agent-resolver:g${generation}` },
  };
}

function delivery(generation: number): WorkspaceHostCredentialDeliverySet {
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
      expiresAt: '2026-08-27T20:00:00.000Z',
    },
  };
}

function agentReport(): WorkspaceHostAgentVerificationReport {
  const evidence = (agent: 'claude' | 'codex' | 'omp'): WorkspaceHostAgentVerificationEvidence => ({
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    agent,
    ready: true,
    // WI-10002402. This said `authenticated-account` for claude/codex — evidence NEITHER agent's
    // probe set can emit (claude's authenticated-account probe was removed as forgeable in
    // WI-10001689; codex's is `satisfiesReadiness: false`). A fixture describing impossible
    // evidence is why this suite stayed green for weeks while every real GCP canary was rejected
    // at the same field. The guard test below pins these against the probe table itself.
    verificationKind: agent === 'omp' ? 'local-inference' : 'live-inference',
    endpoint: `https://auth.example.invalid/${agent}`,
    exitStatus: 0,
    observedAt: OBSERVED_AT,
    proofDigest: `digest-${agent}`,
    subjectDisclosure: 'digest' as const,
  });
  return {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    observedAt: OBSERVED_AT,
    allReady: true,
    agents: {
      claude: evidence('claude'),
      codex: evidence('codex'),
      omp: evidence('omp'),
    },
  };
}

function admissionEvidence(
  input: WorkspaceHostAgentCredentialAdmissionInput,
): WorkspaceHostAgentCredentialAdmissionEvidence {
  const verification = agentReport();
  if (!verification.agents.omp) throw new Error('Admission fixture requires OMP evidence');
  const agents = {
    ...verification.agents,
    // Admission authenticates a present stored OMP credential; local inference is reserved for
    // an intentionally credential-free OMP bundle and therefore has no admission agent record.
    omp: { ...verification.agents.omp, verificationKind: 'authenticated-account' as const },
  };
  return {
    contractVersion: WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
    sourceKind: 'operator-integration-credentials',
    binding: {
      channel: 'agent',
      family: 'agent-forwarded-reference',
      generation: input.delivery.generation,
      referenceDigest: workspaceHostCredentialReferenceDigest(input.credentialRef.ref),
    },
    observedAt: verification.observedAt,
    verification: { ...verification, agents, credentialFreeAgents: [], unfundedAgents: [], admissible: true },
  };
}

const verifyAgentCredentialAdmission = vi.fn(
  async (request: WorkspaceHostAgentCredentialAdmissionInput) => admissionEvidence(request),
);

const operations: WorkspaceHostInitializationHostOperations = {
  supportedStepKinds: [...WORKSPACE_HOST_INITIALIZATION_STEP_KINDS],
  execute: vi.fn(),
};

const credentialMaterialSource: WorkspaceHostCredentialMaterialSource = {
  resolve: vi.fn(async () => {
    throw new Error('the fake initialization runner must not resolve credential material');
  }),
};

function input(overrides: Partial<WorkspaceHostCanaryRunInput> = {}): WorkspaceHostCanaryRunInput {
  return {
    runId: 'run-1',
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    requestedAt: REQUESTED_AT,
    deliveryCapabilities: { fileTransfer: true },
    source: {
      kind: 'git',
      repositoryUrl: 'https://github.com/papercusp/private-canary.git',
      visibility: 'private',
      destination: 'repositories/private-canary',
      revision: 'main',
    },
    credentials: {
      initial: { credentialRefs: refs(1), delivery: delivery(1) },
      rotated: { credentialRefs: refs(2), delivery: delivery(2) },
      // WI-10002402: reconnect owns generation 3 — revoke kills everything through 2, so reusing
      // `rotated` here is the replay the delivery guard refuses on a real host.
      reconnected: { credentialRefs: refs(3), delivery: delivery(3) },
      restored: { credentialRefs: refs(4), delivery: delivery(4) },
    },
    operations,
    credentialMaterialSource,
    ...overrides,
  };
}

async function fakeInitialization(run: WorkspaceHostInitializationRunInput) {
  const operationId = run.operationId!;
  const requestedAt = run.requestedAt!;
  const plan = planWorkspaceHostInitialization({
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId,
    deliveryCapabilities: run.deliveryCapabilities,
    workspaceId: run.workspaceId,
    hostId: run.hostId,
    requestedAt,
    source: run.source,
    credentialRefs: run.credentialRefs,
    credentialDelivery: run.credentialDelivery,
    ...(run.publicMetadata ? { publicMetadata: run.publicMetadata } : {}),
  });
  const report = agentReport();
  run.onPlanned?.(plan);
  return {
    operationId,
    plan,
    receipts: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'succeeded' as const,
      observedAt: OBSERVED_AT,
      ...(step.kind === 'verify-initialization'
        ? {
            publicEvidence: {
              sourceKind: 'git',
              requiredChannels: [...WORKSPACE_HOST_CREDENTIAL_CHANNELS],
              repository: { visibility: 'private', cloned: true },
              agents: report.agents,
              agentContractVersion: report.contractVersion,
            },
          }
        : {}),
    })),
  };
}

const FAMILY_BY_CHANNEL = {
  cloud: 'cloud-workload-identity',
  git: 'git-short-lived-delegation',
  agent: 'agent-forwarded-reference',
} as const satisfies Record<(typeof WORKSPACE_HOST_CREDENTIAL_CHANNELS)[number], WorkspaceHostCredentialFamily>;

function lifecycleRequest(run: WorkspaceHostCredentialLifecycleRunInput): WorkspaceHostCredentialLifecycleRequest {
  const base = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: run.operationId!,
    workspaceId: run.workspaceId,
    hostId: run.hostId,
    requestedAt: run.requestedAt!,
    deliveryCapabilities: run.deliveryCapabilities,
  } as const;
  switch (run.action) {
    case 'rotate':
      return {
        ...base,
        action: run.action,
        currentCredentialRefs: run.currentCredentialRefs,
        currentDelivery: run.currentDelivery,
        nextCredentialRefs: run.nextCredentialRefs,
        nextDelivery: run.nextDelivery,
      };
    case 'revoke':
      return {
        ...base,
        action: run.action,
        currentCredentialRefs: run.currentCredentialRefs,
        currentDelivery: run.currentDelivery,
        channels: run.channels,
      };
    case 'reconnect':
      return {
        ...base,
        action: run.action,
        currentCredentialRefs: run.currentCredentialRefs,
        currentDelivery: run.currentDelivery,
      };
    case 'restore-rebind':
      return {
        ...base,
        action: run.action,
        backup: run.backup,
        nextCredentialRefs: run.nextCredentialRefs,
        nextDelivery: run.nextDelivery,
      };
  }
}

async function fakeLifecycle(run: WorkspaceHostCredentialLifecycleRunInput) {
  const plan = planWorkspaceHostCredentialLifecycle(lifecycleRequest(run));
  return {
    operationId: run.operationId!,
    plan,
    receipts: plan.steps.map((step) => {
      const evidence: WorkspaceHostCredentialEvidence = {
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
      return { stepId: step.id, evidence };
    }),
  };
}

function destroyFinalization(): WorkspaceHostCanaryDestroyFinalizationInput {
  return {
    operationId: 'destroy-1',
    credentialTeardown: WORKSPACE_HOST_CREDENTIAL_CHANNELS.map((channel) => ({
      channel,
      previousBindingRevoked: true,
      credentialReferenceExcluded: true,
    })),
    teardown: {
      operationId: 'destroy-1',
      workspaceId: 'workspace-1',
      hostId: 'host-1',
      startedAt: '2026-08-26T21:05:00.000Z',
      observedAt: '2026-08-26T21:10:00.000Z',
      confirmations: [
        {
          hostId: 'host-1',
          providerResourceId: 'vm-1',
          confirmedAbsentAt: '2026-08-26T21:09:00.000Z',
          source: 'provider-read',
        },
      ],
      orphanCensus: {
        clean: true,
        observedTagged: [],
        untracked: [],
        stillLive: [],
        missingWithoutReceipt: [],
      },
    },
    destroyEvidence: {
      runId: 'run-1',
      workspaceId: 'workspace-1',
      contractApproval: {
        status: 'approved',
        suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
        reportRef: 'report-1',
        approvedBy: 'reviewer-1',
        approvedAt: REQUESTED_AT,
      },
      teardownDeadlineAt: '2026-08-26T22:00:00.000Z',
      budgetEvidenceRef: 'budget-1',
      preRunZeroBaseline: {
        cents: 0,
        observedAt: REQUESTED_AT,
        providerEvidenceRef: 'billing-0',
      },
      costEvidence: [],
    },
  };
}

describe('runWorkspaceHostCanary', () => {
  it('runs the ordered canary, retains plans and receipts, and validates lane-I destroy evidence', async () => {
    const runInitialization = vi.fn(fakeInitialization);
    const runLifecycle = vi.fn(fakeLifecycle);
    const result = await runWorkspaceHostCanary(input({ destroyFinalization: destroyFinalization() }), {
      runInitialization,
      runLifecycle,
      verifyAgentCredentialAdmission,
      now: () => new Date(OBSERVED_AT),
    });

    expect(result.lifecycle.map(({ phase }) => phase)).toEqual(['rotate', 'revoke', 'reconnect', 'restore-rebind']);
    expect(result.lifecycle.map(({ result: phase }) => phase.plan.action)).toEqual([
      'rotate',
      'revoke',
      'reconnect',
      'restore-rebind',
    ]);
    expect(result.initialization.receipts.map((receipt) => receipt.stepId)).toEqual(
      result.initialization.plan.steps.map((step) => step.id),
    );
    expect(result.assembly.validation).toEqual({ ok: true, errors: [] });
    expect(result.assembly.evidence.repository).toEqual({ visibility: 'private', cloned: true });
    expect(result.backupManifest).toMatchObject({
      authorizationMaterial: 'excluded',
      credentialReferences: 'excluded',
      rebindRequired: ['cloud', 'git', 'agent'],
    });
    expect(result.adaptedDestroyEvidence).toEqual(destroyFinalization().destroyEvidence);
    expect(runInitialization).toHaveBeenCalledTimes(1);
    expect(runInitialization).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialMaterialSource,
        additionalCredentialAdmissions: [
          expect.objectContaining({ binding: expect.objectContaining({ generation: 2 }) }),
          expect.objectContaining({ binding: expect.objectContaining({ generation: 3 }) }),
          expect.objectContaining({ binding: expect.objectContaining({ generation: 4 }) }),
        ],
        onPlanned: expect.any(Function),
      }),
    );
    // WI-10002402: 2=rotated, 3=reconnected, 4=restored. Every DELIVERED generation is
    // pre-authenticated; if this list ever loses one, that phase fails late on a live host after
    // paid operations, instead of at the cheap pre-flight boundary.
    expect(verifyAgentCredentialAdmission.mock.calls.map(([request]) => request.delivery.generation)).toEqual([
      2, 3, 4,
    ]);
    expect(runLifecycle).toHaveBeenCalledTimes(4);
  });

  // D-338 (owner-directed) skips the funded Codex leg and continues on Claude and OMP. The canary
  // previously planned all three unconditionally, so that scope was declared but unrunnable: the
  // live r38 run reached 5/6 steps and died on `agent readiness did not pass for: codex
  // (provider-usage-limit)`. A narrowed scope must SKIP the omitted agent, never mark it ready.
  it('honours a narrowed agent scope end to end, and still fails closed when the scope is absent', async () => {
    // Mirrors a real scoped guest: it verifies — and therefore reports evidence for — Claude and
    // OMP only. Held FIXED across both halves below so the declared scope is the single variable.
    const codexSkippingGuest = async (run: WorkspaceHostInitializationRunInput) => {
      const result = await fakeInitialization(run);
      return {
        ...result,
        receipts: result.receipts.map((receipt) =>
          'publicEvidence' in receipt && receipt.publicEvidence
            ? {
                ...receipt,
                publicEvidence: {
                  ...receipt.publicEvidence,
                  agents: { claude: agentReport().agents.claude, omp: agentReport().agents.omp },
                },
              }
            : receipt,
        ),
      };
    };

    const runInitialization = vi.fn(codexSkippingGuest);
    const result = await runWorkspaceHostCanary(
      input({ destroyFinalization: destroyFinalization(), requestedAgents: ['claude', 'omp'] }),
      {
        runInitialization,
        runLifecycle: vi.fn(fakeLifecycle),
        verifyAgentCredentialAdmission,
        now: () => new Date(OBSERVED_AT),
      },
    );

    // The scope must actually reach the initialization runner — that is what makes the guest verify
    // the narrowed set at all, rather than the canary merely tolerating a short receipt.
    expect(runInitialization).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAgents: ['claude', 'omp'] }),
    );
    // The skipped agent is ABSENT from the ratified artifact, never present-and-passing, and the
    // artifact declares its own coverage so a later reader can tell scoped from truncated.
    expect(Object.keys(result.assembly.evidence.agents).sort()).toEqual(['claude', 'omp']);
    expect(result.assembly.evidence.requestedAgents).toEqual(['claude', 'omp']);
    expect(result.assembly.validation).toEqual({ ok: true, errors: [] });

    // FALSIFIER: identical guest, scope omitted. Codex evidence is then genuinely missing and the
    // extractor must still fail closed. Without this the assertions above would pass unchanged even
    // if requestedAgents were ignored end to end.
    await expect(
      runWorkspaceHostCanary(input({ destroyFinalization: destroyFinalization() }), {
        runInitialization: vi.fn(codexSkippingGuest),
        runLifecycle: vi.fn(fakeLifecycle),
        verifyAgentCredentialAdmission,
        now: () => new Date(OBSERVED_AT),
      }),
    ).rejects.toThrow(/missing 'codex' agent evidence/);
  });

  // A rejection that names only the AGENT is unactionable for this gate: the verification evidence
  // is never persisted (harness_shared.workspace_host_operations keeps only `request`/`error`), so
  // the sole way to learn WHICH field was wrong is another full live GCP canary. Measured
  // 2026-09-22: the live r38 run cleared initialization 6/6 and then returned exactly
  // `initialization verification has invalid 'claude' agent evidence` — the same unactionable shape
  // WI-2144034 removed from the readiness message one module away.
  it("names every failing field when an agent's evidence is invalid, without echoing secret-bearing values", async () => {
    const intactClaude = agentReport().agents.claude;
    const intactOmp = agentReport().agents.omp;
    if (!intactClaude || !intactOmp) throw new Error('fixture requires claude + omp evidence');
    const { proofDigest: _droppedDigest, ...claudeWithoutDigest } = intactClaude;

    const withClaudeEvidence = (claude: unknown) => async (run: WorkspaceHostInitializationRunInput) => {
      const result = await fakeInitialization(run);
      return {
        ...result,
        receipts: result.receipts.map((receipt) =>
          'publicEvidence' in receipt && receipt.publicEvidence
            ? {
                ...receipt,
                publicEvidence: { ...receipt.publicEvidence, agents: { claude, omp: intactOmp } },
              }
            : receipt,
        ),
      };
    };

    const canary = (claude: unknown) =>
      runWorkspaceHostCanary(
        input({ destroyFinalization: destroyFinalization(), requestedAgents: ['claude', 'omp'] }),
        {
          runInitialization: vi.fn(withClaudeEvidence(claude)),
          runLifecycle: vi.fn(fakeLifecycle),
          verifyAgentCredentialAdmission,
          now: () => new Date(OBSERVED_AT),
        },
      );

    // Three independently-broken fields, so a message naming only one is still caught.
    const broken = { ...claudeWithoutDigest, subjectDisclosure: 'plaintext', exitStatus: 1.5 };
    const error = (await canary(broken).catch((thrown: unknown) => thrown)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/proofDigest is missing or empty/);
    expect(error.message).toMatch(/subjectDisclosure "plaintext" must be 'redacted' or 'digest'/);
    expect(error.message).toMatch(/exitStatus 1\.5 is not a safe integer/);
    // Closed-enum values are contract vocabulary and safe to echo; the proof material is not.
    expect(error.message).not.toMatch(/digest-claude/);

    // CALIBRATION: the identical guest with INTACT claude evidence must succeed. Without it the
    // assertions above would pass just as well if the canary rejected every run for some other
    // reason, which is the vacuous-control failure this whole test exists to avoid.
    await expect(canary(intactClaude)).resolves.toBeDefined();
  });

  it('admits exactly the readiness-capable verification kinds each agent\'s own probe table declares', async () => {
    // RECURRENCE GUARD (WI-10002402). The bug this pins was a hand-copied allowlist — four call
    // sites each restated "authenticated-account, or local-inference when omp" as a literal, and
    // the copies drifted from the probe table they describe. Three of them then rejected claude
    // for presenting `live-inference`: the ONLY kind claude can emit, and the stronger evidence
    // that deliberately replaced its removed, forgeable authenticated-account probe.
    //
    // This asserts the VALIDATOR against the PROBE TABLE, so re-introducing any literal at any of
    // those sites fails here instead of on a live GCP host an hour and a VM later.
    const intactOmp = agentReport().agents.omp;
    const intactClaude = agentReport().agents.claude;
    if (!intactClaude || !intactOmp) throw new Error('fixture requires claude + omp evidence');

    const withClaudeEvidence = (claude: unknown) => async (run: WorkspaceHostInitializationRunInput) => {
      const result = await fakeInitialization(run);
      return {
        ...result,
        receipts: result.receipts.map((receipt) =>
          'publicEvidence' in receipt && receipt.publicEvidence
            ? {
                ...receipt,
                publicEvidence: { ...receipt.publicEvidence, agents: { claude, omp: intactOmp } },
              }
            : receipt,
        ),
      };
    };

    const canary = (claude: unknown) =>
      runWorkspaceHostCanary(
        input({ destroyFinalization: destroyFinalization(), requestedAgents: ['claude', 'omp'] }),
        {
          runInitialization: vi.fn(withClaudeEvidence(claude)),
          runLifecycle: vi.fn(fakeLifecycle),
          verifyAgentCredentialAdmission,
          now: () => new Date(OBSERVED_AT),
        },
      );

    const claudeKinds = [...workspaceHostAgentAllowedVerificationKinds('claude')];

    // INSTRUMENT CHECK: an empty derived set would make the accept-loop below vacuous — it would
    // iterate zero times and pass while proving nothing.
    expect(claudeKinds.length).toBeGreaterThan(0);
    // The two facts that made this bug possible, asserted directly against the table.
    expect(claudeKinds).toContain('live-inference');
    expect(claudeKinds).not.toContain('authenticated-account');

    // Every kind the table declares readiness-capable must be ADMITTED.
    for (const kind of claudeKinds) {
      await expect(canary({ ...intactClaude, verificationKind: kind })).resolves.toBeDefined();
    }

    // CALIBRATION: a kind absent from claude's table must still be REFUSED, naming the field.
    // Without this the loop above would pass just as well if the validator admitted everything —
    // which is the failure mode that replacing a literal with a derived set could plausibly cause.
    const error = (await canary({ ...intactClaude, verificationKind: 'authenticated-account' }).catch(
      (thrown: unknown) => thrown,
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/verificationKind "authenticated-account" is not allowed for 'claude'/);
  });

  it('gives reconnect a strictly increasing generation instead of replaying the revoked one', async () => {
    // RECURRENCE GUARD (WI-10002402). reconnect used to reuse `credentials.rotated` — the exact
    // generation the immediately-preceding revoke had just killed across every channel. On a real
    // host the delivery guard refused it (`WorkspaceHostRevokedCredentialGenerationError:
    // generations through 2 have been revoked`), stranding the canary at phase 4 of 5.
    //
    // The unit suite could not see it because the FAKE lifecycle does not enforce monotonic
    // generations, so the invariant has to be asserted here explicitly — the same shape of blind
    // spot as the fixtures that encoded impossible agent evidence.
    const runLifecycle = vi.fn(fakeLifecycle);
    await runWorkspaceHostCanary(input({ destroyFinalization: destroyFinalization() }), {
      runInitialization: vi.fn(fakeInitialization),
      runLifecycle,
      verifyAgentCredentialAdmission,
      now: () => new Date(OBSERVED_AT),
    });

    const byAction = new Map(
      runLifecycle.mock.calls.map(([call]) => [
        (call as WorkspaceHostCredentialLifecycleRunInput).action,
        call as WorkspaceHostCredentialLifecycleRunInput,
      ]),
    );
    const generationOf = (action: WorkspaceHostCredentialLifecycleRunInput['action']): number => {
      const call = byAction.get(action);
      if (!call || !('currentDelivery' in call) || !call.currentDelivery) {
        throw new Error(`no ${action} call with a currentDelivery to read a generation from`);
      }
      const git = call.currentDelivery.git;
      if (!git) throw new Error(`${action} call has no git delivery to read a generation from`);
      return git.generation;
    };

    // INSTRUMENT CHECK: both phases must actually have run, or the comparison is vacuous.
    expect(byAction.has('revoke')).toBe(true);
    expect(byAction.has('reconnect')).toBe(true);
    expect(generationOf('reconnect')).toBeGreaterThan(generationOf('revoke'));
  });

  it('resumes with identical phase identities and does not re-execute completed fake phases', async () => {
    const initializationCache = new Map<string, Awaited<ReturnType<typeof fakeInitialization>>>();
    const lifecycleCache = new Map<string, Awaited<ReturnType<typeof fakeLifecycle>>>();
    const executions = new Map<string, number>();
    let reconnectFailed = false;
    const runInitialization = vi.fn(async (run: WorkspaceHostInitializationRunInput) => {
      const id = run.operationId!;
      const cached = initializationCache.get(id);
      if (cached) return cached;
      executions.set(id, (executions.get(id) ?? 0) + 1);
      const result = await fakeInitialization(run);
      initializationCache.set(id, result);
      return result;
    });
    const runLifecycle = vi.fn(async (run: WorkspaceHostCredentialLifecycleRunInput) => {
      const id = run.operationId!;
      const cached = lifecycleCache.get(id);
      if (cached) return cached;
      executions.set(id, (executions.get(id) ?? 0) + 1);
      if (run.action === 'reconnect' && !reconnectFailed) {
        reconnectFailed = true;
        throw new Error('interrupted after revoke');
      }
      const result = await fakeLifecycle(run);
      lifecycleCache.set(id, result);
      return result;
    });
    const run = input();

    await expect(
      runWorkspaceHostCanary(run, {
        runInitialization,
        runLifecycle,
        verifyAgentCredentialAdmission,
        now: () => new Date(OBSERVED_AT),
      }),
    ).rejects.toThrow('interrupted after revoke');
    const resumed = await runWorkspaceHostCanary(run, {
      runInitialization,
      runLifecycle,
      verifyAgentCredentialAdmission,
      now: () => new Date(OBSERVED_AT),
    });

    const ids = workspaceHostCanaryOperationIds(run.runId);
    expect(resumed.operationIds).toEqual(ids);
    expect(executions.get(ids.initialize)).toBe(1);
    expect(executions.get(ids.rotate)).toBe(1);
    expect(executions.get(ids.revoke)).toBe(1);
    expect(executions.get(ids.reconnect)).toBe(2);
    expect(executions.get(ids['restore-rebind'])).toBe(1);
    expect(resumed.assembly.validation.ok).toBe(true);
  });

  it('fails closed before lifecycle work when initialization evidence does not prove a private clone', async () => {
    const runLifecycle = vi.fn(fakeLifecycle);
    const runInitialization = vi.fn(async (run: WorkspaceHostInitializationRunInput) => {
      const result = await fakeInitialization(run);
      const verify = result.receipts.find((receipt) =>
        result.plan.steps.some((step) => step.id === receipt.stepId && step.kind === 'verify-initialization'),
      )!;
      verify.publicEvidence = {
        sourceKind: 'git',
        requiredChannels: [...WORKSPACE_HOST_CREDENTIAL_CHANNELS],
        repository: { visibility: 'public', cloned: true },
        agents: agentReport().agents,
        agentContractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
      };
      return result;
    });

    await expect(
      runWorkspaceHostCanary(input(), {
        runInitialization,
        runLifecycle,
        verifyAgentCredentialAdmission,
        now: () => new Date(OBSERVED_AT),
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostCanaryRunError);
    expect(runLifecycle).not.toHaveBeenCalled();
  });

  it('preflights every credential generation before the initialization runner is invoked', async () => {
    const runInitialization = vi.fn(fakeInitialization);
    const incomplete = input();
    incomplete.credentials.restored.credentialRefs.agentCredentialRef = undefined;

    await expect(
      runWorkspaceHostCanary(incomplete, {
        runInitialization,
        runLifecycle: fakeLifecycle,
        verifyAgentCredentialAdmission,
      }),
    ).rejects.toThrow(/restored credential generation is missing channel/);
    expect(runInitialization).not.toHaveBeenCalled();
  });

  it('rejects a revoked future generation before starting initialization', async () => {
    const runInitialization = vi.fn(fakeInitialization);
    const verifier = vi.fn(async (request: WorkspaceHostAgentCredentialAdmissionInput) => {
      if (request.delivery.generation === 2) throw new Error('generation 2 credential-revoked');
      return admissionEvidence(request);
    });

    await expect(
      runWorkspaceHostCanary(input(), {
        runInitialization,
        runLifecycle: fakeLifecycle,
        verifyAgentCredentialAdmission: verifier,
      }),
    ).rejects.toThrow(/generation 2 credential-revoked/);
    expect(runInitialization).not.toHaveBeenCalled();
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it('rejects a future-generation receipt bound to a different generation before initialization', async () => {
    const runInitialization = vi.fn(fakeInitialization);
    const verifier = vi.fn(async (request: WorkspaceHostAgentCredentialAdmissionInput) => {
      const evidence = admissionEvidence(request);
      return {
        ...evidence,
        binding: { ...evidence.binding, generation: evidence.binding.generation + 1 },
      };
    });

    await expect(
      runWorkspaceHostCanary(input(), {
        runInitialization,
        runLifecycle: fakeLifecycle,
        verifyAgentCredentialAdmission: verifier,
      }),
    ).rejects.toThrow(/does not match the requested binding/);
    expect(runInitialization).not.toHaveBeenCalled();
    expect(verifier).toHaveBeenCalledTimes(1);
  });
});
