import { canonicalBrowserNoiseKey } from './installed-computer-protocol';
import type { InstalledComputerRequest } from './installed-computer-protocol';
import type { PortalRelayDesktopGrant } from '@papercusp/operator-core/lib/remote-access/portal-relay-store';

export interface InstalledComputerPrincipal {
  userId: string;
  organizationId: string;
  workspaceId: string;
}
export interface InstalledComputerApproval {
  type: 'papercusp.local-desktop-approved';
  version: 1;
  requestId: string;
  grant: PortalRelayDesktopGrant;
  machinePublicKey: string;
}

export async function installedComputerPrincipal(): Promise<InstalledComputerPrincipal> {
  const response = await fetch('/api/hosted/auth/session', { cache: 'no-store' });
  const body = await response.json();
  const session = body?.session;
  if (!response.ok || body?.ok !== true || !session ||
      !['userId', 'organizationId', 'workspaceId'].every(key => typeof session[key] === 'string' && session[key])) {
    throw new Error('Choose a signed-in portal workspace first.');
  }
  return { userId: session.userId, organizationId: session.organizationId, workspaceId: session.workspaceId };
}

/** A seed remains in this browser's origin storage; only its public key leaves it. */
export async function installedBrowserKey(storage: Storage = localStorage) {
  const [{ default: SecretStream }, { Buffer }] = await Promise.all([
    import('@hyperswarm/secret-stream'), import('buffer'),
  ]);
  const key = 'papercusp.installed-computer.browser-seed.v1';
  let seed = storage.getItem(key);
  if (seed === null) {
    seed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    storage.setItem(key, seed);
    // Another tab may have established the identity while this one was loading.
    seed = storage.getItem(key);
  }
  if (!canonicalBrowserNoiseKey(seed)) throw new Error('The saved browser identity is invalid. Clear the connection identity and approve this browser again.');
  const pair = SecretStream.keyPair(Buffer.from(seed, 'base64'));
  // SecretStream uses b4a, which returns plain Uint8Array keys in browsers.
  // Keep encoding identical to Node before these keys enter grants or Noise.
  return { publicKey: Buffer.from(pair.publicKey), secretKey: Buffer.from(pair.secretKey) };
}

export function readInstalledComputerApproval(value: unknown, request: InstalledComputerRequest,
  principal: InstalledComputerPrincipal): InstalledComputerApproval | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as InstalledComputerApproval;
  const grant = receipt.grant;
  if (receipt.type !== 'papercusp.local-desktop-approved' || receipt.version !== 1 ||
      receipt.requestId !== request.requestId || !canonicalBrowserNoiseKey(receipt.machinePublicKey) ||
      !grant || grant.version !== 1 || grant.view !== true || typeof grant.control !== 'boolean' ||
      grant.portalOrigin !== request.portalOrigin || grant.browserPublicKey !== request.browserPublicKey ||
      grant.userId !== principal.userId || grant.organizationId !== principal.organizationId ||
      grant.customerWorkspaceId !== principal.workspaceId ||
      ![grant.id, grant.installId, grant.localWorkspaceId].every(v => typeof v === 'string' && v.trim()) ||
      !Number.isFinite(Date.parse(grant.grantedAt))) return null;
  // Copy the public allowlist, rather than persisting arbitrary receipt fields.
  return { type: receipt.type, version: 1, requestId: request.requestId, machinePublicKey: receipt.machinePublicKey,
    grant: { version: 1, id: grant.id, installId: grant.installId, portalOrigin: grant.portalOrigin,
      userId: grant.userId, organizationId: grant.organizationId, customerWorkspaceId: grant.customerWorkspaceId,
      localWorkspaceId: grant.localWorkspaceId, browserPublicKey: grant.browserPublicKey,
      view: true, control: grant.control, grantedAt: grant.grantedAt } };
}

