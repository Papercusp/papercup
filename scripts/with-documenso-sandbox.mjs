#!/usr/bin/env node
/**
 * Bracket a command with a real, disposable Documenso service.
 * Reuses upstream's Docker deployment (Postgres + local signing certificate),
 * with a private per-run bridge and MailDev so test mail stays in this fixture.
 *
 * node scripts/with-documenso-sandbox.mjs --image=documenso/documenso@sha256:... -- <command>
 * The command receives DOCUMENSO_URL, DOCUMENSO_TEST_MAIL_URL and a measured
 * DOCUMENSO_TEST_RUNTIME. Create accounts/API keys through the provider UI.
 * Credentials and signing keys exist only in an owned temporary directory.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, createConnection } from 'node:net';
import { getContainerRuntimeClient } from 'testcontainers';

const PG_IMAGE = 'postgres@sha256:5a65324fe84dc41709ff914e90b07f3e2f577073ed27bf917d4873aca0c9ec51';
const MAIL_IMAGE = 'maildev/maildev@sha256:180ef51f65eefebb0e7122d8308813c1fd7bff164bc440ce5a3c2feee167a810';
const REAPER_IMAGE = 'testcontainers/ryuk@sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0';
const PINNED_IMAGE = /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/;

/** Ryuk must acknowledge this run's exact ownership filter before allocation.
 * Keep one connection per sandbox: the shared Testcontainers reaper waits for
 * every peer's connection, which cannot bound cleanup for one killed wrapper.
 */
export async function registerSandboxReaper({ port, owner, onDisconnect = () => {}, timeoutMs = 30_000 }) {
  if (!/^daohr-documenso-[a-f0-9-]{12}$/.test(owner)) throw new Error('Invalid sandbox cleanup owner');
  const socket = createConnection({ host: '127.0.0.1', port });
  let acknowledged = false, closing = false, connected = false, failure, response = '';
  const lost = error => {
    if (closing || failure) return;
    failure = error;
    connected = false;
    if (acknowledged) onDisconnect(error);
  };
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => fail(new Error('Sandbox cleanup reaper did not acknowledge its ownership filter')), timeoutMs);
      function fail(error) { clearTimeout(timer); lost(error); reject(error); }
      socket.once('connect', () => socket.write('label=papercusp.test.owner=' + owner + '\n'));
      socket.on('error', error => fail(error));
      socket.on('close', () => fail(new Error('Sandbox cleanup reaper connection closed')));
      socket.on('data', data => {
        response += data.toString('utf8');
        if (response.length > 128 || (response.includes('\n') && response !== 'ACK\n')) {
          fail(new Error('Sandbox cleanup reaper rejected its ownership filter'));
        } else if (response === 'ACK\n') {
          clearTimeout(timer);
          acknowledged = connected = true;
          done();
        }
      });
    });
    return {
      assertConnected() { if (!connected) throw failure ?? new Error('Sandbox cleanup reaper is disconnected'); },
      close() { closing = true; connected = false; socket.destroy(); },
    };
  } catch (error) { closing = true; socket.destroy(); throw error; }
}

async function startSandboxReaper(owner, docker, onDisconnect) {
  if (process.env.TESTCONTAINERS_RYUK_DISABLED === 'true') {
    throw new Error('Documenso sandbox requires external-kill cleanup; Ryuk cannot be disabled');
  }
  const client = await getContainerRuntimeClient();
  const name = owner + '-reaper';
  // The reaper itself is outside the wrapper's process scope. --rm and its
  // no-client timeout also cover wrapper death before the registration ACK.
  await dockerAllocation(['run', '-d', '--rm', '--pull=never', '--name', name,
    '--label', 'papercusp.test.reaper=' + owner, '-p', '127.0.0.1::8080', '--mount',
    'type=bind,src=' + client.info.containerRuntime.remoteSocketPath + ',dst=/var/run/docker.sock',
    '-e', 'RYUK_CONNECTION_TIMEOUT=30s', '-e', 'RYUK_RECONNECTION_TIMEOUT=1s', REAPER_IMAGE]);
  const port = loopbackPort(docker(['port', name, '8080/tcp']));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const connection = await registerSandboxReaper({ port, owner, onDisconnect });
      console.error('[documenso-sandbox-reaper] ' + JSON.stringify({ network: owner, container: name, image: REAPER_IMAGE }));
      return connection;
    } catch (error) {
      // A published Docker port can precede the server's listen. Only that
      // pre-listen refusal is retryable; never allocate without an ACK.
      if (error.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
      await new Promise(done => setTimeout(done, 100));
    }
  }
}

