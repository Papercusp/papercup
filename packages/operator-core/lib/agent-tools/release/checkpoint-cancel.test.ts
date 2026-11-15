/**
 * release:checkpoint-cancel — exact attempt/unit cancellation for a detached
 * green-checkpoint runner. The barrel import is intentional: a direct import
 * would make the registration guard pass even if the production wiring were
 * removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAgentIdentity: vi.fn(),
  resolveCheckpointRouting: vi.fn(),
  activeWorkspaceId: vi.fn(),
  operatorHomeHarnessSlug: vi.fn(),
  integrationRoot: vi.fn(),
  checkpointUnitForRoot: vi.fn(),
  terminateActiveCheckpointUnit: vi.fn(),
  cancelStoredQualification: vi.fn(),
  settleStoredUnreachableBlockedQualification: vi.fn(),
}));

vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/identity')>()),
  resolveAgentIdentity: mocks.resolveAgentIdentity,
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: mocks.activeWorkspaceId,
}));
vi.mock('../../harness/operator-home-harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/operator-home-harness')>()),
  operatorHomeHarnessSlug: mocks.operatorHomeHarnessSlug,
}));
vi.mock('../../harness/routines/hive-release-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/routines/hive-release-env')>()),
  resolveCheckpointRouting: mocks.resolveCheckpointRouting,
}));
vi.mock('../../release-deploy-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release-deploy-launch')>()),
  integrationRoot: mocks.integrationRoot,
}));
vi.mock('../../release-checkpoint-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release-checkpoint-launch')>()),
  checkpointUnitForRoot: mocks.checkpointUnitForRoot,
  terminateActiveCheckpointUnit: mocks.terminateActiveCheckpointUnit,
}));
vi.mock('../../release/checkpoint-qualification-transaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/checkpoint-qualification-transaction')>()),
  cancelStoredQualification: mocks.cancelStoredQualification,
  settleStoredUnreachableBlockedQualification: mocks.settleStoredUnreachableBlockedQualification,
}));

import { lookupByMcpName } from '@papercusp/tooldef';
import '../index';

const UNIT = 'papercup-green-checkpoint-manual-expected.service';
const SCHEDULED_SCOPE = 'papercusp-checkpoint-8bf9f42e-e478-425b-80d8-2dd14e915511.scope';
const ATTEMPT = 'attempt-1';
const CTX = {
  role: 'su',
  isSuperuser: true,
  log: vi.fn(),
  signal: new AbortController().signal,
} as never;

// Accepts EITHER shape (the 07-26 parseTextPayload pattern): this tool now returns the
// canonical { data } envelope, but the reader stays shape-agnostic so it does not have to
// be re-edited by the next migration in either direction.
const body = (result: unknown) => {
  const r = result as { data?: unknown; content?: Array<{ text: string }> };
  return (r.data !== undefined ? r.data : JSON.parse(r.content![0]!.text)) as Record<string, unknown>;
};

async function loadTool() {
  return (await import('./checkpoint-cancel')).default;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-test', workspaceId: 'ws-identity' });
  mocks.activeWorkspaceId.mockReturnValue('ws-1');
  mocks.operatorHomeHarnessSlug.mockReturnValue('papercusp');
  mocks.integrationRoot.mockReturnValue('/tooling-root');
  mocks.checkpointUnitForRoot.mockReturnValue('papercup-green-checkpoint-manual-expected');
  mocks.resolveCheckpointRouting.mockResolvedValue({
    root: '/routing-root',
    extraEnv: { PAPERCUSP_INTEGRATION_ROOT: '/subject-root' },
    clearEnv: [],
  });
  mocks.terminateActiveCheckpointUnit.mockReturnValue({ stopped: true });
  mocks.cancelStoredQualification.mockImplementation(async (
    _target: unknown,
    _input: unknown,
    stop: () => Promise<{ stopped: boolean }> | { stopped: boolean },
  ) => {
    const stopped = await stop();
    return stopped.stopped
      ? {
          status: 'updated',
          transaction: {
            outcome: { kind: 'code-inconclusive', reason: 'unsafe candidate' },
          },
        }
      : {
          status: 'stop-failed',
          transaction: {},
          error: 'stop did not complete',
        };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('release:checkpoint-cancel registration', () => {
  it('is reachable through the agent-tools barrel', () => {
    const registered = lookupByMcpName('release:checkpoint-cancel');
    expect(registered, 'release:checkpoint-cancel missing from the agent-tools barrel').toBeTruthy();
    expect(registered).toMatchObject({
      capabilities: ['operator:write'],
      agentRoles: expect.arrayContaining(['worker', 'operator', 'release-fixer', 'release-manager']),
      expose: { mcp: { name: 'release:checkpoint-cancel' } },
    });
  });
});

describe('release:checkpoint-cancel handler', () => {
  it('requires the exact attempt and canonical unit in its published schema', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: UNIT }).success).toBe(true);
    // D-028: the unit is optional in the SCHEMA because the unreachable-blocker settle takes
    // none. A cancel without one is still refused, by the handler (`unit_required` below).
    expect(tool.args.safeParse({ attemptId: ATTEMPT }).success).toBe(true);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, settleUnreachableBlocker: true }).success).toBe(true);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, settleUnreachableBlocker: 'yes' }).success).toBe(false);
    expect(tool.args.safeParse({ unit: UNIT }).success).toBe(false);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: 'other-unit.service' }).success).toBe(false);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: UNIT, reason: 'unsafe candidate' }).success).toBe(true);
    // WI-6554700010042670: a scheduled run's recorded scope is accepted; other scopes are not.
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: SCHEDULED_SCOPE }).success).toBe(true);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: 'pc-0mvsabc.scope' }).success).toBe(false);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: 'papercusp-checkpoint-8bf9f42e.service' }).success).toBe(false);
  });

  it('cancels a scheduled run by its exact recorded scope, without the manual canonical-name check', async () => {
    const tool = await loadTool();
    const result = body(await tool.handler({ attemptId: ATTEMPT, unit: SCHEDULED_SCOPE } as never, CTX));

    expect(result).toMatchObject({ ok: true, cancelled: true, attempt_id: ATTEMPT, unit: SCHEDULED_SCOPE });
    expect(mocks.cancelStoredQualification).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', installSlug: 'papercusp' },
      expect.objectContaining({ attemptId: ATTEMPT, unit: SCHEDULED_SCOPE }),
      expect.any(Function),
    );
    expect(mocks.terminateActiveCheckpointUnit).toHaveBeenCalledWith(SCHEDULED_SCOPE);
  });

  it('fails closed when caller identity cannot be resolved', async () => {
    const tool = await loadTool();
    mocks.resolveAgentIdentity.mockImplementationOnce(() => {
      throw new Error('missing identity');
    });

    expect(body(await tool.handler({ attemptId: ATTEMPT, unit: UNIT } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'authentication_required',
    });
    expect(mocks.resolveCheckpointRouting).not.toHaveBeenCalled();
    expect(mocks.cancelStoredQualification).not.toHaveBeenCalled();
  });

  it('rejects a unit that is syntactically valid but not the canonical routed target', async () => {
    const tool = await loadTool();
    const requested = 'papercup-green-checkpoint-manual-other.service';

    expect(body(await tool.handler({ attemptId: ATTEMPT, unit: requested } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'unit_mismatch',
      attempt_id: ATTEMPT,
      unit: requested,
    });
    expect(mocks.cancelStoredQualification).not.toHaveBeenCalled();
  });

  it('passes the exact target to the store, signals the exact unit, and preserves the queue', async () => {
    const tool = await loadTool();
    const result = body(await tool.handler({
      attemptId: ATTEMPT,
      unit: UNIT,
      reason: 'candidate omitted qualification blobs',
    } as never, CTX));

    expect(result).toMatchObject({
      ok: true,
      cancelled: true,
      attempt_id: ATTEMPT,
      unit: UNIT,
      outcome: { kind: 'code-inconclusive', reason: 'unsafe candidate' },
      repair_queue: 'preserved',
    });
    expect(mocks.resolveCheckpointRouting).toHaveBeenCalledWith(
      { installSlug: 'papercusp', workspaceId: 'ws-1' },
      '/tooling-root',
    );
    expect(mocks.cancelStoredQualification).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', installSlug: 'papercusp' },
      {
        attemptId: ATTEMPT,
        unit: UNIT,
        reason: 'candidate omitted qualification blobs',
        evidenceRefs: ['tool:release:checkpoint-cancel'],
      },
      expect.any(Function),
    );
    expect(mocks.terminateActiveCheckpointUnit).toHaveBeenCalledWith('papercup-green-checkpoint-manual-expected');
  });

  it('maps an exact attempt/unit CAS conflict without signalling a unit', async () => {
    const tool = await loadTool();
    mocks.cancelStoredQualification.mockResolvedValueOnce({
      status: 'conflict',
      transaction: {},
    });

    expect(body(await tool.handler({ attemptId: ATTEMPT, unit: UNIT } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'exact_attempt_unit_mismatch',
    });
    expect(mocks.terminateActiveCheckpointUnit).not.toHaveBeenCalled();
  });

  it('leaves the logical row unchanged when the protected stop fails', async () => {
    const tool = await loadTool();
    mocks.cancelStoredQualification.mockResolvedValueOnce({
      status: 'stop-failed',
      transaction: { outcome: { kind: 'pending' } },
      error: 'systemd kill exited 4',
    });

    expect(body(await tool.handler({ attemptId: ATTEMPT, unit: UNIT } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'stop_failed',
      error: 'systemd kill exited 4',
    });
  });

  it('refuses a cancel that names no unit, before reading or signalling anything', async () => {
    const tool = await loadTool();

    expect(body(await tool.handler({ attemptId: ATTEMPT } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'unit_required',
      attempt_id: ATTEMPT,
    });
    expect(mocks.cancelStoredQualification).not.toHaveBeenCalled();
    expect(mocks.settleStoredUnreachableBlockedQualification).not.toHaveBeenCalled();
    expect(mocks.terminateActiveCheckpointUnit).not.toHaveBeenCalled();
  });
});

// D-028 (staging-main-safe-changes-and-recovery-2026-11-07#D-028, WI-6554700010048992): the one
// narrow settle for a RUNNER-FREE attempt held only by a stored blocker with no production
// clear path. It must never signal a unit, never touch the cancel path, and must attribute the
// settle to the VERIFIED caller rather than anything the caller supplies.
describe('release:checkpoint-cancel settleUnreachableBlocker (D-028)', () => {
  const BLOCKER = { code: 'executor-build-identity-unavailable', clearEvents: [] };

  it('settles through the store with the verified actor and never signals a unit', async () => {
    const tool = await loadTool();
    mocks.settleStoredUnreachableBlockedQualification.mockResolvedValueOnce({
      status: 'updated',
      transaction: { outcome: { kind: 'code-inconclusive', reason: 'unreachable-blocker-settled' } },
      settledBlockers: [BLOCKER],
    });

    const result = body(await tool.handler({
      attemptId: ATTEMPT,
      settleUnreachableBlocker: true,
      reason: 'executor identity blocker has no clear path',
      actor: 'spoofed-caller',
    } as never, CTX));

    expect(result).toMatchObject({
      ok: true,
      cancelled: true,
      settled: 'unreachable-blocker',
      attempt_id: ATTEMPT,
      actor: 'su-test',
      blockers: ['executor-build-identity-unavailable'],
      outcome: { kind: 'code-inconclusive', reason: 'unreachable-blocker-settled' },
      repair_queue: 'preserved',
      audit_event: 'qualification-unreachable-blocker-settled',
    });
    expect(mocks.settleStoredUnreachableBlockedQualification).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', installSlug: 'papercusp' },
      {
        attemptId: ATTEMPT,
        reason: 'executor identity blocker has no clear path',
        actor: 'su-test',
        evidenceRefs: ['tool:release:checkpoint-cancel:settle-unreachable-blocker'],
      },
    );
    expect(mocks.terminateActiveCheckpointUnit).not.toHaveBeenCalled();
    expect(mocks.cancelStoredQualification).not.toHaveBeenCalled();
  });

  it('refuses a settle that names a unit, since a named unit means a runner may exist', async () => {
    const tool = await loadTool();

    expect(body(await tool.handler({
      attemptId: ATTEMPT,
      unit: SCHEDULED_SCOPE,
      settleUnreachableBlocker: true,
      reason: 'should not settle',
    } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'settle_takes_no_unit',
      unit: SCHEDULED_SCOPE,
    });
    expect(mocks.settleStoredUnreachableBlockedQualification).not.toHaveBeenCalled();
    expect(mocks.cancelStoredQualification).not.toHaveBeenCalled();
    expect(mocks.terminateActiveCheckpointUnit).not.toHaveBeenCalled();
  });

  it('passes an absent reason through so the store refuses it, and maps that refusal', async () => {
    const tool = await loadTool();
    mocks.settleStoredUnreachableBlockedQualification.mockResolvedValueOnce({
      status: 'conflict',
      transaction: {},
      refusalReason: 'reason-and-actor-required',
    });

    expect(body(await tool.handler({ attemptId: ATTEMPT, settleUnreachableBlocker: true } as never, CTX)))
      .toMatchObject({ ok: false, refused: true, reason: 'settle_reason_and_actor_required' });
    expect(mocks.settleStoredUnreachableBlockedQualification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: '', actor: 'su-test' }),
    );
  });

  it.each([
    ['runner-held', 'settle_runner_held', /exact unit/],
    ['child-scope-custody-held', 'settle_child_scope_custody_held', /child scope/],
    ['blocker-has-clear-path', 'settle_blocker_has_clear_path', /QUALIFICATION_BLOCKERS_WITHOUT_CLEAR_PATH/],
    ['no-stored-blocker', 'settle_no_stored_blocker', /no stored blocker/],
    ['attempt-mismatch', 'settle_attempt_mismatch', /no longer names this attempt/],
  ])('maps the store refusal %s to %s with its next step', async (refusalReason, reason, note) => {
    const tool = await loadTool();
    mocks.settleStoredUnreachableBlockedQualification.mockResolvedValueOnce({
      status: 'conflict',
      transaction: {},
      refusalReason,
    });

    const result = body(await tool.handler({
      attemptId: ATTEMPT,
      settleUnreachableBlocker: true,
      reason: 'settle it',
    } as never, CTX));

    expect(result).toMatchObject({ ok: false, cancelled: false, refused: true, reason, attempt_id: ATTEMPT });
    expect(String(result.note)).toMatch(note);
    expect(mocks.terminateActiveCheckpointUnit).not.toHaveBeenCalled();
  });

  it('reports an already-terminal attempt without settling it again', async () => {
    const tool = await loadTool();
    mocks.settleStoredUnreachableBlockedQualification.mockResolvedValueOnce({
      status: 'terminal',
      transaction: { outcome: { kind: 'code-inconclusive', reason: 'earlier' } },
    });

    expect(body(await tool.handler({
      attemptId: ATTEMPT,
      settleUnreachableBlocker: true,
      reason: 'settle it',
    } as never, CTX))).toMatchObject({
      ok: false,
      refused: true,
      reason: 'qualification_terminal',
      outcome: { kind: 'code-inconclusive', reason: 'earlier' },
    });
  });

  it('fails closed without a verified caller and never reaches the store', async () => {
    const tool = await loadTool();
    mocks.resolveAgentIdentity.mockImplementationOnce(() => {
      throw new Error('missing identity');
    });

    expect(body(await tool.handler({
      attemptId: ATTEMPT,
      settleUnreachableBlocker: true,
      reason: 'settle it',
    } as never, CTX))).toMatchObject({ ok: false, refused: true, reason: 'authentication_required' });
    expect(mocks.settleStoredUnreachableBlockedQualification).not.toHaveBeenCalled();
  });
});
