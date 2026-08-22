import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const flagEnabled = vi.fn(async () => true);
const loadSnapshot = vi.fn(async (_sql: unknown, _workspace: string) => ({
  enabled: true,
  counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
  sources: [],
  bindings: [],
  recentRuns: [],
}));
const setArmed = vi.fn(async (_sql: unknown, _workspace: string, id: string, armed: boolean) => ({
  id,
  armed,
  updatedAt: '2026-08-22T00:00:00.000Z',
}));
const setStorm = vi.fn(async (_sql: unknown, _workspace: string, id: string, input: unknown) => ({
  id,
  stormPolicy: input,
  updatedAt: '2026-08-22T00:00:00.000Z',
}));
const notify = vi.fn(async (..._args: unknown[]) => {});
const connectSlack = vi.fn(async (_sql: unknown, input: Record<string, unknown>) => ({
  id: '20000000-0000-4000-8000-000000000001',
  kind: 'slack',
  status: 'connecting',
  credentialRef: `slack-socket:${input.field ?? input.ownerUserId}`,
  config: { teamId: 'T1' },
}));
const sql = {};

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'system',
    slug: 'system:operator',
    workspaceId: 'ws-test',
    authMethod: 'superuser-bearer',
    trust: 'trusted',
    capabilities: new Set(['*']),
    label: 'su',
  })),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    constructor(
      public status: number,
      public reason: string,
    ) {
      super(reason);
    }
  },
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: () => flagEnabled() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: '22222222-2222-4222-8222-222222222222' })),
}));
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: (...args: Parameters<typeof notify>) => notify(...args),
}));
vi.mock('../../external-triggers/admin', () => ({
  disabledExternalTriggerAdminSnapshot: () => ({
    enabled: false,
    counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
    sources: [],
    bindings: [],
    recentRuns: [],
  }),
  loadExternalTriggerAdminSnapshot: (...args: Parameters<typeof loadSnapshot>) => loadSnapshot(...args),
  setExternalTriggerBindingArmed: (...args: Parameters<typeof setArmed>) => setArmed(...args),
  updateExternalTriggerBindingStormPolicy: (...args: Parameters<typeof setStorm>) => setStorm(...args),
}));
vi.mock('../../external-triggers/slack', () => ({
  SLACK_APP_MANIFEST_TEMPLATE: { settings: { socket_mode_enabled: true } },
  connectOwnedSlackSource: (...args: Parameters<typeof connectSlack>) => connectSlack(...args),
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import routes from '../routes/admin/external-triggers';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
const [read, mutate, slackManifest, slackConnect] = routes as unknown as AnyRoute[];
const URL = 'http://127.0.0.1:3070/admin/triggers';
const BINDING_ID = '10000000-0000-4000-8000-000000000001';

async function request(route: AnyRoute, method: 'GET' | 'PATCH' | 'POST', body?: unknown, headers: Record<string, string> = {}) {
  const app = new Hono();
  registerRoute(app, route);
  return app.request(`http://127.0.0.1:3070${route.path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  flagEnabled.mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe('external-trigger admin route pair', () => {
  it('keeps owner-local and Slack routes under their explicit trust gates', () => {
    expect(read).toMatchObject({ method: 'GET', path: '/admin/triggers' });
    expect(mutate).toMatchObject({ method: 'PATCH', path: '/admin/triggers' });
    expect(read.auth).toEqual({ trust: ['verified', 'trusted', 'unverified-loopback'] });
    expect(mutate.auth).toEqual(read.auth);
    expect(slackManifest).toMatchObject({
      method: 'GET',
      path: '/admin/triggers/slack/manifest',
      auth: { trust: ['verified', 'trusted'] },
    });
    expect(slackConnect).toMatchObject({
      method: 'POST',
      path: '/admin/triggers/slack/connect',
      auth: { trust: ['verified', 'trusted'] },
    });
  });

  it('returns the shared snapshot and the default-ON flag fails open on provider errors', async () => {
    flagEnabled.mockRejectedValueOnce(new Error('flag provider offline'));
    const response = await request(read, 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true });
    expect(loadSnapshot).toHaveBeenCalledWith(sql, 'ws-test');
  });

  it('returns the disabled shape without reading data when the flag is explicitly off', async () => {
    flagEnabled.mockResolvedValueOnce(false);
    const response = await request(read, 'GET');
    expect(await response.json()).toMatchObject({ enabled: false, bindings: [] });
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('refuses cross-origin writes before flag or data access', async () => {
    const response = await request(
      mutate,
      'PATCH',
      { op: 'set-armed', id: BINDING_ID, armed: true, confirm: true },
      { origin: 'https://evil.example' },
    );
    expect(response.status).toBe(403);
    expect(flagEnabled).not.toHaveBeenCalled();
    expect(setArmed).not.toHaveBeenCalled();
  });

  it('requires explicit owner confirmation for both arming directions', async () => {
    for (const armed of [true, false]) {
      const response = await request(mutate, 'PATCH', { op: 'set-armed', id: BINDING_ID, armed });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'owner_confirmation_required',
        gate: { category: 'schedule-arm', authority: 'owner', reversible: true },
      });
    }
    expect(setArmed).not.toHaveBeenCalled();
  });

  it('applies a confirmed arm and invalidates the shared admin snapshot', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-armed',
      id: BINDING_ID,
      armed: true,
      confirm: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, binding: { id: BINDING_ID, armed: true } });
    expect(setArmed).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID, true);
    expect(notify).toHaveBeenCalledWith('externalTriggers.admin', { workspaceId: 'ws-test' });
  });

  it('validates and applies the canonical storm-policy fields', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-storm-policy',
      id: BINDING_ID,
      maxRuns: 3,
      windowSeconds: 120,
    });
    expect(response.status).toBe(200);
    expect(setStorm).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID, { maxRuns: 3, windowSeconds: 120 });
  });

  it('serves the reusable Socket Mode manifest without exposing a secret', async () => {
    const response = await request(slackManifest, 'GET');
    expect(await response.json()).toEqual({ ok: true, manifest: { settings: { socket_mode_enabled: true } } });
  });

  it('stores Slack tokens through the connection seam and never echoes them', async () => {
    const response = await request(slackConnect, 'POST', {
      appToken: 'xapp-private', botToken: 'xoxb-private', installSlug: 'papercusp', channels: ['C1'],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, source: { kind: 'slack', status: 'connecting' } });
    expect(JSON.stringify(body)).not.toContain('xapp-private');
    expect(JSON.stringify(body)).not.toContain('xoxb-private');
    expect(connectSlack).toHaveBeenCalledWith(sql, expect.objectContaining({
      workspaceId: 'ws-test',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      appToken: 'xapp-private',
      botToken: 'xoxb-private',
    }));
    expect(notify).toHaveBeenCalledWith('externalTriggers.admin', { workspaceId: 'ws-test' });
  });
});
