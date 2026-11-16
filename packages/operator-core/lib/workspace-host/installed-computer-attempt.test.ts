import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { observeInstalledComputerAttempt } from './installed-computer-attempt.fixture';
import { createPortalRelayRoutes, type PortalRelayRouteDependencies } from '../endpoint-route/routes/portal-relay';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});

async function fixture(portalStatus = 200, malformedAuthority = false) {
  const requests: Array<{ method: string; path: string }> = [];
  const unused = async () => { throw new Error('observer must not mutate relay authority'); };
  const statusRoute = createPortalRelayRoutes({
    isLocal: () => true,
    status: async () => ({ state: 'connected', installId: 'PRIVATE_ID', consent: { agreed: true },
      linked: { userId: 'PRIVATE_ACCOUNT' }, desktop: { grant: { token: 'PRIVATE_GRANT' } },
      connector: { bearer: 'PRIVATE_TOKEN' }, extra: 'PRIVATE_EXTRA' } as unknown as
      Awaited<ReturnType<PortalRelayRouteDependencies['status']>>),
    accept: unused, begin: unused, cancel: unused, disconnect: unused,
    approveDesktop: unused, revokeDesktop: unused, reconcileSoon: () => {},
  }).find(route => route.method === 'GET' && route.path === '/remote-access/portal-relay')!;
  server = createServer(async (request, response) => {
    requests.push({ method: request.method!, path: request.url! });
    if (request.url === '/api/remote-access/portal-relay') {
      const result = await statusRoute.handler(new Request('http://127.0.0.1/api/remote-access/portal-relay'), {} as never);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(malformedAuthority ? JSON.stringify({ ok: false, relay: { state: 'connected' } }) : await result.text());
      return;
    }
    const local = request.url!.startsWith('/settings/remote-access');
    response.writeHead(local ? 200 : portalStatus, { 'content-type': 'text/html' });
    response.end(`<h1>${local ? 'Papercusp relay' : 'Sign in or sign up'}</h1>
      <script>fetch('/would-write', {method:'POST',body:'PRIVATE_BODY'}).catch(() => {})</script>`);
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

const runtimeIdentity = { sha: 'a'.repeat(40), evidenceRef: 'isolated browser fixture', observedAt: '2026-11-16T00:00:00Z' };

describe('physical installed-computer attempt observer', () => {
  it('observes real Chromium entries, blocks writes and redacts authority without claiming a connection', async () => {
    const { origin, requests } = await fixture();
    const receipt = await observeInstalledComputerAttempt({ localOrigin: origin, portalOrigin: origin, runtimeIdentity });
    expect(receipt.exitCode).toBe(0);
    expect(receipt.assertions.every(assertion => assertion.passed)).toBe(true);
    expect(receipt.observations.localStatus).toMatchObject({ state: 'connected', consentAgreed: true,
      installationIdentityPresent: true, linkedAccountPresent: true, desktopGrantPresent: true, connectorPresent: true });
    expect(receipt.observations.blockedMethods).toEqual(['POST']);
    expect(requests.some(request => request.path === '/api/remote-access/portal-relay')).toBe(true);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(requests.some(request => request.path === '/would-write')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_');
    // Even a pre-existing linked local status supplies no receiving-browser authorization or stream proof.
    expect(receipt.result).toMatchObject({ connectionEstablished: false, disposition: 'human-prerequisites-required' });
    expect(receipt.observations.account).toBeNull();
    expect(receipt.observations.desktopTransport).toBe('not exercised');
  }, 45_000);

  it('retains a failed Portal entry as incomplete instead of passing a healthy local status', async () => {
    const { origin } = await fixture(404);
    const receipt = await observeInstalledComputerAttempt({ localOrigin: origin, portalOrigin: origin, runtimeIdentity, timeoutMs: 2000 });
    expect(receipt.exitCode).toBe(1);
    expect(receipt.observations.portal).toMatchObject({ httpStatus: 404, markerVisible: false });
    expect(receipt.assertions.find(assertion => assertion.id === 'physical-portal-sign-in-boundary')?.passed).toBe(false);
    expect(receipt.result).toMatchObject({ connectionEstablished: false, disposition: 'observation-incomplete' });
  }, 45_000);

  it('refuses an unsuccessful authority envelope even when it includes a connected relay', async () => {
    const { origin } = await fixture(200, true);
    const receipt = await observeInstalledComputerAttempt({ localOrigin: origin, portalOrigin: origin, runtimeIdentity });
    expect(receipt.exitCode).toBe(1);
    expect(receipt.observations.localStatus).toEqual({ httpStatus: 200, parsed: false });
    expect(receipt.result.disposition).toBe('observation-incomplete');
  }, 45_000);

  it('rejects non-local installed entries and credential-bearing or insecure public origins before navigation', async () => {
    const loopback = 'http://127.0.0.1:1';
    for (const localOrigin of ['https://example.invalid', `${loopback}/wrong`, 'http://user:secret@localhost']) {
      await expect(observeInstalledComputerAttempt({ localOrigin, portalOrigin: loopback, runtimeIdentity }))
        .rejects.toThrow('physical_attempt_requires_loopback_origin');
    }
    for (const portalOrigin of ['http://example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/?token=secret']) {
      await expect(observeInstalledComputerAttempt({ localOrigin: loopback, portalOrigin, runtimeIdentity }))
        .rejects.toThrow('physical_attempt_requires_portal_origin');
    }
  });
});
