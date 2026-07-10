/**
 * Unit tests for the per-branch action registry.
 *
 * Covers:
 *   - listActions discovers .sh files and ignores other files
 *   - listActions rejects malformed names (path traversal etc.)
 *   - runAction validates branch + name, writes log + meta, captures stdout/stderr
 *   - runAction sets PAPERCUSP_* env vars correctly
 *   - listRuns marks orphaned "running" runs as failed when log is stale
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// runAction fires a best-effort pre-destructive backup snapshot (a deliberate
// fire-and-forget side effect). The backup subsystem isn't configured in this
// unit env, so the real trigger would hit getOrgPg() and console.warn a
// "snapshot failed" line — tripping vitest-fail-on-console on a path that has
// nothing to do with branch actions. Stub it out; backups have their own tests
// in packages/backup.
vi.mock('./backup', () => ({ triggerSnapshotEvent: vi.fn(async () => {}) }));

import {
  BRANCHES, isBranch, listActions, listRuns, runAction, MissingEnvError,
} from './branch-actions';
import { resolveEnv } from './branch-action-manifest';

let staging: string;

async function writeAction(branch: string, name: string, script: string) {
  const dir = join(staging, '.papercusp', 'actions', branch);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.sh`);
  await writeFile(path, script, { mode: 0o755 });
  await fs.chmod(path, 0o755);
  return path;
}

beforeEach(async () => {
  staging = await mkdtemp(join(tmpdir(), 'branch-actions-test-'));
});

afterEach(async () => {
  await rm(staging, { recursive: true, force: true });
});

describe('isBranch', () => {
  it('accepts the three valid branches', () => {
    for (const b of BRANCHES) expect(isBranch(b)).toBe(true);
  });
  it('rejects everything else', () => {
    for (const v of ['', 'main', 'STAGING', 'staging ', null, undefined, 42]) {
      expect(isBranch(v)).toBe(false);
    }
  });
});

describe('listActions', () => {
  it('returns [] when no actions dir exists', async () => {
    expect(await listActions(staging, 'staging')).toEqual([]);
  });

  it('discovers .sh files and ignores non-.sh', async () => {
    await writeAction('staging', 'build', '#!/bin/bash\necho hi');
    await writeAction('staging', 'deploy', '#!/bin/bash\necho hi');
    const dir = join(staging, '.papercusp', 'actions', 'staging');
    await writeFile(join(dir, 'README.md'), 'docs');
    await writeFile(join(dir, 'helper.sh.bak'), 'old');

    const out = await listActions(staging, 'staging');
    expect(out.map((a) => a.name).sort()).toEqual(['build', 'deploy']);
  });

  it('skips files with traversal/special characters in their name', async () => {
    const dir = join(staging, '.papercusp', 'actions', 'staging');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '..evil.sh'), '#!/bin/bash');
    await writeFile(join(dir, 'has space.sh'), '#!/bin/bash');
    await writeFile(join(dir, 'ok-name_1.sh'), '#!/bin/bash');
    const out = await listActions(staging, 'staging');
    expect(out.map((a) => a.name)).toEqual(['ok-name_1']);
  });
});

describe('runAction', () => {
  it('runs a simple script and writes log + meta with status=completed', async () => {
    await writeAction(
      'staging', 'hello',
      '#!/bin/bash\necho stdout-line\n>&2 echo stderr-line\nexit 0\n',
    );

    const handle = await runAction({
      stagingPath: staging, harness: 'h1', branch: 'staging', name: 'hello',
    });
    const meta = await handle.done;

    expect(meta.status).toBe('completed');
    expect(meta.exitCode).toBe(0);
    expect(meta.runId).toMatch(/^run-\d+-[a-f0-9]{8}$/);
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);

    const metaOnDisk = JSON.parse(
      await fs.readFile(
        join(staging, '.papercusp', 'action-runs', 'staging', 'hello', `${meta.runId}.json`),
        'utf8',
      ),
    );
    expect(metaOnDisk.status).toBe('completed');

    const log = await fs.readFile(
      join(staging, '.papercusp', 'action-runs', 'staging', 'hello', `${meta.runId}.log`),
      'utf8',
    );
    expect(log).toContain('::papercusp::action-started');
    expect(log).toContain('stdout-line');
    expect(log).toContain('::papercusp::stderr\tstderr-line');
    expect(log).toContain('::papercusp::action-completed');
  });

  // settings-audit 2026-07-09: /settings/backups ships `post_run` ("After each
  // {pot} run") ON by default, but NOTHING ever emitted it, so the checkbox was
  // inert. This runner owns the operator's run lifecycle — it already fires
  // `pre_destructive` before the child spawns — so its terminal `close` is where
  // the post-run snapshot belongs. Pins both halves of that pairing.
  it('fires pre_destructive before the run and post_run after it completes', async () => {
    const { triggerSnapshotEvent } = await import('./backup');
    vi.mocked(triggerSnapshotEvent).mockClear();

    await writeAction('staging', 'snap', '#!/bin/bash\nexit 0\n');
    const handle = await runAction({
      stagingPath: staging, harness: 'h1', branch: 'staging', name: 'snap',
    });
    const meta = await handle.done;

    const reasons = vi.mocked(triggerSnapshotEvent).mock.calls.map((c) => c[1]);
    expect(reasons).toContain('pre_destructive');
    expect(reasons).toContain('post_run');

    const postRun = vi.mocked(triggerSnapshotEvent).mock.calls.find((c) => c[1] === 'post_run');
    expect(postRun?.[2]).toMatchObject({
      op: 'branch_action_run', harness: 'h1', branch: 'staging', name: 'snap',
      runId: meta.runId, exitCode: 0, status: 'completed',
    });
  });

  it('fires post_run even when the run FAILS (a failed run mutates the tree too)', async () => {
    const { triggerSnapshotEvent } = await import('./backup');
    vi.mocked(triggerSnapshotEvent).mockClear();

    await writeAction('staging', 'snapfail', '#!/bin/bash\nexit 3\n');
    const handle = await runAction({
      stagingPath: staging, harness: 'h1', branch: 'staging', name: 'snapfail',
    });
    await handle.done;

    const postRun = vi.mocked(triggerSnapshotEvent).mock.calls.find((c) => c[1] === 'post_run');
    expect(postRun).toBeTruthy();
    expect(postRun?.[2]).toMatchObject({ exitCode: 3, status: 'failed' });
  });

  it('a failing backup never breaks the run', async () => {
    const { triggerSnapshotEvent } = await import('./backup');
    vi.mocked(triggerSnapshotEvent).mockRejectedValueOnce(new Error('kopia down'));

    await writeAction('staging', 'snapresil', '#!/bin/bash\nexit 0\n');
    const handle = await runAction({
      stagingPath: staging, harness: 'h1', branch: 'staging', name: 'snapresil',
    });
    const meta = await handle.done;
    expect(meta.status).toBe('completed');

    vi.mocked(triggerSnapshotEvent).mockImplementation(async () => {});
  });

  it('records exit code on failure', async () => {
    await writeAction('staging', 'fail', '#!/bin/bash\nexit 7\n');
    const handle = await runAction({
      stagingPath: staging, harness: 'h1', branch: 'staging', name: 'fail',
    });
    const meta = await handle.done;
    expect(meta.status).toBe('failed');
    expect(meta.exitCode).toBe(7);
  });

  it('exposes PAPERCUSP_* env vars to the script', async () => {
    await writeAction(
      'staging', 'env',
      '#!/bin/bash\n' +
      'echo "BRANCH=$PAPERCUSP_BRANCH"\n' +
      'echo "SLUG=$PAPERCUSP_HARNESS_SLUG"\n' +
      'echo "ACTION=$PAPERCUSP_ACTION_NAME"\n' +
      'echo "RUN_ID=$PAPERCUSP_RUN_ID"\n' +
      'echo "PROJ=$PAPERCUSP_PROJECT_DIR"\n',
    );
    const handle = await runAction({
      stagingPath: staging, harness: 'h1', branch: 'staging', name: 'env',
    });
    const meta = await handle.done;
    expect(meta.status).toBe('completed');
    const log = await fs.readFile(
      join(staging, '.papercusp', 'action-runs', 'staging', 'env', `${meta.runId}.log`),
      'utf8',
    );
    expect(log).toContain('BRANCH=staging');
    expect(log).toContain('SLUG=h1');
    expect(log).toContain('ACTION=env');
    expect(log).toContain(`RUN_ID=${meta.runId}`);
    expect(log).toContain(`PROJ=${staging}`);
  });

  it('rejects invalid branches', async () => {
    await expect(runAction({
      stagingPath: staging, harness: 'h', branch: 'main' as any, name: 'x',
    })).rejects.toThrow(/invalid branch/);
  });

  it('rejects invalid action names', async () => {
    await expect(runAction({
      stagingPath: staging, harness: 'h', branch: 'staging', name: '../oops',
    })).rejects.toThrow(/invalid action name/);
  });

  it('rejects unknown actions', async () => {
    await expect(runAction({
      stagingPath: staging, harness: 'h', branch: 'staging', name: 'missing',
    })).rejects.toThrow(/action not found/);
  });

  it('uses phasePath as cwd when provided and exists', async () => {
    const phase = join(staging, '..', 'phase-' + Date.now().toString(36));
    await mkdir(phase, { recursive: true });
    try {
      await writeAction('testing', 'pwd', '#!/bin/bash\necho "AT=$PWD"\n');
      const handle = await runAction({
        stagingPath: staging, phasePath: phase, harness: 'h1',
        branch: 'testing', name: 'pwd',
      });
      const meta = await handle.done;
      const log = await fs.readFile(
        join(staging, '.papercusp', 'action-runs', 'testing', 'pwd', `${meta.runId}.log`),
        'utf8',
      );
      // Realpath may differ on macOS (/private/tmp etc.); compare resolved.
      const realPhase = await fs.realpath(phase);
      expect(log).toContain(`AT=${realPhase}`);
    } finally {
      await rm(phase, { recursive: true, force: true });
    }
  });
});

describe('listRuns', () => {
  it('returns runs sorted newest-first', async () => {
    await writeAction('staging', 'a', '#!/bin/bash\nexit 0\n');
    const r1 = await runAction({ stagingPath: staging, harness: 'h', branch: 'staging', name: 'a' });
    await r1.done;
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await runAction({ stagingPath: staging, harness: 'h', branch: 'staging', name: 'a' });
    await r2.done;

    const runs = await listRuns(staging, 'staging', 'a');
    expect(runs.length).toBe(2);
    expect(runs[0].runId).toBe(r2.runId);
    expect(runs[1].runId).toBe(r1.runId);
  });

  it('marks stale running runs as failed', async () => {
    await writeAction('staging', 'a', '#!/bin/bash\nexit 0\n');
    const r = await runAction({ stagingPath: staging, harness: 'h', branch: 'staging', name: 'a' });
    await r.done;

    // Mutate the meta back to "running" and back-date both files by 10 min
    const dir = join(staging, '.papercusp', 'action-runs', 'staging', 'a');
    const metaPath = join(dir, `${r.runId}.json`);
    const logPath = join(dir, `${r.runId}.log`);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.status = 'running';
    delete meta.exitCode;
    delete meta.endedAt;
    delete meta.durationMs;
    await fs.writeFile(metaPath, JSON.stringify(meta));
    const past = (Date.now() - 10 * 60 * 1000) / 1000;
    await utimes(logPath, past, past);

    const runs = await listRuns(staging, 'staging', 'a');
    expect(runs[0].status).toBe('failed');
    expect(runs[0].signal).toBe('orphaned');
  });

  it('does NOT mark fresh running runs as failed', async () => {
    await writeAction('staging', 'a', '#!/bin/bash\nexit 0\n');
    const r = await runAction({ stagingPath: staging, harness: 'h', branch: 'staging', name: 'a' });
    await r.done;

    const dir = join(staging, '.papercusp', 'action-runs', 'staging', 'a');
    const metaPath = join(dir, `${r.runId}.json`);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.status = 'running';
    await fs.writeFile(metaPath, JSON.stringify(meta));
    // Log file is fresh — should remain "running".

    const runs = await listRuns(staging, 'staging', 'a');
    expect(runs[0].status).toBe('running');
  });
});

describe('action manifests', () => {
  it('reads inline manifest from <name>.manifest.json sibling', async () => {
    await writeAction('staging', 'deploy', '#!/bin/bash\necho ok\n');
    const dir = join(staging, '.papercusp', 'actions', 'staging');
    await writeFile(join(dir, 'deploy.manifest.json'), JSON.stringify({
      displayName: 'Deploy to prod',
      env: { TOKEN: { from: 'literal', value: 'xyz' } },
    }));

    const out = await listActions(staging, 'staging');
    expect(out).toHaveLength(1);
    expect(out[0].manifest?.displayName).toBe('Deploy to prod');
    expect(out[0].manifest?.env?.TOKEN).toEqual({ from: 'literal', value: 'xyz' });
  });
});

describe('env resolution + run injection', () => {
  let configsDir: string;
  beforeEach(async () => {
    configsDir = await mkdtemp(join(tmpdir(), 'configs-'));
    await mkdir(join(configsDir, 'plugin-configs', '@scope'), { recursive: true });
  });
  afterEach(async () => { await rm(configsDir, { recursive: true, force: true }); });

  it('throws MissingEnvError when required plugin field is absent', async () => {
    await writeAction('staging', 'deploy', '#!/bin/bash\nexit 0\n');
    const adir = join(staging, '.papercusp', 'actions', 'staging');
    await writeFile(join(adir, 'deploy.manifest.json'), JSON.stringify({
      env: {
        API_TOKEN: { from: 'plugin', plugin: '@scope/p', field: 'token', required: true },
      },
    }));
    // Empty plugin-config — token missing
    await writeFile(join(configsDir, 'plugin-configs', '@scope', 'p.json'), JSON.stringify({}));

    await expect(runAction({
      stagingPath: staging, harness: 'h', branch: 'staging', name: 'deploy',
      harnessConfigsDir: configsDir,
    })).rejects.toBeInstanceOf(MissingEnvError);
  });

  it('injects resolved env vars into the spawned script', async () => {
    await writeAction(
      'staging', 'deploy',
      '#!/bin/bash\necho "TOKEN=$API_TOKEN"\necho "ACCT=$ACCOUNT"\n',
    );
    const adir = join(staging, '.papercusp', 'actions', 'staging');
    await writeFile(join(adir, 'deploy.manifest.json'), JSON.stringify({
      env: {
        API_TOKEN: { from: 'plugin', plugin: '@scope/p', field: 'token', required: true },
        ACCOUNT:   { from: 'plugin', plugin: '@scope/p', field: 'accountId', required: true },
      },
    }));
    await writeFile(join(configsDir, 'plugin-configs', '@scope', 'p.json'), JSON.stringify({
      token: 'sk-secret-123', accountId: 'acct-abc',
    }));

    const handle = await runAction({
      stagingPath: staging, harness: 'h', branch: 'staging', name: 'deploy',
      harnessConfigsDir: configsDir,
    });
    const meta = await handle.done;
    expect(meta.status).toBe('completed');
    const log = await fs.readFile(
      join(staging, '.papercusp', 'action-runs', 'staging', 'deploy', `${meta.runId}.log`),
      'utf8',
    );
    expect(log).toContain('TOKEN=sk-secret-123');
    expect(log).toContain('ACCT=acct-abc');
  });

  it('skipEnvCheck bypasses the missing-env guard', async () => {
    await writeAction('staging', 'deploy', '#!/bin/bash\nexit 0\n');
    const adir = join(staging, '.papercusp', 'actions', 'staging');
    await writeFile(join(adir, 'deploy.manifest.json'), JSON.stringify({
      env: { API_TOKEN: { from: 'plugin', plugin: '@scope/p', field: 'token', required: true } },
    }));
    await writeFile(join(configsDir, 'plugin-configs', '@scope', 'p.json'), JSON.stringify({}));

    const handle = await runAction({
      stagingPath: staging, harness: 'h', branch: 'staging', name: 'deploy',
      harnessConfigsDir: configsDir,
      skipEnvCheck: true,
    });
    const meta = await handle.done;
    expect(meta.status).toBe('completed');
  });

  it('resolveEnv resolves literal values', async () => {
    const r = await resolveEnv(
      { env: { X: { from: 'literal', value: 'hi' } } },
      { harnessConfigsDir: configsDir },
    );
    expect(r.env.X).toBe('hi');
    expect(r.missing).toEqual([]);
  });

  it('resolveEnv reads from harness env.json', async () => {
    await writeFile(join(configsDir, 'env.json'), JSON.stringify({ FOO: 'bar' }));
    const r = await resolveEnv(
      { env: { FOO: { from: 'harness', field: 'FOO', required: true } } },
      { harnessConfigsDir: configsDir },
    );
    expect(r.env.FOO).toBe('bar');
  });

  it('resolveEnv reports `missing` for absent required vars', async () => {
    const r = await resolveEnv(
      { env: { X: { from: 'plugin', plugin: '@scope/p', field: 'token', required: true } } },
      { harnessConfigsDir: configsDir },
    );
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0].name).toBe('X');
    expect(r.missing[0].plugin).toBe('@scope/p');
  });

  it('resolveEnv treats absent NON-required vars as silent', async () => {
    const r = await resolveEnv(
      { env: { X: { from: 'harness', field: 'X' /* required omitted */ } } },
      { harnessConfigsDir: configsDir },
    );
    expect(r.missing).toEqual([]);
    expect(r.env.X).toBeUndefined();
  });
});