export function parseSandboxArgs(argv) {
  const separator = argv.indexOf('--');
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  if (options.length !== 1 || !options[0].startsWith('--image=') || !command.length) {
    throw new Error('usage: with-documenso-sandbox.mjs --image=<repository@sha256:digest> -- <command> [args...]');
  }
  const image = options[0].slice('--image='.length);
  if (!PINNED_IMAGE.test(image)) throw new Error('Documenso test image must be pinned by SHA-256 digest');
  return { image, command };
}

/** Host-published ports are loopback-only, chosen by Docker rather than raced. */
export function loopbackPort(published) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(published.trim());
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error('Sandbox port must be published only on IPv4 loopback');
  }
  return Number(match[1]);
}

export function sandboxEnvironment({ appUrl, databasePassword, secret, encryptionKey, secondaryKey, signingPassword }) {
  if (new URL(appUrl).hostname !== '127.0.0.1') throw new Error('Sandbox public URL must use loopback');
  return {
    PORT: '3000', NEXTAUTH_SECRET: secret,
    NEXT_PRIVATE_ENCRYPTION_KEY: encryptionKey,
    NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY: secondaryKey,
    NEXT_PRIVATE_DATABASE_URL: 'postgres://documenso:' + databasePassword + '@database:5432/documenso',
    NEXT_PRIVATE_DIRECT_DATABASE_URL: 'postgres://documenso:' + databasePassword + '@database:5432/documenso',
    NEXT_PUBLIC_WEBAPP_URL: appUrl,
    NEXT_PRIVATE_INTERNAL_WEBAPP_URL: 'http://127.0.0.1:3000',
    NEXT_PUBLIC_UPLOAD_TRANSPORT: 'database',
    NEXT_PRIVATE_JOBS_PROVIDER: 'local',
    NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH: '/opt/documenso/cert.p12',
    NEXT_PRIVATE_SIGNING_PASSPHRASE: signingPassword,
    NEXT_PRIVATE_SMTP_TRANSPORT: 'smtp-auth', NEXT_PRIVATE_SMTP_HOST: 'mail',
    NEXT_PRIVATE_SMTP_PORT: '1025', NEXT_PRIVATE_SMTP_UNSAFE_IGNORE_TLS: 'true',
    NEXT_PRIVATE_SMTP_FROM_NAME: 'DAO HR sandbox',
    NEXT_PRIVATE_SMTP_FROM_ADDRESS: 'noreply@daohr.example.test',
    DOCUMENSO_DISABLE_TELEMETRY: 'true', NEXT_PUBLIC_POSTHOG_KEY: '',
  };
}

/** An allocation request is not cancelled by killing its Docker CLI client.
 * Join each daemon request, including removal; a CLI timeout can leave work
 * running after the caller has already inspected an incomplete outcome.
 * The threshold is a progress warning, not permission to abandon the request.
 */
export async function dockerAllocation(args, environment = {}, {
  spawnChild = spawn, pendingAfterMs = 30_000,
  onPending = () => console.error('[documenso-sandbox] Docker ' + args[0] + ' request still pending; waiting for its outcome before cleanup'),
} = {}) {
  const child = spawnChild('docker', args, { env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-2_000_000); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
  const warning = setTimeout(onPending, pendingAfterMs);
  try {
    return await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) return done(stdout.trim());
        for (const value of Object.values(environment).filter(value => value.length >= 8)) {
          stderr = stderr.split(value).join('[redacted]');
        }
        reject(new Error('Documenso sandbox Docker request failed: ' + args[0] + ' ' +
          (signal ?? code) + (stderr ? ': ' + stderr : '')));
      });
    });
  } finally { clearTimeout(warning); }
}

/** Normal cleanup joins removal before checking this run's ownership label.
 * A concurrent external reaper may already have removed a named resource;
 * absence is authoritative, while a retained resource always fails closed.
 */
export async function cleanupSandboxResources({ containers, network, networkCreated, inspect,
  remove = args => dockerAllocation(args) }) {
  const errors = [];
  for (const name of [...containers].reverse()) {
    try { await remove(['rm', '-f', '-v', name]); }
    catch (error) { errors.push(error.message); }
  }
  if (networkCreated) {
    try { await remove(['network', 'rm', network]); }
    catch (error) { errors.push(error.message); }
  }
  const remainingContainers = inspect(['ps', '-aq', '--filter', 'label=papercusp.test.owner=' + network]);
  const remainingNetworks = inspect(['network', 'ls', '-q', '--filter', 'label=papercusp.test.owner=' + network]);
  if (remainingContainers || remainingNetworks) {
    throw new Error('Documenso sandbox cleanup incomplete for ' + network + ': containers=' +
      (remainingContainers || 'none') + ', networks=' + (remainingNetworks || 'none') +
      (errors.length ? '; removal errors=' + errors.join('; ') : ''));
  }
}

