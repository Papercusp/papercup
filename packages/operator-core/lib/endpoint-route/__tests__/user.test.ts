/**
 * Smoke tests for the ported `user` family — the 401-unauthenticated
 * gate is the shared invariant (session-cookie auth via getSessionUser).
 * Validation branches covered where they exist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUser: vi.fn(async () => null) }));
vi.mock('../../user-preferences', () => ({
  loadUserPreferences: vi.fn(async () => ({})),
  saveUserPreferences: vi.fn(async (_id, p) => p),
  clearUserPreferenceKey: vi.fn(async () => {}),
}));
vi.mock('../../memory/mem0-client', () => ({
  getMemoryClient: vi.fn(async () => null),
  invalidateMemoryClient: vi.fn(),
}));
vi.mock('../../memory/feedback', () => ({
  recordFeedback: vi.fn(async () => {}),
  loadFeedbackStats: vi.fn(async () => ({ total_edits: 0, total_deletes: 0, recent: [] })),
}));
vi.mock('../../memory/learning', () => ({
  buildLearningInstructions: vi.fn(async () => null),
}));
vi.mock('../../memory/reembed', () => ({ reembedMemories: vi.fn(async () => ({ from: 'a', to: 'b', count: 0 })) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));

import { getSessionUser } from '../../auth';
import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import userPreferences from '../routes/user/preferences';
import userSearch from '../routes/user/search';
import userMemory from '../routes/user/memory';
import userMemoryFeedback from '../routes/user/memory-feedback';
import userMemoryReembed from '../routes/user/memory-reembed';
import userMemoryAudit from '../routes/user/memory-audit';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}
const post = (body: object) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

afterEach(() => vi.clearAllMocks());

describe('user family ports — 401 gate', () => {
  it('GET /user/preferences returns 401 when no session', async () => {
    const res = await appWith(userPreferences as AnyRoute[]).request('/user/preferences');
    expect(res.status).toBe(401);
  });
  it('PATCH /user/preferences returns 401', async () => {
    const res = await appWith(userPreferences as AnyRoute[]).request('/user/preferences', {
      method: 'PATCH', body: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });
  it('GET /user/search returns 401', async () => {
    const res = await appWith(userSearch as AnyRoute).request('/user/search?q=x');
    expect(res.status).toBe(401);
  });
  it('GET /user/memory returns 401', async () => {
    const res = await appWith(userMemory as AnyRoute[]).request('/user/memory');
    expect(res.status).toBe(401);
  });
  it('GET /user/memory/feedback returns 401', async () => {
    const res = await appWith(userMemoryFeedback as AnyRoute).request('/user/memory/feedback');
    expect(res.status).toBe(401);
  });
  it('POST /user/memory/reembed returns 401', async () => {
    const res = await appWith(userMemoryReembed as AnyRoute).request('/user/memory/reembed', post({}));
    expect(res.status).toBe(401);
  });
  it('POST /user/memory/audit returns 401', async () => {
    const res = await appWith(userMemoryAudit as AnyRoute).request('/user/memory/audit', post({}));
    expect(res.status).toBe(401);
  });
});

describe('POST /user/memory/audit — auth + full-flag pathways', () => {
  it('returns full-audit estimate when authenticated and full=true', async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce({ id: 'u1', email: 'a@b' } as never);
    const res = await appWith(userMemoryAudit as AnyRoute).request(
      '/user/memory/audit',
      post({ full: true }),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.skipped).toBe(true);
    expect(j.reason).toBe('full_audit_pending_layer_3');
    expect(j.estimate).toBeDefined();
    expect(j.estimate.tokens).toBeGreaterThan(0);
  });
});

describe('user family ports — happy path / validation', () => {
  it('GET /user/preferences returns payload when authenticated', async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce({ id: 'u1', email: 'a@b' } as never);
    const res = await appWith(userPreferences as AnyRoute[]).request('/user/preferences');
    expect(res.status).toBe(200);
    expect((await res.json()).payload).toEqual({});
  });
  it('DELETE /user/preferences without key returns 400', async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce({ id: 'u1', email: 'a@b' } as never);
    const res = await appWith(userPreferences as AnyRoute[]).request('/user/preferences', {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });
  it('POST /user/memory/reembed rejects invalid mode with 400', async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce({ id: 'u1', email: 'a@b' } as never);
    const res = await appWith(userMemoryReembed as AnyRoute).request('/user/memory/reembed', post({ from: 'x', to: 'y' }));
    expect(res.status).toBe(400);
  });
  it('POST /user/memory/reembed rejects same-mode noop with 400', async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce({ id: 'u1', email: 'a@b' } as never);
    const res = await appWith(userMemoryReembed as AnyRoute).request('/user/memory/reembed', post({ from: 'openai', to: 'openai' }));
    expect(res.status).toBe(400);
  });
});
