import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { parseSandboxArgs, loopbackPort, sandboxEnvironment, runSandbox, dockerAllocation } from './with-documenso-sandbox.mjs';

test('sandbox refuses mutable image tags before any service allocation', () => {
  assert.throws(() => parseSandboxArgs(['--image=documenso/documenso:latest', '--', 'node', 'journey.mjs']), /pinned/);
  assert.throws(() => parseSandboxArgs(['--image=documenso/documenso@sha256:' + 'a'.repeat(64)]), /usage/);
  const image = 'documenso/documenso@sha256:' + 'a'.repeat(64);
  assert.deepEqual(parseSandboxArgs(['--image=' + image, '--', 'node', 'journey.mjs']), { image, command: ['node', 'journey.mjs'] });
});

test('sandbox refuses ports published outside loopback', () => {
  assert.equal(loopbackPort('127.0.0.1:33199\n'), 33199);
  for (const value of ['0.0.0.0:33199', '[::]:33199', '127.0.0.1:0', '127.0.0.1:65536']) {
    assert.throws(() => loopbackPort(value), /loopback/);
  }
});

test('provider config routes mail and data into the isolated fixture', () => {
  const input = { appUrl: 'http://127.0.0.1:33199', databasePassword: 'pg-secret',
    secret: 'auth-secret', encryptionKey: 'enc-secret', secondaryKey: 'secondary-secret', signingPassword: 'cert-secret' };
  const env = sandboxEnvironment(input);
  assert.equal(env.NEXT_PRIVATE_SMTP_HOST, 'mail');
  assert.equal(env.NEXT_PRIVATE_DATABASE_URL, 'postgres://documenso:pg-secret@database:5432/documenso');
  assert.equal(env.NEXT_PRIVATE_DIRECT_DATABASE_URL, env.NEXT_PRIVATE_DATABASE_URL);
  assert.equal(env.NEXT_PUBLIC_WEBAPP_URL, input.appUrl);
  assert.equal(env.NEXT_PRIVATE_SIGNING_PASSPHRASE, input.signingPassword);
  assert.equal(env.NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH, '/opt/documenso/cert.p12');
  assert.equal(env.DOCUMENSO_DISABLE_TELEMETRY, 'true');
  assert.throws(() => sandboxEnvironment({ ...input, appUrl: 'https://example.com' }), /loopback/);
});

test('slow allocation is joined before cleanup instead of being killed at the warning threshold', async () => {
  const observations = [];
  const outcome = await dockerAllocation(['create', '--name', 'fixture'], {}, {
    pendingAfterMs: 10,
    onPending: () => observations.push('still pending'),
    spawnChild: () => spawn(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("allocated-container"),80)']),
  });
  observations.push('safe to clean ' + outcome);
  assert.deepEqual(observations, ['still pending', 'safe to clean allocated-container']);
});

test('allocation errors redact injected credentials', async () => {
  const NEVER_EMIT_MARKER = 'never-emit-me';
  await assert.rejects(dockerAllocation(['create'], { PASSWORD: NEVER_EMIT_MARKER }, {
    spawnChild: () => spawn(process.execPath, ['-e', 'process.stderr.write(process.env.PASSWORD);process.exitCode=7'],
      { env: { ...process.env, PASSWORD: NEVER_EMIT_MARKER } }),
  }), error => error.message.includes('[redacted]') && !error.message.includes(NEVER_EMIT_MARKER));
});

test('real provider starts with a private database and cleans every owned service after child failure',
  { skip: !process.env.DOCUMENSO_TEST_IMAGE, timeout: 240_000 }, async () => {
    const before = spawnSync('docker', ['ps', '-aq', '--filter', 'label=papercusp.test.owner'], { encoding: 'utf8' });
    assert.equal(before.status, 0);
    const code = await runSandbox({ image: process.env.DOCUMENSO_TEST_IMAGE, command: [process.execPath, '--input-type=module', '-e',
      'const r=JSON.parse(process.env.DOCUMENSO_TEST_RUNTIME); if(!r.isolatedDatabase||r.externalMail||!r.testCertificate) process.exit(91); const a=await fetch(process.env.DOCUMENSO_URL+"/signin"); if(!a.ok) process.exit(92); const m=await fetch(process.env.DOCUMENSO_TEST_MAIL_URL+"/email"); if(!m.ok) process.exit(93); process.exit(23);'] });
    assert.equal(code, 23, 'child failure must survive provider cleanup');
    const after = spawnSync('docker', ['ps', '-aq', '--filter', 'label=papercusp.test.owner'], { encoding: 'utf8' });
    assert.equal(after.status, 0);
    assert.deepEqual(after.stdout.trim().split('\n').filter(Boolean).sort(), before.stdout.trim().split('\n').filter(Boolean).sort());
  });
