import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';

import { desktopAuditAction, desktopAuditSubject } from '../desktop/desktop-audit';
import {
  BUNDLE,
  TASK_ID,
  builtReceipts,
  labelJournal,
  memoryReleaseLedger,
  receipt,
} from './release-journal-test-support';
import {
  WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE,
  WorkspaceHostCustomerAcceptanceError,
  recordWorkspaceHostCustomerAcceptance,
  workspaceHostCustomerAcceptanceStage,
} from './customer-acceptance-release-receipt';
import { WorkspaceHostReleaseBindingError } from './release-stage-receipt';

const WORKSPACE = 'workspace-1';
const HOST = 'host-1';
const CUSTOMER = 'customer-workspace-1';
const HOSTED_SESSION = 'hosted-session-1';
const CHANNEL = 'channel-1';
const PREREQUISITE_TIME = '2026-09-02T01:00:00.000Z';
const TAKEOVER_TIME = '2026-09-02T02:00:00.000Z';
const RUNTIME_RELEASE = {
  version: '0.0.21-p318',
  bundleSha256: BUNDLE,
  signingKeySha256: 'f'.repeat(64),
  protocolVersion: '1',
  schemaVersion: '1',
};

function releaseLedger() {
  const values = [
    ...builtReceipts(),
    receipt('publish.finalize', 'committed', [`provider:bundle:${BUNDLE}`], 2),
    receipt('workspace.root-bootstrap', 'committed', ['initialize-operation:init-1'], 3),
    receipt('workspace.fixed-agent-initialization', 'committed', ['initialize-operation:init-1'], 4),
  ].map((entry) => ({ ...entry, recordedAt: PREREQUISITE_TIME }));
  return memoryReleaseLedger(labelJournal(values));
}

function activeHostRow(overrides: Record<string, unknown> = {}) {
  return {
    desired_state: 'running',
    observed_state: 'running',
    observed_revision: 10,
    desired_revision: 10,
    organization_id: 'org-1',
    ...overrides,
  };
}

function takeoverAudit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hosted-vnc-acceptance-1',
    ts: Date.parse(TAKEOVER_TIME),
    actor: 'customer-user-1',
    action: desktopAuditAction('takeover', 'started'),
    subject: desktopAuditSubject('hosted', HOST, CHANNEL),
    details: {
      target: 'hosted',
      organizationId: 'org-1',
      customerWorkspaceId: CUSTOMER,
      hostId: HOST,
      userId: 'customer-user-1',
      hostedSessionId: HOSTED_SESSION,
      channelId: CHANNEL,
      detail: 'desktop=desktop-session-1',
    },
    ...overrides,
  };
}

function fakeSql(options: {
  host?: Record<string, unknown>;
  audit?: Record<string, unknown> | null;
} = {}): Sql {
  return (async (strings: TemplateStringsArray) => {
    const query = strings.join(' ');
    if (query.includes('harness_shared.workspace_hosts') && query.includes('harness_shared.customer_workspaces')) {
      return options.host === undefined ? [activeHostRow()] : [options.host];
    }
    if (query.includes('harness_shared.audit_log')) return options.audit === null ? [] : [options.audit ?? takeoverAudit()];
    throw new Error(`Unexpected SQL in customer acceptance test: ${query}`);
  }) as unknown as Sql;
}

function record(ledger: ReturnType<typeof releaseLedger>, sql: Sql = fakeSql()) {
  return recordWorkspaceHostCustomerAcceptance({
    workspaceId: WORKSPACE,
    hostId: HOST,
    customerWorkspaceId: CUSTOMER,
    hostedSessionId: HOSTED_SESSION,
    channelId: CHANNEL,
    releaseTaskId: TASK_ID,
    sql,
    ledger,
    readHostRuntimeRelease: async () => RUNTIME_RELEASE,
  });
}

