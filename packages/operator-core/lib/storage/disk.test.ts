import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirSizeBytes, dirSizeBytesAsync, type DiskWalkBudget } from './disk';

/**
 * Recurrence guard for EI-6045: the synchronous recursive disk-sizing walk must
 * be wall-clock bounded by a shared budget so `storage:usage` can never block the
 * event loop for minutes and trip the 300s MCP idle abort on a large install.
 */
describe('dirSizeBytes wall-clock budget (EI-6045)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'storage-disk-test-'));
    // A small nested tree with known byte totals.
    writeFileSync(join(root, 'a.bin'), Buffer.alloc(100));
    writeFileSync(join(root, 'b.bin'), Buffer.alloc(200));
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'c.bin'), Buffer.alloc(50));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sizes the full tree when no budget is given (behavior preserved)', () => {
    expect(dirSizeBytes(root)).toBe(350);
  });

  it('sizes the full tree under a far-future deadline and leaves truncated unset', () => {
    const budget: DiskWalkBudget = { deadlineMs: Date.now() + 60_000 };
    expect(dirSizeBytes(root, 400_000, budget)).toBe(350);
    expect(budget.truncated).toBeUndefined();
  });

  it('stops early and marks truncated when the deadline has already elapsed', () => {
    const budget: DiskWalkBudget = { deadlineMs: Date.now() - 1 };
    // An already-elapsed deadline is checked before any syscall on the first
    // iteration, so the walk returns immediately with a partial (0) total.
    expect(dirSizeBytes(root, 400_000, budget)).toBe(0);
    expect(budget.truncated).toBe(true);
  });

  it('a SHARED exhausted budget short-circuits every subsequent dir (many-session-dirs case)', () => {
    const other = mkdtempSync(join(tmpdir(), 'storage-disk-test-2-'));
    writeFileSync(join(other, 'x.bin'), Buffer.alloc(999));
    try {
      const budget: DiskWalkBudget = { deadlineMs: Date.now() - 1 };
      // First dir trips the deadline...
      expect(dirSizeBytes(root, 400_000, budget)).toBe(0);
      expect(budget.truncated).toBe(true);
      // ...and the shared, already-exhausted budget makes later dirs return
      // near-instantly too (the aggregate walk stays bounded regardless of how
      // many session dirs exist).
      expect(dirSizeBytes(other, 400_000, budget)).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

/**
 * WI-5471: `dirSizeBytesAsync` is the event-loop-COOPERATIVE twin — it must be
 * byte-identical to the sync walk, keep the same budget semantics, AND actually
 * relinquish the loop mid-walk (the sync twin's ~90s bg-host freeze on the
 * `storage.usage` precompute was the acute soak-blocker this fixes).
 */
describe('dirSizeBytesAsync (WI-5471 event-loop-cooperative walk)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'storage-disk-async-test-'));
    writeFileSync(join(root, 'a.bin'), Buffer.alloc(100));
    writeFileSync(join(root, 'b.bin'), Buffer.alloc(200));
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'c.bin'), Buffer.alloc(50));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sizes the full tree identically to the sync walk (behavior preserved)', async () => {
    expect(await dirSizeBytesAsync(root)).toBe(350);
    expect(await dirSizeBytesAsync(root)).toBe(dirSizeBytes(root));
  });

  it('honors the shared wall-clock budget (stops early + marks truncated)', async () => {
    const budget: DiskWalkBudget = { deadlineMs: Date.now() - 1 };
    expect(await dirSizeBytesAsync(root, 400_000, budget)).toBe(0);
    expect(budget.truncated).toBe(true);
  });

  it('yields the event loop DURING a large walk — a concurrent macrotask interleaves', async () => {
    // A tree wide enough that the walk crosses several cooperativeYield boundaries
    // (yields every 64 iterations at rest), so a competing setImmediate loop must
    // get to run before the walk finishes — proving the walk never blocks the loop.
    const big = mkdtempSync(join(tmpdir(), 'storage-disk-async-big-'));
    try {
      for (let i = 0; i < 300; i++) writeFileSync(join(big, `f${i}.bin`), Buffer.alloc(1));

      let ticks = 0;
      let done = false;
      const tick = (): void => {
        if (done) return;
        ticks++;
        setImmediate(tick);
      };
      setImmediate(tick);

      const total = await dirSizeBytesAsync(big);
      done = true;

      expect(total).toBe(300); // 300 × 1 byte
      expect(ticks).toBeGreaterThan(0); // the loop ticked mid-walk → not blocked
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });
});