/** Collect failure evidence while the owned container still exists. Never emit config secrets. */
export function sandboxFailureDiagnostic(name, run, secrets = [], readiness = '') {
  const inspected = run(['inspect', '--format', '{{json .State}}', name]);
  let state;
  try {
    const value = JSON.parse(inspected.stdout || '{}');
    state = { status: value.Status, exitCode: value.ExitCode, error: value.Error, oomKilled: value.OOMKilled };
  } catch { state = { inspectExit: inspected.status }; }
  const logs = run(['logs', '--tail', '35', name]);
  let diagnostic = JSON.stringify({ container: name, state, readiness,
    startupLog: ((logs.stdout || '') + (logs.stderr || '')).slice(-4000) });
  for (const value of secrets.filter(value => value && value.length >= 8)) {
    diagnostic = diagnostic.split(value).join('[redacted]');
  }
  return diagnostic;
}

export async function waitForSandboxPostgres(name, { run, secrets = [],
  attempts = 31, isStopped = () => false, delay = () => new Promise(done => setTimeout(done, 1000)) }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (isStopped()) return;
    // The image initializes through a temporary Unix-socket-only server, then
    // stops it before starting the final TCP listener used by Documenso.
    const ready = run(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'documenso', '-d', 'documenso']);
    if (!ready.error && ready.status === 0) return;
    const inspected = run(['inspect', '--format', '{{.State.Status}}', name]);
    const terminal = /^(exited|dead)$/.test((inspected.stdout || '').trim());
    if (terminal || attempt === attempts - 1) {
      const readiness = ready.error?.message || (ready.stdout || '') + (ready.stderr || '') || 'exit=' + ready.status;
      throw new Error('Sandbox Postgres did not become ready: ' + sandboxFailureDiagnostic(name, run, secrets, readiness));
    }
    await delay();
  }
}

