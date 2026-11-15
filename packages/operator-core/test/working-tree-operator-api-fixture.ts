/**
 * Generic working-tree operator-API runner (WI-6554700010048234).
 *
 * Runs ONLY inside `scripts/with-test-pg.mjs --isolated-runtime=operator-api`
 * (launched by `scripts/operator-api-working-tree.mjs` or its integration
 * suite). It bundles the Hono host from the CURRENT WORKING TREE — uncommitted
 * edits included — boots it on the runtime's private port against the
 * disposable migrated PG, ALWAYS runs an MCP probe (tools/list plus one
 * coord:whoami call), then — when given — the caller command after `--`
 * (with PAPERCUSP_OPERATOR_URL / PAPERCUSP_OPERATOR_MCP_URL /
 * PAPERCUSP_OPERATOR_BEARER exported). The host is always stopped. One
 * `WORKING_TREE_OPERATOR_API_RECEIPT {json}` line reports what was measured.
 *
 * Reuses the same private-host helpers as the per-suite HTTP fixtures; it adds
 * no launcher of its own.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildPrivateOperatorApiBundle, privateOperatorApiBuildBudget, privateBundleRuntimeEnv, stopPrivateOperatorHost,
  waitForPrivateOperator } from './private-http-workspace-preflight';
import { readProcessIdentity } from '../lib/process-identity';

const RECEIPT_PREFIX = 'WORKING_TREE_OPERATOR_API_RECEIPT ';
const LIVE_OPERATOR_PORTS = [3055, 3070, 3170, 3271];
const PROBE_TOOL_NAMES = ['coord_whoami', 'coord:whoami'];

function privateMcpUrl(base: string, workspace: string): URL {
  const url = new URL('/api/mcp', base);
  for (const [key, value] of Object.entries({ superuser: '1', workspace,
    client: 'working-tree-operator-api', format: 'json', structured: '1' })) url.searchParams.set(key, value);
  return url;
}

async function probeMcp(url: URL, headers: Record<string, string>, token: string) {
  const client = new Client({ name: 'working-tree-operator-api-probe', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url,
      { requestInit: { headers: { ...headers, Authorization: `Bearer ${token}` } } }), { timeout: 30_000 });
    const listing = await client.listTools(undefined, { timeout: 30_000 });
    const tool = listing.tools.find(({ name }) => PROBE_TOOL_NAMES.includes(name));
    assert.ok(tool, 'private operator did not list coord:whoami; first tools: '
      + listing.tools.slice(0, 20).map(({ name }) => name).join(', '));
    const result = await client.callTool({ name: tool.name, arguments: {} }, undefined, { timeout: 30_000 });
    assert.notEqual(result.isError, true, `${tool.name} failed: ${JSON.stringify(result).slice(0, 2_000)}`);
    return { toolCount: listing.tools.length, calledTool: tool.name, calledToolOk: true };
  } finally {
    await client.close();
  }
}

function runCaller(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', fail);
    child.once('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID ?? '';
  assert.match(workspace, /^test-runtime-/,
    'run only inside scripts/with-test-pg.mjs --isolated-runtime=operator-api (use scripts/operator-api-working-tree.mjs)');
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  const base = e.PAPERCUSP_OPERATOR_URL ?? '';
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(!LIVE_OPERATOR_PORTS.includes(Number(new URL(base).port)), `refusing a live operator port: ${base}`);
  const evidenceDir = e.WORKING_TREE_OPERATOR_API_EVIDENCE_DIR ?? '';
  assert.ok(evidenceDir, 'WORKING_TREE_OPERATOR_API_EVIDENCE_DIR is required');
  const separator = process.argv.indexOf('--');
  const caller = separator >= 0 ? process.argv.slice(separator + 1) : [];
  const root = resolve(import.meta.dirname, '../../..');
  // The desktop installer normally provisions the superuser bearer. The
  // isolated runtime's PAPERCUSP_HOME starts empty, so mint a private one
  // before the host boots — never in the real ~/.papercusp ('wx' also refuses
  // to overwrite an existing token).
  const papercuspHome = e.PAPERCUSP_HOME ?? '';
  assert.ok(papercuspHome && resolve(papercuspHome) !== resolve(userInfo().homedir, '.papercusp'),
    `refusing to provision a bearer outside the isolated runtime home: ${papercuspHome || '(unset)'}`);
  const { readSuperuserToken, isValidSuperuserBearer, superuserTokenPath } = await import('../lib/superuser-token');
  assert.equal(superuserTokenPath(), join(papercuspHome, 'superuser-token'));
  mkdirSync(papercuspHome, { recursive: true, mode: 0o700 });
  writeFileSync(superuserTokenPath(), randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  let host: ChildProcess | undefined;
  try {
    // A working tree is dirty by definition: opt in to a content-addressed
    // snapshot commit as the bundle's source identity (bundle-host-common.sh),
    // so the private MCP surface has an attributable serving generation.
    const { path: bundle, sha256: bundleSha256 } = await buildPrivateOperatorApiBundle(root, evidenceDir,
      { ...privateOperatorApiBuildBudget(), env: { ...e, PAPERCUSP_BUNDLE_SNAPSHOT_DIRTY: '1' } });
    const hostEnv = privateBundleRuntimeEnv({ ...e });
    host = spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout!.on('data', chunk => process.stdout.write(chunk));
    host.stderr!.on('data', chunk => process.stderr.write(chunk));
    const hostIdentity = readProcessIdentity(host.pid!);
    assert.ok(hostIdentity);
    await waitForPrivateOperator({ host, base, evidenceDir, hostIdentity, environment: hostEnv });
    const healthResponse = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(15_000) });
    const health = await healthResponse.json() as { service?: string; sha?: string };
    // Peers keep editing the shared tree, so the label is honest only if every
    // compiler input still had the snapshot's bytes when esbuild finished.
    // bundle-host.sh fences that right after esbuild (rebuilding on a race) and
    // publishes the receipt beside the bundle; a fence run here would compare
    // against the LIVE tree and false-fail on edits made after the build.
    assert.ok(typeof health.sha === 'string' && /^[a-f0-9]{7,64}$/.test(health.sha),
      `working-tree bundle serves no attributable source sha: ${String(health.sha)}`);
    const fence = JSON.parse(readFileSync(`${bundle}.snapshot-fence.json`, 'utf8')) as
      { sha?: string; checked?: number; skipped?: number; mismatches?: string[] };
    assert.equal(fence.sha, health.sha, 'snapshot fence receipt names a different source than the served bundle');
    assert.ok((fence.checked ?? 0) > 0, 'snapshot fence compared no compiler inputs');
    assert.deepEqual(fence.mismatches, [], 'snapshot fence receipt records moved compiler inputs');
    const sourceSnapshot = { sha: health.sha, checked: fence.checked, skipped: fence.skipped };
    const token = readSuperuserToken();
    assert.ok(token && isValidSuperuserBearer(token), 'private operator bearer is unavailable');
    const mcpUrl = privateMcpUrl(base, workspace);
    const headers = { origin: base, 'x-papercusp-workspace': workspace };
    // Always prove the MCP surface (tools/list + one coord:whoami call) before
    // any caller runs, so every receipt carries real MCP evidence and a broken
    // MCP surface fails here with a named tool, not inside the caller.
    const probe = await probeMcp(mcpUrl, headers, token);
    const callerExit = caller.length === 0 ? null : await runCaller(caller,
      e.WORKING_TREE_OPERATOR_API_CALLER_CWD || root, { ...e, PAPERCUSP_OPERATOR_URL: base,
        PAPERCUSP_OPERATOR_MCP_URL: mcpUrl.href, PAPERCUSP_OPERATOR_BEARER: token });
    await stopPrivateOperatorHost(host);
    const hostStopped = readProcessIdentity(host.pid!) !== hostIdentity;
    host = undefined;
    console.log(RECEIPT_PREFIX + JSON.stringify({ workspace, base, bundleSha256,
      health: { service: health.service ?? null, sha: health.sha ?? null }, mode: caller.length === 0 ? 'mcp-probe' : 'caller',
      sourceSnapshot, probe, callerExit, hostStopped }));
    if (callerExit !== null && callerExit !== 0) process.exitCode = callerExit;
  } finally {
    if (host) await stopPrivateOperatorHost(host);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
