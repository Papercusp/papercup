import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  type WorkspaceHostInitializationPlan,
  type WorkspaceHostInitializationStepReceipt,
} from '@papercusp/deployment-driver';
import { projectByocReleaseMilestones } from '../byoc-release-carry';
import {
  WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE,
  WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE,
  openWorkspaceHostInitializationRelease,
  workspaceHostFixedAgentInitializationOutcome,
  workspaceHostFixedAgentInitializationStage,
  workspaceHostRootBootstrapEvidenceRefs,
} from './initialization-release-receipt';
import {
  BUNDLE,
  OTHER_BUNDLE,
  TASK_ID,
  builtReceipts,
  labelJournal,
  memoryReleaseLedger,
  receipt,
} from './release-journal-test-support';
import { WorkspaceHostReleaseBindingError } from './release-stage-receipt';

const SUBJECT = { workspaceId: 'workspace-1', hostId: 'host-1' };

function plan(verifyInput: Record<string, unknown>): WorkspaceHostInitializationPlan {
  return {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: 'init-1',
    workspaceId: SUBJECT.workspaceId,
    hostId: SUBJECT.hostId,
    requestedAt: new Date(0).toISOString(),
    steps: [
      { id: 'workspace', kind: 'create-workspace', dependsOn: [], idempotencyKey: 'init-1:workspace', input: {} },
      {
        id: 'verify',
        kind: 'verify-initialization',
        dependsOn: ['workspace'],
        idempotencyKey: 'init-1:verify',
        input: { sourceKind: 'git', ...verifyInput },
      },
    ],
  };
}

// D-338: the retained legs are Claude and OMP; funded direct-Codex is the one skipped agent.
const RETAINED = plan({ requestedAgents: ['claude', 'omp'], requiredChannels: ['git', 'agent'] });

function verifyReceipt(agents: Record<string, unknown>): WorkspaceHostInitializationStepReceipt {
  return {
    stepId: 'verify',
    status: 'succeeded',
    observedAt: new Date(0).toISOString(),
    publicEvidence: { agents, agentContractVersion: 'papercusp-workspace-host-agent-verification-v4' },
  };
}

const READY = {
  claude: { ready: true, verificationKind: 'live-inference', proofDigest: 'proof-claude' },
  omp: { ready: true, verificationKind: 'local-inference', proofDigest: 'proof-omp' },
};

/** A managed cut whose build and publication committed: the prefix the R-5 stages extend. */
function publishedStore() {
  return memoryReleaseLedger(
    labelJournal([...builtReceipts(), receipt('publish.finalize', 'committed', [`provider:bundle:${BUNDLE}`], 2)]),
  );
}

function open(store: ReturnType<typeof memoryReleaseLedger>, operationId: string, bundle = BUNDLE) {
  return openWorkspaceHostInitializationRelease({
    releaseTaskId: TASK_ID,
    ...SUBJECT,
    operationId,
    plan: RETAINED,
    ledger: store,
    readHostRuntimeRelease: async () => ({ bundleSha256: bundle }),
  });
}

async function bindingError(promise: Promise<unknown>): Promise<WorkspaceHostReleaseBindingError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceHostReleaseBindingError);
  return error as WorkspaceHostReleaseBindingError;
}

async function recordBoth(store: ReturnType<typeof memoryReleaseLedger>, operationId: string) {
  const release = await open(store, operationId);
  await release.begin('root-bootstrap');
  await release.settle(
    'root-bootstrap',
    'committed',
    workspaceHostRootBootstrapEvidenceRefs(SUBJECT, { waitedMs: 41_000, probes: 5, readyImmediately: false }),
  );
  await release.begin('fixed-agents');
  const fixed = workspaceHostFixedAgentInitializationOutcome({
    subject: SUBJECT,
    stage: release.stage('fixed-agents'),
    receipts: [verifyReceipt(READY)],
  });
  await release.settle('fixed-agents', fixed.outcome, fixed.evidenceRefs);
}

describe('workspace.fixed-agent-initialization stage identity', () => {
  it('names the canonical agent set and sorted credential channels of the plan that runs', () => {
    const reordered = plan({ requestedAgents: ['omp', 'claude'], requiredChannels: ['git', 'agent'] });
    expect(workspaceHostFixedAgentInitializationStage(reordered)).toEqual({
      stage: WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE,
      identity: { agents: ['claude', 'omp'], channels: ['agent', 'git'] },
    });
  });

  it('reads omitted coverage as every agent, never as the retained pair', () => {
    const stage = workspaceHostFixedAgentInitializationStage(plan({ requiredChannels: ['agent'] }));
    expect(stage.identity.agents).toEqual(['claude', 'codex', 'omp']);
  });
});

