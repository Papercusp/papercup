#!/usr/bin/env node
/**
 * with-test-pg — run a command against a THROWAWAY, fully-migrated Postgres.
 *
 *   node scripts/with-test-pg.mjs -- node scripts/affected-tests.mjs --all
 *
 * Why this exists (WI-123's other half): ~30 "unit"-tier suites never touch PG
 * directly, but the app code they import resolves a pool through
 * libs/papercusp/libs/db/src/connection.ts. With no env set that chain lands on the
 * native `localhost:5432/papercusp`. CI already papers over this by running a
 * postgres service container + scripts/ci-provision-pg.mjs ("dev-box parity"); a dev
 * box papers over it by happening to run native PG. A PACKAGED install has neither,
 * so those suites ECONNREFUSE there — ~200 reds that are pure environment, not defects.
 *
 * This gives any host the same parity without a service container: the packaged app
 * already ships the PG binaries (@embedded-postgres/*) and all the migrations, so we
 * boot our own postmaster on a free port, into a temp datadir, and point the child at
 * it by env.
 *
 * It is deliberately NOT the product's embedded PG. That one holds the user's real
 * pot; a test suite must never open a pool against it. We pass explicit
 * HARNESS_*_DATABASE_URL (step 1 of the resolution chain, so it beats both the
 * discovery file and the native fallback) and the unit layer additionally pins
 * PAPERCUSP_SKIP_PG_DISCOVERY=1 (libs/test-config/src/setup-hermetic-env.ts).
 *
 * Teardown is best-effort but unconditional: the postmaster is stopped and the temp
 * datadir removed on normal exit, on a failing child, and on SIGINT/SIGTERM.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, stat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, existsSync, readFileSync } from 'node:fs';
import AsyncExitHook from 'async-exit-hook';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePapercuspTmpdir, tmpdirHasCriticalHeadroom } from '../libs/test-config/src/tmpdir-guard.ts';
import { browserCachePath } from './ensure-playwright-browsers.mjs';
import { defaultEvidenceRoot } from '../libs/generic/verification-harness/src/evidence-root.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sep = process.argv.indexOf('--');
const cmd = sep >= 0 ? process.argv.slice(sep + 1) : [];
const options = sep >= 0 ? process.argv.slice(2, sep) : process.argv.slice(2);
const operatorApi = options.length === 1 && options[0] === '--isolated-runtime=operator-api';
const isolatedRuntime = operatorApi || (options.length === 1 && options[0] === '--isolated-runtime');
if (cmd.length === 0 || (options.length > 0 && !isolatedRuntime)) {
  console.error('usage: node scripts/with-test-pg.mjs [--isolated-runtime[=operator-api]] -- <command> [args...]');
  process.exit(2);
}

// Evidence must outlive the private database. Require an explicit reporter-only
// sink before bootstrapping when the caller asks for durable ledger receipts.
// Never derive it from a product URL or silently claim a private insert survived.
if (isolatedRuntime && (process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE?.trim() ||
    process.env.PC_EXECUTED_SOURCE_MAP_RESULT?.trim()) && !process.env.PAPERCUSP_TEST_RUNS_DB_URL?.trim()) {
  console.error('[with-test-pg] evidence preflight failed: PAPERCUSP_TEST_RUNS_DB_URL is required for durable isolated test receipts');
  process.exit(1);
}

// spawn below runs from ROOT. Resolve that SAME executable before allocating
// or migrating Postgres, and pin the path used by spawn. A package-relative
// command must not burn an entire bootstrap before discovering ENOENT.
try {
  const candidates = /[/\\]/.test(cmd[0]) ? [resolve(ROOT, cmd[0])] :
    (process.env.PATH ?? '').split(delimiter).map(dir => resolve(ROOT, dir, cmd[0]));
  let executable;
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      executable = candidate;
      break;
    } catch { /* try the next PATH entry */ }
  }
  if (!executable) throw new Error('child executable is missing or not executable from repository root: ' + cmd[0]);
  cmd[0] = executable;
} catch (error) {
  console.error('[with-test-pg] child preflight failed: ' + error.message);
  process.exit(1);
}

