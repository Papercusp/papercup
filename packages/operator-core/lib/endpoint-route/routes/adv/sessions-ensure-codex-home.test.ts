import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rebuild: vi.fn(),
  pinnedPrompt: vi.fn(),
  buildLaunchSpec: vi.fn(),
  ensureHome: vi.fn(),
  recordLaunchSpec: vi.fn(),
  requestActivation: vi.fn(),
}));

const OWNER = 'su-p006-pinned-codex';
const REVISION = 'a'.repeat(64);
const savedRecord = {
  v: 1, agent: 'codex', workspaceId: 'papercusp-workspace',
  harnessSlug: null, profile: 'generic', contextSize: 'trimmed',
  personaTier: 'full', model: 'gpt-6-sol', planSlug: null,
  launchedBy: null, autoMode: false, drainMode: false,
  loopArmed: false, headless: true, fleet: null, stack: ['domain:research'],
  selectedIdentity: { ref: 'domain:research', sourceRevision: REVISION },
  specificationRevision: REVISION,
  specificationArtifact: { specificationRevision: REVISION },
};

vi.mock('../../../adv-sessions', async (original) => ({
  ...(await original<typeof import('../../../adv-sessions')>()),
  readSuLaunchSpecByOwner: vi.fn(async () => savedRecord),
  getAdvSession: vi.fn(async () => ({ coordOwnerId: OWNER, agent: 'codex' })),
  recordSuLaunchSpec: mocks.recordLaunchSpec,
}));
vi.mock('../../../su-persona-render', async (original) => ({
  ...(await original<typeof import('../../../su-persona-render')>()),
  rebuildSuLaunchArtifact: mocks.rebuild,
  pinnedSuRecoveryPrompt: mocks.pinnedPrompt,
}));
vi.mock('../../../role-launch-spec', async (original) => ({
  ...(await original<typeof import('../../../role-launch-spec')>()),
  buildLaunchSpec: mocks.buildLaunchSpec,
}));
vi.mock('../../../role-codex-home', async (original) => ({
  ...(await original<typeof import('../../../role-codex-home')>()),
  ensureSuCodexHomeConfig: mocks.ensureHome,
}));
vi.mock('../../../agent-tools/coordination/control-anchor', async (original) => ({
  ...(await original<typeof import('../../../agent-tools/coordination/control-anchor')>()),
  requestSessionIdentityActivation: mocks.requestActivation,
}));
vi.mock('../../../superuser-token', async (original) => ({
  ...(await original<typeof import('../../../superuser-token')>()),
  readSuperuserToken: vi.fn(() => 'fixture-token'),
}));

let ensureCodexHome: (req: Request) => Promise<Response>;
beforeAll(async () => {
  const routes = (await import('./sessions')).default;
  const route = routes.find((entry) => entry.path === '/adv/sessions/ensure-codex-home');
  if (!route) throw new Error('ensure-codex-home route is absent');
  ensureCodexHome = route.handler as typeof ensureCodexHome;
}, 45_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pinnedPrompt.mockReturnValue({ promptText: 'PINNED V1 INSTRUCTIONS', specificationRevision: REVISION });
  mocks.buildLaunchSpec.mockResolvedValue({ mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' });
  mocks.ensureHome.mockReturnValue({ repaired: true, promptRepaired: true,
    codexHome: '/tmp/p006-home' });
});

async function call() {
  return ensureCodexHome(new Request('http://localhost:3170/api/adv/sessions/ensure-codex-home', {
    method: 'POST', body: JSON.stringify({ owner: OWNER, advSessionId: 123 }),
  }));
}

describe('ensure-codex-home pinned-source recovery', () => {
  it('restores v1 instructions when v2 blocks rebuild, without claiming a new activation', async () => {
    mocks.rebuild.mockRejectedValue(new Error('selected identity inherited source revision changed before SU artifact rebuild'));
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, repaired: true, reason: 'pinned-source-stale',
      preservedSpecificationRevision: REVISION,
    });
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({
      sid: OWNER, promptText: 'PINNED V1 INSTRUCTIONS',
      mcpUrl: 'http://localhost:3170/api/mcp?superuser=1',
      headless: true,
    }));
    expect(mocks.buildLaunchSpec).toHaveBeenCalledWith(expect.objectContaining({ stack: [], modes: [] }));
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
    expect(mocks.requestActivation).not.toHaveBeenCalled();
  });

  it('does not mask an unrelated rebuild error as pinned-source recovery', async () => {
    mocks.rebuild.mockRejectedValue(new Error('plan context unavailable'));
    await expect(call()).rejects.toThrow('plan context unavailable');
    expect(mocks.pinnedPrompt).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
  });
});
