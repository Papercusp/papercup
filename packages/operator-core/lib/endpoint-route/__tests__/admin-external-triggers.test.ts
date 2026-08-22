import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const flagEnabled = vi.fn(async () => true);
const loadSnapshot = vi.fn(async () => ({
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
const notify = vi.fn(async () => {});
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
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: () => flagEnabled() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: (...args: unknown[]) => notify(...args) }));
vi.mock('../../external-triggers/admin', () => ({
  disabledExternalTriggerAdminSnapshot: () => ({
    enabled: false,
    counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
    sources: [],
    bindings: [],
    recentRuns: [],
  }),
  loadExternalTriggerAdminSnapshot: (...args: unknown[]) => loadSnapshot(...args),
  setExternalTriggerBindingArmed: (...args: unknown[]) => setArmed(...args),
  updateExternalTriggerBindingStormPolicy: (...args: unknown[]) => setStorm(...args),
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import routes from '../routes/admin/external-triggers';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
const [read, mutate] = routes as unknown as AnyRoute[];
const URL = 'http://127.0.0.1:3070/admin/triggers';
const BINDING_ID = '10000000-0000-4000-8000-000000000001';

async function request(route: AnyRoute, method: 'GET' | 'PATCH', body?: unknown, headers: Record<string, string> = {}) {
  const app = new Hono();
  registerRoute(app, route);
  return app.request(URL, {
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
  it('keeps read and write desktop-callable under the same explicit trust gate', () => {
    expect(read).toMatchObject({ method: 'GET', path: '/admin/triggers' });
    expect(mutate).toMatchObject({ method: 'PATCH', path: '/admin/triggers' });
    expect(read.auth).toEqual({ trust: ['verified', 'trusted', 'unverified-loopback'] });
    expect(mutate.auth).toEqual(read.auth);
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
});