/** The migrations dir: the monorepo path, else the packaged sidecar's copy. */
function resolveSqlDir() {
  const candidates = [
    join(ROOT, 'libs/papercusp/libs/db/sql'),
    join(ROOT, 'sidecar/db-sql'),
    process.env.PAPERCUSP_PG_SQL_DIR,
  ].filter(Boolean);
  const hit = candidates.find((d) => existsSync(d));
  if (!hit) throw new Error(`no migrations dir found (looked in: ${candidates.join(', ')})`);
  return hit;
}

/** Ask the OS for a free TCP port. Never hardcode 5432 — that is the host's own PG. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const { startEmbeddedPostgresServer } = await import(
  '../libs/papercusp/packages/embedded-postgres-server/src/index.js'
);

// Reuse the test launcher's capacity policy before initdb or migration writes.
ensurePapercuspTmpdir();
if (!tmpdirHasCriticalHeadroom(tmpdir())) {
  throw new Error('private Postgres storage preflight failed: no temporary volume has critical headroom');
}
const dataDir = await mkdtemp(join(tmpdir(), 'papercusp-test-pg-'));
const runtimeRoot = isolatedRuntime ? await mkdtemp(join(tmpdir(), 'papercusp-test-runtime-')) : null;
const runtimeId = isolatedRuntime ? `test-runtime-${randomUUID().slice(0, 12)}` : null;
const port = await freePort();
const sqlDir = resolveSqlDir();

let pg = null;
let profileProcess = null;
let child = null;
let cleanupPromise = null;
let terminatingSignal = null;
let cleanupStartedAt = null;
function cleanupStage(stage, detail = {}) {
  if (!isolatedRuntime || process.env.PC_ISOLATED_RUNTIME_PROOF !== '1') return;
  const message = { kind: 'isolated-runtime-cleanup', stage,
    elapsedMs: Date.now() - cleanupStartedAt, ...detail };
  console.log('[with-test-pg] cleanup ' + JSON.stringify(message));
  if (process.connected && process.send) return new Promise(done => process.send(message, done));
}
function observePrivatePgStop() {
  if (!isolatedRuntime || process.env.PC_ISOLATED_RUNTIME_PROOF !== '1' || process.platform !== 'linux') return () => {};
  let postmasterPid;
  let postmasterStart;
  const stat = pid => {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(/\s+/);
    return { state: fields[0], parentPid: Number(fields[1]), startTicks: fields[19] };
  };
  try {
    const record = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n');
    postmasterPid = Number(record[0]);
    const pin = stat(postmasterPid);
    if (record[1] !== dataDir || Number(record[3]) !== port || pin.parentPid !== process.pid) {
      throw new Error('private postmaster identity does not match owned runtime');
    }
    postmasterStart = pin.startTicks;
  } catch (error) {
    cleanupStage('pg-stop-observation-unavailable', { error: error.message });
    return () => {};
  }
  const sample = () => {
    try {
      if (stat(postmasterPid).startTicks !== postmasterStart) throw new Error('private postmaster lifetime ended');
      const descendants = readFileSync(`/proc/${postmasterPid}/task/${postmasterPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
      const processes = [postmasterPid, ...descendants].map(pid => {
        try {
          const pin = stat(pid);
          if (pid !== postmasterPid && pin.parentPid !== postmasterPid) throw new Error('PG child reparented');
          const io = Object.fromEntries(readFileSync(`/proc/${pid}/io`, 'utf8').trim().split('\n').map(line => line.split(':').map(s => s.trim())));
          return { pid, ...pin, command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(),
            waitChannel: readFileSync(`/proc/${pid}/wchan`, 'utf8').trim(), io };
        } catch (error) { return { pid, unavailable: error.message }; }
      });
      cleanupStage('pg-stop-observation', { processes });
    } catch (error) { cleanupStage('pg-stop-observation-unavailable', { error: error.message }); }
  };
  sample();
  const timer = setInterval(sample, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
async function cleanup() {
  // Signals and failed bootstrap may converge here. Every caller waits for
  // the same cleanup rather than mistaking "started" for "finished".
  return cleanupPromise ??= cleanupOwnedState();
}
async function cleanupOwnedState() {
  cleanupStartedAt = Date.now();
  cleanupStage('start');
  if (profileProcess && profileProcess.exitCode === null && profileProcess.signalCode === null) {
    cleanupStage('profile-stop', { pid: profileProcess.pid });
    const exited = new Promise((res) => profileProcess.once('exit', res));
    try { process.kill(-profileProcess.pid, 'SIGTERM'); } catch { /* already exited */ }
    await Promise.race([exited, new Promise((res) => setTimeout(res, 5000))]);
    if (profileProcess.exitCode === null && profileProcess.signalCode === null) {
      try { process.kill(-profileProcess.pid, 'SIGKILL'); } catch { /* already exited */ }
      await exited;
    }
  }
  const stopObserving = observePrivatePgStop();
  try {
    cleanupStage('pg-stop', { health: pg?.health() ?? null });
    await pg?.stop();
    cleanupStage('pg-stopped');
  } catch (error) {
    cleanupStage('pg-stop-error', { error: error?.message ?? String(error) });
    /* best effort — we still want the datadir gone */
  } finally { stopObserving(); }
  cleanupStage('remove-private-state');
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
  await cleanupStage('complete', { runtimeRemoved: !runtimeRoot || !existsSync(runtimeRoot), pgDataRemoved: !existsSync(dataDir) });
}

