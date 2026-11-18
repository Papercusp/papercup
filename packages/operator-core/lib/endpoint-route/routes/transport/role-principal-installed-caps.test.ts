import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { loadRoleCapabilities } from './role-principal-caps';

const mocks = vi.hoisted(() => ({ installed: vi.fn(), declared: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: vi.fn() }) }));
vi.mock('../../../hive-federation', () => ({ potHomeSlugForHarness: async () => 'app-hive' }));
vi.mock('../../../resolve-harness-paths', () => ({ resolveHarnessPaths: async () => ({ stateDir: '/fixture/pot' }) }));
vi.mock('../../../capability-envelope/blueprint-envelopes', () => ({ blueprintWorkerRoleCapabilities: mocks.declared }));
vi.mock('../../../blueprint/project-to-pg', () => ({ getEffectiveBlueprint: mocks.installed }));

const role = 'installed-analysis-worker';
const grants = ['coord:read', 'coord:write', 'plans:read', 'work_items:read'];
const tx = (rows: Array<{ capabilities: unknown }> = []) => (() => Promise.resolve(rows)) as unknown as Sql;
const blueprint = () => ({ roles: [{ id: role }], fleet: { workerRoles: [{ id: role, capabilities: grants }] } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.declared.mockReturnValue(undefined);
  mocks.installed.mockResolvedValue(blueprint());
});

describe('installed application role capability declarations', () => {
  it('uses the installed app declaration when its federated pot has no role file', async () => {
    expect([...await loadRoleCapabilities(tx(), 'workspace', role, 'app')].sort())
      .toEqual([...grants, 'agent_tools:read'].sort());
    expect(mocks.installed).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'workspace', harnessSlug: 'app' });
  });

  it('retains an existing pot declaration as the grant source', async () => {
    mocks.declared.mockReturnValue(['coord:read']);
    expect([...await loadRoleCapabilities(tx(), 'workspace', role, 'app')].sort())
      .toEqual(['agent_tools:read', 'coord:read']);
    expect(mocks.installed).not.toHaveBeenCalled();
  });

  it('can resolve the installed canonical pot after an absent app declaration', async () => {
    mocks.installed.mockResolvedValueOnce(null).mockResolvedValueOnce(blueprint());
    expect((await loadRoleCapabilities(tx(), 'workspace', role, 'app')).has('coord:write')).toBe(true);
    expect(mocks.installed.mock.calls.map(([, scope]) => scope.harnessSlug)).toEqual(['app', 'app-hive']);
  });

  it.each(['absent', 'missing-role', 'duplicate-role', 'missing-worker', 'duplicate-worker', 'empty-grants'])(
    'grants nothing from an %s installed declaration', async (change) => {
      const b = blueprint();
      if (change === 'missing-role') b.roles = [];
      if (change === 'duplicate-role') b.roles.push({ id: role });
      if (change === 'missing-worker') b.fleet.workerRoles = [];
      if (change === 'duplicate-worker') b.fleet.workerRoles.push({ id: role, capabilities: grants });
      if (change === 'empty-grants') b.fleet.workerRoles[0]!.capabilities = [];
      mocks.installed.mockResolvedValue(change === 'absent' ? null : b);
      expect([...await loadRoleCapabilities(tx(), 'workspace', role, 'app')]).toEqual(['agent_tools:read']);
    },
  );

  it('fails closed when the installed reader fails', async () => {
    mocks.installed.mockRejectedValue(new Error('unavailable'));
    expect([...await loadRoleCapabilities(tx(), 'workspace', role, 'app')]).toEqual(['agent_tools:read']);
  });

  it('cannot widen a provisioned role whose capability list is explicitly empty', async () => {
    expect([...await loadRoleCapabilities(tx([{ capabilities: [] }]), 'workspace', role, 'app')])
      .toEqual(['agent_tools:read']);
    expect(mocks.installed).not.toHaveBeenCalled();
  });

  it('cannot widen a platform role from an application declaration', async () => {
    const b = blueprint();
    b.roles = [{ id: 'judge' }];
    b.fleet.workerRoles = [{ id: 'judge', capabilities: ['capability:bash'] }];
    mocks.installed.mockResolvedValue(b);
    expect((await loadRoleCapabilities(tx(), 'workspace', 'judge', 'app')).has('capability:bash')).toBe(false);
    expect(mocks.installed).not.toHaveBeenCalled();
  });

  it.each([undefined, '*'])('does not use an unbound harness %s', async (harness) => {
    expect([...await loadRoleCapabilities(tx(), 'workspace', role, harness)]).toEqual(['agent_tools:read']);
    expect(mocks.installed).not.toHaveBeenCalled();
  });
});
