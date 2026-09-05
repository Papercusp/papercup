/**
 * WIRING guard for the capability:fetch MCP corrective (EI-20233057540755917).
 *
 * fetch-mcp-hint.test.ts proves the hint FUNCTION discriminates. That is not the
 * same claim as "a caller who hits the 405 actually sees it" — a pure function
 * nothing calls passes its own tests forever. This file drives the REAL tool
 * handler with a stubbed global fetch and asserts the field reaches the emitted
 * JSON, which is the only thing the stuck agent ever reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fetchTool from './fetch';

type ToolResultish = { content: Array<{ text: string }>; isError?: boolean };
type Tool = { handler: (args: unknown, ctx: unknown) => Promise<ToolResultish> };
const capabilityFetch = fetchTool as unknown as Tool;

const MCP_405_BODY = '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}';

function ctx() {
  return {
    workspaceId: 'ws-test',
    stateDir: '/tmp/fetch-mcp-hint-wiring',
    signal: new AbortController().signal,
    emit: () => {},
    role: 'su',
  } as never;
}

function stubFetch(status: number, body: string): void {
  vi.stubGlobal('fetch', async () =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } }),
  );
}

async function run(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await capabilityFetch.handler(args, ctx());
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('capability:fetch emits the MCP corrective on the response', () => {
  it('attaches `next` when a GET to /api/mcp comes back 405', async () => {
    stubFetch(405, MCP_405_BODY);

    const payload = await run({ url: 'http://127.0.0.1:3170/api/mcp?superuser=1' });

    expect(payload.status).toBe(405);
    expect(typeof payload.next).toBe('string');
    expect(payload.next).toMatch(/is up with the route mounted/);
    expect(payload.next).toContain('--port 3170');
    // The verbatim upstream body must still be returned untouched beside it —
    // the hint is metadata, never a rewrite of what the server said.
    expect(payload.body).toBe(MCP_405_BODY);
  });

  it('defaults an omitted method to GET in the corrective it prints', async () => {
    stubFetch(405, MCP_405_BODY);

    const payload = await run({ url: 'http://127.0.0.1:3170/api/mcp' });

    expect(payload.next).toMatch(/^GET \/api\/mcp → 405/);
  });

  it('omits `next` entirely on a successful POST to the same endpoint', async () => {
    stubFetch(200, '{"jsonrpc":"2.0","id":1,"result":{}}');

    const payload = await run({
      url: 'http://127.0.0.1:3170/api/mcp?superuser=1',
      method: 'POST',
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    });

    expect(payload.status).toBe(200);
    // Absent, not null/empty: an ordinary result must not grow a key at all.
    expect('next' in payload).toBe(false);
  });

  it('omits `next` for a 405 on an unrelated route', async () => {
    stubFetch(405, 'nope');

    const payload = await run({ url: 'http://127.0.0.1:3170/api/health' });

    expect(payload.status).toBe(405);
    expect('next' in payload).toBe(false);
  });
});
