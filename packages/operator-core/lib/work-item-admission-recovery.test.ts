import { beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

const io = vi.hoisted(() => ({
  presence: vi.fn(), modes: vi.fn(), policy: vi.fn(), gate: vi.fn(), fleet: vi.fn(), state: vi.fn(),
  pgTarget: vi.fn(), build: vi.fn(),
}));
vi.mock('postgres', async (original) => {
  const actual = await original<typeof import('postgres')>();
  return { ...actual, default: vi.fn(actual.default) };
});
vi.mock('./embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => io.pgTarget().url,
  getHarnessAdminUrlWithSource: io.pgTarget,
}));
vi.mock('./build-info', async (original) => ({
  ...await original<typeof import('./build-info')>(), getResolvedBuild: io.build,
}));
vi.mock('./agent-tools/coordination/presence', () => ({ getPresence: io.presence }));
vi.mock('./modes/store', () => ({ getModes: io.modes }));
vi.mock('./work-scope-policy', () => ({ readWorkScopePolicy: io.policy, gateWorkScope: io.gate }));
vi.mock('./scheduler/fleet-scope-admission', () => ({ admitWorkItemForFleetTarget: io.fleet }));
vi.mock('./operator-state-pg', () => ({ readOperatorState: io.state }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: {} }),
}));
// This suite isolates session-policy composition. The chain integration suite
// separately exercises authenticated replay through the real dispatch gates.
vi.mock('./work-item-admission-authority', async (original) => ({
  ...await original<typeof import('./work-item-admission-authority')>(),
  authorizeAdmissionReplay: vi.fn(async () => {}),
}));

import { authorizeAdmissionRecovery, withAdmissionPromoterLock } from './work-item-admission-recovery';

const scope = { workspaceId: 'ws-authority', harnessSlug: 'papercusp', workItemId: 'WI-original' };
const request = { caller: 'requester', target: 'reviewer' };
beforeEach(() => {
  vi.resetAllMocks();
  io.presence.mockImplementation(async () => ({ workspaceId: scope.workspaceId, revoked: false }));
  io.modes.mockResolvedValue([]);
  io.policy.mockResolvedValue({ mode: 'enforce', allowHarnesses: ['papercusp'] });
  io.gate.mockResolvedValue({ allowed: true });
  io.fleet.mockResolvedValue({ allowed: true });
  io.state.mockResolvedValue(null);
  io.pgTarget.mockReturnValue({
    url: 'postgresql://private-user:private-password@private-db:6543/private-db?application_name=private-query',
    source: 'operator-env-file',
  });
  io.build.mockReturnValue({ sha: 'test-build', shaSource: 'baked', version: 'test-version' });
});

describe('production recovery authorization (real policy composition, mocked store I/O)', () => {
  it('reads current workspace, per-agent fleet override and confinement for BOTH actors', async () => {
    await authorizeAdmissionRecovery(scope, request);
    for (const actor of [request.caller, request.target]) {
      expect(io.presence).toHaveBeenCalledWith(actor);
      expect(io.modes).toHaveBeenCalledWith(scope.workspaceId, actor);
      expect(io.gate).toHaveBeenCalledWith('coord:dispatch', {
        harness: scope.harnessSlug, workItem: scope.workItemId, actor,
      }, await io.policy());
      expect(io.fleet).toHaveBeenCalledWith({
        workItemId: scope.workItemId, target: actor, harness: scope.harnessSlug, workspaceId: scope.workspaceId,
      });
    }
    expect(io.state).toHaveBeenCalledWith('operator_session_confinements', scope.workspaceId, { fresh: true });
  });

  it.each([request.caller, request.target])('refuses absent, revoked and cross-workspace actor %s', async (actor) => {
    for (const invalid of [null, { workspaceId: scope.workspaceId, revoked: true }, { workspaceId: 'other' }]) {
      io.presence.mockImplementation(async (id) => id === actor ? invalid : { workspaceId: scope.workspaceId });
      await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('absent, revoked, or outside');
    }
  });

  it.each([request.caller, request.target])('refuses AUDIT remediation for %s', async (actor) => {
    io.modes.mockImplementation(async (_ws, id) => id === actor ? [{ mode: 'audit' }] : []);
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('AUDIT mode');
  });

  it.each([request.caller, request.target])('rechecks a revoked fleet override for %s on every replay', async (actor) => {
    await authorizeAdmissionRecovery(scope, request);
    io.fleet.mockImplementation(async ({ target }) => target === actor
      ? { allowed: false, reason: 'effective member override denied original item' } : { allowed: true });
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('effective member override');
  });

  it('fails closed on workspace denial and policy store failure', async () => {
    io.gate.mockResolvedValue({ allowed: false, message: 'workspace scope denied' });
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('workspace scope denied');
    expect(io.fleet).not.toHaveBeenCalled();
    io.gate.mockRejectedValue(new Error('policy unavailable'));
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('policy unavailable');
  });

  it.each([request.caller, request.target])('honors current claim confinement of %s even through the system routine', async (actor) => {
    io.state.mockResolvedValue({ sessions: { [actor]: {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      confinement: { denyTools: ['work_items:claim'], imposedBy: 'director', reason: 'no claims' },
    } } });
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('no claims');
  });

  it('does not require the recipient to have the caller-only dispatch power', async () => {
    const row = {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      confinement: { denyTools: ['coord:dispatch'], imposedBy: 'director', reason: 'no delegation' },
    };
    io.state.mockResolvedValue({ sessions: { [request.target]: row } });
    await expect(authorizeAdmissionRecovery(scope, request)).resolves.toBeUndefined();
    io.state.mockResolvedValue({ sessions: { [request.caller]: row } });
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('no delegation');
  });

  it('does not turn an interrupted confinement read into an authorization grant', async () => {
    io.state.mockRejectedValue(new Error('confinement store unavailable'));
    await expect(authorizeAdmissionRecovery(scope, request)).rejects.toThrow('confinement store unavailable');
  });
});