// Maintained integration callers fork a dedicated process group. That group
// includes initdb, whose dependency does not expose a process handle. Verify
// ownership before signalling it; an ordinary CLI never targets its parent's
// group. Every isolated CLI owns its private cleanup, even when it shares the
// caller's group. Replace the dependency's signal-exit hook for both routes:
// it otherwise exits while startup/cleanup is still pending. Group ownership
// controls only whether we may signal the supervisor's entire process group.
const ownProcessGroup = isolatedRuntime && process.platform === 'linux' &&
  Number(readFileSync('/proc/self/stat', 'utf8').split(')').slice(1).join(')').trim().split(/\s+/)[2]) === process.pid;
if (isolatedRuntime) {
  for (const sig of ['SIGINT', 'SIGTERM']) AsyncExitHook.unhookEvent(sig);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (terminatingSignal) return;
    terminatingSignal = sig;
    if (ownProcessGroup) {
      // The repeated signal to this supervisor is ignored by the guard above;
      // its exact owned initdb/postmaster descendants receive it as well.
      // PG's maintained stop() uses SIGINT (fast shutdown). SIGTERM requests
      // smart shutdown and waits for our still-running migration connection.
      try { process.kill(-process.pid, 'SIGINT'); } catch { /* group already exited */ }
    }
    if (profileProcess?.pid) {
      try { process.kill(-profileProcess.pid, sig); } catch { /* already exited */ }
    }
    if (child?.pid) {
      if (isolatedRuntime) {
        try { process.kill(-child.pid, sig); } catch { /* already exited */ }
      } else child.kill(sig);
    }
  });
}
function assertNotTerminating() {
  if (terminatingSignal) throw new Error(`private runtime cancelled during bootstrap: ${terminatingSignal}`);
}

