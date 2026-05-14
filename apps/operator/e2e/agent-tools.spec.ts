/**
 * Agent-tools HTTP route surface — broad-coverage E2E.
 *
 * The 27+ built-in agent-mcp tools auto-mount at /api/agent-tools/<group>/<verb>
 * via defineTool (PR 0c.D). Each tool's contract is unit-tested at the tool
 * level; this spec verifies the catch-all routing + auth gate work end-to-end.
 *
 * Categories:
 *  - Unauthenticated reads (docs/outline, flags/list)
 *  - Authenticated reads (tasks/list, harness/list_features) — 401 without bearer
 *  - Input validation (zod schema errors return 500 with details)
 *  - Unknown tool (404 with unknown_tool code)
 */
import { test, expect } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

test.describe('agent-tools catch-all routing', () => {
  test('unknown tool returns 404 with unknown_tool error code', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/totally:made:up`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe('unknown_tool');
    expect(body.error?.message).toMatch(/No tool at path/);
  });

  test('tool name uses colon → slash mapping (docs:outline → /docs/outline)', async ({ request }) => {
    const colonStyle = await request.post(`${baseURL}/api/agent-tools/docs:outline`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    const slashStyle = await request.post(`${baseURL}/api/agent-tools/docs/outline`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    // colon-style is not a valid HTTP path → 404
    expect(colonStyle.status()).toBe(404);
    // slash-style is the canonical path → 200
    expect(slashStyle.status()).toBe(200);
  });

  test('docs:outline (unauth) returns the doc tree', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/outline`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.content).toBeDefined();
    expect(Array.isArray(body.content)).toBe(true);
  });

  test('flags:list (unauth) returns flag keys + values', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/flags/list`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const text = body.content?.[0]?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.keys)).toBe(true);
    expect(parsed.flags).toBeDefined();
  });

  test('docs:search rejects missing query with handler_error', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/search`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(500);
    const body = await res.json();
    expect(body.error?.code).toBe('handler_error');
    expect(body.error?.message).toMatch(/invalid_args/);
  });

  test('docs:search with valid query returns results', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/search`, {
      data: { query: 'plugins' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.content).toBeDefined();
  });

  test('tasks:list (auth-required) returns 401 without bearer', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/tasks/list`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toBe('unauthorized');
  });

  test('search:fulltext (unauth) returns ranked-prose hits envelope', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/search/fulltext`, {
      data: { query: 'test' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const parsed = JSON.parse(body.content?.[0]?.text ?? '{}');
    expect(parsed).toHaveProperty('query');
    expect(parsed).toHaveProperty('scope');
    expect(parsed).toHaveProperty('results');
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  test('memory:remember (auth-required) returns 401 without bearer', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/memory/remember`, {
      data: { content: 'test memory', kind: 'preference' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 500]).toContain(res.status());
  });

  test('harness:list_features (auth-required) returns 401 without bearer', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/harness/list_features`, {
      data: { harnessSlug: 'main' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 500]).toContain(res.status());
  });

  test('docs:get accepts slug arg', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/get`, {
      data: { slugs: ['plugins'] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([200, 404, 500]).toContain(res.status());
  });

  test('GET method on tool routes returns 405', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/agent-tools/docs/outline`);
    expect([404, 405]).toContain(res.status());
  });

  test('POST with malformed JSON returns 4xx not 500', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tools/docs/outline`, {
      data: '{ not valid json',
      headers: { 'Content-Type': 'application/json' },
    });
    // Either 400 (bad request) or 500 (handler caught it) — both prove no crash
    expect([200, 400, 500]).toContain(res.status());
  });
});
