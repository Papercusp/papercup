/**
 * The portal's `device-http` relay plane (android-public-release-2026-10-01 D-013 #2, P-015):
 * a phone's device-API call to a cloud workspace, carried over the workspace's connector.
 */
import { describe, expect, it } from 'vitest';
import { PHONE_DEVICE_PATHS, isPhoneDevicePath } from '../device-ingress-paths';
import {
  AppRelayRateLimiter,
  DEVICE_RELAY_INGRESS_MARKER,
  InMemoryHostedAppRelayUsageStore,
  decideDeviceHttpRoute,
  deviceHttpRequestHeaders,
  handleHostedDeviceRelay,
  parseDeviceRelayPath,
  readDeviceJwtBearer,
  type AppRelayChannelKind,
  type AppRelayConnector,
  type AppRelayOpenOptions,
  type HostedAppRelayAuditEvent,
} from './hosted-app-relay';
import { EXTERNAL_INGRESS_MARKER_HEADER } from '../auth/forwarded-request-trust';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXYifQ.c2ln';
const NOW = new Date('2026-10-06T12:00:00Z');

interface Opened {
  kind: AppRelayChannelKind | undefined;
  open: AppRelayOpenOptions | undefined;
  sent: Array<Record<string, unknown>>;
}

function harness(opts: {
  hosting?: 'byoc' | 'papercusp';
  online?: boolean;
  reply?: { status: number; body: string };
} = {}) {
  const opened: Opened[] = [];
  const audits: HostedAppRelayAuditEvent[] = [];
  const connector: AppRelayConnector = {
    binding: { customerWorkspaceId: 'ws-1', hostId: 'h1', generation: 1, hosting: opts.hosting ?? 'papercusp' } as AppRelayConnector['binding'],
    lastSeenAt: opts.online === false ? new Date(NOW.getTime() - 3_600_000) : NOW,
  };
  const reply = opts.reply ?? { status: 200, body: '{"ok":true}' };
  const deps = {
    port: {
      appConnector: (id: string) => (id === 'ws-1' ? connector : null),
      openAppChannel(
        _c: AppRelayConnector,
        handlers: { onFrame: (p: Record<string, unknown>) => void; onClose: (r: string) => void },
        kind?: AppRelayChannelKind,
        open?: AppRelayOpenOptions,
      ) {
        const record: Opened = { kind, open, sent: [] };
        opened.push(record);
        return {
          send(payload: Record<string, unknown>) {
            record.sent.push(payload);
            if (payload.type === 'http.request') {
              queueMicrotask(() => {
                handlers.onFrame({ type: 'http.response', requestId: payload.requestId, status: reply.status, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } });
                handlers.onFrame({ type: 'http.body', requestId: payload.requestId, data: Buffer.from(reply.body).toString('base64') });
                handlers.onFrame({ type: 'http.end', requestId: payload.requestId });
              });
            }
            return true;
          },
          close() {},
        };
      },
    },
    usage: new InMemoryHostedAppRelayUsageStore(),
    rate: new AppRelayRateLimiter(60),
    now: () => NOW,
    randomId: () => 'req-1',
    onAudit: (event: HostedAppRelayAuditEvent) => audits.push(event),
  };
  return { deps, opened, audits };
}

const call = (path: string, init: RequestInit = {}) =>
  new Request(`https://app.papercusp.com/api/workspaces/ws-1/api/device/${path}`, init);

describe('device-http allowlist (derived from the external-ingress phone list)', () => {
  it('admits every phone device path and nothing desktop-only', () => {
    for (const path of PHONE_DEVICE_PATHS) expect(decideDeviceHttpRoute('POST', path).ok, path).toBe(true);
    expect(decideDeviceHttpRoute('GET', '/api/device/devices/dev-1').ok).toBe(true);
    for (const path of ['/api/device/pair-token', '/api/device/mint', '/api/device/qr', '/api/agent-tools/x/y', '/api/mcp']) {
      expect(decideDeviceHttpRoute('POST', path), path).toEqual({ ok: false, code: 'route_not_relayed' });
      expect(isPhoneDevicePath(path), path).toBe(false);
    }
    expect(decideDeviceHttpRoute('PUT', '/api/device/heartbeat')).toEqual({ ok: false, code: 'route_not_relayed' });
    expect(decideDeviceHttpRoute('GET', '/api/device/../mcp')).toEqual({ ok: false, code: 'invalid_path' });
  });

  it('parses only /api/workspaces/<id>/device/<route>', () => {
    expect(parseDeviceRelayPath('/api/workspaces/ws-1/api/device/runtime-config')).toEqual({ customerWorkspaceId: 'ws-1', machinePath: '/api/device/runtime-config' });
    expect(parseDeviceRelayPath('/api/workspaces/ws-1/mcp')).toBeNull();
    // The pre-fix shape: the shared Rust client never sends it, so it must not be relayed.
    expect(parseDeviceRelayPath('/api/workspaces/ws-1/device/runtime-config')).toBeNull();
  });
});

