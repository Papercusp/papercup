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
import { createServer } from 'node:net';

const PG_IMAGE = 'postgres@sha256:5a65324fe84dc41709ff914e90b07f3e2f577073ed27bf917d4873aca0c9ec51';
const MAIL_IMAGE = 'maildev/maildev@sha256:180ef51f65eefebb0e7122d8308813c1fd7bff164bc440ce5a3c2feee167a810';
const PINNED_IMAGE = /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/;

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

export async function runSandbox({ image, command }) {
  const suffix = randomUUID().slice(0, 12);
  const network = 'daohr-documenso-' + suffix;
  const database = network + '-pg', mail = network + '-mail', app = network + '-app';
  const containers = [];
  let directory, networkCreated = false, child, stopped = false, killTimer;
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
  function start(name, args, environment = {}) {
    // docker run can create the container and then fail during port/mount setup.
    // Record the owned name before dispatch so cleanup covers partial allocation.
    containers.push(name);
    docker(['run', '--pull=never', '-d', '--name', name, '--label', 'papercusp.test.owner=' + network,
      '--network', network, ...args], environment);
  }
  async function cleanup() {
    for (const name of [...containers].reverse()) {
      spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', timeout: 30_000 });
    }
    if (networkCreated) spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore', timeout: 10_000 });
    if (directory) rmSync(directory, { recursive: true, force: true });
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
    for (const ref of [image, PG_IMAGE, MAIL_IMAGE]) docker(['image', 'inspect', ref]);
    const openssl = spawnSync('openssl', ['version'], { stdio: 'ignore', timeout: 5000 });
    if (openssl.status !== 0) throw new Error('openssl is required for the sandbox signing certificate');
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
    // Match the upstream supported bridge setup. On this host, creating a
    // published-mail container on an --internal bridge blocks before allocation
    // (>35s), while this bridge creates in <1s. SMTP still terminates at MailDev.
    docker(['network', 'create', '--label', 'papercusp.test.owner=' + network, network]);
    const databasePassword = secret();
    start(database, ['--network-alias', 'database', '-e', 'POSTGRES_USER', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB', PG_IMAGE],
      { POSTGRES_USER: 'documenso', POSTGRES_PASSWORD: databasePassword, POSTGRES_DB: 'documenso' });
    start(mail, ['--network-alias', 'mail', '-p', '127.0.0.1::1080', MAIL_IMAGE]);
    const mailUrl = 'http://127.0.0.1:' + loopbackPort(docker(['port', mail, '1080/tcp']));
    for (let attempt = 0; ; attempt++) {
      if (stopped) return 130;
      const ready = spawnSync('docker', ['exec', database, 'pg_isready', '-U', 'documenso'], { stdio: 'ignore', timeout: 5000 });
      if (ready.status === 0) break;
      if (attempt >= 30) throw new Error('Sandbox Postgres did not become ready');
      await new Promise(done => setTimeout(done, 1000));
    }
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
    start(app, ['-p', '127.0.0.1:' + port + ':3000', '--mount',
      'type=bind,src=' + join(directory, 'cert.p12') + ',dst=/opt/documenso/cert.p12,readonly',
      ...Object.keys(environment).flatMap(key => ['-e', key]), image], environment);
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (stopped) return 130;
      try {
        const response = await fetch(appUrl + '/signin', { signal: AbortSignal.timeout(5000), redirect: 'manual' });
        if (response.status >= 200 && response.status < 400) break;
      } catch { /* boot/migration still in progress; bounded below */ }
      if (Date.now() >= deadline) throw new Error('Documenso sandbox did not become ready within 180s: ' + app);
      await new Promise(done => setTimeout(done, 1000));
    }
    const runtime = { kind: 'documenso-sandbox', image, appUrl, mailUrl, container: app,
      network, isolatedDatabase: true, externalMail: false, testCertificate: true };
    console.error('[documenso-sandbox] ' + JSON.stringify(runtime));
    if (stopped) return 130;
    child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true,
      env: { ...process.env, DOCUMENSO_URL: appUrl, DOCUMENSO_TEST_MAIL_URL: mailUrl,
        DOCUMENSO_TEST_RUNTIME: JSON.stringify(runtime) } });
    return await new Promise((done, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => done(code ?? (signal ? 130 : 1)));
    });
  } finally {
    clearTimeout(killTimer);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runSandbox(parseSandboxArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
