import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import type { Sql } from 'postgres';

import {
  BUNDLE,
  TASK_ID,
  builtReceipts,
  labelJournal,
  memoryReleaseLedger,
  receipt,
} from './release-journal-test-support';
import {
  WORKSPACE_HOST_RELEASE_CLEANUP_STAGE,
  recordWorkspaceHostReleaseCleanup,
  workspaceHostReleaseCleanupStage,
} from './release-cleanup-release-receipt';
import { gcpIapHostKeyAliasFamily } from './gcp-iap-initialization-operations';

const WORKSPACE = 'workspace-1';
const HOST = 'host-1';
const RUNTIME_RELEASE = {
  version: '0.0.21-p318',
  bundleSha256: BUNDLE,
  signingKeySha256: 'f'.repeat(64),
  protocolVersion: '1',
  schemaVersion: '1',
};
const DESIRED = {
  hostId: HOST,
  target: 'gcp',
  scope: { kind: 'project', id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-standard-4',
  image: { id: 'projects/project-1/global/images/workspace-host' },
  data: { encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
} as unknown as WorkspaceHostDesiredSpec;

function releaseLedger(withBilling = true) {
  const build = builtReceipts();
  const committedBuild = { ...build[1]!, requestIdentity: build[0]!.requestIdentity };
  const receipts = [
    build[0]!,
    committedBuild,
    receipt('publish.finalize', 'committed', [`provider:bundle:${BUNDLE}`], 2),
    receipt('workspace.root-bootstrap', 'committed', ['initialize-operation:init-1'], 3),
    receipt('workspace.fixed-agent-initialization', 'committed', ['initialize-operation:init-1'], 4),
    ...(withBilling ? [receipt('billing.closure', 'committed', ['destroy-operation:destroy-1'], 5)] : []),
  ];
  return memoryReleaseLedger(labelJournal(receipts));
}

function hostRow(overrides: Record<string, unknown> = {}) {
  return {
    target: 'gcp',
    desired_state: 'absent',
    observed_state: 'absent',
    observed_revision: 10,
    desired_revision: 10,
    desired_spec: DESIRED,
    ...overrides,
  };
}

function fakeSql(options: {
  host?: Record<string, unknown>;
  operations?: Array<{ id: string; status: string }>;
  workflows?: Array<{ workflow_uuid: string; status: string }>;
  failWorkflowRead?: boolean;
} = {}): Sql {
  return (async (strings: TemplateStringsArray) => {
    const query = strings.join(' ');
    if (query.includes('FROM harness_shared.workspace_hosts') && query.includes('desired_spec')) {
      return options.host === undefined ? [hostRow()] : [options.host];
    }
    if (query.includes('FROM harness_shared.workspace_hosts')) {
      return options.host === undefined ? [hostRow()] : [options.host];
    }
    if (query.includes('FROM harness_shared.workspace_host_operations')) return options.operations ?? [];
    if (query.includes('FROM dbos.workflow_status')) {
      if (options.failWorkflowRead) throw new Error('DBOS status read failed');
      return options.workflows ?? [];
    }
    throw new Error(`Unexpected SQL in release cleanup test: ${query}`);
  }) as unknown as Sql;
}

function cleanup(
  ledger: ReturnType<typeof releaseLedger>,
  sql: Sql = fakeSql(),
  options: {
    pruneControllerPins?: NonNullable<Parameters<typeof recordWorkspaceHostReleaseCleanup>[0]['pruneControllerPins']>;
  } = {},
) {
  return recordWorkspaceHostReleaseCleanup({
    workspaceId: WORKSPACE,
    hostId: HOST,
    releaseTaskId: TASK_ID,
    sql,
    ledger,
    readHostRuntimeRelease: async () => RUNTIME_RELEASE,
    resolveControllerProfile: () => ({ knownHostsFile: '/tmp/test-known-hosts' }),
    pruneControllerPins:
      options.pruneControllerPins ??
      (async ({ identity, confirmHostAbsent }) => {
        const absent = await confirmHostAbsent();
        if (!absent) throw new Error('host stopped being absent before pin cleanup');
        return { aliasFamily: gcpIapHostKeyAliasFamily(identity), removedEntries: 2, remainingEntries: 0 };
      }),
  });
}

describe('release.cleanup', () => {
  it('binds the cleanup predicate to one exact release bundle', () => {
    expect(workspaceHostReleaseCleanupStage(BUNDLE)).toEqual({
      stage: 'release.cleanup',
      identity: { bundleSha256: BUNDLE, cleanupContract: 'workspace-host-release-cleanup-v1' },
    });
  });

  it('commits only after absent host, no live operations/workflows, no other intent, billing, and pin cleanup', async () => {
    const ledger = releaseLedger();
    const pruneControllerPins = vi.fn(async ({ identity, confirmHostAbsent }: Parameters<NonNullable<Parameters<typeof recordWorkspaceHostReleaseCleanup>[0]['pruneControllerPins']>>[0]) => {
      expect(await confirmHostAbsent()).toBe(true);
      return { aliasFamily: gcpIapHostKeyAliasFamily(identity), removedEntries: 2, remainingEntries: 0 };
    });

    const result = await cleanup(ledger, fakeSql(), { pruneControllerPins });

    expect(result).toMatchObject({
      outcome: 'committed',
      stage: WORKSPACE_HOST_RELEASE_CLEANUP_STAGE,
      hostId: HOST,
      releaseTaskId: TASK_ID,
      bundleSha256: BUNDLE,
    });
    expect(result.evidenceRefs).toEqual(
      expect.arrayContaining([
        `release-cleanup-verification:${HOST}`,
        `cleanup-host:gcp:absent:absent`,
        'cleanup-live-operations:none',
        'cleanup-live-workflows:none',
        'cleanup-controller-pins-removed:2',
        'cleanup-controller-pins-remaining:0',
      ]),
    );
    expect(ledger.journal.receipts.at(-1)).toMatchObject({ stage: WORKSPACE_HOST_RELEASE_CLEANUP_STAGE, state: 'committed' });
  });

  it('settles a refused receipt with all measured blockers and does not prune while an operation is live', async () => {
    const ledger = releaseLedger();
    const pruneControllerPins = vi.fn();

    const result = await cleanup(ledger, fakeSql({ operations: [{ id: 'op-running', status: 'running' }] }), {
      pruneControllerPins,
    });

    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContain('cleanup-failed:live-operations:op-running');
    expect(pruneControllerPins).not.toHaveBeenCalled();
    expect(ledger.journal.receipts.at(-1)).toMatchObject({
      stage: WORKSPACE_HOST_RELEASE_CLEANUP_STAGE,
      state: 'refused',
      evidenceRefs: expect.arrayContaining(['reconcile:confirmed-absent']),
    });
  });

  it('blocks cleanup while a different stage still has an unmatched intent receipt', async () => {
    const ledger = releaseLedger();
    const intent = receipt('acceptance.soak-24h', 'intent', [], ledger.journal.cursor);
    ledger.journal.receipts.push(intent);
    ledger.journal.cursor += 1;
    ledger.journal.currentStage = intent.stage;
    ledger.journal.currentState = intent.state;
    ledger.journal.spentOperationIds.push(intent.requestIdentity);

    const pruneControllerPins = vi.fn();
    const result = await cleanup(ledger, fakeSql(), { pruneControllerPins });

    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContain('cleanup-failed:other-stage-intents:acceptance.soak-24h');
    expect(pruneControllerPins).not.toHaveBeenCalled();
  });

  it('fails closed on an unreadable DBOS workflow surface and does not claim there are no workflows', async () => {
    const ledger = releaseLedger();
    const pruneControllerPins = vi.fn();

    const result = await cleanup(ledger, fakeSql({ failWorkflowRead: true }), { pruneControllerPins });

    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContain('cleanup-failed:workflow-status-read-failed:Error');
    expect(pruneControllerPins).not.toHaveBeenCalled();
  });

  it('refuses when billing closure is not committed or a DBOS workflow remains pending', async () => {
    const noBilling = releaseLedger(false);
    const missingBilling = await cleanup(noBilling);
    expect(missingBilling.outcome).toBe('refused');
    expect(missingBilling.evidenceRefs).toContain('cleanup-failed:billing-closure-not-committed');

    const liveWorkflow = releaseLedger();
    const pending = await cleanup(
      liveWorkflow,
      fakeSql({ workflows: [{ workflow_uuid: 'workspace-host:workspace-1:host-1:operation:op-1', status: 'ENQUEUED' }] }),
    );
    expect(pending.outcome).toBe('refused');
    expect(pending.evidenceRefs).toContain(
      'cleanup-failed:live-workflows:workspace-host:workspace-1:host-1:operation:op-1',
    );
  });

  it('does not append a second committed cleanup receipt when the exact verification is replayed', async () => {
    const ledger = releaseLedger();
    await cleanup(ledger);
    const cursor = ledger.journal.cursor;

    await cleanup(ledger);

    expect(ledger.journal.cursor).toBe(cursor);
    expect(ledger.journal.receipts.filter((entry) => entry.stage === WORKSPACE_HOST_RELEASE_CLEANUP_STAGE)).toHaveLength(2);
  });
});
