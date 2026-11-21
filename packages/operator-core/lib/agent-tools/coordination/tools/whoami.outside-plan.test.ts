import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ read: vi.fn(), identity: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async original => ({
  ...await original<typeof import('@papercusp/agent-mcp')>(), defineTool: (tool: unknown) => tool,
}));
vi.mock('../identity', () => ({
  resolveAgentIdentity: () => h.identity(),
  deriveFleetMembership: () => ({ fleetSlug: null, fleetRole: null }),
}));
vi.mock('../presence-fleet', () => ({ resolvePresenceFleet: async () => ({ fleetSlug: null, fleetRole: null }) }));
vi.mock('../../../session-outside-plan', async original => ({
  ...await original<typeof import('../../../session-outside-plan')>(), readSessionOutsidePlanRef: h.read,
}));
import whoami from './whoami';
type IdentityResult = { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };

describe('coord:whoami outside-plan readback', () => {
  beforeEach(() => {
    h.read.mockReset();
    h.identity.mockReset().mockReturnValue({ ownerId: 'owner', workspaceId: 'authenticated-workspace', ownerLabel: 'su' });
  });
  it.each(['tracker:X', null])('reads the stored binding (%s) with the authenticated workspace', async planRef => {
    h.read.mockResolvedValue(planRef);
    const result = await whoami.handler({}, {} as never) as IdentityResult;
    const body = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(h.read).toHaveBeenCalledWith('owner', 'authenticated-workspace');
    expect(body).toMatchObject({ ownerId: 'owner', outsidePlanRef: planRef });
    expect(result.structuredContent).toEqual(body);
  });
  it('preserves structured and text diagnostics when identity cannot resolve', async () => {
    h.identity.mockImplementation(() => { throw new Error('missing identity'); });
    const result = await whoami.handler({}, {} as never) as IdentityResult;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ resolved: false, error: 'missing identity', workspaceId: null });
    expect(result.structuredContent).toEqual(body);
    expect(h.read).not.toHaveBeenCalled();
  });
});
