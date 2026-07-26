import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
// The production entrypoint deliberately stays executable by plain Node (no build step —
// consumed directly by `node scripts/npm-install-safe.mjs`). Mirrors the suppression-comment
// convention test-file-router.test.ts already uses for the sibling .mjs CLI import.
import {
  withFsMutex,
  // @ts-expect-error
} from '../../../../scripts/lib/fs-mutex.mjs';

const originalDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;

afterEach(async () => {
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = originalDir;
  delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
});

// EI-18662389554660036: `withFsMutex` is the serialization primitive for shared-tree-wide
// mutations (e.g. `npm install`) that plain repo tooling needs, with no MCP/Papercusp
// credentials available — the SAME proven mkdir-lock algorithm as
// `withTestcontainerStartLock` (libs/test-config/src/testcontainer-start-lock.ts), duplicated
// rather than imported because this caller must stay a plain, buildless Node script.
describe('withFsMutex', () => {
  it('serializes concurrent callers under the same lock name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let active = 0;
    let maxActive = 0;
    const observed: number[] = [];

    async function lockedWork(id: number): Promise<number> {
      return withFsMutex(
        'npm-install',
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          observed.push(id);
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
          active -= 1;
          return id;
        },
        { timeoutMs: 2_000, retryMs: 5 },
      );
    }

    await Promise.all([lockedWork(1), lockedWork(2), lockedWork(3)]);

    expect(maxActive).toBe(1);
    expect(observed).toHaveLength(3);
    await rm(dir, { recursive: true, force: true });
  });

  it('releases the lock after fn resolves — a second call is not blocked by the first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    await withFsMutex('npm-install', async () => 'first', { timeoutMs: 2_000, retryMs: 5 });
    const second = await withFsMutex('npm-install', async () => 'second', { timeoutMs: 2_000, retryMs: 5 });

    expect(second).toBe('second');
    await rm(dir, { recursive: true, force: true });
  });

  it('releases the lock even when fn throws, so the next caller is never wedged behind a failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    await expect(
      withFsMutex(
        'npm-install',
        async () => {
          throw new Error('boom');
        },
        { timeoutMs: 2_000, retryMs: 5 },
      ),
    ).rejects.toThrow('boom');

    const after = await withFsMutex('npm-install', async () => 'ok', { timeoutMs: 500, retryMs: 5 });
    expect(after).toBe('ok');
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps independent lock names from blocking each other', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let active = 0;
    let maxActive = 0;

    async function lockedWork(name: string): Promise<string> {
      return withFsMutex(
        name,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
          active -= 1;
          return name;
        },
        { timeoutMs: 2_000, retryMs: 5 },
      );
    }

    await expect(Promise.all([lockedWork('npm-install-repo-a'), lockedWork('npm-install-repo-b')])).resolves.toHaveLength(2);

    expect(maxActive).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });

  it('reclaims an abandoned stale lock instead of waiting out the full timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'npm-install.lock');
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);

    const result = await withFsMutex('npm-install', async () => 'done', { timeoutMs: 1_000, staleMs: 1, retryMs: 5 });

    expect(result).toBe('done');
    await rm(dir, { recursive: true, force: true });
  });

  // EI-7818 (ported from testcontainer-start-lock's own regression): reclaim on
  // CONFIRMED-dead-pid evidence alone, even when the lock is fresh (well under staleMs) — a
  // crashed holder must never wedge every future `npm install` for the full timeout.
  it('reclaims immediately when the recorded owner pid is confirmed dead on this host, even when the lock is fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'npm-install.lock');
    await mkdir(lockDir, { recursive: true });

    const deadPid = 2_147_483_647; // guaranteed not to exist
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: deadPid, host: hostname(), startedAt: new Date().toISOString(), name: 'npm-install' }),
    );

    const start = Date.now();
    const result = await withFsMutex('npm-install', async () => 'done', {
      timeoutMs: 5_000,
      staleMs: 10 * 60_000,
      retryMs: 5,
    });
    const elapsed = Date.now() - start;

    expect(result).toBe('done');
    expect(elapsed).toBeLessThan(2_000);
    await rm(dir, { recursive: true, force: true });
  });

  it('does NOT reclaim a lock owned by a live pid on this host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'npm-install.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), name: 'npm-install' }),
    );

    await expect(
      withFsMutex('npm-install', async () => 'done', { timeoutMs: 300, staleMs: 10 * 60_000, retryMs: 20 }),
    ).rejects.toThrow(/Timed out after 300ms/);

    await rm(dir, { recursive: true, force: true });
  });

  it('PAPERCUSP_DISABLE_FS_MUTEX=1 bypasses locking entirely', async () => {
    process.env.PAPERCUSP_DISABLE_FS_MUTEX = '1';
    const result = await withFsMutex('npm-install', async () => 'unlocked');
    expect(result).toBe('unlocked');
  });
});