describe('workspace.fixed-agent-initialization outcome', () => {
  const stage = workspaceHostFixedAgentInitializationStage(RETAINED);

  it('commits only when the verify step itself shows every agent on the identity ready', () => {
    const outcome = workspaceHostFixedAgentInitializationOutcome({ subject: SUBJECT, stage, receipts: [verifyReceipt(READY)] });
    expect(outcome.outcome).toBe('committed');
    expect(outcome.evidenceRefs).toEqual(
      expect.arrayContaining([
        'initialize-agent:claude:ready:live-inference',
        'initialize-agent-proof:claude:proof-claude',
        'initialize-agent:omp:ready:local-inference',
        'initialize-agent-contract:papercusp-workspace-host-agent-verification-v4',
      ]),
    );
    // Codex is not on the identity, so its absence is neither evidence nor a failure.
    expect(outcome.evidenceRefs.some((ref) => ref.includes('codex'))).toBe(false);
  });

  it('refuses when an agent is unready, missing from the evidence, or there is no verify receipt at all', () => {
    const unready = workspaceHostFixedAgentInitializationOutcome({
      subject: SUBJECT,
      stage,
      receipts: [verifyReceipt({ ...READY, omp: { ready: false, verificationKind: 'local-inference' } })],
    });
    expect(unready.outcome).toBe('refused');
    expect(unready.evidenceRefs).toContain('initialize-agent:omp:unready:local-inference');

    const missing = workspaceHostFixedAgentInitializationOutcome({
      subject: SUBJECT,
      stage,
      receipts: [verifyReceipt({ claude: READY.claude })],
    });
    expect(missing.outcome).toBe('refused');
    expect(missing.evidenceRefs).toContain('initialize-agent:omp:unready:unreported');

    expect(workspaceHostFixedAgentInitializationOutcome({ subject: SUBJECT, stage, receipts: [] }).outcome).toBe('refused');
  });
});

describe('initialization release recorder', () => {
  it('records both R-5 stages so the milestone projection verifies them, each naming its initialization', async () => {
    const store = publishedStore();
    await recordBoth(store, 'init-1');

    const committed = store.journal.receipts.filter((entry) => entry.state === 'committed').map((entry) => entry.stage);
    expect(committed).toEqual([
      'release.build.workspace-host-linux-x86_64',
      'publish.finalize',
      WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE,
      WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE,
    ]);
    for (const stage of [WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE, WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE]) {
      const settled = store.journal.receipts.find((entry) => entry.stage === stage && entry.state === 'committed');
      expect(settled?.evidenceRefs[0]).toBe('initialize-operation:init-1');
    }
    const milestones = projectByocReleaseMilestones(store.journal).milestones;
    expect(milestones.find((entry) => entry.key === 'root-bootstrap')?.status).toBe('verified');
    expect(milestones.find((entry) => entry.key === 'fixed-agent-initialization')?.status).toBe('verified');
  });

  it('lets a resumed run of the SAME initialization finish without writing or refusing anything', async () => {
    const store = publishedStore();
    await recordBoth(store, 'init-1');
    const cursor = store.journal.cursor;
    await recordBoth(store, 'init-1');
    expect(store.journal.cursor).toBe(cursor);
  });

  it('refuses a different initialization once the release already committed the stage', async () => {
    const store = publishedStore();
    await recordBoth(store, 'init-1');
    const error = await bindingError(open(store, 'init-2'));
    expect(error.reason).toBe('stage-committed');
    expect(error.stage).toBe(WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE);
  });

  it('settles a failed run refused-and-retryable, so the next attempt mints a fresh request', async () => {
    const store = publishedStore();
    const first = await open(store, 'init-1');
    await first.begin('root-bootstrap');
    await first.refuseOpen(['initialize-failure:GcpIapWorkspaceHostBootstrapNotReadyError']);
    const refused = store.journal.receipts.at(-1)!;
    expect(refused).toMatchObject({ stage: WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE, state: 'refused' });
    expect(refused.evidenceRefs).toEqual([
      'reconcile:confirmed-absent',
      'initialize-operation:init-1',
      'initialize-failure:GcpIapWorkspaceHostBootstrapNotReadyError',
    ]);

    const retry = await open(store, 'init-1');
    await retry.begin('root-bootstrap');
    const intents = store.journal.receipts.filter(
      (entry) => entry.stage === WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE && entry.state === 'intent',
    );
    expect(new Set(intents.map((entry) => entry.requestIdentity)).size).toBe(2);
  });

  it('refuses to open against a host that runs other bytes, before writing anything', async () => {
    const store = publishedStore();
    const cursor = store.journal.cursor;
    const error = await bindingError(open(store, 'init-1', OTHER_BUNDLE));
    expect(error.reason).toBe('bundle-mismatch');
    expect(store.journal.cursor).toBe(cursor);
  });
});
