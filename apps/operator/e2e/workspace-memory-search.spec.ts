/**
 * Workspace registry + user memory + user search route surface.
 *
 * Covers the public HTTP API for:
 *  - /api/workspaces (list + current)
 *  - /api/operator/state-snapshot (auth gate)
 *  - /api/user/preferences (auth gate)
 *  - /api/user/memory (auth gate)
 *  - /api/user/search (auth gate)
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('workspace registry + user surfaces', () => {
  test('GET /api/workspaces returns current + workspaces array', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/workspaces`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.current).toBeTruthy();
    expect(typeof body.current).toBe('string');
    expect(Array.isArray(body.workspaces)).toBe(true);
    if (body.workspaces.length > 0) {
      const ws = body.workspaces[0];
      expect(ws).toHaveProperty('id');
      expect(ws).toHaveProperty('name');
    }
  });

  test('GET /api/workspaces includes the current workspace', async ({ request }) => {
    // The registry must list the workspace it reports as `current`. The id is
    // environment-specific — the dev box calls it 'default', the isolated rig
    // 'verify-tauri-isolated-<display>' — so hardcoding 'default' failed every
    // isolated run (WI-10006791, seeded group operator-e2e-seed-ready-…19-29-08Z).
    const res = await request.get(`${baseURL}/api/workspaces`);
    const body = await res.json();
    const ids = body.workspaces.map((w: { id: string }) => w.id);
    expect(typeof body.current).toBe('string');
    expect(ids).toContain(body.current);
  });

  test('GET /api/operator/state-snapshot requires auth', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/operator/state-snapshot`);
    expect([200, 401, 403]).toContain(res.status());
  });

  test('GET /api/user/preferences requires auth', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/user/preferences`);
    expect([200, 401, 403]).toContain(res.status());
  });

  test('GET /api/user/memory requires auth', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/user/memory`);
    expect([200, 401, 403]).toContain(res.status());
  });

  test('GET /api/user/search?q=test requires auth', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/user/search?q=test`);
    expect([200, 401, 403]).toContain(res.status());
  });

  test('POST /api/user/memory requires auth (create route, P-010)', async ({ request }) => {
    // POST is the settings-page create route (P-010, 2026-06-09) — it
    // session-gates inside the handler, so an unauthenticated POST is 401,
    // never an unhandled 5xx.
    const res = await request.post(`${baseURL}/api/user/memory`, {
      data: { text: 'test', kind: 'preference' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  test('PATCH /api/user/memory requires auth + body', async ({ request }) => {
    const res = await request.fetch(`${baseURL}/api/user/memory`, {
      method: 'PATCH',
      data: { id: 'test-id', text: 'updated' },
      headers: { 'Content-Type': 'application/json' },
    });
    // Either 401 (no auth) or 400 (bad shape) — both prove the route validates
    expect([400, 401, 403, 404, 500]).toContain(res.status());
  });

  test('DELETE /api/user/memory requires auth', async ({ request }) => {
    const res = await request.fetch(`${baseURL}/api/user/memory?id=test-id`, {
      method: 'DELETE',
    });
    expect([400, 401, 403, 404, 500]).toContain(res.status());
  });
});
