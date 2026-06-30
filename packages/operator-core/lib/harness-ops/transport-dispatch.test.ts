/**
 * Operator dispatch transport — REAL-server wire contract
 * (`harness-provided-cadence-ops-2026-06-26` P-004 / P-006). `transport.test.ts`
 * covers `harnessApiBase` resolution; THIS exercises `dispatchHarnessOp` /
 * `harnessApiFetch` against an actual HTTP server that mimics the sidecar's
 * `/api/op/:opName` envelope — the cross-repo seam where the contract (200 +
 * `{ok:false}` vs non-2xx, the `{args,ctx}` body) is easy to break. Uses node's
 * http (no extra deps, no oddsmith import) + the env-override endpoint resolution.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { dispatchHarnessOp, harnessEndpointEnvVar } from './transport.js';

const SLUG = 'oddsmith-ops-test';
const ENV = harnessEndpointEnvVar(SLUG);

let server: Server;
let received: { url?: string; method?: string; body?: unknown } = {};
let respond: (req: { args: unknown; ctx: unknown }) => { status: number; body: unknown } = () => ({
  status: 200,
  body: { ok: true, result: {} },
});

beforeEach(async () => {
  received = {};
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      received = { url: req.url, method: req.method, body };
      const { status, body: out } = respond(body as { args: unknown; ctx: unknown });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.env[ENV] = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  delete process.env[ENV];
  await new Promise<void>((r) => server.close(() => r()));
});

describe('dispatchHarnessOp against a real server', () => {
  it('POSTs {args,ctx} to /api/op/<name> and returns the result on {ok:true}', async () => {
    respond = (req) => ({ status: 200, body: { ok: true, result: { echoed: req.args } } });
    const result = await dispatchHarnessOp(SLUG, 'oddsmith:prospect', { limit: 5 }, {
      workspaceId: 'ws-1',
      ctx: { workspaceId: 'ws-1', harnessSlug: SLUG },
    });
    expect(result).toEqual({ echoed: { limit: 5 } });
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/api/op/oddsmith%3Aprospect'); // op name is URL-encoded
    expect(received.body).toEqual({ args: { limit: 5 }, ctx: { workspaceId: 'ws-1', harnessSlug: SLUG } });
  });

  it('throws the harness error message on a 200 {ok:false} envelope (handler fault)', async () => {
    respond = () => ({ status: 200, body: { ok: false, error: 'connector down' } });
    await expect(dispatchHarnessOp(SLUG, 'oddsmith:prospect', {}, {})).rejects.toThrow(/connector down/);
  });

  it('throws on a non-2xx (routing/transport fault — e.g. unknown op 404)', async () => {
    respond = () => ({ status: 404, body: { ok: false, error: "unknown op 'x'" } });
    await expect(dispatchHarnessOp(SLUG, 'x', {}, {})).rejects.toThrow(/404/);
  });

  it('throws on a malformed envelope (missing ok)', async () => {
    respond = () => ({ status: 200, body: { result: 1 } });
    await expect(dispatchHarnessOp(SLUG, 'oddsmith:prospect', {}, {})).rejects.toThrow(/malformed envelope/);
  });
});
