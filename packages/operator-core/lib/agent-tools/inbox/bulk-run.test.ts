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
  failRunIfExecuting: vi.fn(),
  recordRunHeartbeat: vi.fn(),
  reportOutcomes: vi.fn(),
  setRunPhase: vi.fn(),
  settleRunPhase: vi.fn(),
  callPlansRead: vi.fn(),
  inProcessCall: vi.fn(),
  innerCall: vi.fn(),
  dispatchAttentionTerminalAction: vi.fn(),
  readStandingBulkAutomationPolicy: vi.fn(),
  upsertTriage: vi.fn(),
  notifySyncInvalidate: vi.fn(),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('../../attention/bulk-run-store', () => ({
  getRun: h.getRun,
  getActiveRun: h.getActiveRun,
  getRunItems: h.getRunItems,
  executeBulkRunAction: h.executeBulkRunAction,
  failRunIfExecuting: h.failRunIfExecuting,
  recordRunHeartbeat: h.recordRunHeartbeat,
  reportOutcomes: h.reportOutcomes,
  setRunPhase: h.setRunPhase,
  settleRunPhase: h.settleRunPhase,
}));
vi.mock('../../attention/triage-store', () => ({ upsertTriage: h.upsertTriage }));
vi.mock('../../attention/terminal-action-dispatch', () => ({
  dispatchAttentionTerminalAction: h.dispatchAttentionTerminalAction,
}));
vi.mock('../../attention/automation-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attention/automation-policy')>()),
  readStandingBulkAutomationPolicy: h.readStandingBulkAutomationPolicy,
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
  kind: 'coord-message',
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
  h.recordRunHeartbeat.mockResolvedValue(run);
  h.failRunIfExecuting.mockResolvedValue({ ...run, phase: 'failed' });
  h.reportOutcomes.mockResolvedValue({ unknown: [], refused: null });
  h.callPlansRead.mockResolvedValue({
    groups: [{ items: [{ id: item.itemId, ref: item.ref, actions: [{ id: 'ack', label: 'Acknowledge' }] }] }],
  });
  h.inProcessCall.mockReturnValue(h.innerCall);
  h.dispatchAttentionTerminalAction.mockResolvedValue({ resolved: true });
  h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L1', minConfidence: 'high' });
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
    expect(h.callPlansRead).toHaveBeenCalledTimes(1);
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

  it('loads one canonical action snapshot for a max-size 200-item manifest', async () => {
    const items = Array.from({ length: 200 }, (_, position) => ({
      ...item,
      itemId: `attention-${position + 1}`,
      position,
    }));
    h.getRunItems.mockResolvedValue(items);
    h.callPlansRead.mockResolvedValue({
      groups: [
        {
          items: items.map((row) => ({
            id: row.itemId,
            ref: row.ref,
            actions: [{ id: 'ack', label: 'Acknowledge' }],
          })),
        },
      ],
    });

    const result = body(
      await bulkRunManifest.handler(
        { runId: run.runId, includeReported: false },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.callPlansRead).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(200);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'attention-200',
          actions: [{ id: 'ack', label: 'Acknowledge', terminal: true }],
        }),
      ]),
    );
  });
});

describe('inbox:bulk-run-report live-action snapshot reuse', () => {
  it('validates a batch from one canonical action snapshot', async () => {
    const second = { ...item, itemId: 'attention-2', position: 1 };
    h.callPlansRead.mockResolvedValue({
      groups: [
        {
          items: [item, second].map((row) => ({
            id: row.itemId,
            ref: row.ref,
            actions: [{ id: 'ack', label: 'Acknowledge' }],
          })),
        },
      ],
    });

    await bulkRunReport.handler(
      {
        runId: run.runId,
        items: [item, second].map((row) => ({
          itemId: row.itemId,
          outcome: 'recommended' as const,
          actionId: 'ack',
          rationale: 'The message only needs acknowledgement.',
        })),
      },
      { workspaceId: run.workspaceId } as never,
    );

    expect(h.callPlansRead).toHaveBeenCalledTimes(1);
    expect(h.reportOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        outcomes: expect.arrayContaining([
          expect.objectContaining({ itemId: item.itemId, actionId: 'ack' }),
          expect.objectContaining({ itemId: second.itemId, actionId: 'ack' }),
        ]),
      }),
    );
  });
});

