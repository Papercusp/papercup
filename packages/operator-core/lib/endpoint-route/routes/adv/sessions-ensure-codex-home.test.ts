import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rebuild: vi.fn(),
  pinnedPrompt: vi.fn(),
  buildLaunchSpec: vi.fn(),
  ensureHome: vi.fn(),
  recordLaunchSpec: vi.fn(),
  requestActivation: vi.fn(),
  sessionRow: vi.fn(),
  readRecord: vi.fn(),
  roleBinding: vi.fn(),
  buildRole: vi.fn(),
  roleHome: vi.fn(),
  funding: vi.fn(),
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
  readSuLaunchSpecByOwner: mocks.readRecord,
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
  buildRoleLaunchSpec: mocks.buildRole,
}));
vi.mock('../../../role-codex-home', async (original) => ({
  ...(await original<typeof import('../../../role-codex-home')>()),
  ensureSuCodexHomeConfig: mocks.ensureHome,
  writeRoleCodexHome: mocks.roleHome,
}));
vi.mock('../../../blueprint/operation-worker-binding', async (original) => ({
  ...(await original<typeof import('../../../blueprint/operation-worker-binding')>()),
  resolveAcceptedOperationWorkerBinding: mocks.roleBinding,
}));
vi.mock('../../../spawn-config', async (original) => ({
  ...(await original<typeof import('../../../spawn-config')>()),
  resolveProjectDir: vi.fn(async () => '/fixture/research'),
}));
vi.mock('../../../cupboard/identity-activation-gate-io', () => ({ admitIdentityActivation: mocks.funding }));
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
  const db = await import('@papercusp/db-org');
  vi.spyOn(db, 'getOrgPg').mockReturnValue({ sql: {} } as never);
  const route = routes.find((entry) => entry.path === '/adv/sessions/ensure-codex-home');
  if (!route) throw new Error('ensure-codex-home route is absent');
  ensureCodexHome = route.handler as typeof ensureCodexHome;
}, 45_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex' });
  mocks.readRecord.mockResolvedValue(savedRecord);
  mocks.funding.mockResolvedValue({ ok: true });
  mocks.recordLaunchSpec.mockResolvedValue(true);
  mocks.roleHome.mockReturnValue({ sqliteHome: '/original-state/session-123' });
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
  it('rebuilds an accepted role through its pinned operation instead of replacing it with SU grants', async () => {
    const accepted = {
      workItemId: 'WI-50', harnessSlug: 'research', operationId: 'daily-brief',
      specificationRevision: REVISION, stack: ['domain:blueprint-operation-worker'],
      pin: { kind: 'blueprint-operation' }, identity: { ref: 'blueprint-operation-worker' },
      requiredTools: ['reports:publish'],
      modelPolicy: { mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail' },
    };
    mocks.readRecord.mockResolvedValue({ ...savedRecord, harnessSlug: 'research', role: 'researcher' });
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'researcher',
      feature: 'WI-50', workspaceId: 'papercusp-workspace', sessionId: 'original-native',
      launchArgv: ['psu', '--account=auto'] });
    mocks.roleBinding.mockResolvedValue(accepted);
    mocks.buildRole.mockResolvedValue({ sid: OWNER, nativeSessionId: 'original-native',
      stack: accepted.stack, mcpUrl: 'http://localhost:3170/api/mcp?role=researcher&sig=valid',
      promptText: 'RESTRICTED RESEARCH', cwd: '/fixture/research',
      specificationRevision: REVISION, stateRevision: 'role-state',
      specificationArtifact: { configuration: { grants: { tools: ['reports:publish'] } } } });
    expect((await call('gpt-6.1-sol:medium')).status).toBe(200);
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.buildRole).toHaveBeenCalledWith(expect.objectContaining({
      role: 'researcher', featureId: 'WI-50',
      launchIdentity: { sid: OWNER, nativeSessionId: 'original-native' },
      acceptedOperation: expect.objectContaining({ modelSelection: expect.objectContaining({ model: 'gpt-6.1-sol:medium' }) }),
    }));
    expect(mocks.roleHome).toHaveBeenCalledWith(expect.objectContaining({ preserveExisting: true,
      sid: OWNER, sessionKey: 123, codexGatewayAuto: true,
      mcpUrl: 'http://localhost:3170/api/mcp?role=researcher&sig=valid' }));
    expect(mocks.recordLaunchSpec).toHaveBeenCalledWith(123, OWNER, expect.objectContaining({
      role: 'researcher', acceptedOperation: expect.objectContaining({ workItemId: 'WI-50' }),
    }));
    expect(mocks.requestActivation).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER, revision: { specificationRevision: REVISION, stateRevision: 'role-state' },
    }));
  });

  it('preserves an ordinary role home instead of compiling an SU fallback', async () => {
    mocks.readRecord.mockResolvedValue(null);
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'researcher' });
    const response = await call();
    expect(await response.json()).toMatchObject({ ok: true, repaired: false, reason: 'role-home-preserved' });
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
  });

  it('restores an archived featureless judge with its recorded identity, state, model and auto route', async () => {
    mocks.readRecord.mockResolvedValue({ model: 'gpt-5.6-sol', effort: 'high',
      codexSqliteHome: '/original-state/session-123' });
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'judge',
      feature: null, workspaceId: 'papercusp-workspace', sessionId: 'original-native',
      launchArgv: ['psu', '--role=judge', '--harness=papercusp', '--model=gpt-5.6-sol:high',
        '--account=auto', '--headless'] });
    mocks.buildRole.mockResolvedValue({ stack: ['domain:judge'], cwd: '/fixture/papercusp',
      mcpUrl: 'http://localhost:3170/api/mcp?role=judge&sig=valid', promptText: 'RESTRICTED JUDGE',
      specificationRevision: REVISION, stateRevision: 'judge-state', specificationArtifact: {} });
    expect(await (await call()).json()).toMatchObject({ repaired: true, role: 'judge', acceptedOperation: false });
    expect(mocks.buildRole).toHaveBeenCalledWith(expect.objectContaining({ role: 'judge',
      harnessSlug: 'papercusp', acceptedOperation: null,
      launchIdentity: { sid: OWNER, nativeSessionId: 'original-native' } }));
    expect(mocks.roleHome).toHaveBeenCalledWith(expect.objectContaining({ preserveExisting: true,
      recordedSqliteHome: '/original-state/session-123', sid: OWNER,
      model: 'gpt-5.6-sol:high', codexGatewayAuto: true, headless: true,
      mcpUrl: 'http://localhost:3170/api/mcp?role=judge&sig=valid' }));
    expect(mocks.recordLaunchSpec).toHaveBeenCalledWith(123, OWNER, expect.objectContaining({
      role: 'judge', codexSqliteHome: '/original-state/session-123', acceptedOperation: null }));
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
  });

  it.each([
    { record: { model: 'gpt-5.6-sol' }, error: 'role_state_binding_unavailable' },
    { record: { codexSqliteHome: '' }, error: 'role_state_binding_unavailable' },
    { record: { codexSqliteHome: 'relative-state' }, error: 'role_state_binding_unavailable' },
    { record: { role: 'su', codexSqliteHome: '/original-state' }, error: 'role_launch_provenance_unavailable' },
  ])('refuses missing or conflicting role recovery provenance: $error', async ({ record, error }) => {
    mocks.readRecord.mockResolvedValue(record);
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'judge',
      feature: null, workspaceId: 'papercusp-workspace', sessionId: 'original-native',
      launchArgv: ['psu', '--role=judge', '--harness=papercusp', '--model=gpt-5.6-sol:high'] });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error });
    expect(mocks.buildRole).not.toHaveBeenCalled();
    expect(mocks.roleHome).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
  });

  it('refuses an incompatible accepted model before changing the role home or receipt', async () => {
    mocks.readRecord.mockResolvedValue({ ...savedRecord, harnessSlug: 'research', role: 'researcher' });
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'researcher',
      feature: 'WI-50', workspaceId: 'papercusp-workspace', sessionId: 'original-native' });
    mocks.roleBinding.mockResolvedValue({ modelPolicy: {
      mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail',
    } });
    await expect(call('gpt-6-astra:medium')).rejects.toThrow('outside the accepted exact model policy');
    expect(mocks.roleHome).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
  });

  it('does not drop an unfunded accepted identity or rewrite its home as SU', async () => {
    mocks.readRecord.mockResolvedValue({ ...savedRecord, harnessSlug: 'research', role: 'researcher' });
    mocks.sessionRow.mockResolvedValue({ coordOwnerId: OWNER, agent: 'codex', role: 'researcher',
      feature: 'WI-50', workspaceId: 'papercusp-workspace', sessionId: 'original-native' });
    mocks.roleBinding.mockResolvedValue({ modelPolicy: {
      mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium', onUnavailable: 'fail',
    } });
    mocks.buildRole.mockResolvedValue({ stack: ['domain:blueprint-operation-worker'], cwd: '/fixture/research' });
    mocks.funding.mockResolvedValue({ ok: false, refused: [{ layerRef: 'domain:blueprint-operation-worker' }] });
    const response = await call('gpt-6.1-sol:medium');
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ ok: false, error: 'identity_activation_refused' });
    expect(mocks.roleHome).not.toHaveBeenCalled();
    expect(mocks.ensureHome).not.toHaveBeenCalled();
    expect(mocks.recordLaunchSpec).not.toHaveBeenCalled();
    expect(mocks.requestActivation).not.toHaveBeenCalled();
  });

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
