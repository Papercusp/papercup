/**
 * outbox-drain-shared-listen.test.ts — P-008 (shared-hive-cross-machine-scale-10k):
 * the per-harness outbox drain must be able to ride ONE shared LISTEN backend.
 *
 * WHY THIS EXISTS: `startOutboxDrain` is started once per harness, and its
 * `pg.listen` reserves a dedicated PG backend per call — so N booted harnesses held
 * N dedicated connections, all subscribed to the SAME global `substrate_outbox`
 * channel, each discarding the other N-1 harnesses' payloads. These tests pin the
 * `opts.listen` seam that lets every harness share one ref-counted backend
 * (`pg-listen-hub`), WITHOUT changing the per-harness `ws::slug` filter semantics.
 *
 * Guards the regression in BOTH directions: opting in must not open a dedicated
 * connection, and omitting the option must stay byte-identical to legacy behavior.
 */

import { describe, expect, it, vi } from 'vitest';
import { startOutboxDrain } from '../outbox-drain';
import type { BootedHarnessHandle } from '../boot';

/**
 * Minimal `postgres.Sql` fake. The drain issues template-tag queries during its
 * immediate catch-up pass; those resolve empty (and any drain error is swallowed
 * internally), which keeps these tests focused on the LISTEN routing decision.
 */
function fakePg() {
  const unlisten = vi.fn(async () => {});
  const listen = vi.fn(async () => ({ unlisten }));
  const query = vi.fn(() => Promise.resolve([]));
  const sql = Object.assign(query, {
    listen,
    unsafe: () => Promise.resolve([]),
    begin: async (fn: (t: unknown) => unknown) => fn(sql),
  });
  return { sql: sql as unknown as import('postgres').Sql, listen, unlisten };
}

function fakeHandle(workspaceId: string, harnessSlug: string): BootedHarnessHandle {
  return {
    workspaceId,
    harnessSlug,
    close: async () => {},
  } as unknown as BootedHarnessHandle;
}

/**
 * A stand-in for `hubListen`: ONE backend, ref-counted, fanning out in-process —
 * the shape `pg-listen-hub` provides.
 */
function fakeHub() {
  const subscribers = new Set<(payload: string) => void>();
  let opens = 0;
  let closes = 0;

  const listen = vi.fn(async (_channel: string, cb: (payload: string) => void) => {
    if (subscribers.size === 0) opens++; // first subscriber opens the backend
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
      if (subscribers.size === 0) closes++; // last unsubscribe closes it
    };
  });

  return {
    listen,
    emit: (payload: string) => [...subscribers].forEach((cb) => cb(payload)),
    opens: () => opens,
    closes: () => closes,
    subscriberCount: () => subscribers.size,
  };
}

