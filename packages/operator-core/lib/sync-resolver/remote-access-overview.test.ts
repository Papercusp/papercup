/**
 * `remoteAccess.overview` — the one row Settings → Remote access renders (external-app-access P-010,
 * D-025) with both of the install's routes: its own tunnel (P-009) and the opt-in Papercusp relay
 * (P-008, D-031). A failure reading either route is reported on the row, never thrown, so the list
 * of phones and keys and the kill switch still render when a route's store is unreachable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  getRemoteAccess: vi.fn(),
  listRemoteAccessEntries: vi.fn(),
  ownTunnelStatus: vi.fn(),
  portalRelayStatus: vi.fn(),
}));

vi.mock('../connected-apps/remote-access', () => ({
  getRemoteAccess: H.getRemoteAccess,
  listRemoteAccessEntries: H.listRemoteAccessEntries,
}));
vi.mock('../own-tunnel/service', () => ({ ownTunnelStatus: H.ownTunnelStatus }));
vi.mock('../remote-access/relay-opt-in', () => ({ portalRelayStatus: H.portalRelayStatus }));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

const SWITCH = { workspaceId: 'ws1', enabled: true, changedAt: null, changedBy: null };
const RELAY = { state: 'linked', available: true, health: 'up' };

describe('remoteAccess.overview named query', () => {
  beforeEach(() => {
    H.getRemoteAccess.mockReset().mockResolvedValue(SWITCH);
    H.listRemoteAccessEntries.mockReset().mockResolvedValue([{ id: 'pcapp_1' }]);
    H.ownTunnelStatus.mockReset().mockResolvedValue({ configured: false });
    H.portalRelayStatus.mockReset().mockResolvedValue(RELAY);
  });

  it('returns the switch, the entries and both routes for the workspace', async () => {
    expect(knownQueryNamesV2()).toContain('remoteAccess.overview');
    await expect(resolveNamedQueryV2('remoteAccess.overview', { workspaceId: 'ws1' })).resolves.toEqual([
      {
        workspaceId: 'ws1',
        remoteAccess: SWITCH,
        entries: [{ id: 'pcapp_1' }],
        ownTunnel: { configured: false },
        ownTunnelError: null,
        portalRelay: RELAY,
        portalRelayError: null,
      },
    ]);
    expect(H.getRemoteAccess).toHaveBeenCalledWith('ws1');
    expect(H.listRemoteAccessEntries).toHaveBeenCalledWith('ws1');
  });

  it('reports an unreadable relay on the row and still returns everything else (P-008)', async () => {
    H.portalRelayStatus.mockRejectedValue(new Error('relay store unreachable'));
    const [row] = (await resolveNamedQueryV2('remoteAccess.overview', { workspaceId: 'ws1' })) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      portalRelay: null,
      portalRelayError: 'relay store unreachable',
      ownTunnel: { configured: false },
      entries: [{ id: 'pcapp_1' }],
    });
  });

  it('reports an unreadable tunnel without hiding the relay', async () => {
    H.ownTunnelStatus.mockRejectedValue(new Error('tunnel row unreadable'));
    const [row] = (await resolveNamedQueryV2('remoteAccess.overview', { workspaceId: 'ws1' })) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ ownTunnel: null, ownTunnelError: 'tunnel row unreadable', portalRelay: RELAY, portalRelayError: null });
  });
});
