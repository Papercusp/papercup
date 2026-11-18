import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdvSessionRow } from './adv-sessions';
import { repairRoleCodexHome } from './role-codex-home-repair';

const mocks = vi.hoisted(() => ({
  record: vi.fn(), readLaunch: vi.fn(), activate: vi.fn(), build: vi.fn(), write: vi.fn(), funding: vi.fn(),
}));

vi.mock('./adv-sessions', () => ({
  recordSuLaunchSpec: mocks.record, readAdvSessionLaunchRecordByOwner: mocks.readLaunch,
}));
vi.mock('./su-persona-render', () => ({ parseSuLaunchSpecRecord: () => null }));
vi.mock('./model-context-budget.mjs', () => ({ CODEX_DEFAULT_MODEL: 'gpt-6.1-sol' }));
vi.mock('./agent-tools/coordination/control-anchor', () => ({ requestSessionIdentityActivation: mocks.activate }));
vi.mock('./inference-gateway/spawn-env', () => ({ wakeAccountRouteFromArgv: () => null }));
vi.mock('./events/await/wake-executor', () => ({ codexWakeGatewayInputs: () => ({}) }));
vi.mock('./blueprint/operation-worker-binding', () => ({
  resolveAcceptedOperationWorkerBinding: vi.fn(), selectAcceptedOperationWorkerModel: vi.fn(),
}));
vi.mock('./spawn-config', () => ({ resolveProjectDir: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: vi.fn() }) }));
vi.mock('./role-launch-spec', () => ({ buildRoleLaunchSpec: mocks.build }));
vi.mock('./cupboard/identity-activation-gate-io', () => ({ admitIdentityActivation: mocks.funding }));
vi.mock('./role-codex-home', () => ({ writeRoleCodexHomeAsync: mocks.write }));

const OWNER = 'su-original-role';
const SESSION = 123;
const roleArgv = ['psu', '--role=judge', '--harness=papercusp', '--model=gpt-5.6-sol:high'];

