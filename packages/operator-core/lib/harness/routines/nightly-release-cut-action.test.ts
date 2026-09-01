import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';

const taskManager = vi.hoisted(() => ({ managedSpawn: vi.fn() }));
vi.mock('../../task-manager/managed-spawn', () => ({ managedSpawn: taskManager.managedSpawn }));

import {
  acquireNightlyLock,
  buildNightlyCutInvocation,
  nextNightlyVersion,
  nightlyReleaseRoot,
  readDesktopVersionAtSource,
  runNightlyCut,
} from './nightly-release-cut-action';

describe('nextNightlyVersion', () => {
  it('bumps a stable patch and appends a UTC timestamp prerelease', () => {
    expect(nextNightlyVersion('0.0.18', new Date('2026-09-01T03:04:00.000Z'))).toBe('0.0.19-20260901.0304');
  });

  it('keeps the existing nightly patch stable on subsequent daily cuts', () => {
    expect(nextNightlyVersion('0.0.19-20260901.0304', new Date('2026-09-02T03:04:00.000Z'))).toBe('0.0.19-20260902.0304');
  });

  it('rejects malformed versions', () => {
    expect(() => nextNightlyVersion('0.0', new Date())).toThrow(/X\.Y\.Z/);
  });
});

describe('readDesktopVersionAtSource', () => {
  it('reads the desktop package version from the exact gitlink pinned by main', () => {
    const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..');
    const sourceSha = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'main^{commit}'], { encoding: 'utf8' }).trim();
    expect(readDesktopVersionAtSource(sourceRoot, sourceSha)).toMatch(/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/);
  });
});

describe('nightlyReleaseRoot', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('accepts a dedicated checkout containing papercusp-desktop/bin/release-local.sh', () => {
    root = mkdtempSync(path.join(tmpdir(), 'papercusp-nightly-release-'));
    mkdirSync(path.join(root, 'papercusp-desktop', 'bin'), { recursive: true });
    writeFileSync(path.join(root, 'papercusp-desktop', 'bin', 'release-local.sh'), '#!/bin/bash\n');
    expect(nightlyReleaseRoot({ PAPERCUSP_NIGHTLY_RELEASE_ROOT: root })).toBe(root);
  });

  it('accepts an absent, explicitly nightly-named path for first-fire provisioning', () => {
    root = path.join(mkdtempSync(path.join(tmpdir(), 'papercusp-nightly-parent-')), 'papercusp-nightly-release');
    expect(nightlyReleaseRoot({ PAPERCUSP_NIGHTLY_RELEASE_ROOT: root }, '/tmp/papercusp')).toBe(root);
  });

  it('rejects canonical/staging/release checkout names and arbitrary existing directories', () => {
    expect(nightlyReleaseRoot({ PAPERCUSP_NIGHTLY_RELEASE_ROOT: '/tmp/papercusp-staging' })).toBeNull();
    root = mkdtempSync(path.join(tmpdir(), 'papercusp-not-a-nightly-'));
    expect(nightlyReleaseRoot({ PAPERCUSP_NIGHTLY_RELEASE_ROOT: root }, '/tmp/papercusp')).toBeNull();
  });
});

describe('buildNightlyCutInvocation', () => {
  it('uses the GUI-only channel and preserves the exact source SHA', () => {
    const invocation = buildNightlyCutInvocation('/tmp/papercusp-nightly', '/tmp/papercusp', '0.0.19-20260901.0304', 'a'.repeat(40), 'Avi', { PATH: '/bin' });
    expect(invocation.cwd).toBe('/tmp/papercusp');
    expect(invocation.args).toContain('nightly-release-cut');
    expect(invocation.args).toContain('0.0.19-20260901.0304');
    expect(invocation.args.join(' ')).toContain('setup-release-checkout.sh');
    expect(invocation.args.join(' ')).toContain('--source-integrity object-sourced');
    expect(invocation.env).toMatchObject({
      PAPERCUSP_BUILD_ROLES: 'gui',
      PAPERCUSP_PUBLISH_GITHUB: '0',
      PAPERCUSP_EXPECTED_SOURCE_SHA: 'a'.repeat(40),
      PAPERCUSP_RELEASE_OWNER_NAME: 'Avi',
    });
  });
});

