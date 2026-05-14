# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mcp-transport.spec.ts >> MCP transport (/api/mcp) >> tools/call on unknown tool returns error
- Location: e2e/mcp-transport.spec.ts:103:7

# Error details

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → POST http://127.0.0.1:3055/api/mcp
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: application/json, text/event-stream
    - accept-encoding: gzip,deflate,br
    - Content-Type: application/json
    - content-length: 99

```

# Test source

```ts
  4   |  * /api/mcp serves the MCP HTTP protocol per the @modelcontextprotocol/sdk
  5   |  * spec. Two pipelines coexist on the same endpoint:
  6   |  *   - Built-in tools (defineTool catalog)
  7   |  *   - Projected tools (per-spawn signed-URL gated)
  8   |  *
  9   |  * Specs cover the contract that external MCP clients depend on:
  10  |  *   - initialize handshake returns capabilities envelope
  11  |  *   - tools/list works without auth (catalog discovery)
  12  |  *   - tools/call routes to handler and returns content envelope
  13  |  *   - Wrong Accept header is rejected
  14  |  *   - GET on the same path serves the SSE stream (different transport mode)
  15  |  */
  16  | import { test, expect } from '@playwright/test';
  17  | 
  18  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  19  | 
  20  | const MCP_HEADERS = {
  21  |   'Content-Type': 'application/json',
  22  |   Accept: 'application/json, text/event-stream',
  23  | };
  24  | 
  25  | function rpc(method: string, params?: unknown, id: number = 1) {
  26  |   return { jsonrpc: '2.0', method, params: params ?? {}, id };
  27  | }
  28  | 
  29  | async function parseEventStreamOrJson(res: import('@playwright/test').APIResponse) {
  30  |   const ct = res.headers()['content-type'] ?? '';
  31  |   if (ct.includes('text/event-stream')) {
  32  |     const text = await res.text();
  33  |     // SSE format: lines starting with "data: " contain JSON
  34  |     const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));
  35  |     const last = dataLines.at(-1);
  36  |     if (!last) return null;
  37  |     return JSON.parse(last.slice(6));
  38  |   }
  39  |   return res.json();
  40  | }
  41  | 
  42  | test.describe('MCP transport (/api/mcp)', () => {
  43  |   test('initialize returns capabilities envelope', async ({ request }) => {
  44  |     const res = await request.post(`${baseURL}/api/mcp`, {
  45  |       data: rpc('initialize', {
  46  |         protocolVersion: '2025-03-26',
  47  |         capabilities: {},
  48  |         clientInfo: { name: 'playwright-e2e', version: '1.0' },
  49  |       }),
  50  |       headers: MCP_HEADERS,
  51  |     });
  52  |     expect(res.status()).toBe(200);
  53  |     const body = await parseEventStreamOrJson(res);
  54  |     expect(body).toBeTruthy();
  55  |     expect(body.jsonrpc).toBe('2.0');
  56  |     expect(body.result?.protocolVersion).toBeTruthy();
  57  |     expect(body.result?.capabilities).toBeDefined();
  58  |     expect(body.result?.serverInfo?.name).toBeTruthy();
  59  |   });
  60  | 
  61  |   test('tools/list returns tool catalog', async ({ request }) => {
  62  |     const res = await request.post(`${baseURL}/api/mcp`, {
  63  |       data: rpc('tools/list', {}),
  64  |       headers: MCP_HEADERS,
  65  |     });
  66  |     expect(res.status()).toBe(200);
  67  |     const body = await parseEventStreamOrJson(res);
  68  |     expect(body?.result?.tools).toBeDefined();
  69  |     expect(Array.isArray(body.result.tools)).toBe(true);
  70  |     expect(body.result.tools.length).toBeGreaterThan(0);
  71  |     // Each tool has name + description + inputSchema
  72  |     const first = body.result.tools[0];
  73  |     expect(first.name).toBeTruthy();
  74  |     expect(first.inputSchema).toBeDefined();
  75  |   });
  76  | 
  77  |   test('tools/list includes built-in tools like docs:outline', async ({ request }) => {
  78  |     const res = await request.post(`${baseURL}/api/mcp`, {
  79  |       data: rpc('tools/list', {}),
  80  |       headers: MCP_HEADERS,
  81  |     });
  82  |     const body = await parseEventStreamOrJson(res);
  83  |     const names = body.result.tools.map((t: { name: string }) => t.name);
  84  |     expect(names).toContain('docs:outline');
  85  |     expect(names).toContain('docs:search');
  86  |   });
  87  | 
  88  |   test('tools/call on docs:outline returns content envelope', async ({ request }) => {
  89  |     const res = await request.post(`${baseURL}/api/mcp`, {
  90  |       data: rpc('tools/call', {
  91  |         name: 'docs:outline',
  92  |         arguments: {},
  93  |       }),
  94  |       headers: MCP_HEADERS,
  95  |     });
  96  |     expect(res.status()).toBe(200);
  97  |     const body = await parseEventStreamOrJson(res);
  98  |     expect(body.result?.content).toBeDefined();
  99  |     expect(Array.isArray(body.result.content)).toBe(true);
  100 |     expect(body.result.content[0]?.type).toBe('text');
  101 |   });
  102 | 
  103 |   test('tools/call on unknown tool returns error', async ({ request }) => {
> 104 |     const res = await request.post(`${baseURL}/api/mcp`, {
      |                               ^ Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
  105 |       data: rpc('tools/call', {
  106 |         name: 'totally:fake:tool',
  107 |         arguments: {},
  108 |       }),
  109 |       headers: MCP_HEADERS,
  110 |     });
  111 |     expect(res.status()).toBe(200);  // JSON-RPC errors come back as 200 with error envelope
  112 |     const body = await parseEventStreamOrJson(res);
  113 |     expect(body.error || body.result?.isError).toBeTruthy();
  114 |   });
  115 | 
  116 |   test('rejects POST without Accept header for event-stream', async ({ request }) => {
  117 |     const res = await request.post(`${baseURL}/api/mcp`, {
  118 |       data: rpc('initialize', {
  119 |         protocolVersion: '2025-03-26',
  120 |         capabilities: {},
  121 |         clientInfo: { name: 'test', version: '1' },
  122 |       }),
  123 |       headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  124 |     });
  125 |     // Either accepts (200) or rejects (406) — both valid per spec
  126 |     expect([200, 400, 406]).toContain(res.status());
  127 |   });
  128 | 
  129 |   test('resources/list returns resource catalog', async ({ request }) => {
  130 |     const res = await request.post(`${baseURL}/api/mcp`, {
  131 |       data: rpc('resources/list', {}),
  132 |       headers: MCP_HEADERS,
  133 |     });
  134 |     expect(res.status()).toBe(200);
  135 |     const body = await parseEventStreamOrJson(res);
  136 |     expect(body.result?.resources).toBeDefined();
  137 |     expect(Array.isArray(body.result.resources)).toBe(true);
  138 |   });
  139 | 
  140 |   test('prompts/list returns prompt catalog', async ({ request }) => {
  141 |     const res = await request.post(`${baseURL}/api/mcp`, {
  142 |       data: rpc('prompts/list', {}),
  143 |       headers: MCP_HEADERS,
  144 |     });
  145 |     expect(res.status()).toBe(200);
  146 |     const body = await parseEventStreamOrJson(res);
  147 |     expect(body.result?.prompts).toBeDefined();
  148 |     expect(Array.isArray(body.result.prompts)).toBe(true);
  149 |   });
  150 | });
  151 | 
```