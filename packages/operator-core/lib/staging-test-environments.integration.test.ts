import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
      const e = process.env;
      const root = e.PAPERCUSP_WORKSPACES_ROOT;
      const id = e.PAPERCUSP_WORKSPACE_ID;
      console.log('RUNTIME_PROBE ' + JSON.stringify({
        privateHome: e.HOME !== process.env.TEST_LIVE_HOME,
        homeScoped: e.PAPERCUSP_HOME === e.HOME + '/.papercusp',
        workspaceScoped: id !== process.env.TEST_LIVE_WORKSPACE && e.PAPERCUSP_WORKSPACE === id,
        registryScoped: JSON.parse(fs.readFileSync(root + '/registry.json')).current === id,
        dbScoped: e.HARNESS_ADMIN_DATABASE_URL !== process.env.TEST_LIVE_DB,
        portScoped: e.PAPERCUSP_HONO_PORT !== process.env.TEST_LIVE_PORT,
        background: e.PAPERCUSP_BACKGROUND_WORKERS === '1',
        noLiveCredential: !e.PAPERCUSP_SID && !e.GOOGLE_APPLICATION_CREDENTIALS,
        noLiveIpc: !e.PAPERCUSP_SUBSTRATE_IPC_SOCKET && !e.PAPERCUSP_SPAWNER_IPC_SOCKET,
        noLiveDht: !e.PAPERCUSP_DHT_BOOTSTRAP,
        noLiveAgentSocket: !e.SSH_AUTH_SOCK,
        apiScoped: e.PAPERCUSP_OPERATOR_URL === 'http://127.0.0.1:' + e.PAPERCUSP_HONO_PORT,
        routinesDisabled: e.PAPERCUSP_DBOS_ROUTINES === '0' && e.PAPERCUSP_DBOS_TIMERS === '0',
        vmScoped: e.DBOS__VMID !== process.env.TEST_LIVE_VM,
        home: e.HOME
      }));
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
        console.log('BACKGROUND_HOST_PROBE ' + JSON.stringify({
          privateHome: process.env.PAPERCUSP_HOME === process.env.HOME + '/.papercusp',
          privateVm: process.env.DBOS__VMID.startsWith('test-runtime-'),
          privatePort: process.env.PAPERCUSP_HONO_PORT !== '3271',
          noScheduledRoutines: process.env.PAPERCUSP_DBOS_ROUTINES === '0',
          ready: readiness.ready && readiness.dbosEnabled && readiness.dbos,
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