describe('inbox:bulk-run-act authority boundary', () => {
  async function arrangeSuccessfulAction(
    overrides: Partial<Omit<typeof item, 'kind' | 'ref'>> & {
      kind?: string;
      ref?: Record<string, unknown>;
    } = {},
  ) {
    const activeItem = { ...item, ...overrides };
    h.getRunItems.mockResolvedValue([activeItem]);
    h.callPlansRead.mockResolvedValue({
      groups: [
        {
          items: [
            {
              id: activeItem.itemId,
              ref: activeItem.ref,
              actions: [{ id: 'resolve', label: 'Resolve' }],
            },
          ],
        },
      ],
    });
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => ({
      actionResult: await input.execute(),
      item: {
        ...activeItem,
        outcome: 'auto_resolved',
        actionId: input.actionId,
        rationale: input.rationale,
      },
      run: { ...run, autoResolved: 1 },
      refused: null,
    }));
    return activeItem;
  }

  it('uses the live standing confidence floor rather than the run receipt', async () => {
    h.getRun.mockResolvedValue({
      ...run,
      automationPolicy: { level: 'L2', mode: 'safe-high', minConfidence: 'low' },
    });
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L1', minConfidence: 'high' });
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'Evidence is incomplete.',
          confidenceLevel: 'medium',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      refused: 'automation_policy',
      reason: 'confidence-below-floor',
    });
    expect(h.readStandingBulkAutomationPolicy).toHaveBeenCalledWith(run.workspaceId);
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

  it('keeps L0 review-all even for above-floor delegable kinds', async () => {
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L0', minConfidence: 'high' });
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'High-confidence acknowledgement.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, refused: 'automation_policy', reason: 'review-all' });
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

  it('lets L1 auto-apply an above-floor delegable kind', async () => {
    await arrangeSuccessfulAction();
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'resolve',
          rationale: 'The delegable item has decisive evidence.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, outcome: 'auto_resolved', actionDispatched: true });
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
  });

  it('keeps owner-by-right kinds unreachable at L1', async () => {
    h.getRunItems.mockResolvedValue([
      {
        ...item,
        kind: 'work-item-needs-human',
        ref: { kind: 'work-item-needs-human', msgId: 'msg-owner' },
      },
    ]);
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'resolve',
          rationale: 'The item is ready to resume.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, refused: 'automation_policy', reason: 'owner-by-right' });
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

  it('lets L2 auto-ratify an above-floor owner-by-right judgment kind', async () => {
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L2', minConfidence: 'high' });
    await arrangeSuccessfulAction({
      kind: 'work-item-needs-human',
      ref: { kind: 'work-item-needs-human', msgId: 'msg-owner' },
    });
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'resolve',
          rationale: 'The owner gate is satisfied by decisive evidence.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, outcome: 'auto_resolved', actionDispatched: true });
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
  });

  it('keeps never-auto kinds unreachable even at L2 and above the floor', async () => {
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L2', minConfidence: 'low' });
    h.getRunItems.mockResolvedValue([{ ...item, kind: 'smoke-fail', ref: { kind: 'smoke-fail' } }]);
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'resolve',
          rationale: 'Must remain protected.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, refused: 'automation_policy', reason: 'never-auto' });
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

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
          confidenceLevel: 'high',
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
          confidenceLevel: 'high',
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
          confidenceLevel: 'high',
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

// WI-41370 — the plan-item terminal actions failed live because this wiring passed
// `itemId` to plans:set-status (which accepts only `item` and REJECTS undeclared keys,
// EI-10883) and `dropped` additionally requires a nonblank rationale. Pin the wire
// contract so a key rename or a dropped-reason regression fails here, not in the field.
describe('terminalDependencies plan-item wire contract (WI-41370)', () => {
  it('setPlanItemStatus calls plans:set-status with item (never itemId) and threads the rationale', async () => {
    const { terminalDependencies } = await import('./bulk-run');
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { ok: true };
    };
    const deps = terminalDependencies({ call: call as never });

    await deps.setPlanItemStatus({ slug: 'a-plan', itemId: 'P-010', status: 'dropped', rationale: 'why it is moot' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('plans:set-status');
    expect(calls[0]!.args).toMatchObject({ slug: 'a-plan', item: 'P-010', status: 'dropped' });
    expect(calls[0]!.args).not.toHaveProperty('itemId');
    expect(String(calls[0]!.args.rationale)).toContain('why it is moot');

    // `dropped` REQUIRES a nonblank reason server-side: the wiring must supply a
    // fallback even when the caller omitted one.
    await deps.setPlanItemStatus({ slug: 'a-plan', itemId: 'P-011', status: 'done' });
    expect(String(calls[1]!.args.rationale ?? '').trim()).not.toBe('');
  });
});
