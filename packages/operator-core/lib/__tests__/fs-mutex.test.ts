import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fileWrites = vi.hoisted(() => ({
  beforeWrite: null as null | ((path: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await fileWrites.beforeWrite?.(String(args[0]));
      return actual.writeFile(...args);
    },
  };
});
// The production entrypoint deliberately stays executable by plain Node (no build step —
// consumed directly by `node scripts/npm-install-safe.mjs`). Mirrors the suppression-comment
// convention test-file-router.test.ts already uses for the sibling .mjs CLI import.
import {
  withFsMutex,
  withFsMutexRead,
  peekFsMutexSync,
  resolveFsMutexLockRoot,
} from '../../../../scripts/lib/fs-mutex.mjs';

const originalDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;

afterEach(async () => {
  fileWrites.beforeWrite = null;
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
describe('withFsMutexRead wait observations', () => {
  it('reports the current writer on the requested cadence without admitting the reader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-notices-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    const writer = { pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() };
    await mkdir(writerDir);
    await writeFile(join(writerDir, 'owner.json'), JSON.stringify({ ...writer, intent: { stage: 'first' } }));
    const notices: Array<{ owner: string; elapsedMs: number }> = [];
    let firstNotice!: () => void;
    const observedFirst = new Promise<void>(resolve => { firstNotice = resolve; });
    let readerEntered = false;
    try {
      const reader = withFsMutexRead('npm-install', async () => { readerEntered = true; }, {
        timeoutMs: 120,
        retryMs: 2,
        staleMs: 10_000,
        waitingNoticeIntervalMs: 10,
        onWaiting: notice => { notices.push(notice); firstNotice(); },
      });
      const timedOut = expect(reader).rejects.toThrow('Timed out after 120ms');
      await observedFirst;
      await writeFile(join(writerDir, 'owner.json'), JSON.stringify({ ...writer, intent: { stage: 'second' } }));
      await timedOut;
      expect(notices[0].owner).toContain('first');
      expect(notices.some(notice => notice.owner.includes('second'))).toBe(true);
      for (let index = 1; index < notices.length; index++) {
        expect(notices[index].elapsedMs - notices[index - 1].elapsedMs).toBeGreaterThanOrEqual(10);
      }
      expect(readerEntered).toBe(false);
      expect(await readdir(join(dir, 'npm-install.readers'))).toEqual([]);
      expect(peekFsMutexSync('npm-install').held).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports how long admission queued behind a writer, before the reader body runs (WI-10006385)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-acquired-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    await mkdir(writerDir);
    await writeFile(join(writerDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));
    const events: string[] = [];
    const acquired: number[] = [];
    let noticed!: () => void;
    const firstNotice = new Promise<void>(resolve => { noticed = resolve; });
    try {
      const reader = withFsMutexRead('npm-install', async () => { events.push('body'); }, {
        timeoutMs: 5_000,
        retryMs: 2,
        staleMs: 10_000,
        onWaiting: () => { events.push('waiting'); noticed(); },
        onAcquired: ({ waitedMs }) => { events.push('acquired'); acquired.push(waitedMs); },
      });
      await firstNotice;
      await new Promise(resolve => setTimeout(resolve, 60));
      await rm(writerDir, { recursive: true, force: true });
      await reader;
      expect(events).toEqual(['waiting', 'acquired', 'body']);
      expect(acquired).toHaveLength(1);
      expect(acquired[0]).toBeGreaterThanOrEqual(60);
      expect(await readdir(join(dir, 'npm-install.readers'))).toEqual([]);

      // Uncontested: reported once, with no queueing to speak of.
      const uncontested: number[] = [];
      await withFsMutexRead('npm-install', async () => undefined, {
        onAcquired: ({ waitedMs }) => { uncontested.push(waitedMs); },
      });
      expect(uncontested).toHaveLength(1);
      expect(uncontested[0]).toBeLessThan(60);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes the reader marker when the onAcquired callback throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-acquired-throw-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    let bodyRan = false;
    try {
      await expect(withFsMutexRead('npm-install', async () => { bodyRan = true; }, {
        onAcquired: () => { throw new Error('reporter exploded'); },
      })).rejects.toThrow('reporter exploded');
      expect(bodyRan).toBe(false);
      expect(await readdir(join(dir, 'npm-install.readers'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the one-shot default and cleans up after a bounded timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-default-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    await mkdir(writerDir);
    await writeFile(join(writerDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));
    const notices: string[] = [];
    let readerEntered = false;
    try {
      await expect(withFsMutexRead('npm-install', async () => { readerEntered = true; }, {
        timeoutMs: 40,
        retryMs: 2,
        staleMs: 10_000,
        onWaiting: notice => { notices.push(notice.owner); },
      })).rejects.toThrow('Timed out after 40ms');
      expect(notices).toHaveLength(1);
      expect(readerEntered).toBe(false);
      expect(await readdir(join(dir, 'npm-install.readers'))).toEqual([]);
      expect(peekFsMutexSync('npm-install').held).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('withFsMutex', () => {
  it('does not publish tentative reader markers while a writer has reserved admission', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-reservation-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    const readersDir = join(dir, 'npm-install.readers');
    await mkdir(writerDir);
    await writeFile(join(writerDir, 'owner.json'), JSON.stringify({
      pid: process.pid, host: hostname(), phase: 'draining-readers',
    }));
    let observeAttempt!: () => void;
    const attempted = new Promise<void>(resolve => { observeAttempt = resolve; });
    let finishPublication!: () => void;
    const publicationAllowed = new Promise<void>(resolve => { finishPublication = resolve; });
    // Pause any tentative publication so the assertion observes the race directly,
    // without relying on how many polling readers happen to arrive at once.
    fileWrites.beforeWrite = async path => {
      if (path.startsWith(readersDir)) {
        observeAttempt();
        await publicationAllowed;
      }
    };
    let readerEntered = false;
    const reader = withFsMutexRead('npm-install', async () => { readerEntered = true; }, {
      timeoutMs: 2_000, retryMs: 5, onWaiting: observeAttempt,
    });
    try {
      await attempted;
      expect(readerEntered).toBe(false);
      expect(await readdir(readersDir)).toEqual([]);
      expect(peekFsMutexSync('npm-install').owner).toMatchObject({ phase: 'draining-readers' });
    } finally {
      fileWrites.beforeWrite = null;
      finishPublication();
      await rm(writerDir, { recursive: true, force: true });
      await reader;
      await rm(dir, { recursive: true, force: true });
    }
    expect(readerEntered).toBe(true);
  });

  it('distinguishes a reader-drain reservation from the running writer callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-phases-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    let releaseReader!: () => void;
    const readerReleased = new Promise<void>((resolve) => { releaseReader = resolve; });
    let readerStarted!: () => void;
    const readerReady = new Promise<void>((resolve) => { readerStarted = resolve; });
    const reader = withFsMutexRead('npm-install', async () => {
      readerStarted();
      await readerReleased;
    }, { timeoutMs: 2_000, retryMs: 5 });
    await readerReady;
    let writerDraining!: () => void;
    const drainReady = new Promise<void>((resolve) => { writerDraining = resolve; });
    let writerEntered = false;
    const writer = withFsMutex('npm-install', async () => {
      writerEntered = true;
      return peekFsMutexSync('npm-install').owner;
    }, { timeoutMs: 2_000, retryMs: 5, onWaiting: writerDraining });
    try {
      await drainReady;
      const reserved = peekFsMutexSync('npm-install');
      expect(reserved.held).toBe(true);
      expect(writerEntered).toBe(false);
      expect(reserved.owner).toMatchObject({ phase: 'draining-readers' });
      expect(reserved.owner).not.toHaveProperty('runningAt');
      releaseReader();
      const running = await writer;
      expect(running).toMatchObject({ phase: 'running', acquiredAt: reserved.owner?.acquiredAt });
      expect(Date.parse(running!.runningAt!)).toBeGreaterThanOrEqual(Date.parse(running!.acquiredAt!));
      expect(peekFsMutexSync('npm-install').held).toBe(false);
    } finally {
      releaseReader();
      await Promise.allSettled([reader, writer]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backs out when a writer reserves between reader preflight and publication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-race-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    const readersDir = join(dir, 'npm-install.readers');
    let reserved = false;
    fileWrites.beforeWrite = async path => {
      if (path.startsWith(readersDir) && !reserved) {
        reserved = true;
        await mkdir(writerDir);
        await writeFile(join(writerDir, 'owner.json'), JSON.stringify({
          pid: process.pid, host: hostname(), phase: 'draining-readers',
        }));
      }
    };
    let observeAttempt!: () => void;
    const attempted = new Promise<void>(resolve => { observeAttempt = resolve; });
    let readerEntered = false;
    const reader = withFsMutexRead('npm-install', async () => {
      readerEntered = true;
      observeAttempt();
    }, { timeoutMs: 2_000, retryMs: 5, onWaiting: observeAttempt });
    try {
      await attempted;
      expect(reserved).toBe(true);
      expect(readerEntered).toBe(false);
      expect(await readdir(readersDir)).toEqual([]);
      expect(peekFsMutexSync('npm-install').held).toBe(true);
    } finally {
      fileWrites.beforeWrite = null;
      await rm(writerDir, { recursive: true, force: true });
      await reader;
      await rm(dir, { recursive: true, force: true });
    }
    expect(readerEntered).toBe(true);
  });

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

// EI-25235644267089650: old leases still protect live owners. Age is only a
// recovery fallback for records that cannot identify an owner.
describe('fs-mutex lease reclamation', () => {
  it.each([
    ['local', 'reader'], ['local', 'writer'],
    ['remote', 'reader'], ['remote', 'writer'],
  ] as const)('preserves an old %s writer against a %s waiter until release', async (location, mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-old-writer-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'old-writer.lock');
    await mkdir(lockDir);
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid, host: location === 'local' ? hostname() : `${hostname()}-remote`,
    }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);
    const acquire = mode === 'reader' ? withFsMutexRead : withFsMutex;
    let entered = false;
    try {
      await expect(acquire('old-writer', async () => { entered = true; }, {
        timeoutMs: 120, staleMs: 1, retryMs: 5,
      })).rejects.toThrow('Timed out after 120ms');
      expect(entered).toBe(false);
      expect(peekFsMutexSync('old-writer').owner).toMatchObject({ pid: process.pid });
      await rm(lockDir, { recursive: true, force: true });
      await acquire('old-writer', async () => { entered = true; });
      expect(entered).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps an old live reader protected until its callback releases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-old-reader-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const readersDir = join(dir, 'old-reader.readers');
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const reader = withFsMutexRead('old-reader', async () => { started(); await released; });
    let writerEntered = false;
    try {
      await ready;
      const markers = await readdir(readersDir);
      expect(markers).toHaveLength(1);
      const old = new Date(Date.now() - 60_000);
      await utimes(join(readersDir, markers[0]), old, old);
      await expect(withFsMutex('old-reader', async () => { writerEntered = true; }, {
        timeoutMs: 120, staleMs: 1, retryMs: 5,
      })).rejects.toThrow('Timed out after 120ms');
      expect(writerEntered).toBe(false);
      expect(await readdir(readersDir)).toEqual(markers);
      release();
      await reader;
      expect(await readdir(readersDir)).toEqual([]);
      await withFsMutex('old-reader', async () => { writerEntered = true; });
      expect(writerEntered).toBe(true);
    } finally {
      release();
      await reader;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves an old remote reader until explicit release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-remote-reader-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const readersDir = join(dir, 'remote-reader.readers');
    const markerDir = join(readersDir, 'remote.lock');
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: `${hostname()}-remote` }));
    const old = new Date(Date.now() - 60_000);
    await utimes(markerDir, old, old);
    try {
      await expect(withFsMutex('remote-reader', async () => undefined, {
        timeoutMs: 120, staleMs: 1, retryMs: 5,
      })).rejects.toThrow('Timed out after 120ms');
      expect(await readdir(readersDir)).toEqual(['remote.lock']);
      await rm(markerDir, { recursive: true, force: true });
      await expect(withFsMutex('remote-reader', async () => 'released')).resolves.toBe('released');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['writer', 'reader'] as const)('reclaims a fresh %s lease only after confirming its owner dead', async mode => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-dead-owner-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const markerDir = mode === 'writer' ? join(dir, 'dead-owner.lock') : join(dir, 'dead-owner.readers', 'dead.lock');
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, host: hostname() }));
    try {
      await expect(withFsMutex('dead-owner', async () => 'recovered', {
        timeoutMs: 1_000, staleMs: 60_000, retryMs: 5,
      })).resolves.toBe('recovered');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['writer', undefined], ['reader', undefined],
    ['writer', '{invalid-json'], ['reader', '{invalid-json'],
    ['writer', '{"pid":"invalid","host":"local"}'], ['reader', '{"pid":"invalid","host":"local"}'],
  ] as const)('recovers an old ownerless or malformed %s lease (%s)', async (mode, record) => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-ownerless-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const markerDir = mode === 'writer' ? join(dir, 'ownerless.lock') : join(dir, 'ownerless.readers', 'orphan.lock');
    await mkdir(markerDir, { recursive: true });
    if (record !== undefined) await writeFile(join(markerDir, 'owner.json'), record);
    const old = new Date(Date.now() - 60_000);
    await utimes(markerDir, old, old);
    try {
      await expect(withFsMutex('ownerless', async () => 'recovered', {
        timeoutMs: 1_000, staleMs: 1, retryMs: 5,
      })).resolves.toBe('recovered');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// EI-21915677034576963: withFsMutex had no fairness at all — every waiter just raced
// mkdir() on a fixed poll, so a caller that re-acquires the SAME lock across many
// short-lived sub-invocations (e.g. one shard of a broad affected-tests run after
// another) got a fresh, near-instant shot at every release with no regard for who had
// been waiting longest, starving a bounded/narrow verification run for hours even
// though it registered first. A FIFO ticket queue fixes this: only the OLDEST live
// ticket may attempt the mkdir race on any given poll.
describe('withFsMutex fairness (FIFO ticket queue)', () => {
  it('serves waiters in FIFO ticket order — a later caller cannot leapfrog one already waiting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const order: string[] = [];
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });

    const holder = withFsMutex(
      'fair-lock',
      async () => {
        holderStarted();
        await holderReleased;
        order.push('holder');
      },
      { timeoutMs: 5_000, retryMs: 5 },
    );
    await holderReady;

    // B registers its ticket first — its ticket is strictly OLDER than C's.
    const waiterB = withFsMutex(
      'fair-lock',
      async () => {
        order.push('B');
      },
      { timeoutMs: 5_000, retryMs: 5 },
    );
    // Give B's ticket a moment to land on disk before C registers its own — otherwise
    // same-millisecond ticket ids could tie-break either way.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 30));

    const waiterC = withFsMutex(
      'fair-lock',
      async () => {
        order.push('C');
      },
      { timeoutMs: 5_000, retryMs: 5 },
    );

    releaseHolder();
    await Promise.all([holder, waiterB, waiterC]);

    expect(order).toEqual(['holder', 'B', 'C']);
    await rm(dir, { recursive: true, force: true });
  });

  it('reclaims a ticket from a crashed waiter (confirmed-dead pid) instead of wedging behind it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const queueDir = join(dir, 'fair-lock-dead.queue');
    await mkdir(queueDir, { recursive: true });
    const deadTicketDir = join(queueDir, '0000000000000001-999999-deadticket.ticket');
    await mkdir(deadTicketDir, { recursive: true });
    const deadPid = 2_147_483_647; // guaranteed not to exist
    await writeFile(
      join(deadTicketDir, 'owner.json'),
      JSON.stringify({ pid: deadPid, host: hostname(), startedAt: new Date().toISOString(), name: 'fair-lock-dead' }),
    );

    const start = Date.now();
    const result = await withFsMutex('fair-lock-dead', async () => 'done', {
      timeoutMs: 5_000,
      staleMs: 10 * 60_000,
      retryMs: 5,
    });
    const elapsed = Date.now() - start;

    expect(result).toBe('done');
    expect(elapsed).toBeLessThan(2_000);
    await rm(dir, { recursive: true, force: true });
  });

  it('reclaims a ticket with no owner.json (crash between mkdir and write) once it is stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const queueDir = join(dir, 'fair-lock-orphan.queue');
    await mkdir(queueDir, { recursive: true });
    const orphanTicketDir = join(queueDir, '0000000000000001-999999-orphanticket.ticket');
    await mkdir(orphanTicketDir, { recursive: true }); // deliberately no owner.json
    const old = new Date(Date.now() - 60_000);
    await utimes(orphanTicketDir, old, old);

    const result = await withFsMutex('fair-lock-orphan', async () => 'done', {
      timeoutMs: 1_000,
      staleMs: 1,
      retryMs: 5,
    });

    expect(result).toBe('done');
    await rm(dir, { recursive: true, force: true });
  });

  // The critical safety property: age alone must NEVER reclaim a ticket whose owner is
  // genuinely alive, however old — that is exactly the legitimate multi-hour-wait case
  // this queue exists to protect. A naive reuse of reclaimAbandonedLock's (age OR dead)
  // policy would silently defeat the whole fairness fix by discarding the very ticket
  // that is supposed to win.
  it('never reclaims a ticket whose owner is alive on this host, no matter how old', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const queueDir = join(dir, 'fair-lock-oldlive.queue');
    await mkdir(queueDir, { recursive: true });
    const oldTicketDir = join(queueDir, '0000000000000001-999999-oldbutlive.ticket');
    await mkdir(oldTicketDir, { recursive: true });
    await writeFile(
      join(oldTicketDir, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt: new Date(Date.now() - 999_999_999).toISOString(),
        name: 'fair-lock-oldlive',
      }),
    );
    const veryOld = new Date(Date.now() - 999_999_999);
    await utimes(oldTicketDir, veryOld, veryOld);

    // A brand-new caller's own ticket is always YOUNGER than the planted one. With a
    // tiny staleMs that would wrongly reclaim an age-based ticket, it must still DEFER
    // to the planted (live-pid) ticket and time out — never acquire by racing past it.
    await expect(
      withFsMutex('fair-lock-oldlive', async () => 'done', { timeoutMs: 300, staleMs: 1, retryMs: 20 }),
    ).rejects.toThrow(/Timed out after 300ms/);

    await rm(dir, { recursive: true, force: true });
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

// EI-21917992245424964: the owner record carried IDENTITY (pid/host/startedAt/name) and
// nothing about whether the holder was worth waiting for, so a blocked peer's only safe
// default was to wait — measured at ~26 minutes for a run whose output nobody wanted.
// `intent` is the value half, readable by any waiter with no round-trip and without the
// holder being awake.
describe('withFsMutex owner intent', () => {
  it('publishes a declared intent into the owner record a blocked peer reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let seen: Record<string, unknown> | undefined;
    await withFsMutex(
      'npm-install',
      async () => {
        // Peek from INSIDE the critical section: this is exactly the vantage point of a
        // peer that is blocked while this holder runs.
        seen = peekFsMutexSync('npm-install').owner as Record<string, unknown>;
      },
      { timeoutMs: 5_000, intent: { scope: 'explicit', tasks: 3, etaMinSec: 12 } },
    );

    expect(seen?.intent).toEqual({ scope: 'explicit', tasks: 3, etaMinSec: 12 });
    // The identity fields a waiter and the reclaim path depend on must survive alongside it.
    expect(seen?.pid).toBe(process.pid);
    expect(seen?.host).toBe(hostname());
    await rm(dir, { recursive: true, force: true });
  });

  it('omits the intent key entirely when nothing was declared, so absence stays absence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let seen: Record<string, unknown> | undefined;
    await withFsMutex(
      'npm-install',
      async () => {
        seen = peekFsMutexSync('npm-install').owner as Record<string, unknown>;
      },
      { timeoutMs: 5_000 },
    );

    expect(seen).toBeTruthy();
    expect('intent' in (seen ?? {})).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('cannot be used to shadow the identity fields the reclaim path trusts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const deadPid = 2_147_483_647;
    let seen: Record<string, unknown> | undefined;
    await withFsMutex(
      'npm-install',
      async () => {
        seen = peekFsMutexSync('npm-install').owner as Record<string, unknown>;
      },
      // A caller naming `pid`/`host` must land under `intent`, never over the real values —
      // otherwise a self-description could forge a dead owner and invite its own reclaim.
      { timeoutMs: 5_000, intent: { pid: deadPid, host: 'somewhere-else' } },
    );

    expect(seen?.pid).toBe(process.pid);
    expect(seen?.host).toBe(hostname());
    expect(seen?.intent).toEqual({ pid: deadPid, host: 'somewhere-else' });
    await rm(dir, { recursive: true, force: true });
  });

  it('drops unrepresentable values rather than coercing them, and bounds long strings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let seen: Record<string, unknown> | undefined;
    await withFsMutex(
      'npm-install',
      async () => {
        seen = peekFsMutexSync('npm-install').owner as Record<string, unknown>;
      },
      {
        timeoutMs: 5_000,
        intent: {
          keep: 'yes',
          long: 'x'.repeat(500),
          // A coerced "[object Object]" would read as data; dropping reads as "not declared".
          nested: { a: 1 },
          notFinite: Number.NaN,
        } as unknown as Record<string, string | number | boolean>,
      },
    );

    const intent = seen?.intent as Record<string, unknown>;
    expect(intent.keep).toBe('yes');
    expect('nested' in intent).toBe(false);
    expect('notFinite' in intent).toBe(false);
    expect(String(intent.long)).toHaveLength(201); // 200 chars + the truncation marker
    await rm(dir, { recursive: true, force: true });
  });
});
