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
      verdictStale: false,
      verdictStaleReason: null,
      lastFixerStatus: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      failingTests: [],
      lastVerdict: null,
    },
    deploy: {
      deployedSha: 'deployed0',
      stagingHeadSha: 'staging0head',
      greenPinSha: 'greenpin0',
      deployedBehindStaging: 0,
      greenPinBehindStaging: 0,
      deployedBehindGreenPin: 0,
      greenPinAtStagingHead: true,
      deployedAtMs: 1,
    },
    deployInFlight: null,
    checkpointRunInFlight: null,
    canTriggerGreen: false,
    nothingToDeploy: true,
    state: 'up-to-date',
    recommendation: 'up to date',
    summary: 'up to date',
    errors: [],
    ...over,
  };
}

/** EI-18724155280048738: a running deploy, as `readDeployStatus` reports it. */
function inFlight(over: Partial<NonNullable<DeployStatus['deployInFlight']>> = {}): NonNullable<
  DeployStatus['deployInFlight']
> {
  return {
    active: true,
    unit: 'papercup-auto-deploy',
    activeState: 'active',
    subState: 'running',
    startedAtMs: Date.parse('2026-07-26T16:09:43Z'),
    logPath: '/tmp/papercup-auto-deploy.log',
    logMtimeMs: null,
    source: 'systemd',
    ...over,
  };
}

function checkpointRun(
  over: Partial<NonNullable<DeployStatus['checkpointRunInFlight']>> = {},
): NonNullable<DeployStatus['checkpointRunInFlight']> {
  return {
    active: true,
    candidate: 'fb941a2c',
    initialCandidate: '80cde64e',
    refireObserved: true,
    startedAtMs: Date.parse('2026-08-12T07:29:34Z'),
    elapsedSec: 2400,
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
    expect(b.diagnosticVintage).toMatchObject({
      status: 'stale',
      stagingHeadSha: 'staging0head',
      greenPinSha: 'greenpin0',
    });
    expect(b.diagnosticVintage.warning).toContain('Verify any nextVerb');
    expect(launchM).not.toHaveBeenCalled();
  });
});

describe('release:deploy — skipWorkspaceTx (EI-18733783500981433)', () => {
  it('opts out of the ambient workspace tx — trigger/force await fireGitSyncNow + ' +
    'readDeployStatus (tens of seconds) before launching, and never read ctx.tx, so holding ' +
    'one open the whole time hits Postgres\'s idle_in_transaction_session_timeout (60s) and ' +
    'surfaces as a bare CONNECTION_CLOSED even though the deploy itself launched (the exact ' +
    'false-negative EI-18724155280048738 had to work around with the deployInFlight check). ' +
    'Same fix as capability:bash (EI-18666279107998059).', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('release:deploy — timeoutSec (EI-18761103623054929)', () => {
  it('raises the dispatch-stack timeout above the 60s default — trigger/force await ' +
    'fireGitSyncNow, which is NOT bounded by "tens of seconds" under real load: measured live ' +
    '2026-07-26 (60 commits stranded behind 5 consecutive gate reds), 4 of 5 consecutive ' +
    'trigger calls took 83s/96s/177s/61s, each surfacing as a spurious timeout (or transport ' +
    'CONNECTION_CLOSED) past the 60s default even though the deploy launch itself succeeded.', () => {
    expect((tool as unknown as { timeoutSec?: number }).timeoutSec).toBe(300);
    expect((tool as unknown as { timeoutSec?: number }).timeoutSec!).toBeGreaterThan(177);
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
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false, deploy: { ...mkStatus().deploy, deployedBehindGreenPin: 2, greenPinSha: 'gp' } }),
    );
    const b = body(await tool.handler({ op: 'trigger' } as never, { role: 'operator' } as never));
    expect(b.dry_run).toBe(true);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('confirm:true fires a detached GREEN deploy (no force flags)', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false, deploy: { ...mkStatus().deploy, deployedBehindGreenPin: 2 } }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, launched: true });
    expect(launchM).toHaveBeenCalledWith({}); // green deploy — no force/commit
  });

  /**
   * EI-18724155280048738 — the double-trigger hazard. A trigger can return a TRANSPORT error
   * (CONNECTION_CLOSED against PgBouncer :6432) after the handler already launched the deploy;
   * the caller then re-checks, sees `ps` show nothing for ~20s, reads that as "the trigger did
   * nothing", and fires again at the shared release checkout. These lock the surfaces that make
   * the two states distinguishable.
   */
  it('REFUSES a second trigger while a deploy is in flight, and says so definitely', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'deploy-in-flight', canTriggerGreen: false, nothingToDeploy: false, deployInFlight: inFlight() }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/deploy_in_flight/);
    // it must name the running unit and tell the caller their "failed" trigger probably worked
    expect(b.reason).toMatch(/papercup-auto-deploy/);
    expect(b.reason).toMatch(/transport error/i);
    expect(b.reason).toMatch(/do not re-trigger/i);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('the in-flight refusal WINS over the gate-red message (the caller needs their deploy, not a lecture)', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'deploy-in-flight', canTriggerGreen: false, deployInFlight: inFlight() }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.reason).toMatch(/deploy_in_flight/);
    expect(b.reason).not.toMatch(/gate_red/);
  });

  it('op:status surfaces deployInFlight so a caller who lost the reply can re-check authoritatively', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'deploy-in-flight', deployInFlight: inFlight() }));
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'status', state: 'deploy-in-flight' });
    expect((b.deployInFlight as { active: boolean }).active).toBe(true);
  });

  it('op:status surfaces checkpoint candidate/liveness so an auto-refire is not duplicated', async () => {
    statusM.mockResolvedValue(
      mkStatus({
        state: 'gate-verdict-stale',
        checkpointRunInFlight: checkpointRun(),
      }),
    );
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b.checkpointRunInFlight).toMatchObject({
      active: true,
      candidate: 'fb941a2c',
      initialCandidate: '80cde64e',
      refireObserved: true,
    });
  });

  it('a FINISHED deploy does not keep refusing — the normal green trigger still fires', async () => {
    statusM.mockResolvedValue(
      mkStatus({
        state: 'green-deployable',
        canTriggerGreen: true,
        nothingToDeploy: false,
        deployInFlight: inFlight({ active: false, activeState: 'inactive', subState: 'dead' }),
      }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, launched: true });
  });

  it('the success note pre-warns that a transport error still means the deploy LAUNCHED', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.note).toMatch(/TRANSPORT ERROR/i);
    expect(b.note).toMatch(/deployInFlight/);
    // and it must disqualify the discriminator that caused the incident
    expect(b.note).toMatch(/\bps\b/);
  });

  it('a duplicate-unit refusal from systemd is reported as the guard working, not as a maybe', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false }),
    );
    launchM.mockResolvedValue({
      launched: false,
      unit: 'papercup-auto-deploy',
      mode: 'trigger',
      argv: [],
      logPath: '/tmp/x.log',
      reason: 'systemd-run exited 1 (a deploy may already be in flight): Unit papercup-auto-deploy.service was already loaded',
    });
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.launched).toBe(false);
    expect(b.note).toMatch(/already in flight/i);
    expect(b.note).not.toMatch(/likely/i);
    expect(b.note).toMatch(/deployInFlight/);
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