export async function runSandbox({ image, command }) {
  const suffix = randomUUID().slice(0, 12);
  const network = 'daohr-documenso-' + suffix;
  const database = network + '-pg', mail = network + '-mail', app = network + '-app';
  const containers = [];
  let directory, reaper, reaperFailure, networkCreated = false, child, stopped = false, killTimer;
  const secret = () => randomBytes(32).toString('hex');
  function docker(args, environment = {}) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ...environment }, maxBuffer: 2_000_000 });
    if (result.error || result.status !== 0) {
      // CLI diagnostics explain allocation failures; application logs may contain
      // tokens, so do not dump them. Redact environment values before reporting.
      let diagnostic = (result.stderr ?? '').slice(-2000);
      for (const value of Object.values(environment).filter(value => value.length >= 8)) {
        diagnostic = diagnostic.split(value).join('[redacted]');
      }
      throw new Error('Documenso sandbox Docker operation failed: ' + args[0] + ' ' +
        (result.error?.message ?? result.status) + (diagnostic ? ': ' + diagnostic : ''));
    }
    return result.stdout.trim();
  }
  async function start(name, args, environment = {}) {
    // Create and start have different effects. Await the allocation response
    // before starting; a later start timeout cannot allocate another container.
    reaper.assertConnected();
    containers.push(name);
    await dockerAllocation(['create', '--pull=never', '--name', name, '--label', 'papercusp.test.owner=' + network,
      '--network', network, ...args], environment);
    if (!stopped) docker(['start', name]);
  }
  async function cleanup() {
    try { await cleanupSandboxResources({ containers, network, networkCreated, inspect: docker }); }
    finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
  }
  function stop() {
    stopped = true;
    if (child) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already ended */ }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already ended */ }
      }, 5000);
      killTimer.unref();
    }
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    // Refuse before allocating anything when required images/tools are absent.
    for (const ref of [image, PG_IMAGE, MAIL_IMAGE, REAPER_IMAGE]) docker(['image', 'inspect', ref]);
    const openssl = spawnSync('openssl', ['version'], { stdio: 'ignore', timeout: 5000 });
    if (openssl.status !== 0) throw new Error('openssl is required for the sandbox signing certificate');
    reaper = await startSandboxReaper(network, docker, error => { reaperFailure = error; stop(); });
    if (stopped) return 130;
    directory = mkdtempSync(join(tmpdir(), 'daohr-documenso-'));
    chmodSync(directory, 0o700);
    const signingPassword = secret();
    for (const args of [
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
        '-out', join(directory, 'cert.pem'), '-days', '2', '-subj', '/CN=DAO HR NON-BINDING TEST'],
      ['pkcs12', '-export', '-inkey', join(directory, 'key.pem'), '-in', join(directory, 'cert.pem'),
        '-out', join(directory, 'cert.p12'), '-passout', 'env:DOCUMENSO_CERT_PASSWORD'],
    ]) {
      const result = spawnSync('openssl', args, { stdio: 'ignore', timeout: 10_000,
        env: { ...process.env, DOCUMENSO_CERT_PASSWORD: signingPassword } });
      if (result.status !== 0) throw new Error('Sandbox signing certificate generation failed');
    }
    // The container runs as a non-root user; the enclosing directory stays private.
    chmodSync(join(directory, 'cert.p12'), 0o644);
    networkCreated = true;
    // Match upstream's supported bridge. SMTP terminates at MailDev. Allocation
    // may take longer than the CLI warning threshold on either bridge type.
    reaper.assertConnected();
    await dockerAllocation(['network', 'create', '--label', 'papercusp.test.owner=' + network, network]);
    if (stopped) return 130;
    const databasePassword = secret();
    await start(database, ['--network-alias', 'database', '-e', 'POSTGRES_USER', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB', PG_IMAGE],
      { POSTGRES_USER: 'documenso', POSTGRES_PASSWORD: databasePassword, POSTGRES_DB: 'documenso' });
    if (stopped) return 130;
    await start(mail, ['--network-alias', 'mail', '-p', '127.0.0.1::1080', MAIL_IMAGE]);
    if (stopped) return 130;
    const mailUrl = 'http://127.0.0.1:' + loopbackPort(docker(['port', mail, '1080/tcp']));
    const diagnosticRun = args => spawnSync('docker', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 100_000 });
    await waitForSandboxPostgres(database, { run: diagnosticRun, secrets: [databasePassword], isStopped: () => stopped });
    if (stopped) return 130;
    // Select a free port without starting an unconfigured provider. Docker's
    // bind remains authoritative: a competing bind makes start fail and cleanup
    // runs, rather than treating an unrelated process as our provider.
    const port = await new Promise((done, reject) => {
      const server = createServer(); server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const selected = server.address().port;
        server.close(error => error ? reject(error) : done(selected));
      });
    });
    const appUrl = 'http://127.0.0.1:' + port;
    const environment = sandboxEnvironment({ appUrl, databasePassword, signingPassword,
      secret: secret(), encryptionKey: secret(), secondaryKey: secret() });
    await start(app, ['-p', '127.0.0.1:' + port + ':3000', '--mount',
      'type=bind,src=' + join(directory, 'cert.p12') + ',dst=/opt/documenso/cert.p12,readonly',
      ...Object.keys(environment).flatMap(key => ['-e', key]), image], environment);
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (stopped) return 130;
      try {
        const response = await fetch(appUrl + '/signin', { signal: AbortSignal.timeout(5000), redirect: 'manual' });
        if (response.status >= 200 && response.status < 400) break;
      } catch { /* boot/migration still in progress; bounded below */ }
      if (Date.now() >= deadline) throw new Error('Documenso sandbox did not become ready within 180s: ' +
        sandboxFailureDiagnostic(app, diagnosticRun, Object.values(environment)));
      await new Promise(done => setTimeout(done, 1000));
    }
    const runtime = { kind: 'documenso-sandbox', image, appUrl, mailUrl, container: app,
      network, isolatedDatabase: true, externalMail: false, testCertificate: true };
    console.error('[documenso-sandbox] ' + JSON.stringify(runtime));
    if (stopped) return 130;
    child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true,
      env: { ...process.env, DOCUMENSO_URL: appUrl, DOCUMENSO_TEST_MAIL_URL: mailUrl,
        DOCUMENSO_TEST_RUNTIME: JSON.stringify(runtime) } });
    const exitCode = await new Promise((done, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => done(code ?? (signal ? 130 : 1)));
    });
    if (reaperFailure) throw reaperFailure;
    return exitCode;
  } finally {
    clearTimeout(killTimer);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    try { await cleanup(); }
    finally { reaper?.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runSandbox(parseSandboxArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
