import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rebuild: vi.fn(),
  pinnedPrompt: vi.fn(),
  buildLaunchSpec: vi.fn(),
  ensureHome: vi.fn(),
  recordLaunchSpec: vi.fn(),
  requestActivation: vi.fn(),
  sessionRow: vi.fn(),
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
  getAdvSession: mocks.sessionRow,
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
vi.mock('../../../cupboard/identity-activation-restart', () => ({
  rebuildSuLaunchArtifactFunded: async (input: unknown) => ({ rebuilt: await mocks.rebuild(input) }),
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
  mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex' });
  mocks.recordLaunchSpec.mockResolvedValue(true);
  mocks.pinnedPrompt.mockReturnValue({ promptText: 'PINNED V1 INSTRUCTIONS', specificationRevision: REVISION });
  mocks.buildLaunchSpec.mockResolvedValue({ mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' });
  mocks.ensureHome.mockReturnValue({ repaired: true, promptRepaired: true,
    codexHome: '/tmp/p006-home' });
});

async function call(model?: string, extra: { requireGatewayProvider?: boolean } = {}) {
  return ensureCodexHome(new Request('http://localhost:3170/api/adv/sessions/ensure-codex-home', {
    method: 'POST', body: JSON.stringify({ owner: OWNER, advSessionId: 123, model, ...extra }),
  }));
}

describe('ensure-codex-home pinned-source recovery', () => {
  it.each([
    { name: 'auto', launchArgv: ['psu', '--account=auto'], auto: true, accountId: null },
    { name: 'pin', launchArgv: ['psu', '--account', 'pool-a'], auto: false, accountId: 'pool-a' },
    { name: 'default', launchArgv: ['psu', '--account=default'], auto: false, accountId: null },
    { name: 'legacy', launchArgv: undefined, auto: false, accountId: null },
  ])('preserves the $name launch route when a carry refresh has no provider hint', async ({ launchArgv, auto, accountId }) => {
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', launchArgv });
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    const response = await call(undefined, { requireGatewayProvider: false });
    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({
      codexGatewayAuto: auto,
      codexGatewayAccountId: accountId,
      codexGatewayPriority: auto || accountId ? 'su' : null,
    }));
  });

  it.each([
    { name: 'equals form', launchArgv: ['psu', '--compaction-limit=250000'] },
    { name: 'space form', launchArgv: ['psu', '--compaction-limit', '250000'] },
  ])('restores the $name soft compaction ceiling from the ADV launch argv', async ({ launchArgv }) => {
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', launchArgv });
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ compactionLimit: 250_000 }));
  });

  it('restores the legacy bound gateway provider when the launch argv is unavailable', async () => {
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    const response = await call(undefined, { requireGatewayProvider: true });
    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({
      codexGatewayAuto: true, codexGatewayAccountId: null,
    }));
  });

  it('preserves auto routing through pinned instruction recovery', async () => {
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', launchArgv: ['psu', '--account=auto'] });
    mocks.rebuild.mockRejectedValue(new Error('selected identity inherited source revision changed before SU artifact rebuild'));
    const response = await call(undefined, { requireGatewayProvider: false });
    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ codexGatewayAuto: true }));
  });

  it('persists the actual model when the prompt and home are already current', async () => {
    mocks.rebuild.mockResolvedValue({
      spec: { mcpUrl: 'http://localhost:3170/api/mcp?superuser=1' },
      promptText: 'PINNED V1 INSTRUCTIONS',
      artifact: { stack: savedRecord.stack, specificationRevision: REVISION },
    });
    mocks.ensureHome.mockReturnValue({ repaired: false, promptRepaired: false });
    mocks.recordLaunchSpec.mockResolvedValue(true);
    const response = await call('gpt-6.1-sol:xhigh');
    expect(response.status).toBe(200);
    expect(mocks.ensureHome).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6.1-sol:xhigh' }));
    expect(mocks.recordLaunchSpec).toHaveBeenCalledWith(123, OWNER, expect.objectContaining({
      model: 'gpt-6.1-sol:xhigh', modelSource: 'inherited',
      selectedIdentity: savedRecord.selectedIdentity,
    }));
    expect(mocks.requestActivation).not.toHaveBeenCalled();
  });

  it('persists the model through pinned-source recovery without activating another identity', async () => {
    mocks.rebuild.mockRejectedValue(new Error('selected identity inherited source revision changed before SU artifact rebuild'));
    mocks.recordLaunchSpec.mockResolvedValue(true);
    const response = await call('gpt-6.1-sol:xhigh');
    expect(response.status).toBe(200);
    expect(mocks.recordLaunchSpec).toHaveBeenCalledWith(123, OWNER, expect.objectContaining({
      model: 'gpt-6.1-sol:xhigh', selectedIdentity: savedRecord.selectedIdentity,
      specificationRevision: REVISION,
    }));
    expect(mocks.requestActivation).not.toHaveBeenCalled();
  });

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
