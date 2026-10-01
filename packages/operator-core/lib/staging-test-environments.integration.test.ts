import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_BUILD_TEST_CLASSES, SERVING_RUNTIMES } from './serving-runtimes';

const root = resolve(__dirname, '../../..');

describe('current-build execution route contract', () => {
  it('points every declared runnable route at maintained source and a real runtime', () => {
    for (const route of CURRENT_BUILD_TEST_CLASSES) {
      if (route.runtime) expect(SERVING_RUNTIMES[route.runtime]).toBeDefined();
      if (route.readiness === 'ready' || route.readiness === 'requires-prerequisites') {
        expect(route.routeFile, route.id).not.toBeNull();
        expect(existsSync(resolve(root, route.routeFile!)), route.id).toBe(true);
      }
      expect(route.prerequisites.length, route.id).toBeGreaterThan(0);
      expect(route.verification.length, route.id).toBeGreaterThan(20);
    }
  });

  it('does not promote a separate staging API port into isolated background or data ownership', () => {
    const api = CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'operator-api')!;
    const background = CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'background-federation')!;
    expect(api.runtime).toBe('staging-operator');
    expect(api.isolation).toMatch(/database and workspace are not isolated/i);
    expect(background.runtime).toBe('bg-host');
    expect(background.readiness).toBe('requires-prerequisites');
    expect(background.route).toContain('--isolated-runtime');
    expect(background.isolation).toMatch(/device keychain/);
  });

  it('boots a private migrated background environment and cleans it after a successful child', () => {
    const wrapper = resolve(root, 'scripts/with-test-pg.mjs');
    const probe = `
      const fs = require('node:fs');
      const postgres = require('postgres');
      const e = process.env;
      const root = e.PAPERCUSP_WORKSPACES_ROOT;
      const id = e.PAPERCUSP_WORKSPACE_ID;
      (async () => {
      const sql = postgres(e.HARNESS_ADMIN_DATABASE_URL, { max: 1 });
      const applied = await sql.unsafe('SELECT count(*)::int AS n FROM harness_shared.schema_migrations');
      await sql.end();
      console.log('RUNTIME_PROBE ' + JSON.stringify({
        privateHome: e.HOME !== process.env.TEST_LIVE_HOME,
        homeScoped: e.PAPERCUSP_HOME === e.HOME + '/.papercusp',
        workspaceScoped: id !== process.env.TEST_LIVE_WORKSPACE && e.PAPERCUSP_WORKSPACE === id,
        registryScoped: JSON.parse(fs.readFileSync(root + '/registry.json')).current === id,
        dbScoped: e.HARNESS_ADMIN_DATABASE_URL !== process.env.TEST_LIVE_DB,
        portScoped: e.PAPERCUSP_HONO_PORT !== process.env.TEST_LIVE_PORT,
        background: e.PAPERCUSP_BACKGROUND_WORKERS === '1',
        noVitestMarker: !e.VITEST && !e.VITEST_WORKER_ID,
        noLiveCredential: !e.PAPERCUSP_SID && !e.GOOGLE_APPLICATION_CREDENTIALS,
        noLiveIpc: !e.PAPERCUSP_SUBSTRATE_IPC_SOCKET && !e.PAPERCUSP_SPAWNER_IPC_SOCKET,
        noLiveDht: !e.PAPERCUSP_DHT_BOOTSTRAP,
        noLiveAgentSocket: !e.SSH_AUTH_SOCK,
        apiScoped: e.PAPERCUSP_OPERATOR_URL === 'http://127.0.0.1:' + e.PAPERCUSP_HONO_PORT,
        routinesDisabled: e.PAPERCUSP_DBOS_ROUTINES === '0' && e.PAPERCUSP_DBOS_TIMERS === '0',
        vmScoped: e.DBOS__VMID !== process.env.TEST_LIVE_VM,
        migrated: applied[0].n > 0,
        home: e.HOME
      }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, [wrapper, '--isolated-runtime', '--', process.execPath, '-e', probe], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        TEST_LIVE_HOME: process.env.HOME ?? '',
        TEST_LIVE_WORKSPACE: 'real-workspace',
        TEST_LIVE_DB: 'postgresql://live@localhost:5432/live',
        TEST_LIVE_PORT: '3271',
        PAPERCUSP_SID: 'live-agent',
        GOOGLE_APPLICATION_CREDENTIALS: '/do-not-inherit.json',
        PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/live/substrate.sock',
        PAPERCUSP_SPAWNER_IPC_SOCKET: '/live/spawner.sock',
        PAPERCUSP_DHT_BOOTSTRAP: 'live-host:1234',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070',
        SSH_AUTH_SOCK: '/live/agent.sock',
        TEST_LIVE_VM: 'live-background-vm',
        DBOS__VMID: 'live-background-vm',
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = result.stdout.match(/^RUNTIME_PROBE (.+)$/m)?.[1];
    expect(payload).toBeTruthy();
    const { home, ...checks } = JSON.parse(payload!) as Record<string, unknown>;
    for (const [key, value] of Object.entries(checks)) expect(value, key).toBe(true);
    expect(existsSync(home as string)).toBe(false);
  }, 125_000);

  it('mints a distinct device keychain identity for each isolated child', () => {
    const wrapper = resolve(root, 'scripts/with-test-pg.mjs');
    const keychainId = `current-build-isolation-${randomUUID()}`;
    const probe = `
      import { generateKeyPairSync, createHash } from 'node:crypto';
      import { keychainLoad, keychainStore } from './packages/operator-core/lib/identity/keychain.ts';
      const id = process.env.TEST_KEYCHAIN_ID;
      const before = await keychainLoad(id);
      if (before.kind !== 'error' || before.error.kind !== 'not_found') throw new Error('device key escaped its isolated home');
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      await keychainStore(id, privateKey.export({ type: 'pkcs8', format: 'der' }));
      const after = await keychainLoad(id);
      if (after.kind !== 'ok') throw new Error('private key did not persist in the isolated keychain');
      const pub = publicKey.export({ type: 'spki', format: 'der' });
      console.log('DEVICE_IDENTITY_PROBE ' + JSON.stringify({
        publicKeyHash: createHash('sha256').update(pub).digest('hex'),
        privateIdentityDir: process.env.PAPERCUSP_IDENTITY_DIR === process.env.PAPERCUSP_HOME + '/identity',
        noLiveKeyringBus: !process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.GNOME_KEYRING_CONTROL,
        home: process.env.HOME,
      }));
    `;
    const keys = [];
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [wrapper, '--isolated-runtime', '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
        cwd: root, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, TEST_KEYCHAIN_ID: keychainId, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/live/keyring-bus' },
      });
      expect(result.status, `${result.stdout.slice(-1000)}\n${result.stderr.slice(-1000)}`).toBe(0);
      const payload = result.stdout.match(/^DEVICE_IDENTITY_PROBE (.+)$/m)?.[1];
      expect(payload).toBeTruthy();
      const identity = JSON.parse(payload!) as { publicKeyHash: string; privateIdentityDir: boolean; noLiveKeyringBus: boolean; home: string };
      expect(identity.privateIdentityDir).toBe(true);
      expect(identity.noLiveKeyringBus).toBe(true);
      expect(existsSync(identity.home)).toBe(false);
      keys.push(identity.publicKeyHash);
    }
    expect(keys[0]).not.toBe(keys[1]);
  }, 245_000);

  it('preflights a private request-only API profile and reaps its real embedding sidecar', () => {
    const probe = `
      import { loadHarnessRegistry } from './packages/operator-core/lib/harness-registry.ts';
      const e = process.env;
      const registry = await loadHarnessRegistry(e.PAPERCUSP_WORKSPACE_ID, { fresh: true });
      const health = await (await fetch(e.PAPERCUSP_EMBED_SIDECAR_URL + '/healthz')).json();
      console.log('API_PROFILE_PROBE ' + JSON.stringify({
        requestOnly: e.PAPERCUSP_BACKGROUND_WORKERS === '0',
        dbosDisabled: e.PAPERCUSP_DBOS_ENABLE === '0' && e.PAPERCUSP_DBOS_ORCHESTRATOR === '0',
        homeRegistered: registry.projects.some(p => p.slug === e.PAPERCUSP_POT_HOME_SLUG && p.path.startsWith(e.PAPERCUSP_WORKSPACES_ROOT + '/')),
        privateSidecar: e.PAPERCUSP_EMBED_SIDECAR_URL !== 'http://127.0.0.1:3384' && health.capabilities.includes('POST /embed'),
        privateIngress: !!e.PAPERCUSP_EXTERNAL_INGRESS_PORT && e.PAPERCUSP_EXTERNAL_INGRESS_PORT !== e.PAPERCUSP_HONO_PORT,
        watchdogUnmodified: !e.PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB && !e.PAPERCUSP_MEMORY_WATCHDOG,
        noLiveIdentity: !e.PAPERCUSP_SID,
        home: e.HOME, sidecarPid: health.pid, sidecarUrl: e.PAPERCUSP_EMBED_SIDECAR_URL
      }));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PAPERCUSP_SID: 'live-agent', PAPERCUSP_EMBED_SIDECAR_URL: 'http://127.0.0.1:3384',
        PAPERCUSP_MEMORY_WATCHDOG: '0', PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '99999' },
    });
    expect(result.status, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-3000)}`).toBe(0);
    const payload = result.stdout.match(/^API_PROFILE_PROBE (.+)$/m)?.[1];
    expect(payload).toBeTruthy();
    const { home, sidecarPid, sidecarUrl, ...checks } = JSON.parse(payload!);
    for (const [key, value] of Object.entries(checks)) expect(value, key).toBe(true);
    expect(existsSync(home)).toBe(false);
    expect(() => process.kill(sidecarPid, 0)).toThrow();
    expect(sidecarUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 125_000);

  it('cleans the operator-api profile when the command fails', () => {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--', process.execPath, '-e',
      "console.log('FAILED_API_HOME ' + process.env.HOME); process.exit(7)"], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
    });
    expect(result.status, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-3000)}`).toBe(7);
    const home = result.stdout.match(/^FAILED_API_HOME (.+)$/m)?.[1];
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(false);
  }, 125_000);

  it('serves the real paired device API in the preflighted operator-api profile', () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'papercusp-paired-api-test-'));
    const bundle = join(bundleRoot, 'host/hono-host.mjs');
    symlinkSync(resolve(root, 'node_modules'), join(bundleRoot, 'node_modules'), 'dir');
    const probe = `
      const { spawn } = require('node:child_process');
      const path = require('node:path');
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const base = process.env.PAPERCUSP_OPERATOR_URL;
      const ingress = 'http://127.0.0.1:' + process.env.PAPERCUSP_EXTERNAL_INGRESS_PORT;
      const host = spawn(process.execPath, [process.env.TEST_BUNDLE_PATH], {
        cwd: path.join(process.cwd(), 'apps/operator'), env: process.env, stdio: ['ignore', 'pipe', 'pipe']
      });
      let head = '', tail = '', lastHttp = 'unreachable', paired = null;
      for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => {
        const text = chunk.toString(); head = (head + text).slice(0, 2000); tail = (tail + text).slice(-2000);
      });
      const call = async (route, method = 'GET', body, token) => {
        const response = await fetch(base + route, {
          method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
        });
        const json = await response.json();
        if (response.status !== 200) throw new Error(route + ' returned ' + response.status + ': ' + (json.error?.code ?? json.error ?? 'unknown'));
        return json;
      };
      (async () => {
        const deadline = Date.now() + 150000;
        let ready = false;
        while (Date.now() < deadline) {
          if (host.exitCode !== null || host.signalCode !== null) throw new Error('host exited ' + host.exitCode + '/' + host.signalCode);
          try {
            const r = await fetch(base + '/api/health/ready', { signal: AbortSignal.timeout(1500) });
            const json = await r.json(); lastHttp = r.status + ' ' + JSON.stringify(json);
            if (r.status === 200 && json.ready) { ready = true; break; }
          } catch (error) { lastHttp = String(error); }
          await wait(500);
        }
        if (!ready) throw new Error('request host did not become ready');
        const blockedMint = await fetch(ingress + '/api/device/desktop/mint-pair-token', {
          method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' },
          body: JSON.stringify({ workspaceId: process.env.PAPERCUSP_WORKSPACE_ID }), signal: AbortSignal.timeout(30000)
        });
        if (blockedMint.status !== 403) throw new Error('external ingress admitted desktop mint: ' + blockedMint.status);
        const blockedRead = await fetch(ingress + '/api/device/attention', { signal: AbortSignal.timeout(30000) });
        if (![401, 403].includes(blockedRead.status)) throw new Error('external ingress admitted anonymous device read: ' + blockedRead.status);
        const mint = await call('/api/device/desktop/mint-pair-token', 'POST', { workspaceId: process.env.PAPERCUSP_WORKSPACE_ID });
        paired = await call('/api/device/pair', 'POST', { pairToken: mint.qrPayload.pairToken });
        if (!paired.deviceId || !paired.deviceToken || paired.workspaceId !== process.env.PAPERCUSP_WORKSPACE_ID) throw new Error('pair identity mismatch');
        const paths = ['/api/device/runtime-config', '/api/device/attention', '/api/device/plans', '/api/device/monitoring', '/api/device/devices'];
        for (const route of paths) await call(route, 'GET', undefined, paired.deviceToken);
        for (const route of paths) {
          const response = await fetch(ingress + route, { headers: { authorization: 'Bearer ' + paired.deviceToken }, signal: AbortSignal.timeout(30000) });
          if (response.status !== 200) throw new Error('external paired read ' + route + ': ' + response.status);
        }
        for (const name of ['toastLog.recent', 'auditLog.recent', 'operatorScans.running', 'harnessStatus.list', 'standingCandidates.list']) {
          const json = await call('/api/device/rest-query?name=' + name + '&args=%7B%7D', 'GET', undefined, paired.deviceToken);
          if (!Array.isArray(json.rows)) throw new Error('rest-query ' + name + ' did not return rows');
        }
        console.log('PAIRED_API_PROBE ' + JSON.stringify({ paired: true, deviceReads: paths.length, externalDeviceReads: paths.length,
          deniedExternalMint: true, deniedAnonymousRead: true, restQueries: 5, home: process.env.HOME }));
      })().catch(error => {
        console.error('PAIRED_API_FAILURE ' + JSON.stringify({ message: String(error), lastHttp, exitCode: host.exitCode, signalCode: host.signalCode, head, tail }));
        process.exitCode = 1;
      }).finally(async () => {
        if (paired?.deviceId) {
          try { await call('/api/device/devices/' + paired.deviceId, 'DELETE', undefined, paired.deviceToken); }
          catch (error) { console.error('PAIR_REVOKE_FAILURE ' + String(error)); process.exitCode = 1; }
        }
        if (host.exitCode === null && host.signalCode === null) {
          const exited = new Promise(resolve => host.once('exit', resolve));
          host.kill('SIGTERM'); await Promise.race([exited, wait(5000)]);
          if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await exited; }
        }
        host.stdout.destroy(); host.stderr.destroy();
      });
    `;
    try {
      const build = spawnSync('bash', [resolve(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle], {
        cwd: resolve(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
      });
      expect(build.status, `${build.stdout.slice(-2000)}\n${build.stderr.slice(-2000)}`).toBe(0);
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '-e', probe], {
        cwd: root, encoding: 'utf8', timeout: 210_000, env: { ...process.env, TEST_BUNDLE_PATH: bundle },
      });
      const failure = result.stderr.match(/^PAIRED_API_FAILURE (.+)$/m)?.[1];
      expect(result.status, failure ?? `${result.stdout.slice(-1000)}\n${result.stderr.slice(-2000)}`).toBe(0);
      const payload = result.stdout.match(/^PAIRED_API_PROBE (.+)$/m)?.[1];
      expect(payload).toBeTruthy();
      const measured = JSON.parse(payload!);
      expect(measured.paired).toBe(true);
      expect(measured.deviceReads).toBe(5);
      expect(measured.externalDeviceReads).toBe(5);
      expect(measured.deniedExternalMint).toBe(true);
      expect(measured.deniedAnonymousRead).toBe(true);
      expect(measured.restQueries).toBe(5);
      expect(existsSync(measured.home)).toBe(false);
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
    }
  }, 335_000);

  it('boots the real background host with private DBOS readiness and reaps it', () => {
    const wrapper = resolve(root, 'scripts/with-test-pg.mjs');
    const bundleRoot = mkdtempSync(join(tmpdir(), 'papercusp-current-host-test-'));
    const bundle = join(bundleRoot, 'host/hono-host.mjs');
    symlinkSync(resolve(root, 'node_modules'), join(bundleRoot, 'node_modules'), 'dir');
    const probe = `
      const { spawn } = require('node:child_process');
      const path = require('node:path');
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const base = 'http://127.0.0.1:' + process.env.PAPERCUSP_HONO_PORT;
      const host = spawn(process.execPath, [process.env.TEST_BUNDLE_PATH], {
        cwd: path.join(process.cwd(), 'apps/operator'),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let head = '';
      let tail = '';
      let lastHttp = 'unreachable';
      for (const stream of [host.stdout, host.stderr]) {
        stream.on('data', (chunk) => {
          const text = chunk.toString();
          head = (head + text).slice(0, 2000);
          tail = (tail + text).slice(-2000);
        });
      }
      (async () => {
        const deadline = Date.now() + 150000;
        let readiness;
        while (Date.now() < deadline) {
          if (host.exitCode !== null) throw new Error('host exited ' + host.exitCode + ': ' + tail);
          try {
            const response = await fetch(base + '/api/health/ready', { signal: AbortSignal.timeout(1500) });
            const body = await response.json();
            lastHttp = String(response.status) + ' ' + JSON.stringify(body);
            if (response.status === 200 && body.ready && body.dbosEnabled && body.dbos) {
              readiness = body;
              break;
            }
          } catch (error) { lastHttp = String(error); }
          await wait(500);
        }
        if (!readiness) throw new Error('background DBOS did not become ready');
        const federationResponse = await fetch(base + '/api/discovery/federation-status', {
          signal: AbortSignal.timeout(10000),
        });
        const federation = await federationResponse.json();
        console.log('BACKGROUND_HOST_PROBE ' + JSON.stringify({
          privateHome: process.env.PAPERCUSP_HOME === process.env.HOME + '/.papercusp',
          privateVm: process.env.DBOS__VMID.startsWith('test-runtime-'),
          privatePort: process.env.PAPERCUSP_HONO_PORT !== '3271',
          noScheduledRoutines: process.env.PAPERCUSP_DBOS_ROUTINES === '0',
          ready: readiness.ready && readiness.dbosEnabled && readiness.dbos,
          federationRead: federationResponse.status === 200 && federation.ok === true && Array.isArray(federation.hives) && !!federation.substrate,
          home: process.env.HOME,
        }));
      })().catch((error) => {
        console.error('BACKGROUND_HOST_FAILURE ' + JSON.stringify({
          message: String(error), lastHttp, exitCode: host.exitCode, head, tail,
        }));
        process.exitCode = 1;
      }).finally(async () => {
        const exited = new Promise((resolve) => host.once('exit', resolve));
        host.kill('SIGTERM');
        await Promise.race([exited, wait(5000)]);
        if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
        host.stdout.destroy();
        host.stderr.destroy();
      });
    `;
    try {
      const build = spawnSync('bash', [resolve(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle], {
        cwd: resolve(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
      });
      expect(build.status, `${build.stdout.slice(-2000)}\n${build.stderr.slice(-2000)}`).toBe(0);
      const result = spawnSync(process.execPath, [wrapper, '--isolated-runtime', '--', process.execPath, '-e', probe], {
        cwd: root,
        encoding: 'utf8',
        timeout: 190_000,
        env: { ...process.env, TEST_BUNDLE_PATH: bundle },
      });
      const failure = result.stderr.match(/^BACKGROUND_HOST_FAILURE (.+)$/m)?.[1];
      expect(result.status, failure ?? `${result.stdout.slice(-1000)}\n${result.stderr.slice(-1000)}`).toBe(0);
      const payload = result.stdout.match(/^BACKGROUND_HOST_PROBE (.+)$/m)?.[1];
      expect(payload, result.stdout.slice(-4000)).toBeTruthy();
      const { home, ...checks } = JSON.parse(payload!) as Record<string, unknown>;
      for (const [key, value] of Object.entries(checks)) expect(value, key).toBe(true);
      expect(existsSync(home as string)).toBe(false);
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
    }
  }, 320_000);

  it('cleans the private database and device home after a failing child', () => {
    const wrapper = resolve(root, 'scripts/with-test-pg.mjs');
    const result = spawnSync(process.execPath, [
      wrapper, '--isolated-runtime', '--', process.execPath, '-e',
      "console.log('FAILED_HOME ' + process.env.HOME); process.exit(7)",
    ], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(7);
    const home = result.stdout.match(/^FAILED_HOME (.+)$/m)?.[1];
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(false);
  }, 125_000);

  it('requires opt-in private data for mutable desktop tests and protects the release boundary', () => {
    const desktop = CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'desktop-native')!;
    const script = readFileSync(resolve(root, desktop.routeFile!), 'utf8');
    expect(script).toContain('VERIFY_TAURI_ISOLATED_DB=1');
    expect(desktop.prerequisites.join(' ')).toContain('VERIFY_TAURI_ISOLATED_DB=1');
    expect(CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'final-release')?.readiness)
      .toBe('release-only');
  });
});
