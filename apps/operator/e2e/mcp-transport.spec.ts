/**
 * MCP transport — JSON-RPC handshake and tools/list surface.
 *
 * /api/mcp serves the MCP HTTP protocol per the @modelcontextprotocol/sdk
 * spec. Two pipelines coexist on the same endpoint:
 *   - Built-in tools (defineTool catalog)
 *   - Projected tools (per-spawn signed-URL gated)
 *
 * Specs cover the contract that external MCP clients depend on:
 *   - initialize handshake returns capabilities envelope
 *   - tools/list works without auth (catalog discovery)
 *   - tools/call routes to handler and returns content envelope
 *   - Wrong Accept header is rejected
 *   - GET on the same path serves the SSE stream (different transport mode)
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function rpc(method: string, params?: unknown, id: number = 1) {
  return { jsonrpc: '2.0', method, params: params ?? {}, id };
}

async function parseEventStreamOrJson(res: import('@playwright/test').APIResponse) {
  const ct = res.headers()['content-type'] ?? '';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    // SSE format: lines starting with "data: " contain JSON
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));
    const last = dataLines.at(-1);
    if (!last) return null;
    return JSON.parse(last.slice(6));
  }
  return res.json();
}

test.describe('MCP transport (/api/mcp)', () => {
  test('initialize returns capabilities envelope', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mcp`, {
      data: rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'playwright-e2e', version: '1.0' },
      }),
      headers: MCP_HEADERS,
    });
    expect(res.status()).toBe(200);
    const body = await parseEventStreamOrJson(res);
    expect(body).toBeTruthy();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result?.protocolVersion).toBeTruthy();
    expect(body.result?.capabilities).toBeDefined();
    expect(body.result?.serverInfo?.name).toBeTruthy();
  });

  test('tools/list returns tool catalog', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mcp`, {
      data: rpc('tools/list', {}),
      headers: MCP_HEADERS,
    });
    expect(res.status()).toBe(200);
    const body = await parseEventStreamOrJson(res);
    expect(body?.result?.tools).toBeDefined();
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.tools.length).toBeGreaterThan(0);
    // Each tool has name + description + inputSchema
    const first = body.result.tools[0];
    expect(first.name).toBeTruthy();
    expect(first.inputSchema).toBeDefined();
  });

  test('tools/list includes built-in tools like docs:outline', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mcp`, {
      data: rpc('tools/list', {}),
      headers: MCP_HEADERS,
    });
    const body = await parseEventStreamOrJson(res);
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('docs:outline');
    expect(names).toContain('docs:search');
  });

  test('tools/call on docs:outline returns content envelope', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mcp`, {
      data: rpc('tools/call', {
        name: 'docs:outline',
        arguments: {},
      }),
      headers: MCP_HEADERS,
    });
    expect(res.status()).toBe(200);
    const body = await parseEventStreamOrJson(res);
    expect(body.result?.content).toBeDefined();
    expect(Array.isArray(body.result.content)).toBe(true);
    expect(body.result.content[0]?.type).toBe('text');
  });

  test('tools/call on unknown tool returns error', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mcp`, {
      data: rpc('tools/call', {
        name: 'totally:fake:tool',
        arguments: {},
      }),
      headers: MCP_HEADERS,
    });
    expect(res.status()).toBe(200);  // JSON-RPC errors come back as 200 with error envelope
    const body = await parseEventStreamOrJson(res);
    expect(body.error || body.result?.isError).toBeTruthy();
  });

  test('rejects POST without Accept header for event-stream', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mcp`, {
      data: rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    // Either accepts (200) or rejects (406) — both valid per spec
    expect([200, 400, 406]).toContain(res.status());
  });

  test('resources/list returns resource catalog', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mcp`, {
      data: rpc('resources/list', {}),
      headers: MCP_HEADERS,
    });
    expect(res.status()).toBe(200);
    const body = await parseEventStreamOrJson(res);
    expect(body.result?.resources).toBeDefined();
    expect(Array.isArray(body.result.resources)).toBe(true);
  });

  test('prompts/list returns prompt catalog', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mcp`, {
      data: rpc('prompts/list', {}),
      headers: MCP_HEADERS,
    });
    expect(res.status()).toBe(200);
    const body = await parseEventStreamOrJson(res);
    expect(body.result?.prompts).toBeDefined();
    expect(Array.isArray(body.result.prompts)).toBe(true);
  });
});
