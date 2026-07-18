import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepRecoveryDebris, DEFAULT_DEBRIS_MAX_AGE_MS } from './recovery-debris-cleanup';

/**
 * Pure node:fs coverage for the EI-1032 janitor — no kopia, no PG. Builds a
 * scratch `<root>/<workspace>/...` tree mirroring the real workspaces root
 * shape and asserts the sweep touches ONLY aged, debris-named directories.
 */

async function age(path: string, msAgo: number): Promise<void> {
  const t = new Date(Date.now() - msAgo);
  await utimes(path, t, t);
}

describe('sweepRecoveryDebris', () => {
  let root: string;
  let ws: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'debris-sweep-'));
    ws = join(root, 'default');
    await mkdir(ws, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reaps an OLD debris-named directory of each recognised tag', async () => {
    const names = [
      'embedded-pg-data.broken-2026-05-01',
      'kopia-repo.broken-2026-05-01',
      '.zz-recover-2026-05-01',
      '.half-restored-2026-05-01',
      '.audit-wipe-2026-05-01',
      'something.rolled-back-2026-05-01',
    ];
    for (const name of names) {
      const p = join(ws, name);
      await mkdir(p, { recursive: true });
      await writeFile(join(p, 'payload.bin'), Buffer.alloc(1024, 0x41));
      await age(p, DEFAULT_DEBRIS_MAX_AGE_MS + 60_000);
    }

    const result = await sweepRecoveryDebris(root);

    expect(result.removed.sort()).toEqual(names.map((n) => join(ws, n)).sort());
    expect(result.kept).toEqual([]);
    expect(result.bytesFreed).toBeGreaterThanOrEqual(1024 * names.length);
    for (const name of names) {
      await expect(stat(join(ws, name))).rejects.toThrow();
    }
  });

  it('keeps a RECENT debris-named directory (still inside the inspection window)', async () => {
    const p = join(ws, 'embedded-pg-data.broken-2026-07-17');
    await mkdir(p, { recursive: true });
    // No age() call — mtime is "now", well inside the default 14-day floor.

    const result = await sweepRecoveryDebris(root);

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([p]);
    await expect(stat(p)).resolves.toBeDefined();
  });

  it('never touches a non-debris directory, however old', async () => {
    const real = join(ws, 'src');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'a.ts'), 'export const x = 1;\n');
    await age(real, DEFAULT_DEBRIS_MAX_AGE_MS * 10);
    // Also plant the load-bearing backups/ dir — must never be swept.
    const backups = join(ws, 'backups');
    await mkdir(backups, { recursive: true });
    await age(backups, DEFAULT_DEBRIS_MAX_AGE_MS * 10);

    const result = await sweepRecoveryDebris(root);

    expect(result.removed).toEqual([]);
    await expect(stat(real)).resolves.toBeDefined();
    await expect(stat(backups)).resolves.toBeDefined();
  });

  it('respects a custom maxAgeMs', async () => {
    const p = join(ws, '.zz-recover-2026-07-17');
    await mkdir(p, { recursive: true });
    await age(p, 5000);

    // A 1ms floor makes even a 5s-old dir eligible.
    const result = await sweepRecoveryDebris(root, { maxAgeMs: 1 });

    expect(result.removed).toEqual([p]);
  });

  it('dryRun reports what WOULD be removed without touching disk', async () => {
    const p = join(ws, '.half-restored-2026-05-01');
    await mkdir(p, { recursive: true });
    await age(p, DEFAULT_DEBRIS_MAX_AGE_MS + 1000);

    const result = await sweepRecoveryDebris(root, { dryRun: true });

    expect(result.removed).toEqual([p]);
    await expect(stat(p)).resolves.toBeDefined(); // still there
  });

  it('is a no-op on a workspaces root that does not exist yet', async () => {
    const result = await sweepRecoveryDebris(join(root, 'does-not-exist'));
    expect(result).toEqual({ removed: [], kept: [], bytesFreed: 0 });
  });

  it('handles multiple workspaces independently', async () => {
    const ws2 = join(root, 'other-workspace');
    await mkdir(ws2, { recursive: true });
    const p1 = join(ws, '.audit-wipe-2026-05-01');
    const p2 = join(ws2, '.audit-wipe-2026-05-01');
    await mkdir(p1, { recursive: true });
    await mkdir(p2, { recursive: true });
    await age(p1, DEFAULT_DEBRIS_MAX_AGE_MS + 1000);
    // p2 stays recent.

    const result = await sweepRecoveryDebris(root);

    expect(result.removed).toEqual([p1]);
    expect(result.kept).toEqual([p2]);
  });
});
