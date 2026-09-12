/**
 * Regression coverage for `agent_tools:list`'s `asRole` simulation: it must
 * use the same role→capability synthesis as real dispatch, including
 * blueprint/runtime baselines for roles without a system_principals row.
 * Otherwise the catalog can advertise a capability-gated tool as callable
 * even though the synthesized dispatch principal correctly denies it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadRoleCapabilitiesMock = vi.fn();
const withWorkspaceMock = vi.fn();

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['su', 'operator'],
  listAllProjectedTools: () => [
    {
      expose: { mcp: { name: 'capability:bash' } },
      description: 'run a shell command',
      capabilities: ['capability:bash'],
      agentRoles: null,
      composition: 'primitive',
    },
    {
      expose: { mcp: { name: 'coord:send' } },
      description: 'send a coord message',
      capabilities: [],
      agentRoles: null,
      composition: 'primitive',
    },
  ],
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: (...args: unknown[]) => withWorkspaceMock(...args),
}));

vi.mock('../../endpoint-route/routes/transport/role-principal-caps', () => ({
  loadRoleCapabilities: (...a: unknown[]) => loadRoleCapabilitiesMock(...a),
}));

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-default',
}));

import tool from './list';

function callAsRole(asRole: string) {
  return (tool as { handler: (args: unknown, ctx: unknown) => Promise<unknown> }).handler(
    { asRole, onlyAllowed: false },
    { role: 'su', isSuperuser: true, workspaceId: 'ws-1' },
  );
}

interface ListResult {
  data: { tools: Array<{ name: string; allowed: boolean; reason: string | null }> };
}

function rows(result: unknown): Array<{ name: string; allowed: boolean; reason: string | null }> {
  return (result as ListResult).data.tools;
}

beforeEach(() => {
  vi.clearAllMocks();
  withWorkspaceMock.mockImplementation(async (_workspaceId, callback) => callback({}));
});

describe('agent_tools:list asRole simulation — matches real dispatch capability gating', () => {
  it('a role WITH a real (empty-capability) system_principals row denies a capability-gated tool — matching real dispatch', async () => {
    // worker's real row exists, by design, with zero capabilities.
    loadRoleCapabilitiesMock.mockResolvedValue(new Set<string>());
    const out = rows(await callAsRole('worker'));
    const bash = out.find((r) => r.name === 'capability:bash');
    expect(bash?.allowed).toBe(false);
    expect(bash?.reason).toMatch(/missing_capability/);
    const send = out.find((r) => r.name === 'coord:send');
    expect(send?.allowed).toBe(true); // no capabilities required — never gated
  });

  it('a role with no system_principals row still receives synthesized baseline caps and denies Bash', async () => {
    // judge has no provisioned row in a fresh workspace, but dispatch still
    // synthesizes its role baseline (plus agent_tools:read) before gating.
    loadRoleCapabilitiesMock.mockResolvedValue(new Set(['agent_tools:read', 'coord:read']));
    const out = rows(await callAsRole('judge'));
    const bash = out.find((r) => r.name === 'capability:bash');
    expect(bash?.allowed).toBe(false);
    expect(bash?.reason).toMatch(/missing_capability/);
  });

  it('a role principal that DOES carry the required capability is allowed', async () => {
    loadRoleCapabilitiesMock.mockResolvedValue(new Set(['capability:bash']));
    const out = rows(await callAsRole('worker'));
    const bash = out.find((r) => r.name === 'capability:bash');
    expect(bash?.allowed).toBe(true);
  });

  it('synthesizes the role by asRole name under the caller workspace', async () => {
    loadRoleCapabilitiesMock.mockResolvedValue(new Set<string>());
    await callAsRole('worker');
    expect(withWorkspaceMock).toHaveBeenCalledWith('ws-1', expect.any(Function));
    expect(loadRoleCapabilitiesMock).toHaveBeenCalledWith({}, 'ws-1', 'worker');
  });
});
