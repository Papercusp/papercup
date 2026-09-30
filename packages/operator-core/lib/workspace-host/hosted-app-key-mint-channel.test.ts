/**
 * The machine end of a portal MCP OAuth key mint (plan external-app-access-to-workspaces-2026-09-29
 * P-325, WI-10004189; D-021), driven through the REAL host adapter against a real loopback HTTP
 * server standing in for this machine's operator.
 *
 * The portal's broker opens `relay.open { kind: 'app-key-mint', audience: 'portal-oauth' }` and
 * sends ONE `mint.request`. The adapter must: call only the loopback mint route, WITHOUT the
 * ingress marker (the machine acting on its own connector) and without any principal header;
 * answer exactly once and close; refuse anything that is not a well-formed mint request; and abort
 * the call when the portal closes the channel. The same file pins the two relay-side facts the
 * portal flow depends on: neither relay plane can reach the mint route, and the portal's MCP 401
 * names the workspace's authorization-server metadata.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTERNAL_INGRESS_MARKER_HEADER } from '../auth/forwarded-request-trust';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import {
  PORTAL_MINT_ROUTE_PATH,
  decideAppHttpRoute,
  handleHostedAppRelay,
  type HostedAppRelayDependencies,
} from './hosted-app-relay';
import { HOSTED_PRINCIPAL_SESSION_HEADER, HOSTED_PRINCIPAL_USER_HEADER, decideOperatorHttpRoute } from './hosted-operator-http';
import { HostedWorkspaceHostSessionAdapter, type HostedHostOutboundEnvelope } from './hosted-session-host';

const APP_KEY = `pcapp_${'a'.repeat(16)}_${'s'.repeat(43)}`;
const REQUEST = { type: 'mint.request', requestId: 'r-1', label: 'Claude', scopes: { tools: ['plans:get'] }, approvedBy: 'portal:user-1' };

const binding: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'control-1',
  organizationId: 'org-1',
  customerWorkspaceId: 'workspace-1',
  hostId: 'host-1',
  routeLabel: 'alpha',
  generation: 4,
  transport: 'websocket',
  state: 'active',
};

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function operator(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const json = (status: number, body: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function hostFor(origin: string) {
  const sent: HostedHostOutboundEnvelope[] = [];
  const adapter = new HostedWorkspaceHostSessionAdapter({
    binding,
    workspaceRoot: '/nonexistent-root',
    send: (message) => sent.push(message),
    operatorHttp: { origin },
  });
  const frames = (channelId = 'mint-1') =>
    sent
      .filter((m): m is Extract<HostedHostOutboundEnvelope, { type: 'relay' }> => m.type === 'relay' && m.channelId === channelId)
      .map((m) => m.payload as Record<string, unknown>);
  const closes = (channelId = 'mint-1') =>
    sent.filter((m) => m.type === 'relay.close' && m.channelId === channelId).map((m) => (m as { reason: string }).reason);
  const open = (extra: Record<string, unknown> = {}) =>
    adapter.accept({ type: 'relay.open', channelId: 'mint-1', kind: 'app-key-mint', audience: 'portal-oauth', ...extra });
  const relay = (payload: unknown, channelId = 'mint-1') => adapter.accept({ type: 'relay', channelId, payload });
  return { adapter, sent, frames, closes, open, relay };
}

describe('app-key-mint channel, machine end (P-325)', () => {
  it('mints through the loopback route as the machine itself, answers once, and closes', async () => {
    const op = await operator(json(201, { ok: true, key: APP_KEY, scopes: { capabilities: [], tools: ['plans:get'] } }));
    const host = hostFor(op.origin);
    await host.open();
    expect(host.frames()).toEqual([]); // no http.ready: this channel is not an HTTP pipe
    await host.relay(REQUEST);

    expect(op.seen).toHaveLength(1);
    const call = op.seen[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(PORTAL_MINT_ROUTE_PATH);
    expect(JSON.parse(call.body)).toEqual({ label: 'Claude', scopes: { tools: ['plans:get'] }, approvedBy: 'portal:user-1' });
    expect(call.headers[EXTERNAL_INGRESS_MARKER_HEADER]).toBeUndefined();
    expect(call.headers[HOSTED_PRINCIPAL_USER_HEADER]).toBeUndefined();
    expect(call.headers[HOSTED_PRINCIPAL_SESSION_HEADER]).toBeUndefined();
    expect(call.headers.authorization).toBeUndefined();

    expect(host.frames()).toEqual([
      { type: 'mint.issued', requestId: 'r-1', key: APP_KEY, scopes: { capabilities: [], tools: ['plans:get'] } },
    ]);
    expect(host.closes()).toEqual(['mint_complete']);
    // The channel is gone: a second request reaches nothing.
    await host.relay({ ...REQUEST, requestId: 'r-2' });
    expect(op.seen).toHaveLength(1);
  });

  it('passes the route refusal code back, e.g. a scope this machine will not grant', async () => {
    const op = await operator(json(400, { ok: false, error: { code: 'invalid_scope', problems: [] } }));
    const host = hostFor(op.origin);
    await host.open();
    await host.relay(REQUEST);
    expect(host.frames()).toEqual([{ type: 'mint.error', requestId: 'r-1', code: 'invalid_scope' }]);
    expect(host.closes()).toEqual(['mint_complete']);
  });

  it('refuses a malformed request without calling the operator', async () => {
    for (const bad of [
      { ...REQUEST, approvedBy: 'user-1' },
      { ...REQUEST, approvedBy: 'portal:a b' },
      { ...REQUEST, label: '  ' },
      { ...REQUEST, scopes: ['plans:get'] },
    ]) {
      const op = await operator(json(201, { ok: true, key: APP_KEY }));
      const host = hostFor(op.origin);
      await host.open();
      await host.relay(bad);
      expect(op.seen).toEqual([]);
      expect(host.frames()).toEqual([{ type: 'mint.error', requestId: 'r-1', code: 'invalid_request' }]);
    }
  });

  it('opens only for the portal-oauth audience, and carries nothing but mint.request', async () => {
    const op = await operator(json(201, { ok: true, key: APP_KEY }));
    const wrongAudience = hostFor(op.origin);
    await wrongAudience.open({ audience: 'app' });
    await wrongAudience.relay(REQUEST);
    expect(wrongAudience.frames()).toEqual([]);

    const host = hostFor(op.origin);
    await host.open();
    await host.relay({ type: 'http.request', requestId: 'h-1', method: 'POST', path: '/api/mcp' });
    await host.relay({ type: 'desktop.start', requestId: 'd-1' });
    expect(host.frames()).toEqual([
      { type: 'mint.error', requestId: 'h-1', code: 'channel_kind_mismatch' },
      { type: 'mint.error', requestId: 'd-1', code: 'channel_kind_mismatch' },
    ]);
    expect(op.seen).toEqual([]);

    // And an app-http channel never mints.
    await host.adapter.accept({ type: 'relay.open', channelId: 'app-1', kind: 'app-http', audience: 'app' });
    await host.relay(REQUEST, 'app-1');
    expect(op.seen).toEqual([]);
  });

  it('answers a second request on the same channel with a refusal, not a second key', async () => {
    let release: () => void = () => {};
    const op = await operator((req, res) => {
      release = () => json(201, { ok: true, key: APP_KEY })(req, res);
    });
    const host = hostFor(op.origin);
    await host.open();
    const first = host.relay(REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.relay({ ...REQUEST, requestId: 'r-2' });
    release();
    await first;
    expect(op.seen).toHaveLength(1);
    expect(host.frames()).toEqual([
      { type: 'mint.error', requestId: 'r-2', code: 'mint_already_requested' },
      { type: 'mint.issued', requestId: 'r-1', key: APP_KEY, scopes: REQUEST.scopes },
    ]);
  });

  it('aborts the call when the portal closes the channel, and never delivers a key afterwards', async () => {
    let release: () => void = () => {};
    const op = await operator((req, res) => {
      release = () => json(201, { ok: true, key: APP_KEY })(req, res);
    });
    const host = hostFor(op.origin);
    await host.open();
    const inflight = host.relay(REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.adapter.accept({ type: 'relay.close', channelId: 'mint-1', reason: 'mint_timeout' });
    release();
    await inflight;
    expect(host.frames()).toEqual([]);
  });
});

describe('the mint route is reachable from neither relay plane (P-325)', () => {
  it('refuses it on the app-http and operator-http allowlists', () => {
    expect(decideAppHttpRoute('POST', PORTAL_MINT_ROUTE_PATH).ok).toBe(false);
    expect(decideOperatorHttpRoute('POST', PORTAL_MINT_ROUTE_PATH).ok).toBe(false);
  });
});

describe("the portal MCP 401 names the workspace's authorization server (P-325)", () => {
  const deps = {} as HostedAppRelayDependencies; // refused before any dependency is touched
  it('carries resource_metadata on /mcp, and a plain Bearer challenge on tool calls', async () => {
    const mcp = await handleHostedAppRelay(new Request('https://app.papercusp.com/api/workspaces/ws-1/mcp', { method: 'POST' }), deps);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://app.papercusp.com/.well-known/oauth-protected-resource/api/workspaces/ws-1/mcp"',
    );
    const tools = await handleHostedAppRelay(
      new Request('https://app.papercusp.com/api/workspaces/ws-1/agent-tools/plans/get', { method: 'POST' }),
      deps,
    );
    expect(tools.status).toBe(401);
    expect(tools.headers.get('www-authenticate')).toBe('Bearer');
  });
});
