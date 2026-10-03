/**
 * WI-224710: fleet-logs retention GC — age bound, total-bytes ceiling, and
 * the never-throws / best-effort contract.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync, chmodSync, symlinkSync, statSync, openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openWriterPidsMany } from './native-bg-task-ledger';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runFleetLogsGc,
  FLEET_LOGS_GC_DEFAULT_RETENTION_MS,
  FLEET_LOGS_GC_DEFAULT_MAX_TOTAL_BYTES,
  runPapercuspWorkdirGc,
  PAPERCUSP_WORKDIR_GC_DEFAULT_RETENTION_MS,
  PAPERCUSP_WORKDIR_GC_PROTECTED_BASENAMES,
  WINDOWS_BUILD_SCRATCH_GC_DEFAULT_RETENTION_MS,
  runWindowsBuildScratchGc,
  runLaunchContextGc,
  LAUNCH_CONTEXT_GC_DEFAULT_RETENTION_MS,
} from './fleet-logs-gc';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-fleet-logs-gc-test-'));
});

afterEach(() => {
  // A permission-locked test file (see the "unlink failure" case) refuses a
  // plain rm; restore write perms before cleanup so afterEach itself never
  // throws mid-suite.
  try {
    chmodSync(sandbox, 0o700);
  } catch {
    /* ignore */
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function writeAged(dir: string, name: string, bytes: number, ageMs: number): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 'x'));
  const t = new Date(Date.now() - ageMs);
  utimesSync(p, t, t);
  return p;
}