function approvalKey(principal: InstalledComputerPrincipal, installId: string): string {
  return `papercusp.installed-computer.approval.v1:${JSON.stringify([principal.userId, principal.organizationId, principal.workspaceId, installId])}`;
}
export function saveInstalledComputerApproval(receipt: InstalledComputerApproval, principal: InstalledComputerPrincipal,
  storage: Storage = localStorage): void {
  storage.setItem(approvalKey(principal, receipt.grant.installId), JSON.stringify(receipt));
}
export async function installedComputerApproval(install: { installId: string; customerWorkspaceId: string },
  workspaceId: string): Promise<InstalledComputerApproval> {
  const principal = await installedComputerPrincipal();
  if (principal.workspaceId !== workspaceId || install.customerWorkspaceId !== workspaceId) throw new Error('The selected portal workspace changed.');
  const keys = await installedBrowserKey();
  let saved: InstalledComputerApproval | null = null;
  try { saved = JSON.parse(localStorage.getItem(approvalKey(principal, install.installId)) ?? 'null'); } catch { /* Invalid local data is refused below. */ }
  const receipt = saved && readInstalledComputerApproval(saved, { version: 1, requestId: saved.requestId,
    portalOrigin: location.origin, browserPublicKey: keys.publicKey.toString('base64') }, principal);
  if (!receipt || receipt.grant.installId !== install.installId) throw new Error('Approve desktop access for this browser in the Papercusp app.');
  return receipt;
}

/** Reuse the host's Noise XX wire. No application plaintext reaches the relay. */
export async function installedComputerSocket(url: string, approval: InstalledComputerApproval): Promise<WebSocket> {
  const [{ ByocSealedChannel, isByocSealedPacket }, { Buffer }, keys] = await Promise.all([
    import('@papercusp/operator-core/lib/workspace-host/byoc-sealed-channel'), import('buffer'), installedBrowserKey(),
  ]);
  if (keys.publicKey.toString('base64') !== approval.grant.browserPublicKey) throw new Error('Browser identity changed.');
  const address = new URL(url);
  address.searchParams.set('sealed', '1');
  const socket = new WebSocket(address);
  const channel = new EventTarget();
  let sealed: InstanceType<typeof ByocSealedChannel> | null = null;
  let opened = false;
  let failed = false;
  let bound: string | null = null;
  const pending: Record<string, unknown>[] = [];
  const emit = (frame: unknown) => channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
  const fail = (error?: unknown) => {
    if (failed) return;
    failed = true; opened = false; clearTimeout(deadline);
    channel.dispatchEvent(new ErrorEvent('error', {
      message: error instanceof Error ? error.message : 'Desktop identity verification failed.', error,
    }));
    // Browser callers may send only 1000 or application codes 3000–4999.
    socket.close(4008, 'desktop_identity_verification_failed');
  };
  const deadline = setTimeout(fail, 15_000);
  socket.addEventListener('open', () => {
    sealed = new ByocSealedChannel({ initiator: true, localKeyPair: keys,
      expectedRemotePublicKey: Buffer.from(approval.machinePublicKey, 'base64'),
      sendPacket: packet => socket.send(JSON.stringify(packet)),
      onFrame: frame => { if (opened) emit(frame); else pending.push(frame); }, onError: fail });
    void sealed.opened.then(() => {
      clearTimeout(deadline); opened = true;
      channel.dispatchEvent(new Event('open'));
      if (bound) emit(JSON.parse(bound));
      for (const frame of pending.splice(0)) emit(frame);
    }).catch(fail);
  });
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return fail();
    try {
      const frame = JSON.parse(event.data);
      if (isByocSealedPacket(frame)) sealed?.receive(frame);
      else if (frame?.type === 'session.bound' && frame.kind === address.searchParams.get('kind')) {
        if (opened) emit(frame); else bound = event.data;
      } else fail();
    } catch { fail(); }
  });
  socket.addEventListener('error', () => channel.dispatchEvent(new Event('error')));
  socket.addEventListener('close', event => {
    clearTimeout(deadline); opened = false; sealed?.close();
    channel.dispatchEvent(new CloseEvent('close', { code: event.code, reason: event.reason }));
  });
  Object.defineProperties(channel, { OPEN: { value: 1 }, CLOSED: { value: 3 }, CONNECTING: { value: 0 }, CLOSING: { value: 2 },
    readyState: { get: () => opened ? socket.readyState : socket.readyState === 1 ? 0 : socket.readyState } });
  return Object.assign(channel, {
    send(data: string) {
      if (!opened || !sealed) throw new Error('Desktop identity is not verified.');
      void sealed.send(JSON.parse(data)).catch(fail);
    },
    close(code?: number, reason?: string) { clearTimeout(deadline); opened = false; sealed?.close(); socket.close(code, reason); },
  }) as unknown as WebSocket;
}