describe('admission promoter lock attribution', () => {
  it('retains the default client target and run without publishing its credentials or claiming a backend', async () => {
    const timeout = Object.assign(new Error('write CONNECT_TIMEOUT private-db:6543'), { code: 'CONNECT_TIMEOUT' });
    const client = {
      options: { host: ['private-db'], port: [6543] },
      reserve: vi.fn().mockRejectedValue(timeout),
      end: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(postgres).mockReturnValueOnce(client as never);
    const action = vi.fn(async () => 'screened');
    const failure = await withAdmissionPromoterLock({
      workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runId: 'exact-promoter-run',
    }, undefined, action).catch((error: unknown) => error) as Error & { admissionLock?: unknown; cause?: unknown };

    expect(failure).toBeInstanceOf(Error);
    expect(failure.cause).toBe(timeout);
    expect(failure.admissionLock).toEqual({
      phase: 'reserve', source: 'operator-env-file',
      configured: { host: ['private-db'], port: [6543] }, backend: 'unobserved',
      workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
      runId: 'exact-promoter-run', processId: process.pid,
      runtime: { sha: 'test-build', shaSource: 'baked', version: 'test-version' },
      startedAt: expect.any(String), elapsedMs: expect.any(Number),
    });
    expect(failure.message).toContain('exact-promoter-run');
    for (const secret of ['private-user', 'private-password', 'private-query', 'postgresql://']) {
      expect(failure.message).not.toContain(secret);
      expect(JSON.stringify(failure.admissionLock)).not.toContain(secret);
    }
    expect(action).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('joins an action failure to the same reserved backend that acquired the session lock', async () => {
    const backend = { pid: 321, address: '127.0.0.1', port: 6543, database: 'private-db' };
    const reserved = Object.assign(vi.fn().mockResolvedValueOnce([{ locked: true, ...backend }])
      .mockResolvedValueOnce([]), { release: vi.fn() });
    const client = {
      options: { host: ['private-db'], port: [6543] },
      reserve: vi.fn().mockResolvedValue(reserved), end: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(postgres).mockReturnValueOnce(client as never);
    const actionError = new Error('screening failed');
    await expect(withAdmissionPromoterLock(scope, undefined, async () => { throw actionError; }))
      .rejects.toMatchObject({
        cause: actionError,
        admissionLock: { phase: 'action', backend, runtime: { sha: 'test-build', shaSource: 'baked' } },
      });
    expect(reserved).toHaveBeenCalledTimes(2);
    expect(reserved.release).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('identifies a lock-client reserve timeout and preserves the driver error code', async () => {
    const timeout = Object.assign(new Error('write CONNECT_TIMEOUT localhost:5432'), {
      code: 'CONNECT_TIMEOUT',
    });
    const reserve = vi.fn().mockRejectedValue(timeout);
    const action = vi.fn(async () => 'screened');
    const lockSql = { reserve } as never;

    const failure = await withAdmissionPromoterLock({
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
    }, lockSql, action).then(() => null, (error: unknown) => error as Error & {
      code?: string;
      cause?: unknown;
    });

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('work-item-admission-promoter lock-client phase=reserve');
    expect(failure?.message).toContain(timeout.message);
    expect(failure?.name).toBe(timeout.name);
    expect(failure?.code).toBe(timeout.code);
    expect(failure?.cause).toBe(timeout);
    expect(reserve).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
  });
});
