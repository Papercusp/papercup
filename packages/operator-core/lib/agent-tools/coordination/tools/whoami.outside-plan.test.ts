import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async original => ({
  ...await original<typeof import('@papercusp/agent-mcp')>(), defineTool: (tool: unknown) => tool,
}));
vi.mock('../identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'owner', workspaceId: 'authenticated-workspace', ownerLabel: 'su' }),
  deriveFleetMembership: () => ({ fleetSlug: null, fleetRole: null }),
}));
vi.mock('../presence-fleet', () => ({ resolvePresenceFleet: async () => ({ fleetSlug: null, fleetRole: null }) }));
vi.mock('../../../session-outside-plan', () => ({ readSessionOutsidePlanRef: h.read }));
import whoami from './whoami';

describe('coord:whoami outside-plan readback', () => {
  beforeEach(() => h.read.mockReset());
  it.each(['tracker:X', null])('reads the stored binding (%s) with the authenticated workspace', async planRef => {
    h.read.mockResolvedValue(planRef);
    const result = await whoami.handler({}, {} as never);
    const body = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(h.read).toHaveBeenCalledWith('owner', 'authenticated-workspace');
    expect(body).toMatchObject({ ownerId: 'owner', outsidePlanRef: planRef });
  });
});
