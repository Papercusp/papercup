import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedWorkspaceHostRuntimeOptions } from '../workspace-host/hosted-workspace-host-runtime';
import type { HostedDesktopBackend } from '../workspace-host/hosted-session-host';
import type { PortalRelayDesktopGrant, PortalRelayRow } from './portal-relay-store';
import { linkedWorkspaceIdentity } from '../endpoint-route/routes/hosted-cli/store';
import { PORTAL_RELAY_NOTICE_VERSION } from './relay-notice';
import { createLocalRelayRuntime, portalRelayConnectorMatchesDesktopGrant, resetPortalRelayRuntimeForTests, startPortalRelayConnector } from './portal-relay-runtime';

const seams = vi.hoisted(() => ({ create: vi.fn(), backend: vi.fn(), read: vi.fn(), key: vi.fn() }));
vi.mock('../workspace-host/hosted-workspace-host-runtime', () => ({
  createHostedWorkspaceHostRuntime: seams.create, createDefaultDesktopBackend: seams.backend,
}));
vi.mock('./portal-relay-store', async (original) => ({ ...await original<object>(), readPortalRelay: seams.read }));
vi.mock('../workspace-host/hosted-machine-noise-key', async (original) => ({ ...await original<object>(), loadOrCreateHostedMachineNoiseKeyPair: seams.key }));

const identity = linkedWorkspaceIdentity('org-1', 'install-1');
const grant: PortalRelayDesktopGrant = { version: 1, id: 'grant-1', installId: 'install-1', portalOrigin: 'https://portal.example',
  userId: 'user-1', organizationId: 'org-1', customerWorkspaceId: identity.customerWorkspaceId, localWorkspaceId: 'local-workspace',
  browserPublicKey: Buffer.alloc(32, 33).toString('base64'), view: true, control: false, grantedAt: '2026-11-15T00:00:00Z' };
const row = () => ({ installId: grant.installId, portalOrigin: grant.portalOrigin, linkedUserId: grant.userId,
  organizationId: grant.organizationId, customerWorkspaceId: grant.customerWorkspaceId, state: 'linked',
  consentedAt: new Date(), consentNoticeVersion: PORTAL_RELAY_NOTICE_VERSION, desktopGrant: { ...grant } }) as PortalRelayRow;
const binding = { ...identity, organizationId: grant.organizationId, controlPlaneWorkspaceId: 'control',
  generation: 1, transport: 'websocket' as const, state: 'active' as const };
const input = { url: 'wss://portal.example/connect', bearer: 'secret', workspaceRoot: '/local-data' };
let backend: HostedDesktopBackend;
beforeEach(() => {
  vi.clearAllMocks();
  backend = { roster: vi.fn(async () => [
    { desktopSessionId: 'allowed', state: 'ready', scope: 'agent' as const },
    { desktopSessionId: 'personal', state: 'ready', scope: 'user' as const },
  ]), lookup: vi.fn(async () => null), thumbnail: vi.fn(async () => null), dial: vi.fn(), heartbeat: vi.fn(), start: vi.fn() };
  seams.backend.mockReturnValue(backend); seams.read.mockResolvedValue(row());
  seams.key.mockResolvedValue({ publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) });
  seams.create.mockImplementation((_options: HostedWorkspaceHostRuntimeOptions) => ({ start: vi.fn(), stop: vi.fn(), binding: null, adapter: null }));
});
afterEach(resetPortalRelayRuntimeForTests);
const configured = () => seams.create.mock.calls.at(-1)![0] as HostedWorkspaceHostRuntimeOptions;

