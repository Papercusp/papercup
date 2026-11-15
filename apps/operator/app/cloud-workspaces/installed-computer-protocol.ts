/** Public handoff data only. Credentials and private Noise keys never enter a URL. */
export interface InstalledComputerRequest {
  version: 1;
  requestId: string;
  portalOrigin: string;
  browserPublicKey: string;
}

export function canonicalBrowserNoiseKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try { return atob(value).length === 32 && btoa(atob(value)) === value; } catch { return false; }
}

export function installedPortalOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return url.origin === value && (url.protocol === 'https:' || local && url.protocol === 'http:') ? value : null;
  } catch { return null; }
}

export function encodeInstalledComputerRequest(request: InstalledComputerRequest): string {
  return btoa(JSON.stringify({ version: request.version, requestId: request.requestId,
    portalOrigin: request.portalOrigin, browserPublicKey: request.browserPublicKey }));
}

export function readInstalledComputerRequest(code: string): InstalledComputerRequest | null {
  if (!code || code.length > 4096) return null;
  try {
    const value = JSON.parse(atob(code)) as InstalledComputerRequest;
    if (value?.version !== 1 || typeof value.requestId !== 'string' ||
        !/^[A-Za-z0-9-]{8,128}$/.test(value.requestId) ||
        !installedPortalOrigin(value.portalOrigin) || !canonicalBrowserNoiseKey(value.browserPublicKey)) return null;
    return { version: 1, requestId: value.requestId, portalOrigin: value.portalOrigin, browserPublicKey: value.browserPublicKey };
  } catch { return null; }
}

export function installedComputerUrl(localOrigin: string, request: InstalledComputerRequest): string {
  const url = new URL(localOrigin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('loopback_address_required');
  url.pathname = '/settings/remote-access';
  url.search = '';
  url.hash = `portal-connect=${encodeInstalledComputerRequest(request)}`;
  return url.toString();
}
