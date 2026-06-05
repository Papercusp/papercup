/**
 * dining-philosophers — the classic deadlock problem, solved by the total lock-class
 * order. This is the genericity proof for lock-order: no PG, no domain — just the pure
 * `orderLocks` primitive over an arbitrary class set + an in-memory fork table.
 */
import { describe, expect, it } from 'vitest';
import { createLockOrdering } from './lock-order';

const { orderLocks, isCanonicalOrder } = createLockOrdering(['resource']);

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
  }
  release(key: string): void {
    const q = this.waiters.get(key);
    if (q && q.length > 0) { q.shift()!(); }
    else { this.held.delete(key); }
  }
  get heldCount(): number { return this.held.size; }
}

describe('dining philosophers — canonical lock order removes the cycle', () => {
  it('the naive per-philosopher order has a cycle; orderLocks removes it', () => {
    const N = 5;
    const naive = Array.from({ length: N }, (_, i) => [
      { lockClass: 'resource' as const, key: `fork-${i}` },
      { lockClass: 'resource' as const, key: `fork-${(i + 1) % N}` },
    ]);
    const ordered = naive.map(orderLocks);
    expect(ordered.every(isCanonicalOrder)).toBe(true);
    // The wrapping philosopher (fork-4, fork-0) now grabs fork-0 first → no cycle.
    expect(ordered[N - 1].map((l) => l.key)).toEqual(['fork-0', `fork-${N - 1}`]);
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
      await Promise.resolve(); // "eat"
      ate.push(i);
      for (const f of [...forks].reverse()) table.release(f.key);
    };
    await Promise.race([
      Promise.all(Array.from({ length: N }, (_, i) => philosopher(i))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DEADLOCK: philosophers did not finish')), 2000)),
    ]);
    expect(ate.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(table.heldCount).toBe(0);
  });
});