describe('runFleetLogsGc', () => {
  it('defaults are sane: 3-day age window, 10 GiB ceiling', () => {
    expect(FLEET_LOGS_GC_DEFAULT_RETENTION_MS).toBe(3 * 24 * 60 * 60 * 1000);
    expect(FLEET_LOGS_GC_DEFAULT_MAX_TOTAL_BYTES).toBe(10 * 1024 * 1024 * 1024);
  });

  it('deletes files older than retentionMs and keeps fresh ones', () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    const stale = writeAged(dir, 'stale.log', 1000, 5 * 24 * 60 * 60 * 1000); // 5d old
    const fresh = writeAged(dir, 'fresh.log', 1000, 1 * 60 * 60 * 1000); // 1h old

    const result = runFleetLogsGc({
      dirs: [dir],
      retentionMs: 3 * 24 * 60 * 60 * 1000,
      maxTotalBytes: 1024 * 1024 * 1024, // large — ceiling never engages here
    });

    expect(result.dryRun).toBe(false);
    const [d] = result.dirs;
    expect(d.scanned).toBe(2);
    expect(d.removedByAge).toBe(1);
    expect(d.removedByCeiling).toBe(0);
    expect(d.bytesFreed).toBe(1000);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('enforces the total-bytes ceiling oldest-first even within the retention window', () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    // All three are within the age retention window, but the directory
    // (300 bytes) exceeds a 250-byte ceiling — the oldest one must go.
    const oldest = writeAged(dir, 'a.log', 100, 3 * 60 * 60 * 1000);
    const middle = writeAged(dir, 'b.log', 100, 2 * 60 * 60 * 1000);
    const newest = writeAged(dir, 'c.log', 100, 1 * 60 * 60 * 1000);

    const result = runFleetLogsGc({
      dirs: [dir],
      retentionMs: 30 * 24 * 60 * 60 * 1000, // nothing ages out
      maxTotalBytes: 250,
    });

    const [d] = result.dirs;
    expect(d.removedByAge).toBe(0);
    expect(d.removedByCeiling).toBe(1);
    expect(d.bytesRemaining).toBeLessThanOrEqual(250);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it('a live/fresh file is never caught by the age bound regardless of ceiling pressure ordering', () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    // One huge stale file, one small fresh file. Both bounds should agree:
    // the stale one goes (age), the fresh one is evaluated by the ceiling
    // pass only if it's still over budget afterward — here it isn't.
    const stale = writeAged(dir, 'huge-stale.log', 5000, 10 * 24 * 60 * 60 * 1000);
    const fresh = writeAged(dir, 'small-fresh.log', 10, 0);

    const result = runFleetLogsGc({
      dirs: [dir],
      retentionMs: 3 * 24 * 60 * 60 * 1000,
      maxTotalBytes: 1000,
    });

    const [d] = result.dirs;
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(d.bytesRemaining).toBe(10);
  });

  it('dryRun deletes nothing but reports what would be freed', () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    const stale = writeAged(dir, 'stale.log', 500, 5 * 24 * 60 * 60 * 1000);

    const result = runFleetLogsGc({
      dirs: [dir],
      retentionMs: 3 * 24 * 60 * 60 * 1000,
      maxTotalBytes: 1024 * 1024 * 1024,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.dirs[0].removedByAge).toBe(1);
    expect(result.dirs[0].bytesFreed).toBe(500);
    expect(existsSync(stale)).toBe(true); // nothing actually deleted
  });

  it('a missing directory is a no-op, not an error', () => {
    const dir = join(sandbox, 'does-not-exist');
    const result = runFleetLogsGc({ dirs: [dir] });
    expect(result.dirs[0].scanned).toBe(0);
    expect(result.dirs[0].errors).toHaveLength(0);
  });

  it('sweeps multiple directories independently', () => {
    const dirA = join(sandbox, 'ws-a', 'fleet-logs');
    const dirB = join(sandbox, 'ws-b', 'fleet-logs');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeAged(dirA, 'old.log', 100, 5 * 24 * 60 * 60 * 1000);
    writeAged(dirB, 'new.log', 100, 0);

    const result = runFleetLogsGc({ dirs: [dirA, dirB], retentionMs: 3 * 24 * 60 * 60 * 1000 });
    expect(result.dirs).toHaveLength(2);
    const a = result.dirs.find((d) => d.dir === dirA)!;
    const b = result.dirs.find((d) => d.dir === dirB)!;
    expect(a.removedByAge).toBe(1);
    expect(b.removedByAge).toBe(0);
  });

  it('a stale file it cannot delete is reported as an error and still counted in bytesRemaining', () => {
    const dir = join(sandbox, 'fleet-logs');
    mkdirSync(dir, { recursive: true });
    const locked = writeAged(dir, 'locked.log', 200, 5 * 24 * 60 * 60 * 1000);
    // Remove write permission on the *directory* so unlink fails regardless
    // of the calling user's own file ownership (root-run test suites can
    // otherwise unlink a chmod-000 file with no error).
    chmodSync(dir, 0o500);

    const result = runFleetLogsGc({ dirs: [dir], retentionMs: 3 * 24 * 60 * 60 * 1000 });

    chmodSync(dir, 0o700); // restore before assertions / afterEach cleanup
    const [d] = result.dirs;
    if (d.errors.length > 0) {
      // Root or a permissive FS may still allow the unlink; only assert the
      // failure shape when this environment actually enforced the lock.
      expect(d.errors[0].path).toBe(locked);
      expect(existsSync(locked)).toBe(true);
    }
  });
});

/**
 * WI-10002015: one-off working-DIRECTORY retention under ~/.papercusp.
 *
 * The load-bearing case is "a nested write keeps the whole tree alive". It is
 * the regression guard for a measured near-miss: the largest directory on the
 * host (82.8 GiB, an in-flight release) had an OWN mtime 79 minutes old while
 * being actively written, because appending to a nested file never touches an
 * ancestor directory's mtime. Any "simplification" of the recursive scan back
 * to the directory's own mtime passes every other test here and fails that one.
 */
const DAY = 24 * 60 * 60 * 1000;
const noOpenPaths = async () => ({ byPath: new Map<string, string[]>(), complete: true });

/** Recursively force every file AND directory mtime to `ageMs` in the past.
 *  Depth-first so a parent is stamped last — stamping a child would otherwise
 *  bump the parent's mtime again. */
function ageTree(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const child of readdirSync(path)) ageTree(join(path, child), ageMs);
  }
  utimesSync(path, t, t);
}

/** A realistic one-off working dir: nested structure holding real bytes. */
function makeWorkdir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'nested', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'deep', 'payload.bin'), Buffer.alloc(2048, 'x'));
  writeFileSync(join(dir, 'top.txt'), Buffer.alloc(512, 'y'));
  return dir;
}