function fixture(changes: Record<string, unknown> = {}) {
  return {
    advSessionId: SESSION, owner: OWNER, operatorBaseUrl: 'http://localhost:3170', body: {},
    sessionRow: {
      id: SESSION, coordOwnerId: OWNER, agent: 'codex', role: 'judge', feature: null,
      workspaceId: 'papercusp-workspace', sessionId: 'original-native',
      launchArgv: ['psu', '--resume=123', '--harness=papercusp', '--model=gpt-5.6-sol:high'],
    } as AdvSessionRow,
    rawRecord: {
      role: 'judge', harnessSlug: 'papercusp', codexSqliteHome: '/original-state/session-123',
      originalMemberLaunch: {
        v: 1, advSessionId: SESSION, ownerId: OWNER, sessionId: 'original-native',
        workspaceId: 'papercusp-workspace', agent: 'codex', launchArgv: roleArgv, ...changes,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockResolvedValue(true);
  mocks.readLaunch.mockResolvedValue(null);
  mocks.write.mockResolvedValue({ sqliteHome: '/original-state/session-123' });
  mocks.funding.mockResolvedValue({ ok: true });
  mocks.build.mockResolvedValue({ stack: ['domain:judge'], cwd: '/fixture/papercusp',
    mcpUrl: 'http://localhost:3170/api/mcp?role=judge&sig=valid', promptText: 'RESTRICTED JUDGE',
    specificationRevision: 'revision', stateRevision: 'state', specificationArtifact: {} });
});

describe('featureless role repair after resume', () => {
  it('uses the exact retained original launch without replacing the role or state binding', async () => {
    expect(await repairRoleCodexHome(fixture())).toMatchObject({ status: 200,
      body: { repaired: true, role: 'judge', acceptedOperation: false } });
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ sid: OWNER,
      preserveExisting: true, recordedSqliteHome: '/original-state/session-123', model: 'gpt-5.6-sol:high' }));
    expect(mocks.record).toHaveBeenCalledWith(SESSION, OWNER, expect.objectContaining({ role: 'judge' }));
    expect(mocks.activate).toHaveBeenCalled();
  });

  const carriedCustody = {
    workspaceId: 'papercusp-workspace', advSessionId: SESSION, ownerId: OWNER,
    originalSessionId: 'original-native', currentSessionId: 'carried-native',
    originalEventId: 'applied-original', reanchorEventId: 'applied-reanchor',
  };

  it('repairs a verified managed carry while retaining its immutable original launch', async () => {
    const input = fixture();
    input.sessionRow.sessionId = 'carried-native';
    mocks.readLaunch.mockResolvedValue({ originalMemberNativeCustody: carriedCustody });
    expect(await repairRoleCodexHome(input)).toMatchObject({ status: 200, body: { repaired: true } });
    expect(mocks.readLaunch).toHaveBeenCalledWith(OWNER, 'papercusp-workspace', {
      advSessionId: SESSION, sessionId: 'carried-native',
    });
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({
      launchIdentity: { sid: OWNER, nativeSessionId: 'carried-native' },
    }));
    expect(mocks.record).toHaveBeenCalledWith(SESSION, OWNER, expect.objectContaining({
      originalMemberLaunch: input.rawRecord.originalMemberLaunch,
    }));
  });

  it.each([
    { workspaceId: 'foreign-workspace' }, { advSessionId: SESSION + 1 }, { ownerId: 'foreign-owner' },
    { originalSessionId: 'foreign-original' }, { currentSessionId: 'foreign-current' },
    { originalEventId: '' }, { reanchorEventId: '' }, { reanchorEventId: 'applied-original' },
  ])('refuses conflicting or incomplete carry custody %j before rendering', async (changes) => {
    const input = fixture();
    input.sessionRow.sessionId = 'carried-native';
    mocks.readLaunch.mockResolvedValue({ originalMemberNativeCustody: { ...carriedCustody, ...changes } });
    expect(await repairRoleCodexHome(input)).toMatchObject({ status: 409 });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('does not accept a carry witness supplied through mutable launch metadata', async () => {
    const input = fixture();
    input.sessionRow.sessionId = 'carried-native';
    Object.assign(input.rawRecord, { originalMemberNativeCustody: carriedCustody });
    expect(await repairRoleCodexHome(input)).toMatchObject({ status: 409 });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'version', changes: { v: 2 } },
    { name: 'ADV session', changes: { advSessionId: SESSION + 1 } },
    { name: 'owner', changes: { ownerId: 'another-owner' } },
    { name: 'native session', changes: { sessionId: 'another-native' } },
    { name: 'workspace', changes: { workspaceId: 'another-workspace' } },
    { name: 'backend', changes: { agent: 'claude' } },
    { name: 'argv', changes: { launchArgv: [null] } },
    { name: 'role', changes: { launchArgv: ['--role=su', '--harness=papercusp'] } },
    { name: 'harness', changes: { launchArgv: ['--role=judge', '--harness=foreign'] } },
  ])('refuses a conflicting original $name before any render or write', async ({ changes }) => {
    expect(await repairRoleCodexHome(fixture(changes))).toMatchObject({ status: 409,
      body: { error: 'role_launch_provenance_unavailable' } });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('refuses a missing original receipt', async () => {
    const input = fixture();
    delete (input.rawRecord as Partial<typeof input.rawRecord>).originalMemberLaunch;
    expect(await repairRoleCodexHome(input)).toMatchObject({ status: 409 });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('does not override an explicit conflicting current role', async () => {
    const input = fixture();
    input.sessionRow.launchArgv = ['--role=su', '--model=gpt-5.6-sol:high'];
    expect(await repairRoleCodexHome(input)).toMatchObject({ status: 409 });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('preserves the existing direct-role path without demanding a redundant harness flag', async () => {
    const input = fixture();
    input.sessionRow.launchArgv = ['--role=judge', '--model=gpt-5.6-sol:high'];
    expect(await repairRoleCodexHome(input)).toMatchObject({ status: 200, body: { repaired: true } });
  });

  it('keeps the funding refusal ahead of role-home writes', async () => {
    mocks.funding.mockResolvedValue({ ok: false, refused: ['unfunded'] });
    expect(await repairRoleCodexHome(fixture())).toMatchObject({ status: 402 });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});
