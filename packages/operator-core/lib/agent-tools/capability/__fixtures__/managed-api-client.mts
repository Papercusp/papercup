/** Executed only by the canonical MCP e2e suite in the maintained private profile. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAdaptorServer } from '@hono/node-server';

const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
assert(workspace?.startsWith('test-runtime-'), 'Disposable runtime identity required');
assert.equal(process.env.PAPERCUSP_POT_HOME_SLUG, workspace);
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
assert(process.env.PAPERCUSP_EMBED_SIDECAR_URL, 'Maintained operator-api preflight required');
const { handler } = await import('../../../../../../../apps/operator/bin/host-handler.ts');
const { superuserTokenPath } = await import('../../../../superuser-token.ts');
const { getOrgPg } = await import('@papercusp/db-org');
const { setAutoPumpEnabledForTests } = await import('../../../../events/await/engine.ts');
setAutoPumpEnabledForTests(false);
const token = randomBytes(32).toString('hex');
await writeFile(superuserTokenPath(), token, { mode: 0o600, flag: 'wx' });
const server = createAdaptorServer({ fetch: handler });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert(address && typeof address !== 'string');
const clients: Client[] = [];
async function client(owner: string) {
  const url = new URL(`http://127.0.0.1:${address.port}/api/mcp`);
  for (const [key, value] of Object.entries({ superuser: '1', workspace, harness: workspace,
    client: owner, format: 'json' })) url.searchParams.set(key, value);
  const current = new Client({ name: 'managed-parity-private-client', version: '1' });
  clients.push(current);
  await current.connect(new StreamableHTTPClientTransport(url, { requestInit: {
    headers: { Authorization: `Bearer ${token}` },
  } }));
  await current.listTools(); // Establish the current catalog contract on each fresh transport.
  return current;
}
async function invoke(current: Client, name: string, args: Record<string, unknown>) {
  const result: any = await current.callTool({ name: 'tools:invoke', arguments: { name, args } }, undefined,
    { timeout: 45_000 });
  const text = result.content?.find((part: any) => part.type === 'text')?.text;
  assert(text, `Missing result for ${name}`);
  const body = JSON.parse(text);
  assert(!result.isError, JSON.stringify({ name, body }));
  return { result, body };
}
const pageServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><head><title>HTTP managed browser</title></head><body><script>sessionStorage.n=String(Number(sessionStorage.n||0)+1);document.body.textContent="page:"+sessionStorage.n;</script></body></html>');
});
await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve));
const pageAddress = pageServer.address(); assert(pageAddress && typeof pageAddress !== 'string');
const pageUrl = `http://127.0.0.1:${pageAddress.port}/`;
let kernelId: string | undefined; let browserId: string | undefined; let ptyId: string | undefined;
let current: Client | undefined;
try {
  const owner = 'managed-private-parity-owner'; current = await client(owner);
  const opened = (await invoke(current, 'code:run', { kernel: { op: 'open' } })).body;
  assert.equal(opened.ok, true, JSON.stringify(opened)); kernelId = opened.kernel.id;
  await invoke(current, 'code:run', { kernel: { op: 'run', id: kernelId }, script: 'globalThis.count = 2; return ++count;' });
  const browser = (await invoke(current, 'capability:fetch', { url: pageUrl, browser: { op: 'open', screenshot: true } }));
  assert.equal(browser.body.ok, true, JSON.stringify(browser.body)); browserId = browser.body.browser.id;
  assert.equal(browser.body.observation.text, 'page:1');
  assert(browser.result.content.some((part: any) => part.type === 'image' && part.mimeType === 'image/png'));
  const pty = (await invoke(current, 'capability:pty_open', { command: 'cat', cwd: process.env.HOME, cols: 80, rows: 24 })).body;
  assert.equal(pty.ok, true, JSON.stringify(pty)); ptyId = pty.task_id;
  // A separate MCP session must retain handles by authenticated owner/workspace/harness.
  current = await client(owner);
  const retained = (await invoke(current, 'code:run', { kernel: { op: 'run', id: kernelId }, script: 'return ++count;' })).body;
  assert.equal(retained.ok, true, JSON.stringify(retained)); assert.equal(retained.result, 4);
  const observed = (await invoke(current, 'capability:fetch', { browser: { op: 'observe', id: browserId } })).body;
  assert.equal(observed.ok, true, JSON.stringify(observed)); assert.equal(observed.observation.text, 'page:1');
  const navigated = (await invoke(current, 'capability:fetch', { url: pageUrl, browser: { op: 'navigate', id: browserId } })).body;
  assert.equal(navigated.ok, true, JSON.stringify(navigated)); assert.equal(navigated.observation.text, 'page:2');
  assert.equal((await invoke(current, 'capability:pty_write_stdin', { task_id: ptyId, data: 'retained terminal\n' })).body.ok, true);
  assert.equal((await invoke(current, 'capability:pty_resize', { task_id: ptyId, cols: 91, rows: 31 })).body.ok, true);
  const foreign = await client('managed-private-parity-foreign');
  for (const [name, args] of [
    ['code:run', { kernel: { op: 'status', id: kernelId } }],
    ['capability:fetch', { browser: { op: 'close', id: browserId } }],
    ['capability:pty_resize', { task_id: ptyId, cols: 80, rows: 24 }],
  ] as const) {
    const result: any = await foreign.callTool({ name: 'tools:invoke', arguments: { name, args } });
    const text = result.content.find((part: any) => part.type === 'text')?.text;
    assert.equal(JSON.parse(text).ok, false, `Foreign handle accepted by ${name}`);
  }
  assert.equal((await invoke(current, 'capability:fetch', { browser: { op: 'close', id: browserId } })).body.browser.state, 'closed'); browserId = undefined;
  assert.equal((await invoke(current, 'code:run', { kernel: { op: 'close', id: kernelId } })).body.kernel.state, 'closed'); kernelId = undefined;
  assert.equal((await invoke(current, 'capability:pty_kill', { task_id: ptyId })).body.ok, true); ptyId = undefined;
  console.log('MANAGED_API_PROOF=' + JSON.stringify({ transport: 'http', workspace,
    kernel: 'retained-across-clients', browser: 'retained-across-clients', pty: 'retained-across-clients',
    foreignHandles: 'refused', nativeCutover: 'unchanged' }));
} finally {
  if (current) {
    if (browserId) await invoke(current, 'capability:fetch', { browser: { op: 'close', id: browserId } }).catch(() => {});
    if (kernelId) await invoke(current, 'code:run', { kernel: { op: 'close', id: kernelId } }).catch(() => {});
    if (ptyId) await invoke(current, 'capability:pty_kill', { task_id: ptyId }).catch(() => {});
  }
  for (const entry of clients) await entry.close().catch(() => {});
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await new Promise<void>(resolve => pageServer.close(() => resolve()));
  await getOrgPg().sql.end({ timeout: 2 });
}
process.exit(0);