async function main() {
console.log(`[with-test-pg] booting throwaway PG on :${port} (datadir ${dataDir})`);
console.log(`[with-test-pg] migrations: ${sqlDir}`);

pg = await startEmbeddedPostgresServer({ dataDir, port, dbSqlDir: sqlDir,
  // Every fixture client uses its explicit TCP URL. Avoid an unused socket
  // lock on /tmp, which may be full even when the private data volume is ready.
  extraPostgresSettings: { unix_socket_directories: '' },
  onLog: message => {
    // Preserve boot/migration progress as well as shutdown. A deadline before
    // start() returns otherwise erases the stage that actually consumed it.
    console.log('[with-test-pg] pg ' + String(message));
    if (!child && cleanupStartedAt === null && process.env.PC_ISOLATED_RUNTIME_PROOF === '1' && process.connected) {
      const text = String(message);
      const migration = text.match(/^apply ([\w.-]+\.sql)$/)?.[1];
      const stage = text.startsWith('initialising data dir') ? 'initdb'
        : text.includes('syncing data to disk') ? 'initdb:sync'
        : text.startsWith('starting postgres on ') ? 'postmaster'
        : text.startsWith('creating database ') ? 'database'
        : migration ? 'migration:' + migration : null;
      if (stage) process.send({ kind: 'isolated-runtime-bootstrap-progress', stage }, () => {});
    }
    if (cleanupStartedAt !== null) cleanupStage('pg-log', { message });
} });
assertNotTerminating();
console.log(`[with-test-pg] ready — ${pg.urls.admin.replace(/:[^:@]*@/, ':***@')}`);

let runtimeEnv = {};
if (runtimeRoot && runtimeId) {
  const home = join(runtimeRoot, 'home');
  const papercuspHome = join(home, '.papercusp');
  const workspacesRoot = join(runtimeRoot, 'workspaces');
  await Promise.all([
    mkdir(papercuspHome, { recursive: true }),
    mkdir(join(workspacesRoot, runtimeId), { recursive: true }),
    mkdir(join(runtimeRoot, 'xdg-runtime'), { recursive: true, mode: 0o700 }),
    mkdir(join(runtimeRoot, 'tmp'), { recursive: true }),
  ]);
  assertNotTerminating();
  await writeFile(join(workspacesRoot, 'registry.json'), JSON.stringify({
    current: runtimeId,
    workspaces: [{ id: runtimeId, name: 'Disposable background test', createdAt: Date.now() }],
  }), { mode: 0o600 });
  const httpPort = await freePort();
  const ptyPort = await freePort();
  assertNotTerminating();
  if (httpPort === ptyPort || httpPort === port || ptyPort === port) {
    console.error('[with-test-pg] isolated runtime port collision — refusing to launch');
    await cleanup();
    process.exit(1);
  }
  runtimeEnv = {
    HOME: home,
    PAPERCUSP_HOME: papercuspHome,
    PAPERCUSP_IDENTITY_DIR: join(papercuspHome, 'identity'),
    PAPERCUSP_WORKSPACES_ROOT: workspacesRoot,
    PAPERCUSP_WORKSPACE: runtimeId,
    PAPERCUSP_WORKSPACE_ID: runtimeId,
    PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${httpPort}`,
    PAPERCUSP_API_BASE: `http://127.0.0.1:${httpPort}`,
    HARNESS_ADMIN_DATABASE_URL: pg.urls.admin,
    HARNESS_DATABASE_URL: pg.urls.app,
    PAPERCUSP_HONO_PORT: String(httpPort),
    OPERATOR_DEV_PORT: String(httpPort),
    OPERATOR_DEV_PTY_PORT: String(ptyPort),
    PAPERCUSP_BIND_HOST: '127.0.0.1',
    PAPERCUSP_BACKGROUND_WORKERS: operatorApi ? '0' : '1',
    PAPERCUSP_DBOS_ENABLE: operatorApi ? '0' : '1',
    PAPERCUSP_DBOS_ORCHESTRATOR: operatorApi ? '0' : '1',
    // The test starts explicit background work; global scheduled routines may
    // otherwise act on the shared checkout or external services during boot.
    PAPERCUSP_DBOS_ROUTINES: '0',
    PAPERCUSP_DBOS_TIMERS: '0',
    PAPERCUSP_DBOS_AUTOLOOP: '0',
    DBOS__VMID: runtimeId,
    DBOS__APPVERSION: runtimeId,
    PAPERCUSP_CLUSTER: '0',
    PAPERCUSP_CLUSTER_WORKERS: '0',
    PAPERCUSP_SPAWNER_SIDECAR: '0',
    PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: '0',
    PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR: '0',
    PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '0',
    PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR: '0',
    PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR: '0',
    XDG_DATA_HOME: join(runtimeRoot, 'xdg-data'),
    XDG_CACHE_HOME: join(runtimeRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: join(runtimeRoot, 'xdg-config'),
    XDG_STATE_HOME: join(runtimeRoot, 'xdg-state'),
    XDG_RUNTIME_DIR: join(runtimeRoot, 'xdg-runtime'),
    // Original proof receipts must survive this private HOME's teardown.
    // Pin the caller's maintained root before isolating product state; nested
    // wrappers inherit this same absolute root instead of nesting it in HOME.
    VH_EVIDENCE_ROOT_BASE: resolve(dirname(defaultEvidenceRoot('isolated-integration'))),
    // Browser installations are maintained executable assets, not mutable
    // operator state. Pin their original cache before isolating HOME/XDG;
    // otherwise Playwright silently resolves an empty runtime-local cache.
    PLAYWRIGHT_BROWSERS_PATH: browserCachePath(process.env),
    TMPDIR: join(runtimeRoot, 'tmp'),
  };
}

const childEnv = { ...process.env };
if (isolatedRuntime) {
  // Start from no ambient operator identity, endpoints, IPC or credentials.
  // HOME alone is insufficient: an inherited PAPERCUSP_SUBSTRATE_IPC_SOCKET,
  // API base or DHT bootstrap can still join the running operator.
  // The existing test reporters have a separate explicit ledger sink and
  // attribution contract. Preserve only those keys; product pools still receive
  // the private runtime URLs below, and unrelated PAPERCUSP_ keys stay scrubbed.
  const evidenceKeys = new Set([
    'PAPERCUSP_TEST_RUNS_DB_URL', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
    'PAPERCUSP_TEST_RUN_WORKSPACE', 'PAPERCUSP_TEST_RUN_HARNESS',
    'PAPERCUSP_TEST_RUN_GROUP', 'PAPERCUSP_TEST_RUN_SOURCE',
    'PAPERCUSP_TEST_RUN_COMMIT', 'PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN',
    'PAPERCUSP_TEST_RUN_LOOP_LAG_P95_MS',
  ]);
  for (const key of Object.keys(childEnv)) {
    if (evidenceKeys.has(key)) continue;
    if (/^(PAPERCUSP_|HARNESS_|DBOS__|PG[A-Z]|DATABASE_URL$|AWS_|AZURE_|GOOGLE_|GCP_|OPENAI_|ANTHROPIC_|GITHUB_|GH_|CLOUDSDK_|DOCKER_|GIT_ASKPASS$|GIT_CONFIG_|SSH_AUTH_SOCK$|CODEX_HOME$|VITEST(?:_|$)|DBUS_SESSION_BUS_ADDRESS$|GNOME_KEYRING_CONTROL$)/i.test(key)) {
      delete childEnv[key];
    }
  }
}
if (operatorApi) {
  // A request journey needs the same isolation as a background test, but must
  // not boot DBOS/substrate owners or load an ONNX model in the request host.
  // Reuse the actual registry and sidecar factory in a separate owned process;
  // never inherit the live sidecar, register the shared checkout, or disable
  // the host's memory watchdog. Preflight completes BEFORE the command starts.
  runtimeEnv.PAPERCUSP_POT_HOME_SLUG = runtimeId;
  // Tunnel connectors must use the host's maintained no-local-trust listener,
  // never the desktop loopback API (which can mint pairing tokens).
  let ingressPort;
  do { ingressPort = await freePort(); }
  while ([port, Number(runtimeEnv.PAPERCUSP_HONO_PORT), Number(runtimeEnv.OPERATOR_DEV_PTY_PORT)].includes(ingressPort));
  assertNotTerminating();
  runtimeEnv.PAPERCUSP_EXTERNAL_INGRESS_PORT = String(ingressPort);
  const profileSource = `
    const stage = (name, detail = {}) => process.send({ stage: name, ...detail });
    stage('imports:harness-registry');
    import { mkdir } from 'node:fs/promises';
    import { join } from 'node:path';
    const { saveHarnessRegistry, loadHarnessRegistry } = await import('./packages/operator-core/lib/harness-registry.ts');
    stage('imports:embed-sidecar');
    const { createEmbedSidecarServer } = await import('./packages/operator-core/lib/memory/embed-sidecar-server.ts');
    stage('imports:db-org');
    const { getOrgPg, upsertRoutine } = await import('@papercusp/db-org');
    stage('imports:device-monitoring');
    const { releaseGateTile } = await import('./packages/operator-core/lib/device-monitoring.ts');
    stage('private-registry');
    const id = process.env.PAPERCUSP_WORKSPACE_ID;
    const home = join(process.env.PAPERCUSP_WORKSPACES_ROOT, id, 'operator-home');
    await mkdir(home, { recursive: true });
    await saveHarnessRegistry({ projects: [{ slug: id, path: home, harness_kind: 'hive' }] }, id);
    const registry = await loadHarnessRegistry(id, { fresh: true });
    if (!registry.projects.some(p => p.slug === id && p.path === home)) throw new Error('private home harness was not registered');
    // Inbox refuses an unmeasured system source. An empty disposable database
    // has no pipeline at all, so register an explicitly PAUSED fixture through
    // the maintained routine store. Never manufacture a green verdict or arm
    // a release action against the developer's checkout.
    stage('paused-routine');
    const { sql } = getOrgPg();
    await upsertRoutine(sql, { workspaceId: id, installSlug: id,
      name: 'green-checkpoint', triggerKind: 'api', triggerConfig: {},
      targetRole: 'operator', active: false, nextFireAt: null }, () => null);
    const pause = { reason: 'Disposable operator-api fixture; publication disabled',
      pausedBy: id, pausedAtMs: Date.now() };
    await sql\`UPDATE harness_shared.routines SET metadata = \${sql.json({ pause })}
      WHERE workspace_id = \${id} AND install_slug = \${id} AND name = 'green-checkpoint'\`;
    stage('measure-private-gate');
    const { fetchOrientPipeline } = await import('./packages/operator-core/lib/agent-tools/coordination/pipeline-health.ts');
    const { computePipelineHealth } = await import('./packages/operator-core/lib/why-chain.ts');
    const { gitPipelineSnapshot } = await import('./packages/operator-core/lib/git-pipeline-stats.ts');
    const pendingGateSources = new Set();
    const gate = await releaseGateTile(id, { fetch: (slug) => fetchOrientPipeline(slug, {
      compute: (slug) => computePipelineHealth({ slug, harnessSlug: slug,
        loadSnapshot: () => gitPipelineSnapshot(slug, { useSpawnerSidecar: false,
          onProgress: (name) => {
            const [source, state] = name.split(':');
            if (state === 'start') pendingGateSources.add(source);
            else pendingGateSources.delete(source);
            stage('measure-private-gate:' + name, { pendingGateSources: [...pendingGateSources] });
          } }) }),
    }) });
    if (!gate || gate.gate !== 'wedged' || !gate.red) {
      throw new Error('private paused pipeline was not measured; refusing request journey');
    }
    stage('sidecar-listen');
    const sidecar = createEmbedSidecarServer({ port: 0, warmAtBoot: false });
    const port = await sidecar.listening;
    process.on('SIGTERM', async () => { await sidecar.close(); process.exit(0); });
    process.send({ ready: true, url: 'http://127.0.0.1:' + port, homeHarness: id });
  `;
  try {
    profileProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', profileSource], {
      cwd: ROOT, env: { ...childEnv, ...runtimeEnv, PAPERCUSP_PG_PORT: String(port), PAPERCUSP_SKIP_PG_DISCOVERY: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
    });
    let errors = '';
    for (const stream of [profileProcess.stdout, profileProcess.stderr]) {
      stream.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-6000); });
    }
    const ready = await new Promise((res, rej) => {
      let lastStage = 'process-start';
      let pendingGateSources = [];
      const started = Date.now();
      const timer = setTimeout(() => rej(new Error('operator-api profile preflight timed out at ' + lastStage +
        '; pending gate sources=' + pendingGateSources.join(',') + ': ' + errors)), 45000);
      const failed = (error) => { clearTimeout(timer); rej(error); };
      profileProcess.once('error', failed);
      profileProcess.once('exit', (code, signal) => failed(new Error('operator-api profile exited ' + code + '/' + signal + ': ' + errors)));
      profileProcess.on('message', (message) => {
        if (typeof message?.stage === 'string') {
          lastStage = message.stage;
          if (Array.isArray(message.pendingGateSources)) pendingGateSources = message.pendingGateSources;
          console.log('[with-test-pg] operator-api stage ' + lastStage + ' +' + (Date.now() - started) + 'ms' +
            (Array.isArray(message.pendingGateSources) ? ' pending=' + JSON.stringify(pendingGateSources) : ''));
          if (process.env.PC_ISOLATED_RUNTIME_PROOF === '1' && process.connected) {
            process.send({ kind: 'isolated-runtime-bootstrap-progress', stage: 'profile:' + lastStage }, () => {});
          }
          return;
        }
        clearTimeout(timer);
        res(message);
      });
    });
    assertNotTerminating();
    if (!ready?.ready || ready.homeHarness !== runtimeId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url)) {
      throw new Error('operator-api profile returned an invalid private identity');
    }
    const response = await fetch(ready.url + '/healthz', { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    if (!response.ok || health.pid !== profileProcess.pid || !health.capabilities?.includes('POST /embed')) {
      throw new Error('operator-api private embedding sidecar failed capability/owner preflight');
    }
    runtimeEnv.PAPERCUSP_EMBED_SIDECAR_URL = ready.url;
    console.log('[with-test-pg] operator-api preflight ready — private home harness, measured paused pipeline and embedding sidecar; background/DBOS disabled');
  } catch (error) {
    console.error('[with-test-pg] operator-api preflight failed: ' + (error?.stack ?? error));
    await cleanup();
    process.exit(1);
  }
}
assertNotTerminating();
const observedRuntime = isolatedRuntime && process.env.PC_ISOLATED_RUNTIME_PROOF === '1' && process.send;
const startToken = observedRuntime ? randomUUID() : null;
if (observedRuntime && resolve(cmd[0]) !== process.execPath) {
  throw new Error('original lifetime proof requires the maintained Node worker route');
}
const childArgs = observedRuntime
  ? ['--import', join(ROOT, 'scripts/lib/isolated-runtime-start.mjs'), ...cmd.slice(1)] : cmd.slice(1);