describe('desktop-session.customer-acceptance', () => {
  it('binds the stage identity to the exact release bundle and takeover evidence contract', () => {
    expect(workspaceHostCustomerAcceptanceStage(BUNDLE)).toEqual({
      stage: WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE,
      identity: {
        bundleSha256: BUNDLE,
        evidenceSource: 'hosted-controller-takeover-v1',
      },
    });
  });

  it('commits only after a post-initialization authenticated customer takeover on the exact live release', async () => {
    const ledger = releaseLedger();

    const result = await record(ledger);

    expect(result).toMatchObject({
      outcome: 'committed',
      stage: 'desktop-session.customer-acceptance',
      releaseTaskId: TASK_ID,
      bundleSha256: BUNDLE,
      auditEventId: 'hosted-vnc-acceptance-1',
    });
    expect(result.evidenceRefs).toEqual([
      'hosted-desktop-takeover:hosted-vnc-acceptance-1',
      `hosted-session:${HOSTED_SESSION}`,
      `hosted-channel:${CHANNEL}`,
      'desktop-session:desktop-session-1',
      `customer-workspace:${CUSTOMER}`,
      'customer-actor:customer-user-1',
      `host:${HOST}`,
      `bundle:sha256:${BUNDLE}`,
    ]);
    expect(ledger.journal.receipts.at(-1)).toMatchObject({
      stage: WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE,
      state: 'committed',
      evidenceRefs: expect.arrayContaining(['hosted-desktop-takeover:hosted-vnc-acceptance-1']),
    });
  });

  it('does not write acceptance when the host is not live or the takeover audit is missing', async () => {
    const stopped = releaseLedger();
    await expect(record(stopped, fakeSql({ host: activeHostRow({ observed_state: 'absent' }) }))).rejects.toMatchObject({
      reason: 'host-not-running',
    } satisfies Partial<WorkspaceHostCustomerAcceptanceError>);
    expect(stopped.journal.cursor).toBe(5);

    const noAudit = releaseLedger();
    await expect(record(noAudit, fakeSql({ audit: null }))).rejects.toMatchObject({
      reason: 'takeover-not-found',
    } satisfies Partial<WorkspaceHostCustomerAcceptanceError>);
    expect(noAudit.journal.cursor).toBe(5);
  });

  it('rejects a takeover event that predates the committed initialization receipts', async () => {
    const ledger = releaseLedger();
    const audit = takeoverAudit({ ts: Date.parse('2026-09-02T00:30:00.000Z') });

    await expect(record(ledger, fakeSql({ audit }))).rejects.toMatchObject({ reason: 'takeover-predates-release' });
    expect(ledger.journal.cursor).toBe(5);
  });

  it('refuses a release whose host runtime does not match its published bundle', async () => {
    const ledger = releaseLedger();
    await expect(
      recordWorkspaceHostCustomerAcceptance({
        workspaceId: WORKSPACE,
        hostId: HOST,
        customerWorkspaceId: CUSTOMER,
        hostedSessionId: HOSTED_SESSION,
        channelId: CHANNEL,
        releaseTaskId: TASK_ID,
        sql: fakeSql(),
        ledger,
        readHostRuntimeRelease: async () => ({ ...RUNTIME_RELEASE, bundleSha256: 'd'.repeat(64) }),
      }),
    ).rejects.toMatchObject({ reason: 'bundle-mismatch' } satisfies Partial<WorkspaceHostReleaseBindingError>);
    expect(ledger.journal.cursor).toBe(5);
  });

  it('does not append a duplicate receipt when the same takeover is reconciled again', async () => {
    const ledger = releaseLedger();
    await record(ledger);
    const cursor = ledger.journal.cursor;

    await record(ledger);

    expect(ledger.journal.cursor).toBe(cursor);
    expect(ledger.journal.receipts.filter((entry) => entry.stage === WORKSPACE_HOST_CUSTOMER_ACCEPTANCE_STAGE)).toHaveLength(2);
  });
});