describe('device-http header policy', () => {
  it('forwards a device-JWT-shaped bearer only, and always stamps the deny-only marker', () => {
    expect(readDeviceJwtBearer(`Bearer ${JWT}`)).toBe(JWT);
    expect(readDeviceJwtBearer('Bearer pcapp_abcdef')).toBeNull();
    expect(readDeviceJwtBearer('Basic abc')).toBeNull();
    const headers = deviceHttpRequestHeaders({ Authorization: `Bearer ${JWT}`, Cookie: 'sid=1', 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' });
    expect(headers).toEqual({ authorization: `Bearer ${JWT}`, 'content-type': 'application/json', [EXTERNAL_INGRESS_MARKER_HEADER]: DEVICE_RELAY_INGRESS_MARKER });
    expect(deviceHttpRequestHeaders({ authorization: 'Bearer pcapp_x' }).authorization).toBeUndefined();
  });
});

describe('handleHostedDeviceRelay', () => {
  it('relays a JWT-bearing call over a device-http channel and streams the answer back', async () => {
    const h = harness();
    const res = await handleHostedDeviceRelay(call('runtime-config?x=1', { headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].kind).toBe('device-http');
    expect(h.opened[0].sent[0]).toMatchObject({
      type: 'http.request', method: 'GET', path: '/api/device/runtime-config?x=1',
      headers: { authorization: `Bearer ${JWT}`, [EXTERNAL_INGRESS_MARKER_HEADER]: DEVICE_RELAY_INGRESS_MARKER },
    });
  });

  it('lets pair through with no bearer, and carries its body', async () => {
    const h = harness();
    const res = await handleHostedDeviceRelay(call('pair', { method: 'POST', body: '{"token":"t"}', headers: { 'content-type': 'application/json' } }), h.deps);
    expect(res.status).toBe(200);
    expect(Buffer.from(String(h.opened[0].sent[0].body), 'base64').toString()).toBe('{"token":"t"}');
  });

  it('refuses a non-pair call without a device-JWT-shaped bearer before opening a channel', async () => {
    const h = harness();
    const res = await handleHostedDeviceRelay(call('heartbeat', { method: 'POST', headers: { authorization: 'Bearer pcapp_abc' } }), h.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'device_token_required' });
    expect(h.opened).toHaveLength(0);
  });

  it('passes the machine 401 through unchanged (the VM owns auth)', async () => {
    const h = harness({ reply: { status: 401, body: '{"error":"unauthorized"}' } });
    const res = await handleHostedDeviceRelay(call('heartbeat', { method: 'POST', headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('refuses a route off the phone allowlist as route_not_relayed (never a re-pair code)', async () => {
    const h = harness();
    const res = await handleHostedDeviceRelay(call('pair-token', { method: 'POST', headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'route_not_relayed' });
    expect(h.opened).toHaveLength(0);
  });

  it('answers workspace_offline (503 + retry-after) when the connector is stale', async () => {
    const h = harness({ online: false });
    const res = await handleHostedDeviceRelay(call('heartbeat', { method: 'POST', headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toEqual({ error: 'workspace_offline' });
  });

  it('refuses plaintext device content to a BYOC workspace (D-013 #6)', async () => {
    const h = harness({ hosting: 'byoc' });
    const res = await handleHostedDeviceRelay(call('heartbeat', { method: 'POST', headers: { authorization: `Bearer ${JWT}` } }), h.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'byoc_plaintext_relay_refused' });
    expect(h.opened).toHaveLength(0);
    expect(h.audits).toContainEqual({ action: 'app_relay_refused', customerWorkspaceId: 'ws-1', detail: 'byoc_plaintext_relay_refused' });
  });
});