// Integration setup has its own admin resolver. Pin it to this supervisor's
// actual private cluster in every mode, without changing the product's
// HARNESS_* env-resolution cases in the ordinary wrapper.
const testAdminUrl = new URL(pg.urls.admin);
if (!['postgres:', 'postgresql:'].includes(testAdminUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(testAdminUrl.hostname) || testAdminUrl.port !== String(port) ||
    !testAdminUrl.username || !testAdminUrl.pathname.slice(1)) {
  throw new Error('private integration admin preflight failed: URL does not identify the owned Postgres');
}
child = spawn(cmd[0], childArgs, {
  cwd: ROOT,
  stdio: observedRuntime ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
  env: {
    ...childEnv,
    // PAPERCUSP_PG_PORT is the repo's OWN isolation lever for "this process owns a
    // dedicated PG" (see connection.ts's two native fallbacks and its pgbouncer
    // opt-out, and harness-invoke-once.ts: "getHarnessAdminUrl() honors
    // PAPERCUSP_PG_PORT, so isolated ..."). Both resolvers build their fallback URL
    // from it, which is all the throwaway PG needs.
    //
    // Deliberately NOT exporting HARNESS_ADMIN_DATABASE_URL / HARNESS_DATABASE_URL:
    // those are step 1 of the resolution chain, and injecting them changes the
    // behaviour of the very code under test — it broke harness-invoke-once.test.ts's
    // env-resolution cases (52/52 → 2 failures) purely because the runner had set
    // them. A test harness must not perturb the tests it runs.
    PAPERCUSP_PG_PORT: String(port),
    // Belt-and-braces: the unit layer pins this too, but a non-vitest child (a script,
    // a CLI) must also never resolve the *product's* live embedded PG.
    PAPERCUSP_SKIP_PG_DISCOVERY: '1',
    ...runtimeEnv,
    PAPERCUSP_TEST_PG_ADMIN_URL: testAdminUrl.toString(),
    ...(observedRuntime ? { PC_ISOLATED_RUNTIME_START_TOKEN: startToken } : {}),
  },
  detached: isolatedRuntime,
});

// The test parent measures these PIDs during their actual lifetime. Ordinary
// runs have no IPC observer and pay no receipt cost.
if (observedRuntime) {
  let announced = false;
  const acknowledge = message => {
    if (!announced || message?.kind !== 'isolated-runtime-observed' || message.childPid !== child.pid || message.token !== startToken) return;
    process.off('message', acknowledge);
    child.send({ kind: 'isolated-worker-observed', token: startToken, accepted: message.accepted === true });
  };
  process.on('message', acknowledge);
  child.on('message', message => {
    if (announced || message?.kind !== 'isolated-worker-ready' || message.token !== startToken) return;
    announced = true;
    process.send({ kind: 'isolated-runtime-start', supervisorPid: process.pid, childPid: child.pid,
      workspace: runtimeId, runtimeRoot, dataDir, pgPort: port, root: ROOT, token: startToken });
  });
  child.once('exit', () => process.off('message', acknowledge));
}

child.on('error', async (error) => {
  console.error(`[with-test-pg] child failed to start: ${error.message}`);
  // Cleanup may release the last event-loop handle. Set failure BEFORE it can
  // trigger a natural/exit-hook exit, and explicitly propagate it afterward.
  process.exitCode = 1;
  await cleanup();
  process.exit(1);
});

child.on('exit', async (code, signal) => {
  if (isolatedRuntime && process.env.PC_ISOLATED_RUNTIME_PROOF === '1' && process.send) {
    process.send({ kind: 'isolated-runtime-stopping', childPid: child.pid, exitCode: code, signal });
  }
  if (isolatedRuntime && child.pid) {
    // A short-lived assertion can spawn a long-lived test host. Reap its owned
    // process group before deleting the private DB/identity it was using.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  await cleanup();
  if (isolatedRuntime && process.env.PC_ISOLATED_RUNTIME_PROOF === '1' && process.send) {
    await new Promise(done => process.send({ kind: 'isolated-runtime-end', childPid: child.pid,
      exitCode: code, signal, runtimeRemoved: !existsSync(runtimeRoot), pgDataRemoved: !existsSync(dataDir) }, done));
  }
  if (signal) {
    // The forwarding handler has already run. Restore the native signal exit
    // after cleanup rather than forwarding the signal back to a dead child.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  else process.exit(code ?? 1);
});
}

main().catch(async error => {
  console.error(`[with-test-pg] bootstrap failed: ${error?.stack ?? error}`);
  await cleanup();
  process.exit(terminatingSignal === 'SIGTERM' ? 143 : terminatingSignal === 'SIGINT' ? 130 : 1);
});
