import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureSweep = vi.fn();
const ensureSupervision = vi.fn();
const ensureWorkIntake = vi.fn();
const resolveIdentity = vi.fn();
const loadKeypair = vi.fn();
const projectDir = vi.fn();
const activeWs = vi.fn();

vi.mock('../harness/operator-home-harness', () => ({
  operatorHomeHarnessSlug: () => 'papercusp',
}));
vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: (...args: unknown[]) => activeWs(...args),
}));
vi.mock('../operator-notes', () => ({
  projectDirForSlug: (...args: unknown[]) => projectDir(...args),
}));
vi.mock('../identity/resolve-local-github-identity', () => ({
  resolveLocalGithubIdentity: (...args: unknown[]) => resolveIdentity(...args),
}));
vi.mock('../identity/attest', () => ({
  loadOrGenerateDeviceKeypair: (...args: unknown[]) => loadKeypair(...args),
}));
vi.mock('../identity/device-keychain-id', () => ({
  resolveDeviceKeychainId: (githubUserId: number) => `${githubUserId}:fake-machine`,
  machineFingerprint: () => 'fake-machine',
}));
vi.mock('../harness/routines/sweep-orphaned-foreign-harnesses-action', () => ({
  ensureSweepOrphanedForeignHarnessesRoutine: (...args: unknown[]) => ensureSweep(...args),
}));
vi.mock('../harness/routines/foreign-supervision-action', () => ({
  ensureP2pForeignSupervisionRoutine: (...args: unknown[]) => ensureSupervision(...args),
}));
vi.mock('../harness/routines/work-intake-action', () => ({
  ensureWorkIntakeRoutine: (...args: unknown[]) => ensureWorkIntake(...args),
}));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: {} }),
}));

import {
  ensureP2pHostRoutinesForWorkspace,
  ensureP2pHostRoutinesSeededOnce,
  _resetEnsureP2pHostRoutinesForTests,
} from './ensure-host-routines';

const WORKSPACE_ID = 'ws-1';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ensureP2pHostRoutinesForWorkspace', () => {
  beforeEach(() => {
    ensureSweep.mockReset().mockResolvedValue({ id: 'rt_sweep' });
    ensureSupervision.mockReset().mockResolvedValue({ id: 'rt_supervision' });
    ensureWorkIntake.mockReset().mockResolvedValue({ id: 'rt_work_intake' });
    resolveIdentity.mockReset();
    loadKeypair.mockReset();
    projectDir.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('seeds all three routines when identity + repo root fully resolve', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'avi', token: 't' });
    loadKeypair.mockResolvedValue({ keychainId: '42:fake-machine', pubkeyBase64: 'PUBKEY==' });
    projectDir.mockResolvedValue('/repo/root');

    const result = await ensureP2pHostRoutinesForWorkspace(WORKSPACE_ID);

    expect(result.sweepSeeded).toBe(true);
    expect(result.supervisionSeeded).toBe(true);
    expect(result.workIntakeSeeded).toBe(true);
    expect(result.skippedReasons).toEqual([]);
    expect(result.installSlug).toBe('papercusp');

    expect(ensureSweep).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, installSlug: 'papercusp' },
      expect.anything(),
    );
    expect(ensureSupervision).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        installSlug: 'papercusp',
        host: { responderGithubUserId: 42, responderDevicePubkey: 'PUBKEY==' },
      },
      expect.anything(),
    );
    expect(ensureWorkIntake).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE_ID,
        installSlug: 'papercusp',
        host: {
          hostRef: 'fake-machine',
          responderGithubUserId: 42,
          responderDevicePubkey: 'PUBKEY==',
          executorDevice: 'PUBKEY==',
          sourceRepoPath: '/repo/root',
          rootPath: '/repo/root',
          workspaceRoot: '/repo/root',
          canonicalTree: '/repo/root',
        },
      },
      expect.anything(),
    );
  });

  it('seeds only the identity-free routine when gh is not authenticated (never fabricates)', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'gh_auth_required' });

    const result = await ensureP2pHostRoutinesForWorkspace(WORKSPACE_ID);

    expect(result.sweepSeeded).toBe(true);
    expect(result.supervisionSeeded).toBe(false);
    expect(result.workIntakeSeeded).toBe(false);
    expect(result.skippedReasons.some((r) => r.includes('gh not authenticated'))).toBe(true);
    expect(ensureSupervision).not.toHaveBeenCalled();
    expect(ensureWorkIntake).not.toHaveBeenCalled();
  });

  it('seeds sweep + supervision but skips work-intake when the repo root is unresolved', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'avi', token: 't' });
    loadKeypair.mockResolvedValue({ keychainId: '42:fake-machine', pubkeyBase64: 'PUBKEY==' });
    projectDir.mockResolvedValue(null);

    const result = await ensureP2pHostRoutinesForWorkspace(WORKSPACE_ID);

    expect(result.sweepSeeded).toBe(true);
    expect(result.supervisionSeeded).toBe(true);
    expect(result.workIntakeSeeded).toBe(false);
    expect(result.skippedReasons.some((r) => r.includes('no registered project dir'))).toBe(true);
    expect(ensureWorkIntake).not.toHaveBeenCalled();
  });

  it('never throws when an individual ensure*Routine call rejects — records the reason instead', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'avi', token: 't' });
    loadKeypair.mockResolvedValue({ keychainId: '42:fake-machine', pubkeyBase64: 'PUBKEY==' });
    projectDir.mockResolvedValue('/repo/root');
    ensureSweep.mockRejectedValue(new Error('boom'));

    const result = await expect(ensureP2pHostRoutinesForWorkspace(WORKSPACE_ID)).resolves.toBeDefined();
    void result;
    const outcome = await ensureP2pHostRoutinesForWorkspace(WORKSPACE_ID);
    expect(outcome.sweepSeeded).toBe(false);
    expect(outcome.skippedReasons.some((r) => r.includes('boom'))).toBe(true);
    // The failure of one routine never blocks the others.
    expect(outcome.supervisionSeeded).toBe(true);
    expect(outcome.workIntakeSeeded).toBe(true);
  });
});

