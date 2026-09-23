/**
 * The R-5 release receipts as the initialization runner writes them (WI-10002510): WHEN each stage
 * opens and settles relative to the host work it vouches for, and what a failure leaves behind.
 * Stores are in-memory; the planner, the replay-safe executor and the release writer are real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceHostInitializationHostOperationResult,
  WorkspaceHostInitializationHostOperations,
  WorkspaceHostInitializationStep,
} from '@papercusp/deployment-driver';
import { projectByocReleaseMilestones } from '../byoc-release-carry';
import {
  WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE,
  WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE,
  openWorkspaceHostInitializationRelease,
} from './initialization-release-receipt';
import {
  BUNDLE,
  TASK_ID,
  builtReceipts,
  labelJournal,
  memoryReleaseLedger,
  receipt,
} from './release-journal-test-support';
import { WorkspaceHostReleaseBindingError } from './release-stage-receipt';

const h = vi.hoisted(() => ({ operation: [] as string[] }));
vi.mock('./observability-store', () => ({
  beginWorkspaceHostOperation: vi.fn(async () => {
    h.operation.push('begin');
  }),
  updateWorkspaceHostOperation: vi.fn(async (input: { status: string }) => {
    if (input.status !== 'running') h.operation.push(input.status);
  }),
  appendWorkspaceHostEvent: vi.fn(async () => undefined),
}));
vi.mock('./initialization-replay-store', () => ({
  createWorkspaceHostInitializationReplayStore: () => ({
    runOnce: async (_identity: unknown, run: () => Promise<unknown>) => run(),
  }),
}));

const { runWorkspaceHostInitialization } = await import('./initialization-runner');

const READY_AGENTS = {
  claude: { ready: true, verificationKind: 'live-inference', proofDigest: 'proof-claude' },
  omp: { ready: true, verificationKind: 'local-inference', proofDigest: 'proof-omp' },
};

class GcpIapWorkspaceHostBootstrapNotReadyError extends Error {
  override name = 'GcpIapWorkspaceHostBootstrapNotReadyError';
}

function publishedStore() {
  return memoryReleaseLedger(
    labelJournal([...builtReceipts(), receipt('publish.finalize', 'committed', [`provider:bundle:${BUNDLE}`], 2)]),
  );
}

type Store = ReturnType<typeof publishedStore>;

function lastStage(store: Store) {
  const last = store.journal.receipts.at(-1);
  return last ? `${last.stage}:${last.state}` : null;
}

/** A host adapter that records which release receipt was open when each piece of host work ran. */
function adapter(
  store: Store,
  options: { bootstrap?: 'ready' | 'never' | 'unobservable'; agents?: Record<string, unknown> } = {},
): WorkspaceHostInitializationHostOperations & { seen: string[] } {
  const seen: string[] = [];
  const operations: WorkspaceHostInitializationHostOperations & { seen: string[] } = {
    seen,
    supportedStepKinds: ['create-workspace', 'bind-credential', 'verify-initialization'],
    async execute(step: WorkspaceHostInitializationStep): Promise<WorkspaceHostInitializationHostOperationResult> {
      seen.push(`${step.id} with ${lastStage(store)}`);
      return {
        observedAt: '2026-08-25T16:00:00.000Z',
        publicEvidence:
          step.kind === 'verify-initialization'
            ? { agents: options.agents ?? READY_AGENTS, agentContractVersion: 'papercusp-workspace-host-agent-verification-v4' }
            : { step: step.id },
      };
    },
  };
  if (options.bootstrap !== 'unobservable') {
    operations.awaitBootstrapReady = async () => {
      seen.push(`bootstrap with ${lastStage(store)}`);
      if (options.bootstrap === 'never') throw new GcpIapWorkspaceHostBootstrapNotReadyError('conduit absent');
      return { waitedMs: 12_000, probes: 3, readyImmediately: false };
    };
  }
  return operations;
}

