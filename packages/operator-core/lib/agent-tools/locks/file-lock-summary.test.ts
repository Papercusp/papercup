/**
 * file-lock-summary.test.ts — EI-20192110087737961.
 *
 * The property under test is NOT "the rollup groups rows correctly" (it does,
 * and that is the cheap half). It is the one the item was filed about: a
 * reader of the primary lock surface must never be handed a number that reads
 * as "nothing holds this file" when the truth is "we could not tell". So the
 * failure path is asserted harder than the success path — `activeCount` must be
 * `null` on an unreadable read, and specifically NOT `0`.
 *
 * In-tree (operator-core, tab-visible).
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/locks/file-lock-summary.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./su-lock-store', () => ({ readQueue: vi.fn() }));

import { readQueue } from './su-lock-store';
import {
  FILE_LOCK_SUMMARY_CAPS,
  readFileLockSummary,
  rollUpFileLocks,
  unreadableFileLockSummary,
} from './file-lock-summary';

const readQueueM = vi.mocked(readQueue);
const pool = {} as Parameters<typeof readFileLockSummary>[0];

const row = (owner: string, path: string, intent = 'editing') => ({ owner, path, intent });

beforeEach(() => vi.clearAllMocks());

describe('rollUpFileLocks', () => {
  it('reports a MEASURED active count and rolls paths up per holder', () => {
    const s = rollUpFileLocks({
      active_locks: [row('a', 'x.ts'), row('a', 'y.ts'), row('b', 'z.ts', 'fixing gate')],
      waiting: [{}, {}],
    });
    expect(s.plane).toBe('file');
    expect(s.activeCount).toBe(3);
    expect(s.waitingCount).toBe(2);
    expect(s.distinctHolders).toBe(2);
    // Sorted by holdings, so the widest holder is the one a reader sees first.
    expect(s.holders[0]).toMatchObject({ owner: 'a', pathCount: 2, paths: ['x.ts', 'y.ts'] });
    expect(s.holders[1]).toMatchObject({ owner: 'b', intent: 'fixing gate' });
    expect(s.truncated).toBeUndefined();
  });

  it('keeps the FIRST non-empty intent when one owner holds several paths', () => {
    // A later blank row must not erase a populated earlier one — the intent is
    // the only field that says WHY a peer is on the file, which is what stops a
    // reader misdiagnosing the lock.
    const s = rollUpFileLocks({
      active_locks: [row('a', 'x.ts', ''), row('a', 'y.ts', 'rewriting the guard'), row('a', 'z.ts', '')],
    });
    expect(s.holders[0].intent).toBe('rewriting the guard');
  });

  it('reports pathCount and morePaths ABOVE the per-holder cap, never a capped count', () => {
    // pathCount is what a reader compares against; if the cap silently clipped
    // it, a peer holding 40 files would read as holding 8.
    const many = Array.from({ length: 40 }, (_, i) => row('a', `f${i}.ts`));
    const s = rollUpFileLocks({ active_locks: many });
    expect(s.activeCount).toBe(40);
    expect(s.holders[0].pathCount).toBe(40);
    expect(s.holders[0].paths).toHaveLength(FILE_LOCK_SUMMARY_CAPS.pathsPerHolder);
    expect(s.holders[0].morePaths).toBe(40 - FILE_LOCK_SUMMARY_CAPS.pathsPerHolder);
  });

  it('stamps the cut when there are more holders than the cap', () => {
    const rows = Array.from({ length: FILE_LOCK_SUMMARY_CAPS.holders + 5 }, (_, i) =>
      row(`owner-${i}`, `f${i}.ts`),
    );
    const s = rollUpFileLocks({ active_locks: rows });
    expect(s.distinctHolders).toBe(FILE_LOCK_SUMMARY_CAPS.holders + 5);
    expect(s.holders).toHaveLength(FILE_LOCK_SUMMARY_CAPS.holders);
    expect(s.truncated).toEqual({
      showingHolders: FILE_LOCK_SUMMARY_CAPS.holders,
      ofHolders: FILE_LOCK_SUMMARY_CAPS.holders + 5,
    });
  });

  it('never leaks a release handle into the discovery surface', () => {
    // The item names "release the wrong lock" as the hazard; lock_id is the
    // release handle, so it must not ride along here even when the store row
    // carries one.
    // Widened through a variable rather than cast: the excess-property check
    // only fires on a fresh object literal, and this row deliberately carries
    // the extra store field the rollup must drop.
    const withHandle: Record<string, unknown> = { ...row('a', 'x.ts'), lock_id: 'LOCK-123' };
    // POSITIVE CONTROL: prove the fixture really carries the handle, so a typo
    // in the field name cannot make the assertions below pass for the wrong
    // reason (an absent-handle fixture and a correctly-stripping rollup are
    // indistinguishable downstream).
    expect(JSON.stringify(withHandle)).toContain('lock_id');
    expect(JSON.stringify(withHandle)).toContain('LOCK-123');

    const s = rollUpFileLocks({
      active_locks: [withHandle as unknown as { path: string; owner: string; intent?: string }],
    });

    // Scoped to the holder ROWS, not the whole summary: `readVia` names
    // `lock_id` on purpose (it tells the reader what locks:queue adds), so a
    // whole-object assertion would fail on its own prose rather than on a leak.
    expect(s.holders).toHaveLength(1);
    expect(JSON.stringify(s.holders)).not.toContain('LOCK-123');
    expect(JSON.stringify(s.holders)).not.toContain('lock_id');
  });
});

describe('readFileLockSummary — the failure path (the point of this module)', () => {
  it('reads across EVERY coordination domain', async () => {
    // A caller-scoped domain reports a genuinely-held lock as absent when the
    // serving operator and the edited checkout differ (:3070 vs :3170, WI-5979).
    readQueueM.mockResolvedValue({ active_locks: [], waiting: [] });
    await readFileLockSummary(pool);
    expect(readQueueM).toHaveBeenCalledWith(pool, { coordinationDomain: null });
  });

  it('reports activeCount null + unreadable on a failed read — NOT zero', async () => {
    readQueueM.mockRejectedValue(new Error('pool exhausted'));
    const s = await readFileLockSummary(pool);
    expect(s.activeCount).toBeNull();
    expect(s.waitingCount).toBeNull();
    expect(s.distinctHolders).toBeNull();
    expect(s.unreadable).toContain('pool exhausted');
    // The whole failure mode in one assertion: a caller writing the natural
    // `if (!summary.activeCount)` or `activeCount === 0` must not be able to
    // reach "nothing is locked" from a read that never happened.
    expect(s.activeCount).not.toBe(0);
    expect(s.unreadable).toContain('NOT');
  });

  it('distinguishes a MEASURED empty plane from an unreadable one', async () => {
    // Both are "no holders shown". Only one of them means it is safe to edit,
    // and a reader can only tell them apart if the shapes differ.
    readQueueM.mockResolvedValue({ active_locks: [], waiting: [] });
    const measured = await readFileLockSummary(pool);
    const failed = unreadableFileLockSummary(new Error('x'));
    expect(measured.activeCount).toBe(0);
    expect(measured.unreadable).toBeUndefined();
    expect(failed.activeCount).toBeNull();
    expect(failed.unreadable).toBeDefined();
    expect(measured.activeCount).not.toBe(failed.activeCount);
  });

  it('points at the uncapped read on both paths', async () => {
    readQueueM.mockResolvedValue({ active_locks: [], waiting: [] });
    const measured = await readFileLockSummary(pool);
    expect(measured.readVia).toContain('locks:queue');
    expect(unreadableFileLockSummary(new Error('x')).readVia).toContain('locks:queue');
  });
});
