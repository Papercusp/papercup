import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFlag: vi.fn(),
  claimAttempt: vi.fn(),
  claimSlot: vi.fn(),
  getFleet: vi.fn(),
  listTargets: vi.fn(),
  recordAttempt: vi.fn(),
  releaseSlot: vi.fn(),
  setTransaction: vi.fn(),
  liveMemberIds: vi.fn(),
  buildEnvelope: vi.fn(),
  spawnHeadless: vi.fn(),
  spawnConsole: vi.fn(),
  verify: vi.fn(),
  kill: vi.fn(),
  resolveGoalLaunch: vi.fn(),
  resolveGoalContext: vi.fn(),
  events: [] as string[],
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...args: unknown[]) => mocks.getFlag(...args),
}));
vi.mock('@papercusp/flags', () => ({
  FLAGS: { FLEET_HEADCOUNT_GOVERNOR: 'fleet-headcount-governor' },
}));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  claimFleetHeadcountAttempt: (...args: unknown[]) => mocks.claimAttempt(...args),
  claimFleetLaunchSlot: (...args: unknown[]) => mocks.claimSlot(...args),
  getFleet: (...args: unknown[]) => mocks.getFleet(...args),
  listFleetHeadcountTargets: (...args: unknown[]) => mocks.listTargets(...args),
  recordFleetHeadcountAttempt: (...args: unknown[]) => mocks.recordAttempt(...args),
  releaseFleetLaunchSlot: (...args: unknown[]) => mocks.releaseSlot(...args),
  setFleetLaunchTransaction: (...args: unknown[]) => mocks.setTransaction(...args),
}));
vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: (...args: unknown[]) => mocks.buildEnvelope(...args),
}));
vi.mock('../../console-spawn', () => ({
  spawnHeadless: (...args: unknown[]) => mocks.spawnHeadless(...args),
  spawnConsole: (...args: unknown[]) => mocks.spawnConsole(...args),
}));
vi.mock('../../fleet/fleet-roster', () => ({
  liveFleetMemberIds: (...args: unknown[]) => mocks.liveMemberIds(...args),
}));
vi.mock('../../agent-launch-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-launch-core')>()),
  verifyFreshLaunchStarted: (...args: unknown[]) => mocks.verify(...args),
}));
vi.mock('../../agent-tools/fleet/kill', () => ({
  default: { handler: (...args: unknown[]) => mocks.kill(...args) },
}));
vi.mock('../../goal-launch-settings', () => ({
  resolveGoalLaunch: (...args: unknown[]) => mocks.resolveGoalLaunch(...args),
}));
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: (...args: unknown[]) => mocks.resolveGoalContext(...args),
}));
vi.mock('../../mcp-base-url', () => ({
  resolveSpawnHostOperatorBaseUrl: () => 'http://127.0.0.1:3070',
}));
vi.mock('../../papercusp-root', () => ({
  papercuspPathForWorkspace: () => '/tmp/fleet-headcount-action-test',
}));
vi.mock('./system-actions', () => ({
  registerSystemAction: vi.fn(),
}));

import { runFleetHeadcountGovernor } from './fleet-headcount-action';

const readyAttestation = (ownerId: string, ready: boolean) => ({
  version: 1 as const,
  ownerId,
  ready,
  stages: {
    agentCall: { status: 'satisfied' as const, successfulCalls: 1 },
    durableWake: ready
      ? { status: 'satisfied' as const, wakeSource: 'loop' }
      : { status: 'missing' as const, wakeSource: null },
    schedulerPull: ready
      ? { status: 'satisfied' as const, calls: 1, successfulCalls: 1 }
      : { status: 'missing' as const, calls: 0, successfulCalls: 0 },
    disposition: ready
      ? { status: 'satisfied' as const, kind: 'no-claim' as const, reason: 'lane_drained' }
      : { status: 'missing' as const, kind: 'missing' as const },
  },
  failures: ready ? [] : [{
    stage: 'durableWake' as const,
    code: 'durable-wake-missing' as const,
    detail: 'No durable wake.',
  }],
});

const verifierResult = (ownerId: string, ready: boolean) => ({
  agentStarted: true as boolean | null,
  workerReady: ready,
  waitedMs: 1,
  sessions: [{
    advSessionId: 1,
    ownerId,
    successfulCalls: 1,
    msSinceLastSignal: 1,
    hasPresence: true,
    attestationDiffs: [],
    workerAttestation: readyAttestation(ownerId, ready),
  }],
  note: ready ? 'worker ready' : 'agent started; worker stages incomplete',
});