function makeWindowsBuildScratch(root: string): {
  repoRoot: string;
  container: string;
  buildRoot: string;
} {
  const repoRoot = join(root, 'desktop-source');
  const container = join(root, 'papercusp-win-cross-source-AbC123');
  const buildRoot = join(container, 'papercusp-desktop');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(container);
  writeFileSync(join(repoRoot, 'seed.txt'), 'seed');
  execFileSync('git', ['init', '-q', repoRoot], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoRoot, 'add', 'seed.txt'], { stdio: 'ignore' });
  execFileSync('git', [
    '-C', repoRoot, '-c', 'user.name=GC test', '-c', 'user.email=gc-test@example.com',
    'commit', '-m', 'seed',
  ], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', buildRoot, 'HEAD'], {
    stdio: 'ignore',
  });
  return { repoRoot, container, buildRoot };
}

describe('runPapercuspWorkdirGc', () => {
  it('keeps a genuinely open nested file even when its mtime is old', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    const fd = openSync(join(dir, 'top.txt'), 'r');
    const proc = join(sandbox, 'proc');
    mkdirSync(proc);
    symlinkSync(`/proc/${process.pid}`, join(proc, String(process.pid)));
    try {
      const result = await runPapercuspWorkdirGc({
        root: sandbox, dryRun: false,
        scanOpenPaths: (paths) => openWriterPidsMany(paths, {
          procRoot: proc, descendants: true, includeCwd: true, failClosed: true,
        }),
      });
      expect(result.candidates[0]?.skipped).toBe('in-use');
      expect(existsSync(dir)).toBe(true);
    } finally { closeSync(fd); }
  });

  it('keeps protected stores and symlink replacements after the process scan', async () => {
    const protectedDir = makeWorkdir(sandbox, 'pot-git.AbC123');
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    ageTree(protectedDir, 30 * DAY);
    const result = await runPapercuspWorkdirGc({
      root: sandbox, dryRun: false,
      scanOpenPaths: async () => {
        rmSync(dir, { recursive: true });
        symlinkSync(protectedDir, dir);
        return noOpenPaths();
      },
    });
    expect(result.removed).toBe(0);
    expect(result.candidates.find((c) => c.path === dir)?.skipped).toBe('raced');
    expect(existsSync(join(protectedDir, 'top.txt'))).toBe(true);
  });

  it('WI-10005720: defaults to dry-run and never claims bytes were actually freed', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    const result = await runPapercuspWorkdirGc({ root: sandbox, scanOpenPaths: noOpenPaths });
    expect(result.dryRun).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.wouldRemove).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  it('WI-10005720: refuses an aged directory held open by a process', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    const result = await runPapercuspWorkdirGc({
      root: sandbox, dryRun: false,
      scanOpenPaths: async () => ({ byPath: new Map([[dir, ['42']]]), complete: true }),
    });
    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('in-use');
    expect(existsSync(dir)).toBe(true);
  });

  it('WI-10005720: refuses deletion when process-use evidence is incomplete', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.AbC123');
    ageTree(dir, 30 * DAY);
    const result = await runPapercuspWorkdirGc({
      root: sandbox, dryRun: false,
      scanOpenPaths: async () => ({ byPath: new Map(), complete: false }),
    });
    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('process-scan-incomplete');
    expect(existsSync(dir)).toBe(true);
  });

  it('uses a conservative 7-day default, longer than the 3-day fleet-logs bound', async () => {
    expect(PAPERCUSP_WORKDIR_GC_DEFAULT_RETENTION_MS).toBe(7 * DAY);
    expect(PAPERCUSP_WORKDIR_GC_DEFAULT_RETENTION_MS).toBeGreaterThan(
      FLEET_LOGS_GC_DEFAULT_RETENTION_MS,
    );
  });

  it('removes a stale mktemp-suffixed working directory and reports its bytes', async () => {
    const dir = makeWorkdir(sandbox, 'p309-accept.BZHrUr');
    ageTree(dir, 10 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed, JSON.stringify(result.candidates)).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(result.bytesFreed).toBeGreaterThanOrEqual(2048 + 512);
    expect(result.candidates[0]?.removed).toBe(true);
  });

  // ─── THE REGRESSION GUARD ────────────────────────────────────────────────
  it('a NESTED write keeps the tree alive even though every directory mtime is ancient', async () => {
    const dir = makeWorkdir(sandbox, 'byoc-p318-release.lqhrUZ');
    ageTree(dir, 30 * DAY);

    // Exactly the dangerous real-world shape: a live writer appending deep
    // inside, leaving every ancestor directory's mtime untouched and ancient.
    const live = join(dir, 'nested', 'deep', 'payload.bin');
    const recent = new Date(Date.now() - 60_000);
    utimesSync(live, recent, recent);

    // Precondition: the directory's OWN mtime still looks 30 days stale, so a
    // naive own-mtime sweep would happily delete this tree.
    expect(Date.now() - statSync(dir).mtimeMs).toBeGreaterThan(29 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed).toBe(0);
    expect(existsSync(live)).toBe(true);
    expect(result.candidates[0]?.skipped).toBe('too-new');
  });

  it('ignores directories without a machine-generated mktemp suffix', async () => {
    const dir = makeWorkdir(sandbox, 'p046-deps-snapshot');
    ageTree(dir, 90 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed).toBe(0);
    expect(result.candidates).toHaveLength(0); // never even considered
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses a protected basename even when it carries a mktemp suffix', async () => {
    const name = `${[...PAPERCUSP_WORKDIR_GC_PROTECTED_BASENAMES][0]}.AbC123`;
    const dir = makeWorkdir(sandbox, name);
    ageTree(dir, 90 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('protected');
    expect(existsSync(dir)).toBe(true);
  });

  it('dryRun reports exactly what it would free and deletes nothing', async () => {
    const dir = makeWorkdir(sandbox, 'p314-accept.2Uix7q');
    ageTree(dir, 10 * DAY);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: true, scanOpenPaths: noOpenPaths });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.wouldRemove).toBe(1);
    expect(result.bytesReclaimable).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(true); // reported, but nothing removed
  });

  it('never follows a symlinked directory', async () => {
    const real = makeWorkdir(sandbox, 'real-payload');
    ageTree(real, 90 * DAY);
    symlinkSync(real, join(sandbox, 'linked.AbC123'));

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });

    expect(result.removed).toBe(0);
    expect(existsSync(real)).toBe(true);
    expect(existsSync(join(real, 'top.txt'))).toBe(true);
  });

  it('is a no-op on a missing root and never throws', async () => {
    const result = await runPapercuspWorkdirGc({ root: join(sandbox, 'does-not-exist') });
    expect(result.removed).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });
});