function run(store: Store, operations: WorkspaceHostInitializationHostOperations, releaseTaskId: string | null = TASK_ID) {
  const openRelease = vi.fn((input: Parameters<typeof openWorkspaceHostInitializationRelease>[0]) =>
    openWorkspaceHostInitializationRelease({
      ...input,
      ledger: store,
      readHostRuntimeRelease: async () => ({ bundleSha256: BUNDLE }),
    }),
  );
  const result = runWorkspaceHostInitialization(
    {
      workspaceId: 'workspace-1',
      hostId: 'host-1',
      operationId: 'init-1',
      requestedAt: '2026-08-25T15:00:00.000Z',
      source: { kind: 'empty' },
      credentialRefs: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
      credentialDelivery: {
        cloud: { kind: 'provider-identity', generation: 1, audience: 'host-1', revocationRef: 'revoke-cloud-1' },
      },
      requestedAgents: ['claude', 'omp'],
      credentialMaterialSource: {
        resolve: async () => {
          throw new Error('no credential material is read by this test');
        },
      },
      deliveryCapabilities: { fileTransfer: true },
      operations,
      ...(releaseTaskId !== null ? { releaseTaskId } : {}),
    },
    { openRelease },
  );
  return { result, openRelease };
}

describe('initialization runner release receipts', () => {
  beforeEach(() => {
    h.operation.length = 0;
  });

  it('holds root-bootstrap open across the bootstrap gate and fixed-agent-initialization across the plan', async () => {
    const store = publishedStore();
    const operations = adapter(store);
    await run(store, operations).result;

    expect(operations.seen).toEqual([
      `bootstrap with ${WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE}:intent`,
      `workspace with ${WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE}:intent`,
      `bind-cloud with ${WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE}:intent`,
      `verify with ${WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE}:intent`,
    ]);
    expect(h.operation).toEqual(['begin', 'succeeded']);
    const milestones = projectByocReleaseMilestones(store.journal).milestones;
    expect(milestones.find((entry) => entry.key === 'root-bootstrap')).toMatchObject({
      status: 'verified',
      evidenceRefs: expect.arrayContaining(['initialize-operation:init-1', 'bootstrap-waited-ms:12000']),
    });
    expect(milestones.find((entry) => entry.key === 'fixed-agent-initialization')).toMatchObject({
      status: 'verified',
      evidenceRefs: expect.arrayContaining(['initialize-agent:claude:ready:live-inference', 'initialize-agent:omp:ready:local-inference']),
    });
  });

  it('settles root-bootstrap refused when the bootstrap never finishes, and opens no fixed-agent stage', async () => {
    const store = publishedStore();
    await expect(run(store, adapter(store, { bootstrap: 'never' })).result).rejects.toThrow('conduit absent');

    expect(h.operation).toEqual(['begin', 'failed']);
    expect(store.journal.receipts.at(-1)).toMatchObject({
      stage: WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE,
      state: 'refused',
      evidenceRefs: [
        'reconcile:confirmed-absent',
        'initialize-operation:init-1',
        'initialize-failure:GcpIapWorkspaceHostBootstrapNotReadyError',
        'initialize-completed-steps:0/3',
      ],
    });
    expect(store.journal.receipts.some((entry) => entry.stage === WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE)).toBe(false);
  });

  it('refuses the fixed-agent RECEIPT, not the initialization, when the verify evidence shows an unready agent', async () => {
    const store = publishedStore();
    const agents = { ...READY_AGENTS, omp: { ready: false, verificationKind: 'local-inference' } };
    await run(store, adapter(store, { agents })).result;

    expect(h.operation).toEqual(['begin', 'succeeded']);
    expect(store.journal.receipts.at(-1)).toMatchObject({
      stage: WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE,
      state: 'refused',
      evidenceRefs: expect.arrayContaining(['initialize-agent:omp:unready:local-inference']),
    });
  });

  it('refuses a release run on an adapter that cannot observe bootstrap readiness, before any row or receipt', async () => {
    const store = publishedStore();
    const cursor = store.journal.cursor;
    const { result, openRelease } = run(store, adapter(store, { bootstrap: 'unobservable' }));
    const error = await result.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceHostReleaseBindingError);
    expect((error as WorkspaceHostReleaseBindingError).reason).toBe('stage-unobservable');
    expect(openRelease).not.toHaveBeenCalled();
    expect(h.operation).toEqual([]);
    expect(store.journal.cursor).toBe(cursor);
  });

  it('never opens a release journal for an ordinary initialization', async () => {
    const store = publishedStore();
    const cursor = store.journal.cursor;
    const { result, openRelease } = run(store, adapter(store), null);
    await result;
    expect(openRelease).not.toHaveBeenCalled();
    expect(store.journal.cursor).toBe(cursor);
  });
});
