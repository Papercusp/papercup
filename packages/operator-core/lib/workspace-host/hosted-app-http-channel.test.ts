/**
 * The machine end of an outside app's call (plan external-app-access-to-workspaces-2026-09-29
 * P-007, WI-10004018), driven through the REAL host adapter: the portal's broker opens it as
 * `relay.open { kind: 'app-http', audience: 'app' }`, and HostedWorkspaceHostSessionAdapter must
 * build it with the APP plane's policy, not operator-http's — no ticket principal (even one a
 * frame claims), the app key as the only credential, and the deny-only ingress marker so the
 * operator never grants the call loopback trust (R-7, D-015). Runs against a real loopback HTTP
 * server, so the forwarded headers are what the operator actually receives.
 *
 * hosted-app-relay.test.ts covers the portal half and the channel factory in isolation; this file
 * pins the adapter's `open()` wiring, which that file's fake machine bypasses.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTERNAL_INGRESS_MARKER_HEADER } from '../auth/forwarded-request-trust';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import { APP_RELAY_INGRESS_MARKER } from './hosted-app-relay';
import { HOSTED_PRINCIPAL_SESSION_HEADER, HOSTED_PRINCIPAL_USER_HEADER } from './hosted-operator-http';
import { HostedWorkspaceHostSessionAdapter, type HostedHostOutboundEnvelope } from './hosted-session-host';

const APP_KEY = `pcapp_${'a'.repeat(16)}_${'s'.repeat(43)}`;

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

function hostFor(origin: string) {
  const sent: HostedHostOutboundEnvelope[] = [];
  const audit: Array<{ action: string; userId?: string; detail?: string }> = [];
  const adapter = new HostedWorkspaceHostSessionAdapter({
    binding,
    workspaceRoot: '/nonexistent-root',
    send: (message) => sent.push(message),
    onAudit: (event) => audit.push(event),
    operatorHttp: { origin },
  });
  const payloads = (channelId = 'app-1') =>
    sent
      .filter((m): m is Extract<HostedHostOutboundEnvelope, { type: 'relay' }> => m.type === 'relay' && m.channelId === channelId)
      .map((m) => m.payload as Record<string, unknown>);
  const open = (extra: Record<string, unknown> = {}) =>
    adapter.accept({ type: 'relay.open', channelId: 'app-1', kind: 'app-http', audience: 'app', role: 'controller', ...extra });
  const relay = (payload: unknown) => adapter.accept({ type: 'relay', channelId: 'app-1', payload });
  return { adapter, sent, audit, payloads, open, relay };
}

const decodeBody = (frames: Array<Record<string, unknown>>) =>
  frames.filter((f) => f.type === 'http.body').map((f) => Buffer.from(String(f.data), 'base64').toString()).join('');

describe('HostedWorkspaceHostSessionAdapter — app-http channels (P-007)', () => {
  it('forwards an app tool call with the app key and the ingress marker, and drops any ticket principal', async () => {
    const { seen, origin } = await operator((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=1' });
      res.end('{"ok":true}');
    });
    const h = hostFor(origin);
    // A frame that also claims an owner's ticket identity: the app plane binds none.
    await h.open({ userId: 'owner-1', hostedSessionId: 'owner-session' });
    expect(h.payloads()[0]).toEqual({ type: 'http.ready' });
    await h.relay({
      type: 'http.request',
      requestId: 'r1',
      method: 'POST',
      path: '/api/agent-tools/plans/list',
      headers: {
        authorization: `Bearer ${APP_KEY}`,
        cookie: 'papercusp_session=owner',
        'content-type': 'application/json',
        [HOSTED_PRINCIPAL_USER_HEADER]: 'owner-1',
        'x-forwarded-for': '203.0.113.9',
        [EXTERNAL_INGRESS_MARKER_HEADER]: 'spoofed',
      },
      body: Buffer.from('{}').toString('base64'),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/agent-tools/plans/list', body: '{}' });
    const headers = seen[0]!.headers;
    expect(headers.authorization).toBe(`Bearer ${APP_KEY}`);
    expect(headers[EXTERNAL_INGRESS_MARKER_HEADER]).toBe(APP_RELAY_INGRESS_MARKER);
    expect(headers[HOSTED_PRINCIPAL_USER_HEADER]).toBeUndefined();
    expect(headers[HOSTED_PRINCIPAL_SESSION_HEADER]).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    const frames = h.payloads();
    expect(frames).toContainEqual({ type: 'http.response', requestId: 'r1', status: 200, headers: { 'content-type': 'application/json' } });
    expect(decodeBody(frames)).toBe('{"ok":true}');
    expect(h.audit).toContainEqual(expect.objectContaining({ action: 'app_http_attached', userId: 'app-relay' }));
    expect(h.audit).toContainEqual(expect.objectContaining({ action: 'app_http_request', userId: 'app-relay' }));
    expect(h.audit.some((e) => e.action.startsWith('operator_http_') || e.userId === 'owner-1')).toBe(false);
  });

  it('never forwards an owner or admin ticket as the credential', async () => {
    const { seen, origin } = await operator((_req, res) => res.end('{}'));
    const h = hostFor(origin);
    await h.open();
    await h.relay({
      type: 'http.request', requestId: 'r1', method: 'POST', path: '/api/mcp',
      headers: { authorization: 'Bearer owner-ticket-jwt', 'content-type': 'application/json' },
      body: Buffer.from('{}').toString('base64'),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers[EXTERNAL_INGRESS_MARKER_HEADER]).toBe(APP_RELAY_INGRESS_MARKER);
  });

  it('refuses an operator route the owner plane allows, without making any request', async () => {
    const { seen, origin } = await operator((_req, res) => res.end('should not be reached'));
    const h = hostFor(origin);
    await h.open();
    await h.relay({ type: 'http.request', requestId: 'r1', method: 'POST', path: '/api/harness/portal/agent-chats' });
    expect(seen).toEqual([]);
    expect(h.payloads()).toContainEqual({ type: 'http.error', requestId: 'r1', code: 'route_not_relayed', status: 403 });
    expect(h.audit).toContainEqual(expect.objectContaining({ action: 'app_http_denied' }));
  });

  it('opens nothing for an app-http frame without the app audience or a channel id', async () => {
    const { origin } = await operator((_req, res) => res.end());
    const h = hostFor(origin);
    await h.open({ audience: 'workspace-operator' });
    await h.adapter.accept({ type: 'relay.open', kind: 'app-http', audience: 'app', role: 'controller' });
    expect(h.sent).toEqual([]);
  });

  it('refuses a second open of a live app channel', async () => {
    const { origin } = await operator((_req, res) => res.end());
    const h = hostFor(origin);
    await h.open();
    await h.open();
    expect(h.sent).toContainEqual({ type: 'relay.close', channelId: 'app-1', reason: 'channel_already_open' });
  });
});