describe('local relay desktop composition', () => {
  it('keeps an app-only link failclosed without a separate local grant', async () => {
    await createLocalRelayRuntime({ ...input, onTerminal: vi.fn() });
    const options = configured();
    expect(options.desktop).toBeUndefined(); expect(options.localDesktopAccess!.browserPublicKey).toBeNull();
    expect(await options.localDesktopAccess!.authorize({ binding, userId: grant.userId, control: false })).toBe(false);
    expect(options.allowedChannelKinds!.has('pty')).toBe(false); expect(options.allowedChannelKinds!.has('operator-http')).toBe(false);
    expect(seams.backend).not.toHaveBeenCalled(); expect(seams.key).not.toHaveBeenCalled();
  });

  it('uses the approved local workspace and independently pins the browser key', async () => {
    await createLocalRelayRuntime({ ...input, desktopGrant: grant, onTerminal: vi.fn() });
    expect(seams.backend).toHaveBeenCalledWith('local-workspace', { reconcile: undefined });
    expect(configured().localDesktopAccess!.browserPublicKey).toEqual(Buffer.from(grant.browserPublicKey, 'base64'));
    expect(await configured().localDesktopAccess!.authorize({ binding, userId: grant.userId, control: false })).toBe(true);
    expect(await configured().localDesktopAccess!.authorize({ binding, userId: grant.userId, control: true })).toBe(false);
    seams.read.mockResolvedValue({ ...row(), desktopGrant: Object.fromEntries(Object.entries(grant).reverse()) });
    expect(await configured().localDesktopAccess!.authorize({ binding, userId: grant.userId, control: false })).toBe(true);
  });

  it.each(['user', 'organization', 'workspace', 'host', 'revoke', 'key', 'account', 'notice', 'read-failure'])(
    'does not authorize a changed %s', async (change) => {
      await createLocalRelayRuntime({ ...input, desktopGrant: grant, onTerminal: vi.fn() });
      const current = row(), request = { binding: { ...binding }, userId: grant.userId, control: false };
      if (change === 'user') request.userId = 'other';
      if (change === 'organization') request.binding.organizationId = 'other';
      if (change === 'workspace') request.binding.customerWorkspaceId = 'other';
      if (change === 'host') request.binding.hostId = 'other';
      seams.read.mockResolvedValue(change === 'revoke' ? { ...current, desktopGrant: null } :
        change === 'key' ? { ...current, desktopGrant: { ...grant, browserPublicKey: Buffer.alloc(32, 99).toString('base64') } } :
        change === 'account' ? { ...current, linkedUserId: 'other' } :
        change === 'notice' ? { ...current, consentNoticeVersion: 0 } : current);
      if (change === 'read-failure') seams.read.mockRejectedValue(new Error('unavailable'));
      await expect(configured().localDesktopAccess!.authorize(request).catch(() => false)).resolves.toBe(false);
    });

  it('checks roster membership before lookup, thumbnail and dial, and withholds personal desktops', async () => {
    await createLocalRelayRuntime({ ...input, desktopGrant: grant, onTerminal: vi.fn() });
    const scoped = configured().desktop!;
    expect(await scoped.roster()).toEqual([{ desktopSessionId: 'allowed', state: 'ready', scope: 'agent' }]);
    for (const id of ['personal', 'another-workspace']) {
      await expect(scoped.lookup(id)).rejects.toMatchObject({ code: 'desktop_session_unknown' });
      await expect(scoped.thumbnail(id)).rejects.toMatchObject({ code: 'desktop_session_unknown' });
      await expect(scoped.dial({ desktopSessionId: id } as never)).rejects.toMatchObject({ code: 'desktop_session_unknown' });
    }
    expect(backend.lookup).not.toHaveBeenCalled(); expect(backend.thumbnail).not.toHaveBeenCalled(); expect(backend.dial).not.toHaveBeenCalled();
    await scoped.lookup('allowed'); expect(backend.lookup).toHaveBeenCalledWith('allowed');
    await expect(scoped.start()).rejects.toMatchObject({ code: 'desktop_start_not_allowed' }); expect(backend.start).not.toHaveBeenCalled();
  });

  it('reconfigures the existing connector when the independent grant changes', async () => {
    await startPortalRelayConnector({ ...input, desktopGrant: grant });
    const first = seams.create.mock.results[0]!.value;
    await startPortalRelayConnector({ ...input, desktopGrant: { ...grant } }); expect(seams.create).toHaveBeenCalledTimes(1);
    expect(portalRelayConnectorMatchesDesktopGrant(grant)).toBe(true);
    await startPortalRelayConnector({ ...input, desktopGrant: null });
    expect(first.stop).toHaveBeenCalledWith('relay_reconfigured'); expect(seams.create).toHaveBeenCalledTimes(2);
    expect(configured().desktop).toBeUndefined(); expect(portalRelayConnectorMatchesDesktopGrant(null)).toBe(true);
  });
});
