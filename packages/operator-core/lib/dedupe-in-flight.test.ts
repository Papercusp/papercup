import { describe, it, expect } from 'vitest';
import { dedupeInFlight } from './dedupe-in-flight';

// Moved verbatim from system-health/compute.test.ts (EI-22091013068319789) when
// dedupeInFlight was extracted to its own module for reuse by
// sync-resolver/adv-roster-read.ts. Behavior is unchanged; only the import
// changed.
describe('dedupeInFlight — generic per-key single-flight (EI-19303672371455669)', () => {
  // Why this exists: resolveSystemHealth's cold path (no in-process cache, shared-snapshot
  // miss) fell straight through to a blocking runSystemHealthTick with NO de-dup — every
  // concurrent caller ran its own full ~20-collector aggregation. Measured live: a single
  // booting host sustained ~40x its expected tick rate for minutes. runSystemHealthTick now
  // wraps its real work in `dedupeInFlight`, keyed per workspace — these tests pin the
  // generic mechanism directly (no DB / no computeSystemHealth needed).

  it('concurrent callers on the SAME key share exactly one in-flight fn() call', async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const store = new Map<string, Promise<string>>();
    const fn = () => {
      calls += 1;
      return new Promise<string>((res) => { release = res; });
    };
    const a = dedupeInFlight(store, 'ws-a', fn);
    const b = dedupeInFlight(store, 'ws-a', fn); // starts BEFORE the first settles
    expect(calls).toBe(1); // fn invoked once, not twice — the exact stampede this closes
    release('health-snapshot');
    expect(await a).toBe('health-snapshot');
    expect(await b).toBe('health-snapshot'); // both callers got the SAME result
  });

  it('DIFFERENT keys never share an in-flight call — each workspace gets its own', async () => {
    const calls: string[] = [];
    const store = new Map<string, Promise<string>>();
    const a = dedupeInFlight(store, 'ws-a', async () => { calls.push('ws-a'); return 'a'; });
    const b = dedupeInFlight(store, 'ws-b', async () => { calls.push('ws-b'); return 'b'; });
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    expect(calls.sort()).toEqual(['ws-a', 'ws-b']);
  });

  it('the entry is cleared on SETTLE — a later call is a genuine fresh re-run, never a stale replay', async () => {
    let calls = 0;
    const store = new Map<string, Promise<number>>();
    const fn = async () => { calls += 1; return calls; };
    expect(await dedupeInFlight(store, 'ws-a', fn)).toBe(1);
    expect(await dedupeInFlight(store, 'ws-a', fn)).toBe(2); // NOT still 1 — not a permanent cache
    expect(store.size).toBe(0); // no leaked entries once every call has settled
  });

  it('a REJECTION is cleared too — the very next call retries rather than replaying the failure forever', async () => {
    let calls = 0;
    const store = new Map<string, Promise<string>>();
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('cold-tick boom');
      return 'recovered';
    };
    await expect(dedupeInFlight(store, 'ws-a', fn)).rejects.toThrow('cold-tick boom');
    // A caller racing DURING the failing call would have shared that SAME rejection
    // (single-flight applies to failures too) — but a call AFTER it settled must retry,
    // never serve (or re-throw) a cached rejection forever.
    expect(await dedupeInFlight(store, 'ws-a', fn)).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('concurrent callers racing INTO a failing call all share the SAME rejection (never a partial stampede)', async () => {
    let calls = 0;
    const store = new Map<string, Promise<string>>();
    let reject!: (e: Error) => void;
    const fn = () => {
      calls += 1;
      return new Promise<string>((_res, rej) => { reject = rej; });
    };
    const a = dedupeInFlight(store, 'ws-a', fn);
    const b = dedupeInFlight(store, 'ws-a', fn);
    expect(calls).toBe(1);
    reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
  });
});
