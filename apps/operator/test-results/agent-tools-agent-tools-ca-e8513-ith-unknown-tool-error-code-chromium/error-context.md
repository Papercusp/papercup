# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: agent-tools.spec.ts >> agent-tools catch-all routing >> unknown tool returns 404 with unknown_tool error code
- Location: e2e/agent-tools.spec.ts:19:7

# Error details

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
Call log:
  - → POST http://127.0.0.1:3055/api/agent-tools/totally:made:up
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - Content-Type: application/json
    - content-length: 2

```

# Test source

```ts
  1   | /**
  2   |  * Agent-tools HTTP route surface — broad-coverage E2E.
  3   |  *
  4   |  * The 27+ built-in agent-mcp tools auto-mount at /api/agent-tools/<group>/<verb>
  5   |  * via defineTool (PR 0c.D). Each tool's contract is unit-tested at the tool
  6   |  * level; this spec verifies the catch-all routing + auth gate work end-to-end.
  7   |  *
  8   |  * Categories:
  9   |  *  - Unauthenticated reads (docs/outline, flags/list)
  10  |  *  - Authenticated reads (tasks/list, harness/list_features) — 401 without bearer
  11  |  *  - Input validation (zod schema errors return 500 with details)
  12  |  *  - Unknown tool (404 with unknown_tool code)
  13  |  */
  14  | import { test, expect } from '@playwright/test';
  15  | 
  16  | const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';
  17  | 
  18  | test.describe('agent-tools catch-all routing', () => {
  19  |   test('unknown tool returns 404 with unknown_tool error code', async ({ request }) => {
> 20  |     const res = await request.post(`${baseURL}/api/agent-tools/totally:made:up`, {
      |                               ^ Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3055
  21  |       data: {},
  22  |       headers: { 'Content-Type': 'application/json' },
  23  |     });
  24  |     expect(res.status()).toBe(404);
  25  |     const body = await res.json();
  26  |     expect(body.error?.code).toBe('unknown_tool');
  27  |     expect(body.error?.message).toMatch(/No tool at path/);
  28  |   });
  29  | 
  30  |   test('tool name uses colon → slash mapping (docs:outline → /docs/outline)', async ({ request }) => {
  31  |     const colonStyle = await request.post(`${baseURL}/api/agent-tools/docs:outline`, {
  32  |       data: {},
  33  |       headers: { 'Content-Type': 'application/json' },
  34  |     });
  35  |     const slashStyle = await request.post(`${baseURL}/api/agent-tools/docs/outline`, {
  36  |       data: {},
  37  |       headers: { 'Content-Type': 'application/json' },
  38  |     });
  39  |     // colon-style is not a valid HTTP path → 404
  40  |     expect(colonStyle.status()).toBe(404);
  41  |     // slash-style is the canonical path → 200
  42  |     expect(slashStyle.status()).toBe(200);
  43  |   });
  44  | 
  45  |   test('docs:outline (unauth) returns the doc tree', async ({ request }) => {
  46  |     const res = await request.post(`${baseURL}/api/agent-tools/docs/outline`, {
  47  |       data: {},
  48  |       headers: { 'Content-Type': 'application/json' },
  49  |     });
  50  |     expect(res.status()).toBe(200);
  51  |     const body = await res.json();
  52  |     expect(body.content).toBeDefined();
  53  |     expect(Array.isArray(body.content)).toBe(true);
  54  |   });
  55  | 
  56  |   test('flags:list (unauth) returns flag keys + values', async ({ request }) => {
  57  |     const res = await request.post(`${baseURL}/api/agent-tools/flags/list`, {
  58  |       data: {},
  59  |       headers: { 'Content-Type': 'application/json' },
  60  |     });
  61  |     expect(res.status()).toBe(200);
  62  |     const body = await res.json();
  63  |     const text = body.content?.[0]?.text;
  64  |     expect(text).toBeTruthy();
  65  |     const parsed = JSON.parse(text);
  66  |     expect(Array.isArray(parsed.keys)).toBe(true);
  67  |     expect(parsed.flags).toBeDefined();
  68  |   });
  69  | 
  70  |   test('docs:search rejects missing query with handler_error', async ({ request }) => {
  71  |     const res = await request.post(`${baseURL}/api/agent-tools/docs/search`, {
  72  |       data: {},
  73  |       headers: { 'Content-Type': 'application/json' },
  74  |     });
  75  |     expect(res.status()).toBe(500);
  76  |     const body = await res.json();
  77  |     expect(body.error?.code).toBe('handler_error');
  78  |     expect(body.error?.message).toMatch(/invalid_args/);
  79  |   });
  80  | 
  81  |   test('docs:search with valid query returns results', async ({ request }) => {
  82  |     const res = await request.post(`${baseURL}/api/agent-tools/docs/search`, {
  83  |       data: { query: 'plugins' },
  84  |       headers: { 'Content-Type': 'application/json' },
  85  |     });
  86  |     expect(res.status()).toBe(200);
  87  |     const body = await res.json();
  88  |     expect(body.content).toBeDefined();
  89  |   });
  90  | 
  91  |   test('tasks:list (auth-required) returns 401 without bearer', async ({ request }) => {
  92  |     const res = await request.post(`${baseURL}/api/agent-tools/tasks/list`, {
  93  |       data: {},
  94  |       headers: { 'Content-Type': 'application/json' },
  95  |     });
  96  |     expect(res.status()).toBe(401);
  97  |     const body = await res.json();
  98  |     expect(body.error?.code).toBe('unauthorized');
  99  |   });
  100 | 
  101 |   test('search:fulltext (unauth) returns ranked-prose hits envelope', async ({ request }) => {
  102 |     const res = await request.post(`${baseURL}/api/agent-tools/search/fulltext`, {
  103 |       data: { query: 'test' },
  104 |       headers: { 'Content-Type': 'application/json' },
  105 |     });
  106 |     expect(res.status()).toBe(200);
  107 |     const body = await res.json();
  108 |     const parsed = JSON.parse(body.content?.[0]?.text ?? '{}');
  109 |     expect(parsed).toHaveProperty('query');
  110 |     expect(parsed).toHaveProperty('scope');
  111 |     expect(parsed).toHaveProperty('results');
  112 |     expect(Array.isArray(parsed.results)).toBe(true);
  113 |   });
  114 | 
  115 |   test('memory:remember (auth-required) returns 401 without bearer', async ({ request }) => {
  116 |     const res = await request.post(`${baseURL}/api/agent-tools/memory/remember`, {
  117 |       data: { content: 'test memory', kind: 'preference' },
  118 |       headers: { 'Content-Type': 'application/json' },
  119 |     });
  120 |     expect([401, 500]).toContain(res.status());
```