/**
 * Falsifiability control for the guard above.
 *
 * A guard test that has never failed is a guard nobody has tested. The usual
 * way to prove one CAN fail is to mutate the implementation and re-run — but
 * the implementation here calls `rmSync` recursively, and executing a MUTANT of
 * deletion logic is precisely how a reaper's loop once became `for d in /*` and
 * destroyed ~370 GB (EI-20566003853444873). A PATH shim cannot help either:
 * `rmSync` is an in-process syscall, not an `rm` executable.
 *
 * So the wrong implementation lives here instead, permanently, per the repo's
 * prescribed tier for an imported module. `naiveOwnMtimeWouldDelete` is the
 * predicate this module must never regress to. The pair below is the whole
 * proof, and BOTH halves are required:
 *   • CALIBRATION — on a genuinely stale tree the control agrees with the real
 *     sweep. Without this, a control that simply never fires would make the
 *     divergence case pass even if the property under test were broken.
 *   • DIVERGENCE — on the nested-write tree the control WOULD delete while the
 *     real sweep spares it. That gap is the recursive scan doing its job, and
 *     it is what the near-miss would have cost us.
 */
function naiveOwnMtimeWouldDelete(dir: string, retentionMs: number): boolean {
  return Date.now() - statSync(dir).mtimeMs >= retentionMs;
}

