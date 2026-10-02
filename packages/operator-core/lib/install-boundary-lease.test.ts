// WI-10005137: headless agent launches wait out an in-flight install:safe.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- buildless plain-JS mutex module intentionally has no declaration file.
import { withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';
// @ts-expect-error -- same buildless plain-JS module family, no declaration file.
import { installLockNameForRoot } from '../../../scripts/lib/install-lock-name.mjs';
// @ts-expect-error -- plain-Node .mjs CLI, no declaration file.
import { repoLockName } from '../../../scripts/npm-install-safe.mjs';
import {
  acquireInstallBoundaryLease,
  installBoundaryRoot,
} from './install-boundary-lease';
import { bootDeathLogExcerpt, installBoundaryNote } from './console-spawn';

describe('installBoundaryRoot', () => {
  it('follows the psu shim precedence and skips roots that do not exist', () => {
    const exists = (p: string) => p !== '/missing';
    expect(
      installBoundaryRoot(
        { PAPERCUSP_CANONICAL_TREE: '/missing', PAPERCUSP_INTEGRATION_ROOT: '/tree', PAPERCUSP_RELEASE_ROOT: '/rel' },
        exists,
      ),
    ).toBe('/tree');
    expect(installBoundaryRoot({ PAPERCUSP_CANONICAL_TREE: '/canon', PAPERCUSP_INTEGRATION_ROOT: '/tree' }, exists)).toBe('/canon');
    expect(installBoundaryRoot({}, exists)).toBeNull();
  });
});

describe('install lock name', () => {
  it('runtime derivation is the same lock install:safe takes', () => {
    const root = process.cwd();
    expect(installLockNameForRoot(root)).toBe(repoLockName(root));
  });
});

describe('acquireInstallBoundaryLease (real fs-mutex)', () => {
  let lockDir: string;
  let repoRoot: string;
  const savedLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), 'install-boundary-locks-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'install-boundary-repo-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = lockDir;
  });
  afterEach(() => {
    if (savedLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = savedLockDir;
    rmSync(lockDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('waits for an in-flight install writer before the launch proceeds', async () => {
    const order: string[] = [];
    let finishInstall: () => void = () => {};
    let writerHeld: () => void = () => {};
    const held = new Promise<void>((r) => { writerHeld = r; });
    const install = withFsMutex(installLockNameForRoot(repoRoot), async () => {
      writerHeld();
      await new Promise<void>((r) => { finishInstall = r; });
      order.push('install-done');
    }, { retryMs: 10 });
    await held;
    const leaseP = acquireInstallBoundaryLease(repoRoot, { env: {}, timeoutMs: 10_000 }).then((lease) => {
      order.push('launch');
      return lease;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual([]); // still waiting on the writer
    finishInstall();
    await install;
    const lease = await leaseP;
    expect(lease.outcome).toBe('acquired');
    expect(order).toEqual(['install-done', 'launch']);
    lease.release();
  });

  it('holds the install out until released (boot window), then lets it run', async () => {
    const lease = await acquireInstallBoundaryLease(repoRoot, { env: {}, timeoutMs: 5_000 });
    expect(lease.outcome).toBe('acquired');
    let installRan = false;
    const install = withFsMutex(installLockNameForRoot(repoRoot), async () => {
      installRan = true;
    }, { retryMs: 10 });
    await new Promise((r) => setTimeout(r, 150));
    expect(installRan).toBe(false);
    lease.release();
    lease.release(); // idempotent
    await install;
    expect(installRan).toBe(true);
  });

  it('fails open when the install outlasts the wait', async () => {
    let finishInstall: () => void = () => {};
    let writerHeld: () => void = () => {};
    const held = new Promise<void>((r) => { writerHeld = r; });
    const install = withFsMutex(installLockNameForRoot(repoRoot), async () => {
      writerHeld();
      await new Promise<void>((r) => { finishInstall = r; });
    }, { retryMs: 10 });
    await held;
    const lease = await acquireInstallBoundaryLease(repoRoot, { env: {}, timeoutMs: 200 });
    expect(['timed-out', 'error']).toContain(lease.outcome);
    expect(installBoundaryNote(lease)).toContain('launched without the install:safe boundary');
    finishInstall();
    await install;
  });

  it('skips the lease when nested inside an install-safe reader, or with no root', async () => {
    expect((await acquireInstallBoundaryLease(repoRoot, { env: { PAPERCUSP_INSTALL_MUTEX_HELD: '1' } })).outcome).toBe('nested');
    expect((await acquireInstallBoundaryLease(null)).outcome).toBe('no-root');
    expect(installBoundaryNote({ outcome: 'acquired', waitedMs: 0, release: () => {} })).toBe('');
  });
});

describe('bootDeathLogExcerpt', () => {
  it('keeps the missing-package line that the stack tail cut off', () => {
    const head = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from /tree/apps/operator/scripts/psu-launcher.mjs";
    const stack = Array.from({ length: 40 }, (_, i) => `    at packageResolve (node:internal/modules/esm/resolve:${i}:10)`).join('\n');
    const excerpt = bootDeathLogExcerpt(`boot\n${head}\n${stack}\n`);
    expect(excerpt.startsWith(head)).toBe(true);
    expect(excerpt).toContain('esm/resolve:39');
  });

  it('returns the plain tail when it already holds the head line', () => {
    const log = "x\nError: Cannot find module 'y'\n  at z";
    expect(bootDeathLogExcerpt(log)).toBe(log);
  });
});
