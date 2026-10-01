/**
 * Guard: the MCP SDK that `mcp-handler` actually loads must populate
 * `extra.requestInfo.url` (WI-10005116).
 *
 * Every projected tools/call is authorised from the request URL
 * (`?superuser=1`, `?harness=…`, `?client=…`): `tryBuildSpawnContext` in
 * `_mcp-host.ts` reads it through `urlFromExtra`, which reads
 * `extra.requestInfo.url`. SDK 1.26.0's `WebStandardStreamableHTTPServerTransport`
 * builds `requestInfo = { headers }` only; `url` arrived later. `mcp-handler`
 * declares an EXACT peer pin on `@modelcontextprotocol/sdk@1.26.0`, so a plain
 * `npm install` (which honours peer pins, unlike CI's `--legacy-peer-deps`)
 * hoists 1.26.0 to the root, `mcp-handler` resolves that copy, and every
 * projected call is refused `invalid_request_context` with no other error.
 * The nested 1.31.0 copies inside our own workspaces do not help: the
 * transport is constructed inside `mcp-handler`.
 *
 * This test therefore resolves the SDK FROM `mcp-handler`'s own location (the
 * same resolution Node performs for it) and asserts the real transport hands a
 * URL to `onmessage`. It is behavioural on purpose: a version-string check
 * would pass a future SDK that renamed the field.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { urlFromExtra } from '@papercusp/tooldef-mcp';

interface TransportLike {
  onmessage?: (message: { id?: unknown }, extra?: unknown) => void;
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  handleRequest(req: Request): Promise<Response>;
  close(): Promise<void>;
}

async function loadTransportAsMcpHandlerDoes(): Promise<{
  sdkPath: string;
  Transport: new (opts: Record<string, unknown>) => TransportLike;
}> {
  const fromHere = createRequire(import.meta.url);
  // mcp-handler's `exports` map hides package.json; its main entry resolves to
  // a file inside the package, which gives the same node_modules walk-up.
  const fromHandler = createRequire(fromHere.resolve('mcp-handler'));
  const sdkPath = fromHandler.resolve('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
  const mod = (await import(pathToFileURL(sdkPath).href)) as {
    WebStandardStreamableHTTPServerTransport: new (opts: Record<string, unknown>) => TransportLike;
  };
  return { sdkPath, Transport: mod.WebStandardStreamableHTTPServerTransport };
}

describe('mcp-handler SDK resolution (WI-10005116)', () => {
  it('the transport mcp-handler loads passes the request URL to onmessage', async () => {
    const { sdkPath, Transport } = await loadTransportAsMcpHandlerDoes();
    const transport = new Transport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let seenExtra: unknown;
    transport.onmessage = (message, extra) => {
      seenExtra = extra;
      void transport.send({ jsonrpc: '2.0', id: message.id, result: {} });
    };
    await transport.start();
    try {
      const res = await transport.handleRequest(
        new Request('http://127.0.0.1:3170/api/mcp?superuser=1&client=su-guard', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        }),
      );
      expect(res.status).toBe(200);
      const url = urlFromExtra(seenExtra);
      expect(
        url?.searchParams.get('superuser'),
        `extra.requestInfo.url is missing from the SDK mcp-handler resolves (${sdkPath}). ` +
          'A plain `npm install` honoured mcp-handler\'s exact 1.26.0 peer pin; keep the root ' +
          'package.json override for @modelcontextprotocol/sdk so one modern copy is hoisted.',
      ).toBe('1');
      expect(url?.searchParams.get('client')).toBe('su-guard');
    } finally {
      await transport.close();
    }
  });
});
