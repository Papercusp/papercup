/** Executed only by the canonical MCP e2e suite in the maintained private profile. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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
const stage = (name: string) => console.log('MANAGED_API_STAGE=' + name);
stage('host-import');
const { handler } = await import('../../../../../../apps/operator/bin/host-handler.ts');
const { superuserTokenPath } = await import('../../../superuser-token.ts');
const { getOrgPg } = await import('@papercusp/db-org');
const { setAutoPumpEnabledForTests } = await import('../../../events/await/engine.ts');
setAutoPumpEnabledForTests(false);
stage('host-ready');
const token = randomBytes(32).toString('hex');
await writeFile(superuserTokenPath(), token, { mode: 0o600, flag: 'wx' });
const server = createAdaptorServer({ fetch: handler });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert(address && typeof address !== 'string');
const clients: Client[] = [];
const owner = 'managed-private-parity-owner';
async function client(owner: string) {
  stage('client-connect:' + owner);
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
async function invoke(current: Client, name: string, args: Record<string, unknown>, expectSuccess = true) {
  stage('invoke:' + name);
  let result: any = await current.callTool({ name: 'tools:invoke', arguments: { name, args } }, undefined,
    { timeout: 45_000 });
  let text = result.content?.find((part: any) => part.type === 'text' && part.text.trim().startsWith('{'))?.text;
  let body = text ? JSON.parse(text) : null;
  if (body?.schemaVersion === 'papercusp.output-envelope/v1') {
    const reference = body.content.find((part: any) => part.uri?.startsWith('papercusp://scratch/'));
    assert(reference, 'Result envelope must carry an owned recovery reference');
    stage('hydrate:' + name);
    const chunks: Buffer[] = []; let cursor: Record<string, unknown> | null = { uri: reference.uri, byte_offset: 0, byte_limit: 2048 };
    let offset = 0;
    for (let pages = 0; cursor && pages < 64; pages++) {
      // The direct read door propagates its recovery-page accounting mode.
      // A tools:invoke wrapper is a different outer tool and spends the cohort.
      const read: any = await current.callTool({ name: 'capability:read', arguments: cursor });
      const page = JSON.parse(read.content.find((part: any) => part.type === 'text').text);
      assert.equal(page.ok, true, JSON.stringify(page)); assert.equal(page.encoding, 'base64');
      const bytes = Buffer.from(page.data, 'base64');
      assert.equal(bytes.toString('base64'), page.data); assert.equal(bytes.length, page.byte_length);
      assert.equal(page.byte_offset, offset); chunks.push(bytes); offset += bytes.length;
      cursor = page.next_cursor?.args ?? null;
      if (!cursor) { assert.equal(page.eof, true); assert.equal(offset, page.total_bytes); }
    }
    assert.equal(cursor, null, 'Reference paging must reach EOF within its bound');
    const bytes = Buffer.concat(chunks);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
    result = JSON.parse(bytes.toString('utf8'));
    text = result.content.find((part: any) => part.type === 'text' && part.text.trim().startsWith('{'))?.text;
    body = text ? JSON.parse(text) : null;
  }
  if (expectSuccess) assert(!result.isError, JSON.stringify({ name, body }));
  stage('settled:' + name);
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
  current = await client(owner);
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
  const { result: screen } = await invoke(current, 'capability:pty_read_screen', { task_id: ptyId });
  const resource = screen.content.find((part: any) => part.type === 'resource')?.resource;
  assert.equal(resource?.mimeType, 'application/x-papercusp-pty-screen+ansi');
  assert(resource.text.includes('retained terminal'));
  const foreign = await client('managed-private-parity-foreign');
  for (const [name, args] of [
    ['code:run', { kernel: { op: 'status', id: kernelId } }],
    ['capability:fetch', { browser: { op: 'close', id: browserId } }],
    ['capability:pty_resize', { task_id: ptyId, cols: 80, rows: 24 }],
  ] as const) {
    const { body } = await invoke(foreign, name, args, false);
    assert.equal(body?.ok, false, `Foreign handle accepted by ${name}`);
  }
  assert.equal((await invoke(current, 'capability:fetch', { browser: { op: 'close', id: browserId } })).body.browser.state, 'closed'); browserId = undefined;
  assert.equal((await invoke(current, 'code:run', { kernel: { op: 'close', id: kernelId } })).body.kernel.state, 'closed'); kernelId = undefined;
  assert.equal((await invoke(current, 'capability:pty_kill', { task_id: ptyId })).body.ok, true); ptyId = undefined;
  console.log('MANAGED_API_PROOF=' + JSON.stringify({ transport: 'http', workspace,
    kernel: 'retained-across-clients', browser: 'retained-across-clients', pty: 'retained-across-clients',
    foreignHandles: 'refused' }));
} finally {
  if (current) {
    if (browserId) await invoke(current, 'capability:fetch', { browser: { op: 'close', id: browserId } }).catch(() => {});
    if (kernelId) await invoke(current, 'code:run', { kernel: { op: 'close', id: kernelId } }).catch(() => {});
    if (ptyId) await invoke(current, 'capability:pty_kill', { task_id: ptyId }).catch(() => {});
  }
  // A lost reply can hide a successfully opened handle. Drain the exact private
  // owner's ledger rows before PostgreSQL goes away, rather than losing receipts.
  const { getTask } = await import('../../../task-manager/store.ts');
  const { killTask } = await import('../../../task-manager/control.ts');
  const { cleanupEndedBrowserDirectory } = await import('../../../task-manager/reconcile-tick.ts');
  const { readProcessIdentity } = await import('../../../process-identity.ts');
  const rows = await getOrgPg().sql`SELECT task_id FROM harness_shared.task_ledger
    WHERE workspace_id = ${workspace} AND launched_by = ${owner} AND class IN ('browser', 'pty')`;
  for (const entry of rows) {
    const row = await getTask(entry.task_id);
    if (!row) continue;
    if (row.pid && readProcessIdentity(row.pid) === row.processIdentity) {
      const killed = await killTask(row.taskId); assert(killed.ok, JSON.stringify(killed));
    }
    await cleanupEndedBrowserDirectory(row);
  }
  for (const entry of clients) await entry.close().catch(() => {});
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await new Promise<void>(resolve => pageServer.close(() => resolve()));
  await getOrgPg().sql.end({ timeout: 2 });
}
process.exit(0);
