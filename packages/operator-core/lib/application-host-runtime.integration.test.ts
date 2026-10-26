/** Source-host startup proof. Packaged candidate and cutover acceptance are separate. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const interpreters = [{ executable: process.execPath, name: 'node' },
  ...(process.env.PAPERCUSP_RUNTIME_TEST_BUN
    ? [{ executable: process.env.PAPERCUSP_RUNTIME_TEST_BUN, name: 'bun' }] : [])];

describe('isolated application host runtime', () => {
  it.each(interpreters)('$name boots the actual host on private PostgreSQL and releases its runtime', async ({ executable, name }) => {
    // with-test-pg owns the migrated database, HOME, workspace, ports and process
    // group. The controller survives the application so teardown is observable.
    const controller = `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
const [executable, expectedName, retainedNode] = process.argv.slice(1);
assert.match(process.env.PAPERCUSP_WORKSPACE_ID, /^test-runtime-/);
const db = new URL(process.env.HARNESS_ADMIN_DATABASE_URL);
assert.equal(db.port, process.env.PAPERCUSP_PG_PORT);
assert.notEqual(db.port, '5432');
const bin = join(process.env.HOME, 'retained-bin');
mkdirSync(bin);
symlinkSync(retainedNode, join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
const entry = resolve('apps/operator/bin/serve.ts');
// tsx otherwise classifies some source .ts files as CommonJS. The retained
// committed-source loader correctly refuses their rewritten _compile input.
// Resolve source TypeScript as ESM so that loader still judges the RAW source
// before tsx transforms it; keep every inherited enforcement preload intact.
const esmHook = "export async function resolve(specifier, context, next) { const r = await next(specifier, context); return r.url.startsWith('file:') && /[.]tsx?$/.test(r.url) && !r.url.includes('/node_modules/') ? {...r,format:'module'} : r; }";
const esmPreload = 'data:text/javascript,' + encodeURIComponent(
  "import {register} from 'node:module'; register(" +
  JSON.stringify('data:text/javascript,' + encodeURIComponent(esmHook)) + ');');
const child = spawn(executable, [...(expectedName === 'node' ? ['--import', 'tsx', '--import', esmPreload] : []), entry], {
  cwd: process.cwd(), env: { ...process.env, PAPERCUSP_USE_EMBEDDED_PG: '0',
    PAPERCUSP_SIDECAR_BIN: bin, PAPERCUSP_DHT_BOOTSTRAP: '127.0.0.1:1',
    PAPERCUSP_SERVE_UI: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
  output = (output + bytes.toString()).slice(-32000);
});
const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
let admitted = false;
try {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'host exited before readiness: ' + output);
    assert.equal(child.signalCode, null, 'host signaled before readiness: ' + output);
    try {
      const discovery = JSON.parse(readFileSync(join(process.env.PAPERCUSP_HOME, 'operator.json'), 'utf8'));
      assert.equal(discovery.pid, child.pid);
      assert.equal(discovery.port, Number(process.env.PAPERCUSP_HONO_PORT));
      if (process.platform === 'linux') assert.equal(realpathSync('/proc/' + child.pid + '/exe'), realpathSync(executable));
      const response = await fetch(discovery.httpUrl + '/api/health', { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200, 'host health response: ' + output);
      const health = await response.json();
      assert.equal(health.ok, true);
      assert.equal(health.service, 'papercusp-operator');
      admitted = true;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'TimeoutError'
        && !String(error.message).includes('fetch failed')) throw error;
    }
    await delay(200);
  }
  assert.ok(admitted, 'host readiness deadline: ' + output);
  const sql = postgres(db.toString(), { max: 1 });
  try {
    const [row] = await sql\`SELECT current_database() AS name, current_setting('port')::int AS port\`;
    assert.equal(row.name, 'papercusp');
    assert.equal(row.port, Number(db.port));
  } finally { await sql.end(); }
  console.log('APPLICATION_HOST_RUNTIME_READY ' + JSON.stringify({ name: expectedName, pid: child.pid, privatePg: true }));
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let stopped = await Promise.race([closed, delay(10000).then(() => null)]);
  if (!stopped) { child.kill('SIGKILL'); stopped = await closed; }
  assert.ok(stopped, 'application process did not stop');
}
`;
    const { stdout, stderr } = await run(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime', '--', process.execPath, '--input-type=module', '-e', controller,
      executable, name, process.execPath], { cwd: root, env: { ...process.env },
      timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }).catch((error: { code?: string; stdout?: string; stderr?: string }) => {
        throw new Error(`Isolated ${name} host failed (${error.code ?? 'unknown'}):\n${(error.stderr ?? '').slice(-12000)}\n${(error.stdout ?? '').slice(-4000)}`);
      });
    expect(stdout, stderr.slice(-2000)).toContain('APPLICATION_HOST_RUNTIME_READY ');
    const marker = stdout.split('\n').find(line => line.startsWith('APPLICATION_HOST_RUNTIME_READY '))!;
    expect(JSON.parse(marker.slice('APPLICATION_HOST_RUNTIME_READY '.length))).toMatchObject({ name, privatePg: true });
    const cleanup = (stdout + '\n' + stderr).split('\n')
      .filter(line => line.startsWith('[with-test-pg] cleanup '))
      .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)))
      .find(row => row.stage === 'complete');
    expect(cleanup).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
  }, 200_000);
});
