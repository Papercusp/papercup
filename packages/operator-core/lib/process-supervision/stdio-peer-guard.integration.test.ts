/**
 * (WI-39599) The end-to-end property the unit test cannot reach: a REAL broken
 * pipe, in a REAL orphaned process, does not burn a core.
 *
 * Topology reproduced: test → middle ("operator", owns the sidecars' pipe read
 * ends) → two sidecars, identical but for `installStdioPeerGuard()`. The test
 * SIGKILLs the middle process, which closes both read ends, then measures each
 * sidecar's CPU from /proc.
 *
 * ⚠ The UNGUARDED child is a POSITIVE CONTROL and its spin is asserted, not
 * merely observed. A machine or a Node version where the amplification does not
 * reproduce makes this instrument blind, and a blind instrument reporting
 * "guarded child is quiet" is exactly the green a broken subject also produces.
 * If the control stops spinning, this test fails and must be re-derived rather
 * than relaxed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PKG_ROOT = resolve(__dirname, '../..');
const MIDDLE = resolve(PKG_ROOT, 'test/_stdio-peer-guard-middle.ts');
const CHILD = resolve(PKG_ROOT, 'test/_stdio-peer-guard-child.ts');

/** Linux-only: the measurement reads utime+stime from /proc/<pid>/stat. */
const onLinux = process.platform === 'linux';

const scratch = mkdtempSync(join(tmpdir(), 'stdio-peer-guard-'));
let middle: ChildProcess | undefined;
let spawned: Record<string, number> = {};

afterAll(() => {
  // Kill by PID only — never by name/pattern (a pattern kill has twice taken
  // down unrelated processes on this box).
  for (const pid of Object.values(spawned)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  try {
    if (middle?.pid) process.kill(middle.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** utime+stime in clock ticks, or null if the process is gone. */
function cpuTicks(pid: number): number | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm can contain spaces and parens — parse after the LAST ')'.
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  // After that slice, field[0] is `state`; utime/stime are stat fields 14/15.
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : null;
}

/** Mean cores consumed over `ms`, measured against the elapsed wall clock. */
async function measureCores(pid: number, ms: number): Promise<number> {
  const t0 = Date.now();
  const a = cpuTicks(pid);
  await sleep(ms);
  const b = cpuTicks(pid);
  if (a === null || b === null) return 0;
  const elapsedSec = (Date.now() - t0) / 1000;
  // USER_HZ is 100 on every Linux this ships to.
  return (b - a) / 100 / elapsedSec;
}

describe.skipIf(!onLinux)('stdio peer guard — real orphaned sidecar (WI-39599)', () => {
  it('an orphaned sidecar does not burn a core, while the unguarded control does', async () => {
    const pidsPath = join(scratch, 'pids.json');
    middle = spawn(process.execPath, ['--import', 'tsx', MIDDLE], {
      cwd: PKG_ROOT,
      env: { ...process.env, CHILD_PATH: CHILD, PIDS_PATH: pidsPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    middle.stdout?.on('data', () => {});
    middle.stderr?.on('data', () => {});

    // Wait for both sidecars to be spawned and booted (tsx startup included).
    for (let i = 0; i < 60 && Object.keys(spawned).length < 2; i++) {
      await sleep(500);
      try {
        spawned = JSON.parse(readFileSync(pidsPath, 'utf8')) as Record<string, number>;
      } catch {
        /* not written yet */
      }
    }
    expect(Object.keys(spawned).sort()).toEqual(['guarded', 'unguarded']);
    await sleep(3000);
    expect(alive(spawned.guarded)).toBe(true);
    expect(alive(spawned.unguarded)).toBe(true);

    // Abrupt operator death — skips every graceful teardown, closes both pipes.
    process.kill(middle.pid!, 'SIGKILL');
    middle = undefined;
    await sleep(2000);

    const [unguardedCores, guardedCores] = await Promise.all([
      measureCores(spawned.unguarded, 6000),
      measureCores(spawned.guarded, 6000),
    ]);

    // POSITIVE CONTROL first: if the bug does not reproduce here, the
    // measurement below proves nothing and this test must fail loudly.
    expect(
      unguardedCores,
      `positive control did not spin (${unguardedCores.toFixed(3)} cores) — the instrument is blind, not the subject fixed`,
    ).toBeGreaterThan(0.5);

    // The subject: same process shape, plus the guard.
    expect(
      guardedCores,
      `guarded sidecar burned ${guardedCores.toFixed(3)} cores against a ${unguardedCores.toFixed(3)}-core control`,
    ).toBeLessThan(0.1);

    // And it is quiet because it is healthy, not because it died.
    expect(alive(spawned.guarded)).toBe(true);
  }, 120_000);
});