describe('startOutboxDrain — shared LISTEN (P-008)', () => {
  it('opts.listen replaces the dedicated pg.listen entirely (N harnesses != N connections)', async () => {
    const pg = fakePg();
    const hub = fakeHub();

    const drain = startOutboxDrain(fakeHandle('ws1', 'alpha'), pg.sql, {
      pollMs: 0,
      listen: hub.listen,
    });

    // The whole point: no dedicated backend was reserved for this harness.
    expect(pg.listen).not.toHaveBeenCalled();
    expect(hub.listen).toHaveBeenCalledTimes(1);
    expect(hub.listen.mock.calls[0]![0]).toBe('substrate_outbox');

    await drain.stop();
  });

  it('three harnesses share ONE backend instead of opening three', async () => {
    const hub = fakeHub();
    const pgs = [fakePg(), fakePg(), fakePg()];

    const drains = [
      startOutboxDrain(fakeHandle('ws1', 'alpha'), pgs[0]!.sql, { pollMs: 0, listen: hub.listen }),
      startOutboxDrain(fakeHandle('ws1', 'beta'), pgs[1]!.sql, { pollMs: 0, listen: hub.listen }),
      startOutboxDrain(fakeHandle('ws1', 'gamma'), pgs[2]!.sql, { pollMs: 0, listen: hub.listen }),
    ];
    await Promise.resolve();

    expect(hub.opens()).toBe(1);
    expect(hub.subscriberCount()).toBe(3);
    pgs.forEach((p) => expect(p.listen).not.toHaveBeenCalled());

    for (const d of drains) await d.stop();
  });

  it('keeps per-harness ws::slug filtering — a peer harness NOTIFY is ignored', async () => {
    const pg = fakePg();
    const hub = fakeHub();
    const drain = startOutboxDrain(fakeHandle('ws1', 'alpha'), pg.sql, {
      pollMs: 0,
      listen: hub.listen,
    });
    // Let the immediate catch-up drain fully settle FIRST — otherwise its in-flight
    // queries land between the baseline snapshot and the assertion and look like a
    // spurious wake (they are not).
    const settle = () => new Promise((r) => setTimeout(r, 10));
    await settle();

    const queryCount = () =>
      (pg.sql as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const callsAfterBoot = queryCount();

    // A NOTIFY addressed to a DIFFERENT harness on the shared channel must not
    // wake this drain — the whole fan-out rests on this filter staying intact.
    hub.emit('ws1::beta');
    hub.emit('ws2::alpha'); // same slug, different workspace
    await settle();
    expect(queryCount()).toBe(callsAfterBoot);

    // Its OWN payload does wake it.
    hub.emit('ws1::alpha');
    await settle();
    expect(queryCount()).toBeGreaterThan(callsAfterBoot);

    await drain.stop();
  });

  it('stopping one harness does not deafen its peers; the LAST detach closes the backend', async () => {
    const hub = fakeHub();
    const a = startOutboxDrain(fakeHandle('ws1', 'alpha'), fakePg().sql, {
      pollMs: 0,
      listen: hub.listen,
    });
    const b = startOutboxDrain(fakeHandle('ws1', 'beta'), fakePg().sql, {
      pollMs: 0,
      listen: hub.listen,
    });
    await Promise.resolve();
    expect(hub.subscriberCount()).toBe(2);

    await a.stop();
    expect(hub.subscriberCount()).toBe(1); // beta still listening
    expect(hub.closes()).toBe(0); // backend still open

    await b.stop();
    expect(hub.subscriberCount()).toBe(0);
    expect(hub.closes()).toBe(1); // last detach released it
  });

  it('stop() is idempotent on the shared path (double teardown must not over-release)', async () => {
    const hub = fakeHub();
    const drain = startOutboxDrain(fakeHandle('ws1', 'alpha'), fakePg().sql, {
      pollMs: 0,
      listen: hub.listen,
    });
    await Promise.resolve();

    await drain.stop();
    await drain.stop();
    expect(hub.closes()).toBe(1);
  });

  it('a failing shared subscription does not throw into the boot path', async () => {
    const failing = vi.fn(async () => {
      throw new Error('hub down');
    });
    const drain = startOutboxDrain(fakeHandle('ws1', 'alpha'), fakePg().sql, {
      pollMs: 0,
      listen: failing as unknown as (
        c: string,
        cb: (p: string) => void,
      ) => Promise<() => void>,
    });
    await Promise.resolve();
    await Promise.resolve();

    // Setup failed, but the drain object is usable and teardown stays quiet —
    // the poll fallback is what preserves liveness in this case.
    await expect(drain.stop()).resolves.toBeUndefined();
  });

  it('OMITTING opts.listen keeps the legacy dedicated pg.listen path byte-identical', async () => {
    const pg = fakePg();
    const drain = startOutboxDrain(fakeHandle('ws1', 'alpha'), pg.sql, { pollMs: 0 });
    await Promise.resolve();

    expect(pg.listen).toHaveBeenCalledTimes(1);
    expect(pg.listen.mock.calls[0]![0]).toBe('substrate_outbox');

    await drain.stop();
    expect(pg.unlisten).toHaveBeenCalledTimes(1);
  });
});
