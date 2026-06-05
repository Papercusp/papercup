/**
 * classic-dining-philosophers.test.ts — D-008 (dining philosophers).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The one residual cross-layer
 * deadlock surface is an agent acquiring MULTIPLE locks across subsystems. The fix is a
 * documented global lock-class order (orderLocks): always acquire in canonical order, so
 * there is no circular wait. This test proves orderLocks gives a total order AND that
 * concurrent "philosophers" acquiring their fork pairs via orderLocks never deadlock —
 * whereas the naive per-philosopher order forms a cycle.
 */
import { describe, expect, it } from 'vitest';
import { orderLocks, isCanonicalOrder, lockClassRank, type OrderedLock } from './lock-order';

/** Minimal async fork-lock with FIFO hand-off (ownership passes directly on release). */
class ForkTable {
  private held = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();
  async acquire(key: string): Promise<void> {
    if (!this.held.has(key)) { this.held.add(key); return; }
    await new Promise<void>((resolve) => {
      const q = this.waiters.get(key) ?? [];
      q.push(resolve);
      this.waiters.set(key, q);
    });
    // Ownership was handed to us on release — `held` is already true.
  }
  release(key: string): void {
    const q = this.waiters.get(key);
    if (q && q.length > 0) { q.shift()!(); } // hand off; held stays true
    else { this.held.delete(key); }
  }
  get heldCount(): number { return this.held.size; }
}

describe('dining philosophers — canonical lock-class order (D-008)', () => {
  it('orderLocks is a total order across classes then keys', () => {
    const locks: OrderedLock[] = [
      { lockClass: 'plan-item', key: 'P-2' },
      { lockClass: 'file', key: 'b.ts' },
      { lockClass: 'file', key: 'a.ts' },
      { lockClass: 'resource', key: 'dev-server' },
    ];
    expect(orderLocks(locks).map((l) => `${l.lockClass}:${l.key}`)).toEqual([
      'resource:dev-server', 'file:a.ts', 'file:b.ts', 'plan-item:P-2',
    ]);
    expect(lockClassRank('resource')).toBeLessThan(lockClassRank('file'));
    expect(isCanonicalOrder([{ lockClass: 'file', key: 'b' }, { lockClass: 'file', key: 'a' }])).toBe(false);
  });

  it('the naive per-philosopher order has a cycle; orderLocks removes it', () => {
    const N = 5;
    // Philosopher i naively wants [fork i, fork (i+1)%N] — the last wraps, forming the
    // classic cycle (each holds its left, waits on its right).
    const naive = Array.from({ length: N }, (_, i) => [
      { lockClass: 'resource' as const, key: `fork-${i}` },
      { lockClass: 'resource' as const, key: `fork-${(i + 1) % N}` },
    ]);
    // Under orderLocks every philosopher acquires the LOWER-keyed fork first, so the
    // wrapping philosopher (fork-4, fork-0) now grabs fork-0 first → no cycle.
    const ordered = naive.map(orderLocks);
    expect(ordered.every(isCanonicalOrder)).toBe(true);
    expect(ordered[N - 1].map((l) => l.key)).toEqual(['fork-0', `fork-${N - 1}`]); // wrap fixed
  });

  it('concurrent philosophers acquiring via orderLocks all eat (no deadlock)', async () => {
    const N = 5;
    const table = new ForkTable();
    const ate: number[] = [];
    const philosopher = async (i: number) => {
      const forks = orderLocks([
        { lockClass: 'resource' as const, key: `fork-${i}` },
        { lockClass: 'resource' as const, key: `fork-${(i + 1) % N}` },
      ]);
      for (const f of forks) await table.acquire(f.key);
      await Promise.resolve(); // "eat" — yield to force interleaving
      ate.push(i);
      for (const f of [...forks].reverse()) table.release(f.key);
    };
    // Bounded so a deadlock would hang the test rather than silently pass.
    await Promise.race([
      Promise.all(Array.from({ length: N }, (_, i) => philosopher(i))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DEADLOCK: philosophers did not finish')), 2000)),
    ]);
    expect(ate.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(table.heldCount).toBe(0); // every fork released
  });
});
