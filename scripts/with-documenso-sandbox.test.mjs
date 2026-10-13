import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSandboxArgs, loopbackPort, sandboxEnvironment, runSandbox, dockerAllocation, prepareSandboxImages, waitForSandboxPostgres, registerSandboxReaper, cleanupSandboxResources } from './with-documenso-sandbox.mjs';

async function withReaperServer(handler, run) {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); handler(socket);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { await run(server.address().port); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); }
}

test('cleanup registration waits for ACK and sends only the exact sandbox ownership label', { timeout: 5000 }, async () => {
  const owner = 'daohr-documenso-12345678-abc';
  let registered = false, releaseAck;
  await withReaperServer(socket => socket.once('data', data => {
    assert.equal(data.toString(), 'label=papercusp.test.owner=' + owner + '\n');
    releaseAck = () => { socket.write('A'); setImmediate(() => socket.write('CK\n')); };
  }), async port => {
    const pending = registerSandboxReaper({ port, owner, timeoutMs: 1000 }).then(value => { registered = true; return value; });
    pending.catch(() => {}); // consumed below; a bad fixture must fail, never hang the runner
    const deadline = Date.now() + 1000;
    while (!releaseAck && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
    if (!releaseAck) { await pending; assert.fail('reaper filter was never sent'); }
    assert.equal(registered, false, 'provider allocation cannot proceed before ACK');
    releaseAck();
    const connection = await pending;
    connection.assertConnected(); connection.close();
    assert.throws(() => connection.assertConnected(), /disconnected/);
  });
});

test('cleanup registration fails closed on rejection, EOF, missing ACK or an unsafe filter owner', async () => {
  const owner = 'daohr-documenso-12345678-abc';
  await assert.rejects(registerSandboxReaper({ port: 1, owner: owner + '\nlabel=peer' }), /Invalid/);
  for (const reply of ['NO\n', 'EOF', 'NONE']) {
    await withReaperServer(socket => socket.once('data', () => {
      if (reply === 'EOF') socket.end();
      else if (reply !== 'NONE') socket.write(reply);
    }), async port => {
      await assert.rejects(registerSandboxReaper({ port, owner, timeoutMs: 100 }), /rejected|closed|did not acknowledge/);
    });
  }
});

test('losing an acknowledged cleanup connection stops the sandbox and forbids further allocations', { timeout: 5000 }, async () => {
  let peer, stopped = 0;
  await withReaperServer(socket => { peer = socket; socket.once('data', () => socket.write('ACK\n')); }, async port => {
    const connection = await registerSandboxReaper({ port, owner: 'daohr-documenso-12345678-abc', timeoutMs: 1000, onDisconnect: () => stopped++ });
    peer.destroy();
    const deadline = Date.now() + 1000;
    while (!stopped && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
    assert.equal(stopped, 1);
    assert.throws(() => connection.assertConnected(), /closed/);
    connection.close();
  });
});

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

test('cached immutable sandbox images do not need a registry request', async () => {
  const inspected = [];
  assert.equal(await prepareSandboxImages('documenso/documenso@sha256:' + 'a'.repeat(64), {
    inspect: ref => inspected.push(ref), pull: () => assert.fail('cache hit must not pull'),
  }), true);
  assert.equal(inspected.length, 4);
  assert.equal(new Set(inspected).size, 4);
  for (const ref of inspected) assert.match(ref, /@sha256:[a-f0-9]{64}$/);
});

test('missing reaper image is pulled by its exact digest and verified after the request completes', async () => {
  let present = false, releasePull, completed = false;
  const calls = [];
  const ready = prepareSandboxImages('documenso/documenso@sha256:' + 'a'.repeat(64), {
    inspect: ref => {
      calls.push(['inspect', ref]);
      if (ref.startsWith('testcontainers/ryuk@') && !present) throw new Error('No such image');
    },
    pull: ref => { calls.push(['pull', ref]); return new Promise(done => { releasePull = () => { present = true; done(); }; }); },
  }).then(value => { completed = true; return value; });
  assert.equal(completed, false, 'preparation must wait for the daemon pull');
  assert.equal(typeof releasePull, 'function');
  releasePull();
  assert.equal(await ready, true);
  const reaper = 'testcontainers/ryuk@sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0';
  assert.deepEqual(calls.slice(-3), [['inspect', reaper], ['pull', reaper], ['inspect', reaper]]);
});

test('image preparation refuses mutable references, a failed pull, and a pull that did not install its digest', async () => {
  await assert.rejects(prepareSandboxImages('documenso/documenso:latest', {
    inspect: () => assert.fail('unsafe image must be refused before Docker'),
  }), /pinned/);
  const image = 'documenso/documenso@sha256:' + 'a'.repeat(64);
  await assert.rejects(prepareSandboxImages(image, {
    inspect: () => { throw new Error('No such image'); },
    pull: async ref => { assert.equal(ref, image); throw new Error('registry unavailable'); },
  }), /registry unavailable/);
  await assert.rejects(prepareSandboxImages(image, {
    inspect: () => { throw new Error('digest still absent'); }, pull: async () => {},
  }), /digest still absent/);
});

test('stop during an image pull joins the request and prevents subsequent preparation', async () => {
  let stopped = false, pulls = 0, inspections = 0;
  assert.equal(await prepareSandboxImages('documenso/documenso@sha256:' + 'a'.repeat(64), {
    inspect: () => { inspections++; throw new Error('No such image'); },
    pull: async () => { pulls++; stopped = true; }, isStopped: () => stopped,
  }), false);
  assert.equal(pulls, 1);
  assert.equal(inspections, 1);
});

test('actual sandbox entry refuses provider allocation when pinned image preparation fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daohr-image-preparation-'));
  const calls = join(directory, 'calls.jsonl');
  try {
    writeFileSync(join(directory, 'docker'), '#!' + process.execPath + '\n' +
      'const fs=require("node:fs"); const args=process.argv.slice(2);\n' +
      'fs.appendFileSync(process.env.DAOHR_IMAGE_TEST_CALLS,JSON.stringify(args)+"\\n");\n' +
      'process.stderr.write(args[0]==="pull"?"registry unavailable":"No such image"); process.exit(1);\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, ['scripts/with-documenso-sandbox.mjs',
      '--image=documenso/documenso@sha256:' + 'a'.repeat(64), '--', process.execPath, '-e', 'process.exit(91)'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: directory + ':' + process.env.PATH, DAOHR_IMAGE_TEST_CALLS: calls },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /registry unavailable/);
    const requests = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(requests, [
      ['image', 'inspect', 'documenso/documenso@sha256:' + 'a'.repeat(64)],
      ['pull', 'documenso/documenso@sha256:' + 'a'.repeat(64)],
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
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

test('normal cleanup waits for slow daemon removal before inspecting exact ownership', { timeout: 5000 }, async () => {
  const owner = 'daohr-documenso-12345678-abc', calls = [];
  let removed = false, warned = false;
  await cleanupSandboxResources({ containers: ['owned-app'], network: owner, networkCreated: true,
    remove: async args => {
      calls.push(args);
      if (args[0] === 'rm') {
        await dockerAllocation(args, {}, { pendingAfterMs: 10,
          onPending: () => { warned = true; },
          spawnChild: () => spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),80)']),
        });
        removed = true;
      }
    },
    inspect: args => {
      assert.equal(removed, true, 'daemon request must finish before absence is inspected');
      assert.equal(args.at(-1), 'label=papercusp.test.owner=' + owner);
      calls.push(args); return '';
    },
  });
  assert.equal(warned, true);
  assert.deepEqual(calls.map(args => args[0]), ['rm', 'network', 'ps', 'network']);
});

test('cleanup accepts an already reaped resource but reports a retained resource with its removal failure', async () => {
  const owner = 'daohr-documenso-12345678-abc';
  const removal = { containers: ['owned-app'], network: owner, networkCreated: false,
    remove: async () => { throw new Error('daemon removal failed'); } };
  await cleanupSandboxResources({ ...removal, inspect: () => '' });
  await assert.rejects(cleanupSandboxResources({ ...removal,
    inspect: args => args[0] === 'ps' ? 'retained-container' : '' }), /retained-container.*daemon removal failed/);
});

test('database startup failure retains state, readiness and sanitized logs before cleanup', async () => {
  const secret = 'never-emit-me', calls = [];
  await assert.rejects(waitForSandboxPostgres('owned-pg', {
    secrets: [secret], delay: async () => assert.fail('an exited container cannot become ready'),
    run: args => {
      calls.push(args[0]);
      if (args[0] === 'exec') return { status: 1, stderr: 'container is not running' };
      if (args[0] === 'logs') return { status: 0, stderr: 'initdb: permission denied; password=' + secret };
      return { status: 0, stdout: args[2] === '{{.State.Status}}' ? 'exited\n' :
        JSON.stringify({ Status: 'exited', ExitCode: 1, Error: '', OOMKilled: false }) };
    },
  }), error => {
    assert.match(error.message, /container is not running/);
    assert.match(error.message, /permission denied/);
    assert.match(error.message, /exitCode.*1/);
    assert.match(error.message, /redacted/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(calls, ['exec', 'inspect', 'inspect', 'logs']);
});

test('database readiness waits for the final TCP server while the temporary Unix server accepts', async () => {
  let tcpProbes = 0, delays = 0;
  await waitForSandboxPostgres('owned-pg', {
    delay: async () => { delays++; },
    run: args => {
      if (args[0] !== 'exec') return { status: 0, stdout: 'running' };
      // A socket-only initialization server would immediately satisfy the old
      // check. The final server begins accepting TCP on the second probe.
      if (!args.includes('-h')) return { status: 0, stdout: 'socket accepting connections' };
      assert.deepEqual(args, ['exec', 'owned-pg', 'pg_isready', '-h', '127.0.0.1', '-U', 'documenso', '-d', 'documenso']);
      return { status: ++tcpProbes === 2 ? 0 : 2, stdout: '127.0.0.1:5432 - no response' };
    },
  });
  assert.equal(tcpProbes, 2);
  assert.equal(delays, 1);
});

test('running database readiness retries converge and exhaustion retains the final probe', async () => {
  let probes = 0, delays = 0;
  const run = args => args[0] === 'exec' ? { status: ++probes === 3 ? 0 : 1, stdout: 'rejecting connections' } :
    { status: 0, stdout: 'running' };
  await waitForSandboxPostgres('owned-pg', { run, delay: async () => { delays++; } });
  assert.equal(probes, 3);
  assert.equal(delays, 2);
  probes = 0;
  await assert.rejects(waitForSandboxPostgres('owned-pg', { run, attempts: 2, delay: async () => {} }),
    /rejecting connections/);
  assert.equal(probes, 2);
});

test('stopping a sandbox cancels database readiness without another Docker operation', async () => {
  await waitForSandboxPostgres('owned-pg', { isStopped: () => true, run: () => assert.fail('already stopping') });
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

test('external SIGKILL of the sandbox process group reaps its Docker resources and preserves a peer',
  { skip: !process.env.DOCUMENSO_TEST_IMAGE, timeout: 300_000 }, async () => {
    const docker = args => {
      const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.error, undefined, 'Docker probe failed: ' + result.error?.message);
      assert.equal(result.status, 0, 'Docker ' + args[0] + ': ' + result.stderr);
      return result.stdout.trim();
    };
    const sentinel = 'daohr-peer-' + randomUUID().slice(0, 12);
    const directory = mkdtempSync(join(tmpdir(), 'daohr-kill-test-'));
    let wrapper, owner, reaper, output = '';
    try {
      docker(['network', 'create', '--label', 'papercusp.test.owner=' + sentinel, sentinel]);
      docker(['create', '--pull=never', '--name', sentinel, '--network', sentinel,
        '--label', 'papercusp.test.owner=' + sentinel, process.env.DOCUMENSO_TEST_IMAGE]);
      wrapper = spawn(process.execPath, ['scripts/with-documenso-sandbox.mjs', '--image=' + process.env.DOCUMENSO_TEST_IMAGE,
        '--', process.execPath, '-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, TMPDIR: directory } });
      wrapper.stderr.on('data', data => {
        output = (output + data).slice(-12000);
        const receipt = /\[documenso-sandbox-reaper\] (\{[^\n]+\})/.exec(output);
        if (receipt) { const runtime = JSON.parse(receipt[1]); owner = runtime.network; reaper = runtime.container; }
      });
      const ended = new Promise(done => wrapper.once('close', (code, signal) => done({ code, signal })));
      const startedBy = Date.now() + 90_000;
      for (;;) {
        assert.equal(wrapper.exitCode, null, output);
        if (owner && docker(['ps', '-aq', '--filter', 'name=^/' + owner + '-pg$'])) break;
        assert.ok(Date.now() < startedBy, 'sandbox did not reach Docker allocation: ' + output);
        await new Promise(done => setTimeout(done, 100));
      }
      // Kill before the detached journey starts. SIGKILL cannot run the
      // wrapper's finally or signal handlers; cleanup must be external.
      assert.equal(output.includes('[documenso-sandbox] {'), false, 'kill fixture already started its child');
      assert.ok(docker(['network', 'ls', '-q', '--filter', 'label=papercusp.test.owner=' + owner]));
      process.kill(-wrapper.pid, 'SIGKILL');
      assert.deepEqual(await ended, { code: null, signal: 'SIGKILL' });
      const cleanedBy = Date.now() + 120_000;
      for (;;) {
        const containers = docker(['ps', '-aq', '--filter', 'label=papercusp.test.owner=' + owner]);
        const networks = docker(['network', 'ls', '-q', '--filter', 'label=papercusp.test.owner=' + owner]);
        const guardian = docker(['ps', '-aq', '--filter', 'name=^/' + reaper + '$']);
        if (!containers && !networks && !guardian) break;
        assert.ok(Date.now() < cleanedBy, 'external cleanup retained containers=' + containers + ' networks=' + networks + ' reaper=' + guardian);
        await new Promise(done => setTimeout(done, 250));
      }
      assert.equal(docker(['inspect', '--format', '{{.Name}}', sentinel]), '/' + sentinel);
      assert.equal(docker(['network', 'inspect', '--format', '{{.Name}}', sentinel]), sentinel);
    } finally {
      if (wrapper?.pid && wrapper.exitCode === null && wrapper.signalCode === null) {
        try { process.kill(-wrapper.pid, 'SIGKILL'); } catch { /* already ended */ }
      }
      // Only our recorded names, even after a failed assertion; never delete
      // the fleet-wide ownership population to clean up a failed test.
      for (const name of owner ? [owner + '-app', owner + '-mail', owner + '-pg', reaper, sentinel] : [sentinel]) {
        spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', timeout: 30_000 });
      }
      for (const name of owner ? [owner, sentinel] : [sentinel]) {
        spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore', timeout: 10_000 });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
