import { describe, expect, it } from 'vitest';
import { encodeInstalledComputerRequest, installedComputerUrl, readInstalledComputerRequest } from './installed-computer-protocol';

const request = { version: 1 as const, requestId: 'request-12345678', portalOrigin: 'https://portal.example', browserPublicKey: btoa('b'.repeat(32)) };

describe('installed computer public handoff', () => {
  it('roundtrips only public data in a loopback fragment with no network query', () => {
    const url = new URL(installedComputerUrl('http://127.0.0.1:3070', request));
    expect(url.pathname).toBe('/settings/remote-access');
    expect(url.search).toBe('');
    expect(readInstalledComputerRequest(url.hash.slice('#portal-connect='.length))).toEqual(request);
  });
  it.each(['https://attacker.example', 'file:///tmp/operator', 'http://127.0.0.1.attacker.example:3070', 'http://user:password@localhost'])('refuses a nonlocal or credentialed app address: %s', origin => {
    expect(() => installedComputerUrl(origin, request)).toThrow('loopback_address_required');
  });
  it.each([
    { portalOrigin: 'http://portal.example' }, { portalOrigin: 'https://portal.example/path' },
    { browserPublicKey: btoa('short') }, { browserPublicKey: btoa('b'.repeat(32)).replace(/=$/, '') },
    { requestId: '<script>' }, { version: 2 },
  ])('refuses malformed connection data %j', change => {
    expect(readInstalledComputerRequest(btoa(JSON.stringify({ ...request, ...change })))).toBeNull();
  });
  it('rejects malformed, oversized and null payloads', () => {
    for (const code of ['not-base64', 'x'.repeat(4097), btoa('null')]) expect(readInstalledComputerRequest(code)).toBeNull();
    expect(readInstalledComputerRequest(encodeInstalledComputerRequest(request))).toEqual(request);
  });
});
