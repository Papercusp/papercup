/**
 * run-git-sync-lock-holder.test.ts — WI-10003529.
 *
 * `lockHasLiveHolder` decides whether git-sync may unlink an aged `index.lock`.
 * It used to scan /proc and return `true` ("assume held") on any host without
 * /proc, so on macOS a lock orphaned by a restart was NEVER reclaimed and every
 * later tick failed (P-203 Mac VM, 2026-09-27: two locks aged 50-70 min, 57
 * consecutive error ticks, while `lsof` proved no process held either one).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockHasLiveHolder, lsofLockHolder } from './run-git-sync';

type RunResult = { code: number | null; stdout: string; stderr: string; missing?: boolean };

describe('lockHasLiveHolder (WI-10003529)', () => {
  it('reclaims on a /proc-less host when lsof PROVES no holder (the macOS case that used to wedge)', async () => {
    const held = await lockHasLiveHolder('/x/.git/index.lock', {
      procHolder: async () => null,
      lsofHolder: async () => false,
    });
    expect(held).toBe(false);
  });

  it('stays fail-closed when neither /proc nor lsof can answer', async () => {
    const held = await lockHasLiveHolder('/x/.git/index.lock', {
      procHolder: async () => null,
      lsofHolder: async () => null,
    });
    expect(held).toBe(true);
  });

  it('keeps an lsof-reported holder held', async () => {
    expect(await lockHasLiveHolder('/x', { procHolder: async () => null, lsofHolder: async () => true })).toBe(true);
  });

  it('trusts a usable /proc verdict and never consults lsof', async () => {
    let lsofCalls = 0;
    const lsofHolder = async () => {
      lsofCalls += 1;
      return false;
    };
    expect(await lockHasLiveHolder('/x', { procHolder: async () => true, lsofHolder })).toBe(true);
    expect(await lockHasLiveHolder('/x', { procHolder: async () => false, lsofHolder })).toBe(false);
    expect(lsofCalls).toBe(0);
  });
});

describe('lsofLockHolder verdict parsing (WI-10003529)', () => {
  const fake = (results: RunResult[]) => {
    const bins: string[] = [];
    const run = async (bin: string): Promise<RunResult> => {
      bins.push(bin);
      return results.shift() ?? { code: null, stdout: '', stderr: '', missing: true };
    };
    return { run, bins };
  };

  it('rc 0 with a pid line = held', async () => {
    const { run } = fake([{ code: 0, stdout: '4242\n', stderr: '' }]);
    expect(await lsofLockHolder('/l', run)).toBe(true);
  });

  it('rc 1 with no output at all = PROVEN not held', async () => {
    const { run } = fake([{ code: 1, stdout: '', stderr: '' }]);
    expect(await lsofLockHolder('/l', run)).toBe(false);
  });

  it('rc 1 WITH stderr is not proof of absence (an lsof error also exits 1)', async () => {
    const { run } = fake([{ code: 1, stdout: '', stderr: 'lsof: status error on /l: Permission denied' }]);
    expect(await lsofLockHolder('/l', run)).toBeNull();
  });

  it('a timeout / signal (code null) cannot answer', async () => {
    const { run } = fake([{ code: null, stdout: '', stderr: 'lsof timed out' }]);
    expect(await lsofLockHolder('/l', run)).toBeNull();
  });

  it('falls through to the absolute paths when lsof is not on PATH (a LaunchDaemon PATH may omit /usr/sbin)', async () => {
    const { run, bins } = fake([
      { code: null, stdout: '', stderr: 'spawn lsof ENOENT', missing: true },
      { code: 1, stdout: '', stderr: '' },
    ]);
    expect(await lsofLockHolder('/l', run)).toBe(false);
    expect(bins).toEqual(['lsof', '/usr/sbin/lsof']);
  });

  it('no lsof binary anywhere cannot answer', async () => {
    const { run } = fake([]);
    expect(await lsofLockHolder('/l', run)).toBeNull();
  });

  it('passes -t -w and ends option parsing before the path', async () => {
    const seen: string[][] = [];
    await lsofLockHolder('-weird/path', async (_bin, args) => {
      seen.push(args);
      return { code: 1, stdout: '', stderr: '' };
    });
    expect(seen[0]).toEqual(['-t', '-w', '--', '-weird/path']);
  });
});

let hasLsof = true;
try {
  execFileSync('lsof', ['-v'], { stdio: 'ignore' });
} catch (e) {
  // `lsof -v` exits non-zero on some builds while still existing; only ENOENT means absent.
  hasLsof = (e as NodeJS.ErrnoException).code !== 'ENOENT';
}

describe.skipIf(!hasLsof)('lsofLockHolder against the real lsof (WI-10003529)', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reports a lock this process holds open, and reports none once it is closed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lock-holder-'));
    const lock = join(dir, 'index.lock');
    await writeFile(lock, '');
    const fh = await open(lock, 'r');
    try {
      expect(await lsofLockHolder(lock)).toBe(true);
    } finally {
      await fh.close();
    }
    expect(await lsofLockHolder(lock)).toBe(false);
  });
});