const baseConfig = {
  plan: 'plan-a',
  harness: 'papercusp',
  agent: 'codex' as const,
  model: 'gpt-5.6-sol',
  effort: 'high',
  account: 'default',
  headless: true,
  carry: 'warm' as const,
  productiveCapacityFloor: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.getFlag.mockResolvedValue(true);
  mocks.listTargets.mockResolvedValue([{ workspaceId: 'ws', fleetSlug: 'fleet-a' }]);
  mocks.claimAttempt.mockResolvedValue({
    workspaceId: 'ws',
    fleetSlug: 'fleet-a',
    target: 1,
    config: baseConfig,
    nextAttemptAt: null,
    backoffMs: 0,
    lastError: null,
    claimedAt: 1,
  });
  mocks.claimSlot.mockResolvedValue({ won: true, at: 10 });
  mocks.recordAttempt.mockResolvedValue(undefined);
  mocks.releaseSlot.mockResolvedValue(undefined);
  mocks.setTransaction.mockResolvedValue(undefined);
  mocks.buildEnvelope.mockResolvedValue({ cwd: '/tmp/fleet', env: {} });
  mocks.spawnHeadless.mockImplementation(async () => {
    mocks.events.push('spawn');
    return { status: 'ok', terminal: 'headless', pid: 123 };
  });
  mocks.spawnConsole.mockResolvedValue({ status: 'ok', terminal: 'xterm', pid: 123 });
  mocks.kill.mockImplementation(async () => {
    mocks.events.push('kill');
    return { data: { ok: true, counts: { ok: 1, failed: 0 }, results: [{ ok: true }] } };
  });
  mocks.resolveGoalLaunch.mockResolvedValue({ effective: {}, refusal: null });
  mocks.resolveGoalContext.mockResolvedValue(null);
});

