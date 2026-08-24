/**
 * inbox:bulk-run-act / report recurrence guards (WI-41022).
 *
 * The store integration suite proves the run-row lock ordering. These tests
 * pin the tool boundary around that store primitive: only `act` may create an
 * auto-resolved outcome, it reuses the shared terminal dispatcher, a Stop
 * refusal never enters the dispatcher, and a persistence failure after an
 * external effect is surfaced as a non-retryable reconciliation incident.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getRun: vi.fn(),
  getActiveRun: vi.fn(),
  getRunItems: vi.fn(),
  executeBulkRunAction: vi.fn(),
  reportOutcomes: vi.fn(),
  setRunPhase: vi.fn(),
  settleRunPhase: vi.fn(),
  callPlansRead: vi.fn(),
  inProcessCall: vi.fn(),
  innerCall: vi.fn(),
  dispatchAttentionTerminalAction: vi.fn(),
  upsertTriage: vi.fn(),
  notifySyncInvalidate: vi.fn(),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('../../attention/bulk-run-store', () => ({
  getRun: h.getRun,
  getActiveRun: h.getActiveRun,
  getRunItems: h.getRunItems,
  executeBulkRunAction: h.executeBulkRunAction,
  reportOutcomes: h.reportOutcomes,
  setRunPhase: h.setRunPhase,
  settleRunPhase: h.settleRunPhase,
}));
vi.mock('../../attention/triage-store', () => ({ upsertTriage: h.upsertTriage }));
vi.mock('../../attention/terminal-action-dispatch', () => ({
  dispatchAttentionTerminalAction: h.dispatchAttentionTerminalAction,
}));
vi.mock('../plans/read-dispatch', () => ({ callPlansRead: h.callPlansRead }));
vi.mock('../_compound-dispatch', () => ({ inProcessCall: h.inProcessCall }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-resolver' }),
}));
vi.mock('../coordination/inbox-reply', () => ({ deliverInboxOwnerReply: vi.fn() }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: h.notifySyncInvalidate }));

import { bulkRunAct, bulkRunManifest, bulkRunReport } from './bulk-run';

type ToolBody = Record<string, unknown>;
type ExecuteInput = {
  runId: string;
  itemId: string;
  actionId: string;
  rationale: string;
  execute: () => Promise<unknown>;
  audit?: (tx: unknown) => Promise<void>;
};

function body(result: unknown): ToolBody {
  const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`not a tool response: ${JSON.stringify(result)}`);
  return JSON.parse(text) as ToolBody;
}

const run = {
  runId: 'run-1',
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp',
  phase: 'running',
  autoResolved: 0,
  recommended: 0,
  skipped: 0,
  failed: 0,
};

const item = {
  runId: run.runId,
  itemId: 'attention-1',
  position: 0,
  kind: 'message',
  title: 'Acknowledge this message',
  ref: { kind: 'coord-message', msgId: 'msg-1' },
  ownerAgentId: 'su-asker',
  outcome: 'pending',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getFlag.mockResolvedValue(true);
  h.getRun.mockResolvedValue(run);
  h.getRunItems.mockResolvedValue([item]);
  h.callPlansRead.mockResolvedValue({
    groups: [{ items: [{ id: item.itemId, ref: item.ref, actions: [{ id: 'ack', label: 'Acknowledge' }] }] }],
  });
  h.inProcessCall.mockReturnValue(h.innerCall);
  h.dispatchAttentionTerminalAction.mockResolvedValue({ resolved: true });
  h.upsertTriage.mockResolvedValue(undefined);
  h.notifySyncInvalidate.mockResolvedValue(undefined);
});

describe('inbox:bulk-run-report auto_resolved rail', () => {
  it('rejects auto_resolved in both shorthand and bulk forms while accepting recommendations', () => {
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        itemId: item.itemId,
        outcome: 'auto_resolved',
        actionId: 'ack',
        rationale: 'Handled.',
      }).success,
    ).toBe(false);
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        items: [{ itemId: item.itemId, outcome: 'auto_resolved', actionId: 'ack', rationale: 'Handled.' }],
      }).success,
    ).toBe(false);
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        itemId: item.itemId,
        outcome: 'recommended',
        actionId: 'ack',
        rationale: 'The message only needs acknowledgement.',
      }).success,
    ).toBe(true);
  });
});

describe('inbox:bulk-run-manifest canonical action vocabulary', () => {
  it('bypasses the UI list projection, which intentionally strips actions', async () => {
    const result = body(
      await bulkRunManifest.handler(
        { runId: run.runId, includeReported: false },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.callPlansRead).toHaveBeenCalledWith('attention', {}, { uiProjection: false });
    expect(result).toMatchObject({
      ok: true,
      items: [
        expect.objectContaining({
          itemId: item.itemId,
          actions: [{ id: 'ack', label: 'Acknowledge', terminal: true }],
        }),
      ],
    });
  });
});

describe('inbox:bulk-run-act authority boundary', () => {
  it('dispatches through the shared map and joins the required audit to the store transaction', async () => {
    const tx = { transaction: 'bulk-act' };
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => {
      const actionResult = await input.execute();
      await input.audit?.(tx);
      return {
        actionResult,
        item: { ...item, outcome: 'auto_resolved', actionId: input.actionId, rationale: input.rationale },
        run: { ...run, autoResolved: 1 },
        refused: null,
      };
    });

    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'The owner has read the message.',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ id: item.itemId, ref: item.ref }),
        actionId: 'ack',
      }),
    );
    expect(h.upsertTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: item.itemId,
        action: 'resolve',
        note: 'Bulk resolve: The owner has read the message.',
        triagedBy: 'su-resolver',
        workspaceId: run.workspaceId,
        sql: tx,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      outcome: 'auto_resolved',
      actionDispatched: true,
      counters: { autoResolved: 1 },
    });
  });

  it('does not enter the dispatcher when Stop has already revoked run authority', async () => {
    h.executeBulkRunAction.mockResolvedValue({
      actionResult: null,
      item: null,
      run: { ...run, phase: 'review' },
      refused: { reason: 'run_authority_revoked', phase: 'review' },
    });

    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'Must not run after Stop.',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
    expect(h.upsertTriage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      refused: 'run_authority_revoked',
      actionDispatched: false,
    });
  });

  it('surfaces a post-dispatch audit failure as reconciliation-required and never retries', async () => {
    const tx = { transaction: 'bulk-act-failed' };
    h.upsertTriage.mockRejectedValue(new Error('audit insert failed'));
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => {
      await input.execute();
      await input.audit?.(tx);
      throw new Error('unreachable');
    });

    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'The message was acknowledged before audit persistence failed.',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
    expect(h.upsertTriage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      error: 'post_dispatch_persistence_failed',
      actionDispatched: true,
      reconciliationRequired: true,
    });
  });
});
