import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { BlueprintSchema } from '@papercusp/orchestrator/blueprint';
import * as orgDb from '@papercusp/db-org';
import * as blueprints from './blueprint/project-to-pg';
import * as federation from './hive-federation';
import { mockOrgPgSql } from './testing/mock-org-pg';
import { resolveInstalledRoleForAllowlist } from './blueprint-role-base';
import { checkSessionConfinement, setSessionConfinementResolver } from './capability-envelope/session-confinement-port';

const lifecycle = ['plan_items:adopt_name', 'plan_items:my_items', 'work_items:get',
  'work_items:checkpoint', 'work_items:complete', 'plans:publish-outputs'];
const allowedCaps = ['coord:read', 'coord:write', 'work_items:read', 'work_items:write', 'plans:write'];
const installed = BlueprintSchema.parse({ id: 'analysis-app', workItem: { kind: 'analysis' }, spine: {},
  roles: [{ id: 'oddsmith-analyst', baseRole: 'worker' }],
  fleet: { workerRoles: [{ id: 'oddsmith-analyst', capabilities: allowedCaps }] },
});
const context = (overrides: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(), signal: new AbortController().signal, emit: vi.fn(), progress: vi.fn(),
  workspaceId: 'workspace-a', harnessSlug: 'oddsmith', role: 'oddsmith-analyst',
  uiClientId: 'installed-analyst', principal: { slug: 'system:oddsmith-analyst',
    workspaceId: 'workspace-a', capabilities: new Set(allowedCaps) },
  ...overrides,
});

beforeAll(async () => {
  await Promise.all([
    import('./agent-tools/plan-items/adopt-name'), import('./agent-tools/plan-items/my-items'),
    import('./agent-tools/work_items/get'), import('./agent-tools/work_items/checkpoint'),
    import('./agent-tools/work_items/complete'), import('./agent-tools/plans/publish-outputs'),
    import('./agent-tools/plans/set-content'),
  ]);
}, 180_000);

beforeEach(() => {
  mockOrgPgSql(vi.spyOn(orgDb, 'getOrgPg'), vi.fn(() => {
    throw new Error('Unexpected SQL outside installed blueprint read');
  }));
  vi.spyOn(federation, 'canonicalHiveHomeSlug').mockImplementation(async (workspace, harness) =>
    workspace === 'workspace-a' && ['oddsmith', 'oddsmith-alias'].includes(harness) ? 'oddsmith-hive' : 'other-pot');
  vi.spyOn(blueprints, 'getEffectiveBlueprint').mockImplementation(async (_sql, scope) =>
    scope.workspaceId === 'workspace-a' && scope.harnessSlug === 'oddsmith' ? installed : null);
});
afterEach(() => {
  setSessionConfinementResolver(undefined);
  vi.restoreAllMocks();
});

describe('installed custom-role allowlist resolution', () => {
  it('is wired to the shared production dispatcher deps', async () => {
    const { PROJECTED_DEPS } = await import('./projected-tool-deps');
    expect(PROJECTED_DEPS.resolveRoleForAllowlist).toBe(resolveInstalledRoleForAllowlist);
  }, 180_000);
  it.each(lifecycle)('admits %s through real tool metadata and dispatch, without replacing the role', async name => {
    const tool = lookupByMcpName(name);
    expect(tool).toBeDefined();
    expect(tool!.agentRoles).not.toContain('oddsmith-analyst');
    const handler = vi.fn(async (_name, _args, ctx: UnifiedToolContext) => {
      expect(ctx.role).toBe('oddsmith-analyst');
      expect([...ctx.principal!.capabilities]).toEqual(allowedCaps);
      return { content: [{ type: 'text' as const, text: 'admitted' }] };
    });
    const result = await dispatchProjectedTool(tool!, name, {}, context(), {
      resolveRoleForAllowlist: resolveInstalledRoleForAllowlist, overrideTool: handler,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(blueprints.getEffectiveBlueprint).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'workspace-a', harnessSlug: 'oddsmith',
    });
  });

  it.each([
    { role: 'undeclared-analyst' }, { workspaceId: 'workspace-b' },
    { harnessSlug: 'uninstalled-app' }, { harnessSlug: '*' },
  ])('refuses undeclared/uninstalled/foreign role evidence: %j', async overrides => {
    const name = lifecycle[0]!;
    const handler = vi.fn();
    const result = await dispatchProjectedTool(lookupByMcpName(name)!, name, {}, context(overrides), {
      resolveRoleForAllowlist: resolveInstalledRoleForAllowlist, overrideTool: handler,
    });
    expect(result.error?.code).toBe('role_not_allowed');
    expect(handler).not.toHaveBeenCalled();
  });

  it('reads the installed canonical pot for a local harness alias', async () => {
    vi.mocked(blueprints.getEffectiveBlueprint).mockImplementation(async (_sql, scope) =>
      scope.workspaceId === 'workspace-a' && scope.harnessSlug === 'oddsmith-hive' ? installed : null);
    expect(await resolveInstalledRoleForAllowlist(context({ harnessSlug: 'oddsmith-alias' }))).toBe('worker');
  });

  it('never aliases a built-in role or accepts an unknown/chained base role', async () => {
    expect(await resolveInstalledRoleForAllowlist(context({ role: 'worker' }))).toBeNull();
    expect(blueprints.getEffectiveBlueprint).not.toHaveBeenCalled();
    vi.mocked(blueprints.getEffectiveBlueprint).mockResolvedValue(BlueprintSchema.parse({
      ...installed, roles: [{ id: 'oddsmith-analyst', baseRole: 'unregistered-base' }],
    }));
    expect(await resolveInstalledRoleForAllowlist(context())).toBeNull();
  });

  it('fails closed when installed blueprint evidence cannot be read', async () => {
    vi.mocked(blueprints.getEffectiveBlueprint).mockRejectedValue(new Error('registry unavailable'));
    const name = lifecycle[0]!;
    const handler = vi.fn();
    const result = await dispatchProjectedTool(lookupByMcpName(name)!, name, {}, context(), {
      resolveRoleForAllowlist: resolveInstalledRoleForAllowlist, overrideTool: handler,
    });
    expect(result.error?.code).toBe('role_not_allowed');
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps the capability gate independent of the canonical base role', async () => {
    const name = 'plans:publish-outputs';
    const ctx = context({ principal: { slug: 'system:oddsmith-analyst', workspaceId: 'workspace-a',
      capabilities: new Set(allowedCaps.filter(cap => cap !== 'plans:write')) } });
    const handler = vi.fn();
    const result = await dispatchProjectedTool(lookupByMcpName(name)!, name, {}, ctx, {
      resolveRoleForAllowlist: resolveInstalledRoleForAllowlist, overrideTool: handler,
    });
    expect(result.error?.code).toBe('missing_capability');
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps real session confinement binding after base-role admission', async () => {
    setSessionConfinementResolver(() => ({ denyTools: [], denyOutside: lifecycle,
      imposedBy: 'installed-analysis-launcher', reason: 'read/propose workflow only' }));
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'admitted' }] }));
    const deps = { resolveRoleForAllowlist: resolveInstalledRoleForAllowlist,
      checkCapabilityEnvelope: checkSessionConfinement, overrideTool: handler };
    const allowed = await dispatchProjectedTool(lookupByMcpName(lifecycle[0]!)!, lifecycle[0]!, {}, context(), deps);
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
    const denied = await dispatchProjectedTool(lookupByMcpName('plans:set-content')!, 'plans:set-content', {}, context(), deps);
    expect(denied.error?.code).toBe('capability_denied');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
