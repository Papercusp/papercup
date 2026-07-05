/**
 * deploy.test.ts — the release:deploy TOOL routing + safety gates (release-pipeline-resilience P-015).
 * Mocks all I/O (status read, deploy launch, audit, notify) so it asserts the decision logic —
 * refuse / dry-run / fire / role-gate — without touching PG or firing a real deploy.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/release/deploy.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeployStatus } from '../../release-deploy-launch';

vi.mock('../../release-deploy-launch', () => ({
  readDeployStatus: vi.fn(),
  launchDetachedDeploy: vi.fn(),
}));
// Partial-mocks (importOriginal) — the tool's import graph (agent-mcp bootstrap) needs the
// real OTHER exports of these modules; we override only the single function each touches.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: vi.fn() } }) as never,
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'test-ws',
}));
vi.mock('../locks/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/identity')>()),
  readIdentity: () => ({ ownerId: 'o', ownerLabel: 'tester', coordinationDomain: 'd' }) as never,
}));
const notifyM = vi.fn();
vi.mock('../../attention-notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attention-notify')>()),
  notifyAttention: notifyM,
}));
// WI-1320: a confirmed release:deploy fires git-sync FIRST (so it ships current staging, not
// stale). Mock that I/O (no-op) so the tool's decision logic is tested in isolation — same as
// the readDeployStatus / launch / notify mocks above. Spread the real module so the rest of
// the import graph keeps git-sync-action's other exports.
vi.mock('../../harness/git-sync/git-sync-action', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/git-sync/git-sync-action')>()),
  fireGitSyncNow: vi.fn(),
}));
vi.mock('../../harness/operator-home-harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/operator-home-harness')>()),
  operatorHomeHarnessSlug: () => 'test-home',
}));

import { readDeployStatus, launchDetachedDeploy } from '../../release-deploy-launch';
const statusM = vi.mocked(readDeployStatus);
const launchM = vi.mocked(launchDetachedDeploy);
const tool = (await import('./deploy')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

function mkStatus(over: Partial<DeployStatus> = {}): DeployStatus {
  return {
    gate: {
      green: true,
      consecutiveReds: 0,
      stalled: false,
      fireStale: false,
      fireStaleReason: null,
      lastGreenAtMs: null,
      lastFixerStatus: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
    },
    deploy: {
      deployedSha: 'deployed0',
      stagingHeadSha: 'staging0head',
      greenPinSha: 'greenpin0',
      deployedBehindMain: 0,
      readyBehindMain: 0,
      deployedBehindReady: 0,
      readyAtMainHead: true,
      deployedAtMs: 1,
    },
    canTriggerGreen: false,
    nothingToDeploy: true,
    state: 'up-to-date',
    recommendation: 'up to date',
    summary: 'up to date',
    errors: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  launchM.mockResolvedValue({ launched: true, unit: 'papercup-auto-deploy', mode: 'trigger', argv: [], logPath: '/tmp/x.log' });
});

describe('release:deploy — status', () => {
  it('returns the full status read-only (no launch)', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', canTriggerGreen: false }));
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'status', state: 'gate-red' });
    expect(launchM).not.toHaveBeenCalled();
  });
});

describe('release:deploy — trigger', () => {
  it('refuses when the gate is red (no green pin to ship)', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', canTriggerGreen: false }));
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/gate_red/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('dry-run (no confirm) previews but does NOT launch even when green-deployable', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false, deploy: { ...mkStatus().deploy, deployedBehindReady: 2, greenPinSha: 'gp' } }),
    );
    const b = body(await tool.handler({ op: 'trigger' } as never, { role: 'operator' } as never));
    expect(b.dry_run).toBe(true);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('confirm:true fires a detached GREEN deploy (no force flags)', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false, deploy: { ...mkStatus().deploy, deployedBehindReady: 2 } }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, launched: true });
    expect(launchM).toHaveBeenCalledWith({}); // green deploy — no force/commit
  });
});

describe('release:deploy — force (owner-gated)', () => {
  const forceArgs = { op: 'force', reason: 'no-users window: ship the ledger fix', acknowledgeRedTests: ['orchestrator/invoke.test'], confirm: true };

  it('is role-gated: a bee cannot force, and no deploy fires', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red' }));
    const b = body(await tool.handler(forceArgs as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/role_forbidden/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('dry-run (no confirm) previews the commit + acknowledged reds, does NOT launch', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', deploy: { ...mkStatus().deploy, stagingHeadSha: 'feedface' } }));
    const b = body(await tool.handler({ ...forceArgs, confirm: false } as never, { role: 'operator' } as never));
    expect(b.dry_run).toBe(true);
    expect(b.would_force_deploy).toMatchObject({ commit: 'feedface' });
    expect(launchM).not.toHaveBeenCalled();
  });

  it('confirm:true fires force (un-green commit) AND notifies the owner', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', deploy: { ...mkStatus().deploy, stagingHeadSha: 'feedface' } }));
    launchM.mockResolvedValue({ launched: true, unit: 'papercup-auto-deploy', mode: 'force', commit: 'feedface', argv: [], logPath: '/tmp/x.log' });
    const b = body(await tool.handler(forceArgs as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, launched: true, op: 'force', commit: 'feedface' });
    expect(launchM).toHaveBeenCalledWith({ force: true, commit: 'feedface' });
    expect(notifyM).toHaveBeenCalledTimes(1); // loud owner notification
  });
});
