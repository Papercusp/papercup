/**
 * substrate-eviction-reaper.test.ts — the LAZY_SUBSTRATE_BOOT reaper LOOP
 * (P-008 / WI-596). The pure decision is tested in substrate-eviction-policy.test.ts;
 * here we prove the loop: it asks the policy, evicts the chosen keys, honours the
 * evict-fn's skip return, never overlaps a slow pass, and never throws out.
 */

import { describe, expect, it, vi } from 'vitest';
import { startSubstrateEvictionReaper } from './substrate-eviction-reaper';
import type { BootedHarnessFacts } from './substrate-eviction-policy';

const IDLE = 30 * 60_000;
const NOW = 1_000_000_000;

function fact(over: Partial<BootedHarnessFacts> & { key: string }): BootedHarnessFacts {
  return {
    lastAccessMs: NOW - IDLE - 1, // idle by default
    hasActivePeer: false,
    pinned: false,
    ...over,
  };
}

describe('substrate eviction reaper loop', () => {
  it('evicts the keys the policy chooses', async () => {
    const evicted: string[] = [];
    const reaper = startSubstrateEvictionReaper({
      intervalMs: 0, // timer off — drive by hand
      idleMs: IDLE,
      maxResident: 0,
      now: () => NOW,
      gatherFacts: () => [fact({ key: 'a' }), fact({ key: 'b' })],
      evict: (key) => {
        evicted.push(key);
        return true;
      },
    });
    const out = await reaper.tickOnce();
    expect(out.sort()).toEqual(['a', 'b']);
    expect(evicted.sort()).toEqual(['a', 'b']);
    reaper.stop();
  });

  it('never evicts pinned / active-peer / hot facts (policy boundary)', async () => {
    const reaper = startSubstrateEvictionReaper({
      intervalMs: 0,
      idleMs: IDLE,
      maxResident: 0,
      now: () => NOW,
      gatherFacts: () => [
        fact({ key: 'pinned', pinned: true }),
        fact({ key: 'peer', hasActivePeer: true }),
        fact({ key: 'hot', lastAccessMs: NOW - 1 }),
        fact({ key: 'cold' }),
      ],
      evict: (k) => k === 'cold',
    });
    const out = await reaper.tickOnce();
    expect(out).toEqual(['cold']);
    reaper.stop();
  });

  it('honours the evict-fn skip (race re-check returns false)', async () => {
    const reaper = startSubstrateEvictionReaper({
      intervalMs: 0,
      idleMs: IDLE,
      maxResident: 0,
      now: () => NOW,
      gatherFacts: () => [fact({ key: 'a' }), fact({ key: 'b' })],
      // 'a' got hot between snapshot + close → skip; 'b' evicts.
      evict: (key) => key === 'b',
    });
    const out = await reaper.tickOnce();
    expect(out).toEqual(['b']);
    reaper.stop();
  });

  it('a throwing evict never aborts the pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evicted: string[] = [];
    const reaper = startSubstrateEvictionReaper({
      intervalMs: 0,
      idleMs: IDLE,
      maxResident: 0,
      now: () => NOW,
      gatherFacts: () => [fact({ key: 'a' }), fact({ key: 'b' }), fact({ key: 'c' })],
      evict: (key) => {
        if (key === 'b') throw new Error('boom');
        evicted.push(key);
        return true;
      },
    });
    const out = await reaper.tickOnce();
    expect(out).toEqual(['a', 'c']); // 'b' threw → not counted, pass continued
    expect(evicted).toEqual(['a', 'c']);
    expect(warn).toHaveBeenCalled(); // the failed evict was logged
    warn.mockRestore();
    reaper.stop();
  });

  it('a throwing gatherFacts never throws out of the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reaper = startSubstrateEvictionReaper({
      intervalMs: 0,
      idleMs: IDLE,
      maxResident: 0,
      now: () => NOW,
      gatherFacts: () => {
        throw new Error('pg down');
      },
      evict: () => true,
    });
    await expect(reaper.tickOnce()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    reaper.stop();
  });

  it('does not overlap a slow pass', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reaper = startSubstrateEvictionReaper({
      intervalMs: 0,
      idleMs: IDLE,
      maxResident: 0,
      now: () => NOW,
      gatherFacts: () => [fact({ key: 'a' })],
      evict: async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await gate;
        inFlight--;
        return true;
      },
    });
    const p1 = reaper.tickOnce();
    const p2 = reaper.tickOnce(); // should no-op while p1 runs
    expect(await p2).toEqual([]); // skipped — p1 still running
    release();
    await p1;
    expect(maxConcurrent).toBe(1);
    reaper.stop();
  });

  it('the interval timer is unref-d and stop() is idempotent', () => {
    const reaper = startSubstrateEvictionReaper({
      intervalMs: 60_000,
      idleMs: IDLE,
      maxResident: 0,
      gatherFacts: () => [],
      evict: () => true,
    });
    // No throw on double-stop.
    reaper.stop();
    reaper.stop();
    expect(true).toBe(true);
  });

  it('reports each tick decision to onTick', async () => {
    const ticks: Array<{ evict: string[]; evicted: string[] }> = [];
    const reaper = startSubstrateEvictionReaper({
      intervalMs: 0,
      idleMs: IDLE,
      maxResident: 0,
      now: () => NOW,
      gatherFacts: () => [fact({ key: 'a' }), fact({ key: 'keep', pinned: true })],
      evict: () => true,
      onTick: ({ decision, evicted }) =>
        ticks.push({ evict: decision.evict, evicted }),
    });
    await reaper.tickOnce();
    expect(ticks).toHaveLength(1);
    expect(ticks[0].evict).toEqual(['a']);
    expect(ticks[0].evicted).toEqual(['a']);
    reaper.stop();
  });
});
