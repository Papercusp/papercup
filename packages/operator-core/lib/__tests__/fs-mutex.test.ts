import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
// The production entrypoint deliberately stays executable by plain Node (no build step —
// consumed directly by `node scripts/npm-install-safe.mjs`). Mirrors the suppression-comment
// convention test-file-router.test.ts already uses for the sibling .mjs CLI import.
import {
  withFsMutex,
  withFsMutexRead,
  peekFsMutexSync,
  resolveFsMutexLockRoot,
  // @ts-expect-error
} from '../../../../scripts/lib/fs-mutex.mjs';

const originalDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;

afterEach(async () => {
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = originalDir;
  delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
});

describe('resolveFsMutexLockRoot', () => {
  it('keeps one POSIX lock root when callers carry different TMPDIR values', () => {
    const withoutTmpOverride = resolveFsMutexLockRoot({}, { platform: 'linux', homeDir: '/unused' });
    const withPapercuspTmp = resolveFsMutexLockRoot(
      { TMPDIR: '/tmp/pcv' },
      { platform: 'linux', homeDir: '/unused' },
    );

    expect(withoutTmpOverride).toBe('/tmp/pcv/fs-mutex-locks');
    expect(withPapercuspTmp).toBe(withoutTmpOverride);
  });

  it('preserves the explicit lock-root override on every platform', () => {
    expect(
      resolveFsMutexLockRoot(
        { PAPERCUSP_FS_MUTEX_LOCK_DIR: '/operator/serialized-locks', TMPDIR: '/different/tmp' },
        { platform: 'linux', homeDir: '/unused' },
      ),
    ).toBe('/operator/serialized-locks');
  });
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

  it('allows concurrent readers while a writer still waits for every reader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let activeReaders = 0;
    let maxActiveReaders = 0;
    let releaseFirstReader!: () => void;
    const firstReaderReleased = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    let firstReaderStarted!: () => void;
    const firstReaderReady = new Promise<void>((resolve) => {
      firstReaderStarted = resolve;
    });
    let secondReaderStarted!: () => void;
    const secondReaderReady = new Promise<void>((resolve) => {
      secondReaderStarted = resolve;
    });

    const reader = withFsMutexRead(
      'npm-install',
      async () => {
        activeReaders += 1;
        maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
        firstReaderStarted();
        await firstReaderReleased;
        activeReaders -= 1;
      },
      { timeoutMs: 2_000, retryMs: 5 },
    );
    await firstReaderReady;

    const secondReader = withFsMutexRead(
      'npm-install',
      async () => {
        activeReaders += 1;
        maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
        secondReaderStarted();
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 30));
        activeReaders -= 1;
      },
      { timeoutMs: 2_000, retryMs: 5 },
    );
    await secondReaderReady;

    let writerEntered = false;
    const writer = withFsMutex(
      'npm-install',
      async () => {
        writerEntered = true;
        return 'writer';
      },
      { timeoutMs: 2_000, retryMs: 5 },
    );

    expect(maxActiveReaders).toBe(2);
    expect(writerEntered).toBe(false);

    releaseFirstReader();
    await expect(Promise.all([reader, secondReader, writer])).resolves.toEqual([undefined, undefined, 'writer']);
    expect(writerEntered).toBe(true);
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

// EI-19304880034803985: a NON-blocking peek so a caller (test-files.mjs) can
// WARN ("an install is in flight, this may hang") instead of hanging silently
// on a spawnSync it cannot introspect while the mutex is held.
describe('peekFsMutexSync', () => {
  it('reports held:false when no lock directory exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    expect(peekFsMutexSync('npm-install').held).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('reports held:true with the owner when a lock is currently held', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'npm-install.lock');
    await mkdir(lockDir, { recursive: true });
    const owner = { pid: 424242, host: hostname(), startedAt: new Date().toISOString(), name: 'npm-install' };
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner));

    const peek = peekFsMutexSync('npm-install');
    expect(peek.held).toBe(true);
    expect(peek.owner).toMatchObject(owner);
    await rm(dir, { recursive: true, force: true });
  });

  it('never blocks/waits — returns immediately even while a real holder has the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    // A real, un-released hold (fn never resolves within this test) — peek must
    // not be the thing that waits for it.
    const held = withFsMutex('npm-install', () => new Promise(() => {}), { timeoutMs: 5_000, retryMs: 5 });

    // Give the mkdir a tick to land before peeking.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    const start = Date.now();
    const peek = peekFsMutexSync('npm-install');
    expect(Date.now() - start).toBeLessThan(50);
    expect(peek.held).toBe(true);

    void held; // deliberately never awaited — it would hang the test
    await rm(dir, { recursive: true, force: true });
  });

  it('never throws — a missing/unreadable owner.json reports held:false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    // Lock directory exists but owner.json was never (or not yet) written —
    // the narrow window right after mkdir succeeds, before writeFile lands.
    await mkdir(join(dir, 'npm-install.lock'), { recursive: true });

    expect(() => peekFsMutexSync('npm-install')).not.toThrow();
    expect(peekFsMutexSync('npm-install').held).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