describe('plugin-contributed actions', () => {
  let pluginsDir: string;
  let configsDir: string;
  beforeEach(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), 'plugins-'));
    configsDir = await mkdtemp(join(tmpdir(), 'configs-'));
  });
  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true });
    await rm(configsDir, { recursive: true, force: true });
  });

  it('discovers a plugin-contributed action when its plugin is enabled', async () => {
    const pdir = join(pluginsDir, '@scope', 'mything');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'papercusp.json'), JSON.stringify({
      name: '@scope/mything',
      branchActions: {
        deploy: {
          branches: ['staging'],
          displayName: 'Deploy via mything',
          scriptPath: 'actions/deploy.sh',
        },
      },
    }));
    await mkdir(join(pdir, 'actions'), { recursive: true });
    await writeFile(join(pdir, 'actions/deploy.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    await writeFile(
      join(configsDir, 'enabled-plugins.json'),
      JSON.stringify({ enabled: { '@scope/mything': { version: '0.1.0' } } }),
    );

    const out = await listActions(staging, 'staging', {
      harnessConfigsDir: configsDir,
      globalPluginsDir: pluginsDir,
    });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('@scope/mything:deploy');
    expect(out[0].source).toBe('plugin');
    expect(out[0].pluginSlug).toBe('@scope/mything');
    expect(out[0].manifest?.displayName).toBe('Deploy via mything');
  });

  it('skips plugin actions whose branch list excludes the queried branch', async () => {
    const pdir = join(pluginsDir, 'simple');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'papercusp.json'), JSON.stringify({
      name: 'simple',
      branchActions: {
        prod_only: { branches: ['production'], scriptPath: 'go.sh' },
      },
    }));
    await writeFile(join(pdir, 'go.sh'), '#!/bin/bash\n');
    await writeFile(
      join(configsDir, 'enabled-plugins.json'),
      JSON.stringify({ enabled: { simple: { version: '0.1.0' } } }),
    );

    const staging_actions = await listActions(staging, 'staging', {
      harnessConfigsDir: configsDir, globalPluginsDir: pluginsDir,
    });
    expect(staging_actions).toEqual([]);

    const prod_actions = await listActions(staging, 'production', {
      harnessConfigsDir: configsDir, globalPluginsDir: pluginsDir,
    });
    expect(prod_actions).toHaveLength(1);
    expect(prod_actions[0].name).toBe('simple:prod_only');
  });

  it('runs plugin-contributed actions; from:config resolves to the plugin\'s own config', async () => {
    const pdir = join(pluginsDir, '@scope', 'cf');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'papercusp.json'), JSON.stringify({
      name: '@scope/cf',
      branchActions: {
        deploy: {
          branches: ['staging'],
          scriptPath: 'deploy.sh',
          env: { TOKEN: { from: 'config', field: 'apiToken', required: true } },
        },
      },
    }));
    await writeFile(join(pdir, 'deploy.sh'), '#!/bin/bash\necho "TOKEN=$TOKEN"\n', { mode: 0o755 });
    await writeFile(
      join(configsDir, 'enabled-plugins.json'),
      JSON.stringify({ enabled: { '@scope/cf': { version: '0.1.0' } } }),
    );
    await mkdir(join(configsDir, 'plugin-configs', '@scope'), { recursive: true });
    await writeFile(
      join(configsDir, 'plugin-configs', '@scope', 'cf.json'),
      JSON.stringify({ apiToken: 'plugin-supplied-token' }),
    );

    const handle = await runAction({
      stagingPath: staging, harness: 'h', branch: 'staging',
      name: '@scope/cf:deploy',
      harnessConfigsDir: configsDir,
      globalPluginsDir: pluginsDir,
    });
    const meta = await handle.done;
    expect(meta.status).toBe('completed');
    const safeName = '_scope_cf_deploy';
    const log = await fs.readFile(
      join(staging, '.papercusp', 'action-runs', 'staging', safeName, `${meta.runId}.log`),
      'utf8',
    );
    expect(log).toContain('TOKEN=plugin-supplied-token');
  });

  it('discovers URL-based buttons under buttons.<branch>.<name>', async () => {
    const pdir = join(pluginsDir, '@scope', 'cf');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'papercusp.json'), JSON.stringify({
      name: '@scope/cf',
      buttons: {
        staging: { build: '/api/plugins/@scope/cf/build-staging' },
        production: {
          build: { url: '/api/plugins/@scope/cf/build-prod', displayName: 'Build & deploy (prod)' },
        },
      },
    }));
    await writeFile(
      join(configsDir, 'enabled-plugins.json'),
      JSON.stringify({ enabled: { '@scope/cf': { version: '0.1.0' } } }),
    );

    const staging = await listActions('/tmp/unused', 'staging', {
      harnessConfigsDir: configsDir, globalPluginsDir: pluginsDir,
    });
    expect(staging).toHaveLength(1);
    expect(staging[0].name).toBe('@scope/cf:build');
    expect(staging[0].source).toBe('plugin-button');
    expect(staging[0].buttonUrl).toBe('/api/plugins/@scope/cf/build-staging');
    expect(staging[0].buttonMethod).toBe('POST');

    const prod = await listActions('/tmp/unused', 'production', {
      harnessConfigsDir: configsDir, globalPluginsDir: pluginsDir,
    });
    expect(prod).toHaveLength(1);
    expect(prod[0].buttonUrl).toBe('/api/plugins/@scope/cf/build-prod');
    expect(prod[0].manifest?.displayName).toBe('Build & deploy (prod)');
  });

  it('button per-branch URL routing — different URLs for staging vs production', async () => {
    const pdir = join(pluginsDir, 'p');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'papercusp.json'), JSON.stringify({
      name: 'p',
      buttons: {
        staging: { build: '/api/build-staging' },
        production: { build: '/api/build-prod' },
      },
    }));
    await writeFile(
      join(configsDir, 'enabled-plugins.json'),
      JSON.stringify({ enabled: { p: { version: '0.1.0' } } }),
    );

    const s = await listActions('/tmp/unused', 'staging', { harnessConfigsDir: configsDir, globalPluginsDir: pluginsDir });
    const t = await listActions('/tmp/unused', 'testing', { harnessConfigsDir: configsDir, globalPluginsDir: pluginsDir });
    const p = await listActions('/tmp/unused', 'production', { harnessConfigsDir: configsDir, globalPluginsDir: pluginsDir });

    expect(s[0]?.buttonUrl).toBe('/api/build-staging');
    expect(t).toEqual([]); // no testing button declared
    expect(p[0]?.buttonUrl).toBe('/api/build-prod');
  });

  it('runAction dispatches HTTP for plugin-button and writes log lines', async () => {
    const pdir = join(pluginsDir, 'echo');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'papercusp.json'), JSON.stringify({
      name: 'echo',
      buttons: { staging: { build: 'http://localhost:0/' } },
    }));
    await writeFile(
      join(configsDir, 'enabled-plugins.json'),
      JSON.stringify({ enabled: { echo: { version: '0.1.0' } } }),
    );

    // Override fetch to record + return a known body.
    const origFetch = globalThis.fetch;
    let captured: { url: string; body: string } | null = null;
    globalThis.fetch = (async (input: any, init: any) => {
      captured = { url: typeof input === 'string' ? input : input.url, body: init?.body ?? '' };
      return new Response('plugin says hi\n', { headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;

    try {
      const handle = await runAction({
        stagingPath: staging,
        harness: 'h', branch: 'staging',
        name: 'echo:build',
        harnessConfigsDir: configsDir,
        globalPluginsDir: pluginsDir,
      });
      const meta = await handle.done;
      expect(meta.status).toBe('completed');
      expect(captured?.url).toContain('http://localhost:0/');
      const body = JSON.parse(captured!.body);
      expect(body.harness).toBe('h');
      expect(body.branch).toBe('staging');
      expect(body.button).toBe('build');
      // Log captured the response
      const safeName = 'echo_build';
      const log = await fs.readFile(
        join(staging, '.papercusp', 'action-runs', 'staging', safeName, `${meta.runId}.log`),
        'utf8',
      );
      expect(log).toContain('plugin says hi');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('runAction marks plugin-button as failed on non-2xx response', async () => {
    const pdir = join(pluginsDir, 'fail');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'papercusp.json'), JSON.stringify({
      name: 'fail',
      buttons: { staging: { build: 'http://localhost:0/' } },
    }));
    await writeFile(
      join(configsDir, 'enabled-plugins.json'),
      JSON.stringify({ enabled: { fail: { version: '0.1.0' } } }),
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('boom', { status: 500, statusText: 'Internal' })) as typeof fetch;

    try {
      const handle = await runAction({
        stagingPath: staging, harness: 'h', branch: 'staging', name: 'fail:build',
        harnessConfigsDir: configsDir, globalPluginsDir: pluginsDir,
      });
      const meta = await handle.done;
      expect(meta.status).toBe('failed');
      expect(meta.exitCode).toBe(500);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not list plugin actions when the plugin is not enabled', async () => {
    const pdir = join(pluginsDir, 'notenabled');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'papercusp.json'), JSON.stringify({
      name: 'notenabled',
      branchActions: { x: { scriptPath: 'x.sh' } },
    }));
    await writeFile(join(pdir, 'x.sh'), '#!/bin/bash\n');
    await writeFile(
      join(configsDir, 'enabled-plugins.json'),
      JSON.stringify({ enabled: {} }),
    );

    const out = await listActions(staging, 'staging', {
      harnessConfigsDir: configsDir, globalPluginsDir: pluginsDir,
    });
    expect(out).toEqual([]);
  });
});
