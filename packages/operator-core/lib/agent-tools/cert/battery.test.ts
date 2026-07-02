/**
 * cert:run / cert:catalog tool tests (WI-1659). cert:catalog is pure (reads the
 * static CERTIFIED_CATALOG, no I/O) — tested directly. cert:run is tested END-TO-END
 * against a real local HTTP server standing in for a served OpenAI-compatible backend,
 * exercising the REAL cert-battery library (no battery/probe mocking) so the tool
 * wrapper's wiring (config resolution, backendId lookup, error paths) is genuinely
 * proven, not just its own glue code.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/cert/battery.test.ts
 */
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { certRunTool, certCatalogTool } from './battery';
import { CERTIFIED_CATALOG } from '../../provisioner/catalog';

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  vi.doUnmock('../../inference-gateway/local-backend-store');
  vi.resetModules();
});

const body = (o: unknown) => JSON.parse((o as { content: { text: string }[] }).content[0]!.text);

interface Req {
  messages: { role: string; content: string }[];
  tools?: { function: { name: string } }[];
}

/** A compliant fake backend: replies to each of the 4 probes' request shapes so the
 *  REAL cert-battery certifies against it (verdict: 'certified'). */
function startCompliantBackend(): Promise<number> {
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const parsed = JSON.parse(raw) as Req;
      const toolNames = (parsed.tools ?? []).map((t) => t.function.name);
      let message: { content: string | null; tool_calls?: unknown[] };
      if (toolNames.includes('handoff')) {
        message = { content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'handoff', arguments: JSON.stringify({ token: 'ORN-7F3A', note: 'go' }) } }] };
      } else if (toolNames.includes('consume')) {
        message = { content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'consume', arguments: JSON.stringify({ token: 'ORN-7F3A' }) } }] };
      } else if (toolNames.includes('emit_finding')) {
        message = { content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'emit_finding', arguments: JSON.stringify({ summary: 'ok', count: 1 }) } }] };
      } else {
        // no tools offered → the behavior probe
        message = { content: JSON.stringify({ count: 3, first: 'alpha' }) };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
    });
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port)));
}

test('cert:catalog with no id returns the full CERTIFIED_CATALOG', async () => {
  const r = body(await certCatalogTool.handler({} as never, {} as never));
  assert.equal(r.ok, true);
  assert.equal(r.count, CERTIFIED_CATALOG.length);
  assert.deepEqual(
    r.catalog.map((e: { id: string }) => e.id),
    CERTIFIED_CATALOG.map((e) => e.id),
  );
});

test('cert:catalog with a known id returns that entry', async () => {
  const known = CERTIFIED_CATALOG[0]!;
  const r = body(await certCatalogTool.handler({ id: known.id } as never, {} as never));
  assert.equal(r.ok, true);
  assert.equal(r.entry.id, known.id);
  assert.equal(r.entry.status, known.status);
});

test('cert:catalog with an unknown id fails soft and lists known ids', async () => {
  const r = body(await certCatalogTool.handler({ id: 'not-a-real-entry' } as never, {} as never));
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes('not-a-real-entry'));
  assert.deepEqual(r.knownIds, CERTIFIED_CATALOG.map((e) => e.id));
});

test('cert:run against an explicit baseUrl+backend certifies a compliant backend end-to-end', async () => {
  const port = await startCompliantBackend();
  const r = body(
    await certRunTool.handler(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        backend: 'llama-server',
        model: 'test-model',
        quant: 'IQ3_M',
        numCtx: 4096,
        parallel: 1,
        timeoutMs: 5000,
      } as never,
      {} as never,
    ),
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.report.verdict, 'certified');
  assert.equal(r.report.config.model, 'test-model');
  assert.equal(r.report.config.backend, 'llama-server');
  assert.equal(r.report.manglingRate, 0);
  assert.equal(r.report.probes.length, 4);
  assert.ok(r.report.probes.every((p: { passed: boolean; critical: boolean }) => !p.critical || p.passed));
});

test('cert:run resolves a registered backendId to its baseUrl/kind before running', async () => {
  const port = await startCompliantBackend();
  vi.doMock('../../inference-gateway/local-backend-store', async () => {
    const actual = await vi.importActual<typeof import('../../inference-gateway/local-backend-store')>(
      '../../inference-gateway/local-backend-store',
    );
    return {
      ...actual,
      listLocalBackends: vi.fn(async () => [
        { id: 'my-backend', kind: 'vllm', baseUrl: `http://127.0.0.1:${port}`, models: ['test-model'], maxConcurrent: 4, enabled: true, createdAt: '', updatedAt: '' },
      ]),
    };
  });
  const { certRunTool: freshTool } = await import('./battery');
  const r = body(await freshTool.handler({ backendId: 'my-backend', model: 'test-model' } as never, {} as never));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.report.config.backend, 'vllm');
  assert.equal(r.report.verdict, 'certified');
});

test('cert:run fails soft on an unknown backendId (no such registration)', async () => {
  vi.doMock('../../inference-gateway/local-backend-store', async () => {
    const actual = await vi.importActual<typeof import('../../inference-gateway/local-backend-store')>(
      '../../inference-gateway/local-backend-store',
    );
    return { ...actual, listLocalBackends: vi.fn(async () => []) };
  });
  const { certRunTool: freshTool } = await import('./battery');
  const r = body(await freshTool.handler({ backendId: 'nope', model: 'test-model' } as never, {} as never));
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes('nope'));
});

test('cert:run args schema requires either backendId, or baseUrl+backend together', () => {
  assert.equal(certRunTool.args.safeParse({ model: 'x' }).success, false, 'neither backendId nor baseUrl+backend');
  assert.equal(certRunTool.args.safeParse({ model: 'x', baseUrl: 'http://x' }).success, false, 'baseUrl without backend');
  assert.equal(certRunTool.args.safeParse({ model: 'x', backendId: 'b' }).success, true);
  assert.equal(certRunTool.args.safeParse({ model: 'x', baseUrl: 'http://x', backend: 'ollama' }).success, true);
});
