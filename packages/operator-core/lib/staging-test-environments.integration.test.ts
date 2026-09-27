import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
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
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = result.stdout.match(/^RUNTIME_PROBE (.+)$/m)?.[1];
    expect(payload).toBeTruthy();
    const { home, ...checks } = JSON.parse(payload!) as Record<string, unknown>;
    for (const [key, value] of Object.entries(checks)) expect(value, key).toBe(true);
    expect(existsSync(home as string)).toBe(false);
  }, 125_000);

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