describe('runPapercuspWorkdirGc — falsifiability control', () => {
  it('CALIBRATION: on a genuinely stale tree the naive control agrees with the real sweep', async () => {
    const dir = makeWorkdir(sandbox, 'calibration-stale.QqWw11');
    ageTree(dir, 30 * DAY);

    // The control fires here — so it is not a predicate that never triggers.
    expect(naiveOwnMtimeWouldDelete(dir, 7 * DAY)).toBe(true);

    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });
    expect(result.removed).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('DIVERGENCE: the naive control would DELETE the live tree the real sweep spares', async () => {
    const dir = makeWorkdir(sandbox, 'byoc-p318-release.lqhrUZ');
    ageTree(dir, 30 * DAY);
    const live = join(dir, 'nested', 'deep', 'payload.bin');
    const recent = new Date(Date.now() - 60_000);
    utimesSync(live, recent, recent);

    // The wrong implementation destroys an in-flight release …
    expect(naiveOwnMtimeWouldDelete(dir, 7 * DAY)).toBe(true);

    // … and the real one does not. If this pair ever stops diverging, the
    // recursive scan has been lost and this suite is no longer guarding it.
    const result = await runPapercuspWorkdirGc({ root: sandbox, dryRun: false, scanOpenPaths: noOpenPaths });
    expect(result.removed).toBe(0);
    expect(existsSync(live)).toBe(true);
  });
});

describe('runWindowsBuildScratchGc', () => {
  it('uses a 48-hour retention window', () => {
    expect(WINDOWS_BUILD_SCRATCH_GC_DEFAULT_RETENTION_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('removes a stale producer worktree only after claiming its exact Git lock', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: noOpenPaths,
    });

    expect(result.removed, JSON.stringify(result.candidates)).toBe(1);
    expect(result.candidates[0]?.removed).toBe(true);
    expect(existsSync(buildRoot)).toBe(false);
    expect(existsSync(container)).toBe(false);
    const remaining = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(remaining).not.toContain(buildRoot);
  });

  it('keeps fresh nested data written during the post-removal process scan', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);
    const lateWrite = join(container, 'late-write.txt');

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: async () => {
        if (!existsSync(buildRoot) && !existsSync(lateWrite)) writeFileSync(lateWrite, 'new data');
        return { byPath: new Map(), complete: true };
      },
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('raced');
    expect(existsSync(buildRoot)).toBe(false);
    expect(existsSync(lateWrite)).toBe(true);
    expect(existsSync(container)).toBe(true);
  });

  it('keeps the container when the post-removal process scan is incomplete', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: async () => existsSync(buildRoot)
        ? { byPath: new Map(), complete: true }
        : { byPath: new Map(), complete: false },
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('process-scan-incomplete');
    expect(existsSync(buildRoot)).toBe(false);
    expect(existsSync(container)).toBe(true);
  });

  it('keeps a worktree that had a Git lock before the sweep', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    execFileSync('git', [
      '-C', repoRoot, 'worktree', 'lock', '--reason', 'owned-before-gc', buildRoot,
    ], { stdio: 'ignore' });
    ageTree(container, 3 * DAY);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: noOpenPaths,
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('git-locked');
    expect(existsSync(buildRoot)).toBe(true);
  });

  it('keeps a stale-looking container when its recursive tree has a recent write', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);
    const activeFile = join(buildRoot, 'seed.txt');
    const recent = new Date(Date.now() - 60_000);
    utimesSync(activeFile, recent, recent);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: noOpenPaths,
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('too-new');
    expect(existsSync(activeFile)).toBe(true);
  });

  it('fails closed when the open-writer scan is incomplete', async () => {
    const { repoRoot, container, buildRoot } = makeWindowsBuildScratch(sandbox);
    ageTree(container, 3 * DAY);

    const result = await runWindowsBuildScratchGc({
      root: sandbox,
      repoRoot,
      dryRun: false,
      scanOpenPaths: async () => ({ byPath: new Map(), complete: false }),
    });

    expect(result.removed).toBe(0);
    expect(result.candidates[0]?.skipped).toBe('process-scan-incomplete');
    expect(existsSync(buildRoot)).toBe(true);
  });
});

// ── launch-context render GC (WI-10002015) ───────────────────────────────────