describe('nightly cut runtime guards', () => {
  it('single-flights via a lock file and replaces stale lock contents', () => {
    const lock = path.join(mkdtempSync(path.join(tmpdir(), 'nightly-lock-')), 'cut.lock');
    expect(acquireNightlyLock(lock, '0.0.19-20260901.0304')).toBe(true);
    expect(acquireNightlyLock(lock, '0.0.19-20260901.0305')).toBe(false);
    expect(JSON.parse(readFileSync(lock, 'utf8')).version).toBe('0.0.19-20260901.0304');
  });

  it('fails soft when owner identity or dedicated checkout is absent', async () => {
    await expect(runNightlyCut({ installSlug: 'papercusp' }, { env: {} })).resolves.toMatchObject({ status: 'skipped' });
    await expect(runNightlyCut({ installSlug: 'papercusp' }, { env: { PAPERCUSP_RELEASE_OWNER_NAME: 'Avi' } })).resolves.toMatchObject({ status: 'skipped' });
    expect(taskManager.managedSpawn).not.toHaveBeenCalled();
  });

  it('launches through managedSpawn with a bounded deploy task', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'papercusp-nightly-launch-'));
    mkdirSync(path.join(root, 'papercusp-desktop', 'bin'), { recursive: true });
    writeFileSync(path.join(root, 'papercusp-desktop', 'bin', 'release-local.sh'), '#!/bin/bash\n');
    const lock = path.join(root, 'cut.lock');
    const child = Object.assign(new EventEmitter(), { pid: 4321 });
    taskManager.managedSpawn.mockResolvedValue({ taskId: 'task-nightly', child });
    const result = await runNightlyCut(
      { installSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
      {
        env: { PAPERCUSP_NIGHTLY_RELEASE_ROOT: root, PAPERCUSP_RELEASE_OWNER_NAME: 'Avi' },
        lockPath: lock,
        sourceSha: 'b'.repeat(40),
        readVersion: () => '0.0.18',
      },
    );
    expect(result.status).toBe('launched');
    const [command, args, spec, opts] = taskManager.managedSpawn.mock.calls[0];
    expect(command).toBe('bash');
    expect(args.join(' ')).toContain('nightly');
    expect(spec).toMatchObject({ class: 'deploy', runtimeMaxSec: 3 * 60 * 60, launchedBy: 'system:nightly-release-cut' });
    expect(opts.workspaceId).toBe('papercusp-workspace');
    expect(opts.spawnOptions.detached).toBe(true);
    expect(opts.spawnOptions.env.PAPERCUSP_RELEASE_OWNER_NAME).toBe('Avi');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('production wiring', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..');

  it('registers, classifies, and seeds the action as an active daily single-flight routine', () => {
    const registry = readFileSync(path.join(repoRoot, 'packages/operator-core/lib/harness/routines/register-system-actions.ts'), 'utf8');
    const classification = readFileSync(path.join(repoRoot, 'packages/operator-core/lib/automation/routine-classification.ts'), 'utf8');
    const seed = readFileSync(path.join(repoRoot, 'apps/operator/lib/release/seed-release-routines.ts'), 'utf8');
    expect(registry).toContain("import './nightly-release-cut-action'");
    expect(classification).toContain("'system:nightly-release-cut'");
    expect(seed).toContain("target: 'system:nightly-release-cut'");
    expect(seed).toContain("cron: '0 0 3 * * *'");
    expect(seed).toContain('activeDefault: true');
    expect(seed).toContain("'skip', 'skip-old'");
  });
});
