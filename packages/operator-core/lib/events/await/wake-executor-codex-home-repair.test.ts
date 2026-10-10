import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readSuLaunchSpecByOwner: vi.fn(),
  getAdvSession: vi.fn(),
  buildLaunchSpec: vi.fn(),
  ensureHome: vi.fn(),
  readSuperuserToken: vi.fn(),
  allowsAmbient: vi.fn(),
}));

vi.mock('../../adv-sessions', async (original) => ({
  ...(await original<typeof import('../../adv-sessions')>()),
  readSuLaunchSpecByOwner: mocks.readSuLaunchSpecByOwner,
  getAdvSession: mocks.getAdvSession,
}));
vi.mock('../../role-launch-spec', async (original) => ({
  ...(await original<typeof import('../../role-launch-spec')>()),
  buildLaunchSpec: mocks.buildLaunchSpec,
}));
vi.mock('../../role-codex-home', async (original) => ({
  ...(await original<typeof import('../../role-codex-home')>()),
  ensureSuCodexHomeConfig: mocks.ensureHome,
}));
vi.mock('../../superuser-token', async (original) => ({
  ...(await original<typeof import('../../superuser-token')>()),
  readSuperuserToken: mocks.readSuperuserToken,
}));
vi.mock('../../capability-envelope/session-confinement-port', async (original) => ({
  ...(await original<typeof import('../../capability-envelope/session-confinement-port')>()),
  sessionAllowsAmbientContext: mocks.allowsAmbient,
}));

import { defaultEnsureCodexHomeForWake } from './wake-executor';

const OWNER = 'su-codex-wake-repair';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSuLaunchSpecByOwner.mockResolvedValue({
    v: 1,
    agent: 'codex',
    workspaceId: 'papercusp-workspace',
    harnessSlug: null,
    profile: 'engineer',
    contextSize: 'trimmed',
    personaTier: null,
    model: 'gpt-6.1-sol',
    planSlug: null,
    launchedBy: null,
    autoMode: false,
    drainMode: false,
    loopArmed: false,
    headless: true,
    fleet: null,
  });
  mocks.getAdvSession.mockResolvedValue(null);
  mocks.buildLaunchSpec.mockResolvedValue({ mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' });
  mocks.ensureHome.mockReturnValue({ repaired: true });
  mocks.readSuperuserToken.mockReturnValue('test-token');
  mocks.allowsAmbient.mockResolvedValue(true);
});

describe('default Codex wake home repair', () => {
  it.each([true, false])('preserves the authoritative ambient-context policy (%s) during wake repair', async (allowed) => {
    mocks.allowsAmbient.mockResolvedValue(allowed);
    mocks.getAdvSession.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex',
      workspaceId: 'papercusp-workspace', cwd: '/frozen-assignment' });
    expect(await defaultEnsureCodexHomeForWake({ advSessionId: 123, owner: OWNER,
      codexHome: '/tmp/codex-home', headless: true })).toMatchObject({ ok: true, repaired: true });
    expect(mocks.allowsAmbient).toHaveBeenCalledWith({ ownerId: OWNER, workspaceId: 'papercusp-workspace' });
    const input = mocks.ensureHome.mock.calls[0][0];
    expect(input.denyAmbientContext === true).toBe(!allowed);
    expect(input.projectDir).toBe('/frozen-assignment');
  });

  it.each([
    { name: 'equals form', launchArgv: ['psu', '--compaction-limit=250000'] },
    { name: 'space form', launchArgv: ['psu', '--compaction-limit', '250000'] },
  ])('preserves the $name soft compaction ceiling from the ADV row', async ({ launchArgv }) => {
    const sessionRow = {
      coordOwnerId: OWNER,
      agent: 'codex',
      workspaceId: 'papercusp-workspace',
      launchArgv,
      cwd: '/workspace/papercusp',
    } as never;

    const result = await defaultEnsureCodexHomeForWake({
      advSessionId: 123,
      owner: OWNER,
      codexHome: '/tmp/codex-home',
      headless: true,
      sessionRow,
    });

    expect(result).toMatchObject({ ok: true, repaired: true });
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ compactionLimit: 250_000 }));
    expect(mocks.getAdvSession).not.toHaveBeenCalled();
  });

  it('loads the ADV row when the wake did not include it', async () => {
    mocks.getAdvSession.mockResolvedValue({
      coordOwnerId: OWNER,
      agent: 'codex',
      workspaceId: 'papercusp-workspace',
      launchArgv: ['psu', '--compaction-limit=250000'],
      cwd: '/workspace/papercusp',
    });

    const result = await defaultEnsureCodexHomeForWake({
      advSessionId: 123,
      owner: OWNER,
      codexHome: '/tmp/codex-home',
      headless: true,
    });

    expect(result).toMatchObject({ ok: true, repaired: true });
    expect(mocks.getAdvSession).toHaveBeenCalledWith(123);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ compactionLimit: 250_000 }));
  });
});
