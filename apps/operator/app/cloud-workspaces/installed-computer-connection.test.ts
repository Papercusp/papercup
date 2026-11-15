// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import SecretStream from '@hyperswarm/secret-stream';
import { Buffer } from 'buffer';
import { ByocSealedChannel, type ByocSealedPacket } from '@papercusp/operator-core/lib/workspace-host/byoc-sealed-channel';
import { installedBrowserKey, readInstalledComputerApproval, saveInstalledComputerApproval,
  installedComputerSocket, type InstalledComputerApproval } from './installed-computer-connection';

const browserPublicKey = btoa('b'.repeat(32));
const request = { version: 1 as const, requestId: 'request-123', portalOrigin: 'https://portal.example', browserPublicKey };
const principal = { userId: 'user-1', organizationId: 'org-1', workspaceId: 'workspace-1' };
function approval(): InstalledComputerApproval {
  return { type: 'papercusp.local-desktop-approved', version: 1, requestId: request.requestId,
    machinePublicKey: btoa('m'.repeat(32)), grant: { version: 1, id: 'grant-1', installId: 'install-1',
      portalOrigin: request.portalOrigin, userId: principal.userId, organizationId: principal.organizationId,
      customerWorkspaceId: principal.workspaceId, localWorkspaceId: 'local-1', browserPublicKey, view: true,
      control: false, grantedAt: '2026-11-15T10:00:00.000Z' } };
}
const stored = new Map<string, string>();
const browserStorage: Storage = {
  get length() { return stored.size; },
  clear: () => stored.clear(), getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => { stored.set(key, value); }, removeItem: key => { stored.delete(key); },
  key: index => [...stored.keys()][index] ?? null,
};
beforeEach(() => { vi.stubGlobal('localStorage', browserStorage); browserStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());
describe('installed computer browser authority', () => {
  it('keeps a stable browser key across reloads and never stores the private key in approval metadata', async () => {
    const first = await installedBrowserKey();
    const again = await installedBrowserKey();
    expect(again.publicKey.equals(first.publicKey)).toBe(true);
    expect(again.secretKey.equals(first.secretKey)).toBe(true);
    expect(first.publicKey.length).toBe(32);
    expect(first.secretKey.length).toBe(64);
    saveInstalledComputerApproval(approval(), principal);
    const saved = [...stored.keys()].find(key => key.includes('.approval.'))!;
    expect(localStorage.getItem(saved)).not.toContain(first.secretKey.toString('base64'));
  });
  it('fails closed on a corrupted saved browser seed rather than silently changing identity', async () => {
    localStorage.setItem('papercusp.installed-computer.browser-seed.v1', 'corrupt');
    await expect(installedBrowserKey()).rejects.toThrow('saved browser identity is invalid');
  });
  it.each(['userId', 'organizationId', 'customerWorkspaceId', 'browserPublicKey', 'portalOrigin'] as const)(
    'refuses a receipt for a different %s', key => {
      const value = approval(); (value.grant as unknown as Record<string, unknown>)[key] = 'wrong';
      expect(readInstalledComputerApproval(value, request, principal)).toBeNull();
    });
  it.each(['requestId', 'machinePublicKey', 'type', 'version'] as const)('refuses malformed receipt field %s', key => {
    const value = { ...approval(), [key]: 'wrong' };
    expect(readInstalledComputerApproval(value, request, principal)).toBeNull();
  });
  it('requires explicit viewing permission and preserves separate control permission', () => {
    const value = approval();
    expect(readInstalledComputerApproval(value, request, principal)?.grant.control).toBe(false);
    expect(readInstalledComputerApproval({ ...value, grant: { ...value.grant, view: false } }, request, principal)).toBeNull();
  });
  it('strips extra receipt credentials before persistence', () => {
    const value = approval();
    const clean = readInstalledComputerApproval({ ...value, connectorBearer: 'secret',
      grant: { ...value.grant, secretKey: 'secret' } }, request, principal);
    expect(clean).toEqual(value);
    expect(JSON.stringify(clean)).not.toContain('secret');
  });
  it.each([false, true])('uses the real host Noise wire and refuses a changed machine pin (wrongPin=%s)', async wrongPin => {
    const keys = await installedBrowserKey();
    const machine = SecretStream.keyPair(Buffer.alloc(32, 47));
    const wire: string[] = []; const frames: Record<string, unknown>[] = []; const incoming: unknown[] = [];
    let host!: ByocSealedChannel; let raw!: FakeSocket;
    class FakeSocket extends EventTarget {
      OPEN = 1; CLOSED = 3; CONNECTING = 0; CLOSING = 2; readyState = 0;
      constructor(readonly url: string) {
        super(); raw = this;
        expect(new URL(url).searchParams.get('sealed')).toBe('1');
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open'));
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.bound', kind: 'desktop-discovery' }) })); });
      }
      send(data: string) { wire.push(data); queueMicrotask(() => host.receive(JSON.parse(data) as ByocSealedPacket)); }
      close(code = 1000, reason = '') {
        if (code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException('Invalid browser close code', 'InvalidAccessError');
        if (this.readyState === 3) return;
        this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code, reason }));
      }
    }
    host = new ByocSealedChannel({ initiator: false, localKeyPair: machine, expectedRemotePublicKey: keys.publicKey,
      sendPacket: packet => queueMicrotask(() => raw.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) }))),
      onFrame: frame => frames.push(frame), onError: () => {} });
    void host.opened.then(() => host.send({ type: 'desktop.discovery.ready' })).catch(() => {});
    vi.stubGlobal('WebSocket', FakeSocket);
    const original = approval();
    const receipt = { ...original,
      machinePublicKey: (wrongPin ? SecretStream.keyPair().publicKey : machine.publicKey).toString('base64'),
      grant: { ...original.grant, browserPublicKey: keys.publicKey.toString('base64') } };
    const socket = await installedComputerSocket('wss://portal.example/api/hosted/connectors/socket?kind=desktop-discovery', receipt);
    socket.addEventListener('message', event => incoming.push(JSON.parse(event.data)));
    try {
      if (wrongPin) {
        await vi.waitFor(() => expect(raw.readyState).toBe(3));
        expect(incoming).toEqual([]); expect(frames).toEqual([]);
      } else {
        await vi.waitFor(() => expect(incoming).toContainEqual({ type: 'desktop.discovery.ready' }));
        socket.send(JSON.stringify({ type: 'desktop.roster', requestId: 'private-request-id' }));
        await vi.waitFor(() => expect(frames).toContainEqual({ type: 'desktop.roster', requestId: 'private-request-id' }));
        expect(wire.every(packet => JSON.parse(packet).type === 'sealed.packet')).toBe(true);
        expect(wire.join('')).not.toContain('private-request-id');
        raw.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'desktop.discovery.ready' }) }));
        expect(raw.readyState).toBe(3);
      }
    } finally { socket.close(); host.close(); }
  });
});
