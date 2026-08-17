/**
 * WI-6154 (part 3, "SECONDARY BUG"): agent_tools:list's `asRole` simulation
 * used to blindly drop the principal for EVERY simulated role, on the
 * assumption that "real spawned agents at that role don't carry one". That
 * assumption is false for a role with a real (possibly capability-EMPTY)
 * `system_principals` row — e.g. `worker` on a live host, whose row exists
 * by design with zero capabilities. The result: `agent_tools:list { asRole:
 * 'worker' }` reported `allowed:true` for capability-gated tools that the
 * REAL dispatch path (which sees a non-null-but-empty-capability principal)
 * correctly denies with `missing_capability` — the catalog and dispatch
 * disagreeing, exactly as WI-6154 observed live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupSystemPrincipalCapabilitiesByRoleMock = vi.fn();

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['su', 'operator'],
  lookupSystemPrincipalCapabilitiesByRole: (...a: unknown[]) =>
    lookupSystemPrincipalCapabilitiesByRoleMock(...a),
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
});

describe('agent_tools:list asRole simulation — matches real dispatch capability gating (WI-6154)', () => {
  it('a role WITH a real (empty-capability) system_principals row denies a capability-gated tool — matching real dispatch', async () => {
    // worker's real row exists, by design, with zero capabilities.
    lookupSystemPrincipalCapabilitiesByRoleMock.mockResolvedValue(new Set<string>());
    const out = rows(await callAsRole('worker'));
    const bash = out.find((r) => r.name === 'capability:bash');
    expect(bash?.allowed).toBe(false);
    expect(bash?.reason).toMatch(/missing_capability/);
    const send = out.find((r) => r.name === 'coord:send');
    expect(send?.allowed).toBe(true); // no capabilities required — never gated
  });

  it('a role WITH NO system_principals row at all is NOT capability-gated (matches a genuinely principal-less real dispatch)', async () => {
    lookupSystemPrincipalCapabilitiesByRoleMock.mockResolvedValue(null);
    const out = rows(await callAsRole('some-gateless-role'));
    const bash = out.find((r) => r.name === 'capability:bash');
    expect(bash?.allowed).toBe(true);
  });

  it('a role principal that DOES carry the required capability is allowed', async () => {
    lookupSystemPrincipalCapabilitiesByRoleMock.mockResolvedValue(new Set(['capability:bash']));
    const out = rows(await callAsRole('worker'));
    const bash = out.find((r) => r.name === 'capability:bash');
    expect(bash?.allowed).toBe(true);
  });

  it('looks up the role by the simulated asRole name, in the caller workspace', async () => {
    lookupSystemPrincipalCapabilitiesByRoleMock.mockResolvedValue(new Set<string>());
    await callAsRole('worker');
    expect(lookupSystemPrincipalCapabilitiesByRoleMock).toHaveBeenCalledWith('ws-1', 'worker');
  });
});
