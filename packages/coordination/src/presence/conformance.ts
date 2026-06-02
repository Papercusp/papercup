/**
 * describePresenceConformance — the shared PresenceStore contract suite.
 *
 * The SAME assertions run against BOTH `InMemoryPresenceStore` (the test
 * double) and `PgPresenceStore` (production, over a live org PG). That
 * dual run is what actually proves the two impls are swappable (P-050) —
 * the presence analogue of `@papercusp/file-claim/conformance`. Before
 * this, only the in-mem double was asserted and the PG impl was merely
 * "exercised live in prod", so the swappability claim was unbacked.
 *
 * Two realities this suite is written to tolerate, so the SAME cases pass
 * for both backends:
 *   1. No injectable clock on PG — it stamps `now()`. So timing is asserted
 *      by ordering + monotonicity (with small real delays), never exact
 *      values. Exact stale-boundary assertions need a fake clock and stay
 *      in-mem-only (see presence.test.ts).
 *   2. The PG table is SHARED and non-empty (other agents' live rows). So
 *      every case mints unique owner ids + a unique workspace, filters
 *      global `list()` results to its own owners, and clears its rows after.
 *   3. Timestamp representation differs (postgres-js returns `Date`; the
 *      in-mem double returns ISO strings) — both are JSON-identical, so
 *      time is compared via `new Date(x).getTime()`, not string identity.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PresenceIdentity, PresenceStore } from './types';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ms = (t: string): number => new Date(t).getTime();

/**
 * Register the PresenceStore contract cases against `makeStore`.
 *
 * @param makeStore returns a store to test — a fresh one per case for the
 *   in-mem double; a shared handle for PG (isolation is by unique owner id).
 * @param opts.ready optional async gate; when it resolves `false` (e.g. PG
 *   unreachable) every case soft-skips instead of failing.
 */
export function describePresenceConformance(
  name: string,
  makeStore: () => PresenceStore,
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`PresenceStore conformance — ${name}`, () => {
    let skip = false;
    const runPrefix = `conf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let n = 0;
    const created: Array<{ store: PresenceStore; ownerId: string }> = [];

    function ident(
      store: PresenceStore,
      suffix: string,
      workspaceId: string | null = 'w1',
    ): PresenceIdentity {
      const ownerId = `${runPrefix}-${n++}-${suffix}`;
      created.push({ store, ownerId });
      return { ownerId, ownerLabel: `lbl-${suffix}`, source: 'static-client', workspaceId };
    }

    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    afterEach(async () => {
      // Self-clean every owner this case minted — load-bearing on the
      // shared live PG table so cases don't see each other's rows.
      for (const { store, ownerId } of created.splice(0)) {
        try {
          await store.clear(ownerId);
        } catch {
          /* best-effort */
        }
      }
    });

    it('write upserts; get returns the written state and is fresh', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'a');
      await store.write(id, {
        intent: 'first',
        currentFiles: ['x.ts'],
        currentPlanSlug: 'p1',
        host: 'h',
        pid: 42,
      });
      const rec = await store.get(id.ownerId);
      expect(rec).not.toBeNull();
      expect(rec!.ownerId).toBe(id.ownerId);
      expect(rec!.ownerLabel).toBe('lbl-a');
      expect(rec!.source).toBe('static-client');
      expect(rec!.workspaceId).toBe('w1');
      expect(rec!.intent).toBe('first');
      expect(rec!.currentFiles).toEqual(['x.ts']);
      expect(rec!.currentPlanSlug).toBe('p1');
      expect(rec!.host).toBe('h');
      expect(rec!.pid).toBe(42);
      expect(rec!.stale).toBe(false);
    });

    it('get returns null for an unknown owner', async () => {
      if (skip) return;
      const store = makeStore();
      expect(await store.get(`${runPrefix}-missing`)).toBeNull();
    });

    it('re-write preserves startedAt and advances heartbeatAt', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'a');
      await store.write(id, { intent: 'first' });
      const first = await store.get(id.ownerId);
      await delay(8);
      await store.write(id, { intent: 'second', currentFiles: ['y.ts'] });
      const second = await store.get(id.ownerId);
      expect(second!.intent).toBe('second');
      expect(second!.currentFiles).toEqual(['y.ts']);
      expect(ms(second!.startedAt)).toBe(ms(first!.startedAt));
      expect(ms(second!.heartbeatAt)).toBeGreaterThanOrEqual(ms(first!.heartbeatAt));
    });

    it('touchHeartbeat bumps heartbeat and is a no-op on a missing owner', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'a');
      await store.write(id, { intent: 'keep' });
      const before = await store.get(id.ownerId);
      await delay(8);
      await store.touchHeartbeat(id.ownerId);
      await store.touchHeartbeat(`${runPrefix}-nobody`); // must not throw
      const after = await store.get(id.ownerId);
      expect(after!.intent).toBe('keep'); // only heartbeat moved
      expect(ms(after!.heartbeatAt)).toBeGreaterThanOrEqual(ms(before!.heartbeatAt));
    });

    it('heartbeat creates a row if absent (empty intent) and never clobbers a declared intent', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'hb');
      // create-if-absent — no prior write
      await store.heartbeat(id);
      let rec = await store.get(id.ownerId);
      expect(rec).not.toBeNull();
      expect(rec!.intent).toBe('');
      expect(rec!.ownerLabel).toBe('lbl-hb');
      expect(rec!.stale).toBe(false);
      // declare a real intent, then heartbeat must PRESERVE it (unlike write)
      await store.write(id, { intent: 'doing X', currentFiles: ['a.ts'], currentPlanSlug: 'p9' });
      const before = await store.get(id.ownerId);
      await delay(8);
      await store.heartbeat(id);
      rec = await store.get(id.ownerId);
      expect(rec!.intent).toBe('doing X'); // preserved
      expect(rec!.currentFiles).toEqual(['a.ts']); // preserved
      expect(rec!.currentPlanSlug).toBe('p9'); // preserved
      expect(ms(rec!.heartbeatAt)).toBeGreaterThanOrEqual(ms(before!.heartbeatAt)); // bumped
    });

    it('clear removes the row', async () => {
      if (skip) return;
      const store = makeStore();
      const id = ident(store, 'a');
      await store.write(id);
      await store.clear(id.ownerId);
      expect(await store.get(id.ownerId)).toBeNull();
    });

    it('list returns rows newest-heartbeat-first', async () => {
      if (skip) return;
      const store = makeStore();
      const a = ident(store, 'a');
      await store.write(a);
      await delay(8);
      const b = ident(store, 'b');
      await store.write(b);
      await delay(8);
      const c = ident(store, 'c');
      await store.write(c);
      const ids = [a.ownerId, b.ownerId, c.ownerId];
      const mine = (await store.list()).filter((r) => ids.includes(r.ownerId));
      expect(mine.map((r) => r.ownerId)).toEqual([c.ownerId, b.ownerId, a.ownerId]);
    });

    it('list filters by workspace', async () => {
      if (skip) return;
      const store = makeStore();
      const ws = `${runPrefix}-ws`; // unique → isolates this case on the shared table
      const a = ident(store, 'a', ws);
      await store.write(a);
      await delay(8);
      const other = ident(store, 'other', `${ws}-other`);
      await store.write(other);
      await delay(8);
      const c = ident(store, 'c', ws);
      await store.write(c);
      const inWs = await store.list({ workspaceId: ws });
      expect(inWs.map((r) => r.ownerId)).toEqual([c.ownerId, a.ownerId]);
    });
  });
}
