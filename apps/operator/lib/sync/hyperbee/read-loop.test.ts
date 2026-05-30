/**
 * read-loop.test.ts — unit tests for the Hyperbee→PG read-loop driver.
 *
 * No live Autobase / PG: a fake handle exposes an in-memory op-log `view`
 * ({ length, get(i) }) + an EventEmitter for `'update'`; `applyImpl` is
 * injected so we assert replay ordering / cursor advance / idempotency /
 * teardown deterministically. `intervalMs: 0` disables the polled fallback so
 * drains happen only via the constructor's initial backfill, an emitted
 * 'update', or an explicit drainOnce(). `tick()` (a macrotask) flushes the
 * pending microtasks of the constructor's initial drain.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { startHyperbeeReadLoop } from './read-loop';
import type { AutobaseHarnessHandle } from './autobase-setup';

const tick = () => new Promise((r) => setTimeout(r, 0));

interface FakeView {
  log: unknown[];
  throwOnNextGet: boolean;
  gate: Promise<void> | null;
}

function fakeHandle() {
  const ee = new EventEmitter();
  const v: FakeView = { log: [], throwOnNextGet: false, gate: null };
  const base = {
    base: {
      view: {
        get length() {
          return v.log.length;
        },
        async get(i: number): Promise<unknown> {
          if (v.gate) await v.gate;
          if (v.throwOnNextGet) {
            v.throwOnNextGet = false;
            throw new Error('view closing');
          }
          return v.log[i] ?? null;
        },
      },
      on: (ev: string, fn: () => void) => ee.on(ev, fn),
      off: (ev: string, fn: () => void) => ee.off(ev, fn),
    },
    append: async () => {},
    close: async () => {},
  } as unknown as AutobaseHarnessHandle;
  return { base, v, emit: () => ee.emit('update') };
}

const op = (id: string) => ({ type: 'put', table: 'queue', hbKey: id, value: { id } });

describe('startHyperbeeReadLoop', () => {
  it('replays all current ops in order on the initial backfill drain', async () => {
    const { base, v } = fakeHandle();
    const applied: unknown[] = [];
    v.log.push(op('a'), op('b'), op('c'));
    const loop = startHyperbeeReadLoop({
      workspaceId: 'w',
      harnessSlug: 's',
      base,
      intervalMs: 0,
      applyImpl: async (o) => {
        applied.push(o);
        return true;
      },
    });
    await tick(); // let the constructor's initial drain finish
    expect(applied.map((o) => (o as { hbKey: string }).hbKey)).toEqual(['a', 'b', 'c']);
    loop.stop();
  });

  it('replays only the delta on later drains (cursor advances, no re-apply)', async () => {
    const { base, v } = fakeHandle();
    const apply = vi.fn(async () => true);
    const loop = startHyperbeeReadLoop({ workspaceId: 'w', harnessSlug: 's', base, intervalMs: 0, applyImpl: apply });
    await tick(); // initial drain over empty log
    v.log.push(op('a'));
    expect(await loop.drainOnce()).toBe(1);
    v.log.push(op('b'), op('c'));
    expect(await loop.drainOnce()).toBe(2);
    expect(apply).toHaveBeenCalledTimes(3); // a, then b+c — 'a' never re-applied
    loop.stop();
  });

  it('drains on the Autobase "update" event', async () => {
    const { base, v, emit } = fakeHandle();
    const apply = vi.fn(async () => true);
    const loop = startHyperbeeReadLoop({ workspaceId: 'w', harnessSlug: 's', base, intervalMs: 0, applyImpl: apply });
    await tick();
    apply.mockClear();
    v.log.push(op('a'));
    emit();
    await tick();
    expect(apply).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('stop() halts further draining', async () => {
    const { base, v } = fakeHandle();
    const apply = vi.fn(async () => true);
    const loop = startHyperbeeReadLoop({ workspaceId: 'w', harnessSlug: 's', base, intervalMs: 0, applyImpl: apply });
    await tick();
    loop.stop();
    v.log.push(op('a'));
    expect(await loop.drainOnce()).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('bails without advancing the cursor when view.get throws, retrying that op next drain', async () => {
    const { base, v } = fakeHandle();
    const applied: string[] = [];
    const loop = startHyperbeeReadLoop({
      workspaceId: 'w',
      harnessSlug: 's',
      base,
      intervalMs: 0,
      applyImpl: async (o) => {
        applied.push((o as { hbKey: string }).hbKey);
        return true;
      },
    });
    await tick(); // initial drain (empty)
    v.log.push(op('a'));
    v.throwOnNextGet = true; // first get(0) throws
    expect(await loop.drainOnce()).toBe(0); // bailed, cursor still 0
    expect(applied).toEqual([]);
    expect(await loop.drainOnce()).toBe(1); // retries index 0 successfully
    expect(applied).toEqual(['a']);
    loop.stop();
  });

  it('coalesces overlapping drains (the in-flight guard)', async () => {
    const { base, v } = fakeHandle();
    const apply = vi.fn(async () => true);
    const loop = startHyperbeeReadLoop({ workspaceId: 'w', harnessSlug: 's', base, intervalMs: 0, applyImpl: apply });
    await tick(); // initial drain (empty) done
    let release: () => void = () => {};
    v.gate = new Promise<void>((r) => {
      release = r;
    });
    v.log.push(op('a'));
    const first = loop.drainOnce(); // enters, awaits the gate inside view.get
    const second = await loop.drainOnce(); // in-flight guard → 0 immediately
    expect(second).toBe(0);
    release();
    v.gate = null;
    await first;
    expect(apply).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('skips null view entries but still advances past them', async () => {
    const { base, v } = fakeHandle();
    const apply = vi.fn(async () => true);
    const loop = startHyperbeeReadLoop({ workspaceId: 'w', harnessSlug: 's', base, intervalMs: 0, applyImpl: apply });
    await tick();
    v.log.push(op('a'), null, op('c'));
    expect(await loop.drainOnce()).toBe(2); // null skipped
    loop.stop();
  });
});
