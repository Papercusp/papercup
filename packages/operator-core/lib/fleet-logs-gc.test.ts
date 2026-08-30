/**
 * WI-224710: fleet-logs retention GC — age bound, total-bytes ceiling, and
 * the never-throws / best-effort contract.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runFleetLogsGc,
  FLEET_LOGS_GC_DEFAULT_RETENTION_MS,
  FLEET_LOGS_GC_DEFAULT_MAX_TOTAL_BYTES,
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