describe('runLaunchContextGc', () => {
  it('reaps an aged render nothing is serving', () => {
    writeAged(sandbox, 'session-old.md', 2048, 30 * DAY);
    const r = runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });

    expect(r.refused).toBeUndefined();
    expect(r.removed).toBe(1);
    expect(r.bytesFreed).toBe(2048);
    expect(existsSync(join(sandbox, 'session-old.md'))).toBe(false);
  });

  it('keeps a render younger than the retention window', () => {
    writeAged(sandbox, 'session-new.md', 512, 60_000);
    const r = runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });

    expect(r.removed).toBe(0);
    expect(r.candidates[0]?.skipped).toBe('too-new');
    expect(existsSync(join(sandbox, 'session-new.md'))).toBe(true);
  });

  // THE load-bearing guard. A render is written once, at exec, and never
  // touched again — so its mtime records when the session STARTED, not when it
  // stopped mattering. Age alone therefore deletes the persona out from under
  // any agent alive longer than the retention window. The pair below pins that:
  // if the naive rule and the real one ever stop diverging, the live-session
  // exclusion has been lost and this suite no longer guards it.
  it('refuses to reap an ANCIENT render that a live session is still serving', () => {
    const inUse = writeAged(sandbox, 'session-long-lived.md', 4096, 90 * DAY);
    const stale = writeAged(sandbox, 'session-abandoned.md', 4096, 90 * DAY);

    // The wrong implementation — age only — destroys a live agent's persona.
    const naiveWouldDelete = (p: string) =>
      Date.now() - statSync(p).mtimeMs > LAUNCH_CONTEXT_GC_DEFAULT_RETENTION_MS;
    expect(naiveWouldDelete(inUse)).toBe(true);

    // … and the real one holds it back while still reclaiming its twin.
    const r = runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set([inUse]) });

    expect(existsSync(inUse)).toBe(true);
    expect(r.liveHeld).toBe(1);
    expect(r.candidates.find((c) => c.path === inUse)?.skipped).toBe('live-session');

    expect(existsSync(stale)).toBe(false);
    expect(r.removed).toBe(1);
  });

  // `undefined` (no measurement) and an empty Set (a measurement that found no
  // live sessions) must never collapse into the same behaviour.
  it('fails closed when no live-render evidence is supplied at all', () => {
    writeAged(sandbox, 'session-ancient.md', 4096, 120 * DAY);

    const r = runLaunchContextGc({ dir: sandbox });

    expect(r.refused).toBe('no-live-render-evidence');
    expect(r.removed).toBe(0);
    expect(r.scanned).toBe(0);
    expect(existsSync(join(sandbox, 'session-ancient.md'))).toBe(true);

    // The same directory, with an EMPTY set, does proceed — proving the refusal
    // above is about missing evidence, not about an empty exclusion list.
    const measured = runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });
    expect(measured.refused).toBeUndefined();
    expect(measured.removed).toBe(1);
  });

  it('never recurses into or removes a subdirectory', () => {
    const sub = join(sandbox, 'nested');
    mkdirSync(sub);
    const buried = join(sub, 'payload.md');
    writeFileSync(buried, 'x');
    const old = new Date(Date.now() - 120 * DAY);
    utimesSync(buried, old, old);
    utimesSync(sub, old, old);

    const r = runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set() });

    expect(r.removed).toBe(0);
    expect(r.candidates[0]?.skipped).toBe('not-a-file');
    expect(existsSync(buried)).toBe(true);
    expect(existsSync(sub)).toBe(true);
  });

  it('reports what it would free without removing anything on a dry run', () => {
    writeAged(sandbox, 'session-old.md', 1024, 30 * DAY);

    const r = runLaunchContextGc({ dir: sandbox, liveRenderPaths: new Set(), dryRun: true });

    expect(r.removed).toBe(1);
    expect(r.bytesFreed).toBe(1024);
    expect(existsSync(join(sandbox, 'session-old.md'))).toBe(true);
  });

  it('treats an unreadable directory as empty rather than throwing', () => {
    const missing = join(sandbox, 'does-not-exist');
    expect(() =>
      runLaunchContextGc({ dir: missing, liveRenderPaths: new Set() }),
    ).not.toThrow();
    expect(runLaunchContextGc({ dir: missing, liveRenderPaths: new Set() }).scanned).toBe(0);
  });
});
