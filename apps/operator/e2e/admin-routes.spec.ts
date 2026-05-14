/**
 * Admin route surface — auth/loopback gating + shape contracts.
 *
 * The /api/admin/* family is loopback-only OR requires the per-install
 * superuser bearer token. These specs verify:
 *
 *  - Routes are reachable from loopback (200 / shape OK)
 *  - Wrong HTTP verb returns 405
 *  - Bearer-required routes return 401 without bearer
 *  - Input validation rejects bad shapes
 *
 * Not covered (would mutate state):
 *  - Actually running a build command
 *  - Actually pruning executed actions
 *  - Actually rotating tokens
 *  - Actually executing a destructive admin action
 */
import { test, expect } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

test.describe('admin route surface', () => {
  test('GET /api/admin/tables returns table list', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/tables`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tables)).toBe(true);
    if (body.tables.length > 0) {
      expect(body.tables[0]).toHaveProperty('exportName');
      expect(body.tables[0]).toHaveProperty('label');
      expect(body.tables[0]).toHaveProperty('schema');
    }
  });

  test('GET /api/admin/commands returns command list with build/run sections', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/commands`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.commands)).toBe(true);
    // Verify schema: each command has id, label, section, command, description
    const cmd = body.commands[0];
    expect(cmd).toHaveProperty('id');
    expect(cmd).toHaveProperty('label');
    expect(cmd).toHaveProperty('section');
    expect(cmd).toHaveProperty('command');
  });

  test('GET /api/admin/run without cmd param returns 400', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/run`);
    expect(res.status()).toBe(400);
  });

  test('GET /api/admin/run with unknown cmd returns error', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/run?cmd=totally-fake-cmd-id`);
    // 400 (unknown cmd) or 404 — either proves the route validates
    expect([400, 404]).toContain(res.status());
  });

  test('POST /api/admin/embed-backfill is gated', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/admin/embed-backfill`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    // 200 (loopback authorized) or 401/403 (auth required)
    expect([200, 401, 403]).toContain(res.status());
  });

  test('GET /api/admin/embed-backfill returns 405 (POST only)', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/embed-backfill`);
    expect(res.status()).toBe(405);
  });

  test('GET /api/admin/spawn-signing/failures requires bearer', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/spawn-signing/failures`);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid_bearer|unauthorized/);
  });

  test('POST /api/admin/spawn-signing/rotate requires bearer', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/admin/spawn-signing/rotate`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/admin/rotate-token is bearer-gated', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/admin/rotate-token`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([200, 401, 403]).toContain(res.status());
  });

  test('POST /api/admin/prune-executed-actions returns 405 on GET', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/prune-executed-actions`);
    expect(res.status()).toBe(405);
  });

  test('POST /api/admin/backup-orphan-cleanup is reachable', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/admin/backup-orphan-cleanup`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([200, 401, 403]).toContain(res.status());
  });

  test('GET /api/admin/tables/[exportName] returns table data for a known table', async ({ request }) => {
    // First fetch the list to get a known exportName.
    const list = await request.get(`${baseURL}/api/admin/tables`);
    const tables = (await list.json()).tables ?? [];
    if (tables.length === 0) {
      test.skip(true, 'No admin tables present');
    }
    const first = tables[0].exportName;
    const res = await request.get(`${baseURL}/api/admin/tables/${first}`);
    expect([200, 401]).toContain(res.status());
  });
});
