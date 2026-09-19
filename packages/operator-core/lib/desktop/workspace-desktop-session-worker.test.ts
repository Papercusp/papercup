import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { assertWorkspaceDesktopIdentity, workspaceDesktopEnvironment } from './workspace-desktop-session-worker';

describe('isolated desktop worker', () => {
  it('refuses root, operator, agent and substituted homes', () => {
    for (const identity of [
      { uid: 0, username: 'papercusp-desktop', home: '/var/lib/papercusp-desktop' },
      { uid: 900, username: 'papercusp', home: '/var/lib/papercusp-desktop' },
      { uid: 901, username: 'papercusp-agent', home: '/var/lib/papercusp-desktop' },
      { uid: 902, username: 'papercusp-desktop', home: '/home/papercusp-agent' },
    ]) expect(() => assertWorkspaceDesktopIdentity(identity)).toThrow();
    expect(() => assertWorkspaceDesktopIdentity({ uid: 902, username: 'papercusp-desktop', home: '/var/lib/papercusp-desktop' })).not.toThrow();
  });
  it('scrubs secrets, loader overrides and service identity from the environment', () => {
    const env = workspaceDesktopEnvironment({
      DATABASE_URL: 'postgres://secret', ANTHROPIC_API_KEY: 'secret', LD_PRELOAD: '/attack.so', NODE_OPTIONS: '--require attack',
      HOME: '/var/lib/papercusp', PATH: '/attack', DISPLAY: ':110', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/owned',
    });
    expect(env).toEqual({ HOME: '/var/lib/papercusp-desktop', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', DISPLAY: ':110', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/owned' });
  });
  it('bundles and executes with only builtins and no operator/database runtime', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const scratch = mkdtempSync(join(tmpdir(), 'desktop-worker-bundle-'));
    try {
      const out = join(scratch, 'worker.cjs'); const meta = join(scratch, 'meta.json');
      const built = spawnSync(join(root, 'node_modules/.bin/esbuild'), [
        join(root, 'packages/operator-core/bin/workspace-desktop-session.ts'), '--bundle', '--platform=node', '--format=cjs', '--target=node22',
        `--outfile=${out}`, `--metafile=${meta}`,
      ], { encoding: 'utf8', timeout: 30_000 });
      expect(built.status, built.stderr).toBe(0);
      const inputs = Object.keys(JSON.parse(readFileSync(meta, 'utf8')).inputs);
      expect(inputs.filter(path => /task-manager\/|papercusp-db|flags\/|orchestrator\/|exec-sandbox/.test(path))).toEqual([]);
      const result = spawnSync(process.execPath, [out, '--help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('papercusp-desktop-session --stdio');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 45_000);
});