describe('ensureP2pHostRoutinesSeededOnce (WI-5780 regression)', () => {
  beforeEach(() => {
    _resetEnsureP2pHostRoutinesForTests();
    ensureSweep.mockReset().mockResolvedValue({ id: 'rt_sweep' });
    ensureSupervision.mockReset().mockResolvedValue({ id: 'rt_supervision' });
    ensureWorkIntake.mockReset().mockResolvedValue({ id: 'rt_work_intake' });
    resolveIdentity.mockReset().mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'avi', token: 't' });
    loadKeypair.mockReset().mockResolvedValue({ keychainId: '42:fake-machine', pubkeyBase64: 'PUBKEY==' });
    projectDir.mockReset().mockResolvedValue('/repo/root');
    activeWs.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('seeds under activeWorkspaceId(), NEVER a loop-variable from the passed-in registry list', async () => {
    activeWs.mockReturnValue('papercusp-workspace');
    // The full registry list boot-all passes — includes the non-federating
    // 'default'/'*' partitions the old loop used to collide on. Must be
    // ignored entirely: only activeWorkspaceId()'s value is used.
    ensureP2pHostRoutinesSeededOnce(['default', '*', 'papercusp-workspace', 'generic-test']);
    await flush();

    expect(ensureSupervision).toHaveBeenCalledTimes(1);
    expect(ensureSupervision).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'papercusp-workspace' }),
      expect.anything(),
    );
    expect(ensureWorkIntake).toHaveBeenCalledTimes(1);
    expect(ensureWorkIntake).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'papercusp-workspace' }),
      expect.anything(),
    );
  });

  it('loudly skips seeding (never calls any ensure*Routine) when activeWorkspaceId() resolves to an unresolvable p2p partition', async () => {
    activeWs.mockReturnValue('default');
    ensureP2pHostRoutinesSeededOnce(['default']);
    await flush();

    expect(ensureSweep).not.toHaveBeenCalled();
    expect(ensureSupervision).not.toHaveBeenCalled();
    expect(ensureWorkIntake).not.toHaveBeenCalled();
  });

  it('is once-per-process — a second call is a no-op even with a different workspace', async () => {
    activeWs.mockReturnValue('papercusp-workspace');
    ensureP2pHostRoutinesSeededOnce([]);
    await flush();
    activeWs.mockReturnValue('ws-1');
    ensureP2pHostRoutinesSeededOnce([]);
    await flush();

    expect(ensureSupervision).toHaveBeenCalledTimes(1);
  });
});