describe('fleet headcount governor I/O ordering (P-004)', () => {
  it('refreshes a late boot to productive and performs no duplicate launch', async () => {
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-slow',
      launcherOwnerId: 'su-leader',
      state: 'partial' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-slow'],
      openedMemberIds: ['su-slow'],
      verifiedMemberIds: [],
      unconfirmedMemberIds: ['su-slow'],
      failed: [],
      waves: [{ index: 0, ownerIds: ['su-slow'], state: 'partial' as const }],
      recovery: { retryOwnerIds: ['su-slow'], nextAction: 'wait' },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: transaction,
    });
    mocks.liveMemberIds.mockResolvedValue(['su-slow']);
    mocks.verify.mockResolvedValue(verifierResult('su-slow', true));

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({ launcherOwnerId: 'su-leader', expectedOwnerIds: ['su-slow'] }),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ succeeded: true }),
    );
    const persisted = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
    expect(persisted.governor.terminalVerdict).toMatchObject({
      outcome: 'productive', action: 'none', workerReadyMemberIds: ['su-slow'],
    });
  });

  it('kills the exact repeatedly non-working identity before spawning its pre-pinned replacement', async () => {
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-dark',
      launcherOwnerId: 'su-leader',
      state: 'verified' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-dark'],
      openedMemberIds: ['su-dark'],
      verifiedMemberIds: ['su-dark'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: [],
      workerAttestations: [readyAttestation('su-dark', false)],
      failed: [],
      waves: [{ index: 0, ownerIds: ['su-dark'], state: 'verified' as const }],
      recovery: { retryOwnerIds: [], nextAction: 'retry' },
      governor: {
        version: 1 as const,
        probeOwnerIds: ['su-dark'],
        attestationAttempts: { 'su-dark': 2 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: transaction,
    });
    let rosterRead = 0;
    mocks.liveMemberIds.mockImplementation(async () => {
      rosterRead += 1;
      if (rosterRead === 1) return ['su-dark'];
      const replacement = mocks.spawnHeadless.mock.calls[0]?.[0]?.coordOwnerId;
      return replacement ? [replacement] : [];
    });
    mocks.verify.mockImplementation(async (args: { expectedOwnerIds: string[] }) => {
      const ownerId = args.expectedOwnerIds[0];
      return verifierResult(ownerId, ownerId !== 'su-dark');
    });

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.events).toEqual(['kill', 'spawn']);
    expect(mocks.kill).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'su-dark' }),
      expect.anything(),
    );
    const spawnArgs = mocks.spawnHeadless.mock.calls[0][0];
    expect(spawnArgs.coordOwnerId).toMatch(/^su-/);
    expect(spawnArgs.envelope.greetingCmd).toContain('--launched-by=su-leader');
    expect(spawnArgs.envelope.greetingCmd).toContain(`--owner-id=${spawnArgs.coordOwnerId}`);

    const persisted = mocks.setTransaction.mock.calls.at(-1)?.[0].transaction;
    expect(persisted.previousTransactionId).toBe('tx-dark');
    expect(persisted.governor.retiredMemberIds).toContain('su-dark');
    expect(persisted.governor.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'prune', ownerId: 'su-dark', replacementOwnerId: spawnArgs.coordOwnerId }),
      expect.objectContaining({ action: 'respawn', ownerId: 'su-dark', replacementOwnerId: spawnArgs.coordOwnerId }),
    ]));
    expect(persisted.governor.terminalVerdict).toMatchObject({ outcome: 'productive', action: 'none' });
  });

  it('releases its launch slot and opens nothing when a concurrent transaction wins the CAS', async () => {
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: null,
    });
    mocks.liveMemberIds.mockResolvedValue([]);
    mocks.setTransaction.mockResolvedValue(false);

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.setTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: null }),
    );
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    expect(mocks.spawnConsole).not.toHaveBeenCalled();
    expect(mocks.releaseSlot).toHaveBeenCalledWith({ workspaceId: 'ws', fleetSlug: 'fleet-a', at: 10 });
    expect(mocks.recordAttempt).toHaveBeenLastCalledWith(expect.objectContaining({
      succeeded: false,
      error: expect.stringContaining('changed concurrently'),
    }));
  });

  it('attributes an attestation mismatch only to the mismatched member and bounds retained history', async () => {
    mocks.claimAttempt.mockResolvedValue({
      workspaceId: 'ws',
      fleetSlug: 'fleet-a',
      target: 2,
      config: { ...baseConfig, productiveCapacityFloor: 1 },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
      claimedAt: 1,
    });
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-mismatch',
      launcherOwnerId: 'su-leader',
      state: 'partial' as const,
      requestedAt: 1,
      updatedAt: 1,
      requestedMemberIds: ['su-mismatch', 'su-waiting'],
      openedMemberIds: ['su-mismatch', 'su-waiting'],
      verifiedMemberIds: [],
      unconfirmedMemberIds: ['su-mismatch', 'su-waiting'],
      workerReadyMemberIds: [],
      workerAttestations: [
        readyAttestation('su-mismatch', false),
        readyAttestation('su-waiting', false),
      ],
      failed: [],
      waves: [{
        index: 0,
        ownerIds: ['su-mismatch', 'su-waiting'],
        state: 'partial' as const,
      }],
      recovery: { retryOwnerIds: ['su-mismatch', 'su-waiting'], nextAction: 'retry' },
      governor: {
        version: 1 as const,
        probeOwnerIds: ['su-mismatch', 'su-waiting'],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: Array.from({ length: 40 }, (_value, index) => ({
          at: index,
          action: 'observe' as const,
          reason: `prior event ${index}`,
        })),
        terminalVerdict: null,
      },
    };
    mocks.getFleet.mockResolvedValue({
      fleetSlug: 'fleet-a',
      leaderOwnerId: 'su-leader',
      lastLaunchTransaction: transaction,
    });
    mocks.liveMemberIds.mockResolvedValue(['su-mismatch', 'su-waiting']);
    mocks.verify.mockResolvedValue({
      agentStarted: false,
      workerReady: false,
      waitedMs: 1,
      sessions: [
        {
          ...verifierResult('su-mismatch', false).sessions[0],
          attestationDiffs: [{ field: 'model', requested: 'gpt-a', actual: 'gpt-b' }],
        },
        verifierResult('su-waiting', false).sessions[0],
      ],
      note: '✗ ATTESTATION MISMATCH — su-mismatch.model differs',
    });

    await runFleetHeadcountGovernor({
      installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: null,
    });

    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.spawnHeadless).not.toHaveBeenCalled();
    const persistedCall = mocks.setTransaction.mock.calls.at(-1)?.[0];
    expect(persistedCall.expectedRevision).toEqual({ transactionId: 'tx-mismatch', updatedAt: 1 });
    expect(persistedCall.transaction.failed).toEqual([
      expect.objectContaining({ ownerId: 'su-mismatch', phase: 'attestation' }),
    ]);
    expect(persistedCall.transaction.governor.history).toHaveLength(32);
    expect(persistedCall.transaction.governor.terminalVerdict).toMatchObject({
      outcome: 'unverified',
      action: 'retry',
    });
  });
});
