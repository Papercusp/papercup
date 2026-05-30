/**
 * conformance.ts — the ONE SubscriptionStore contract suite, exported so
 * every backend proves swappability against the SAME assertions (the P-050
 * gate), mirroring the sibling stores.
 *
 * Consumed by:
 *   - `subscription-store.test.ts` (package): InMemorySubscriptionStore.
 *   - the operator's live-PG integration test: PgSubscriptionStore.
 *
 * Cases mint unique owner + msg_id values per case (a `runPrefix`) so the
 * suite is safe against a SHARED live PG table without a cleanup hook —
 * listActive filters by owner, so other cases' rows are never observed.
 * Expiry is asserted with far-past / far-future fixed timestamps so the
 * wall-clock `now()` comparison (SQL `now()` / `Date.now()`) is
 * deterministic without an injectable clock.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SubscriptionStore } from './types';

const FAR_PAST = '2000-01-01T00:00:00.000Z';
const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

export function describeSubscriptionStoreConformance(
  name: string,
  makeStore: () => SubscriptionStore,
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`SubscriptionStore conformance — ${name}`, () => {
    let skip = false;
    const runPrefix = `subconf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let n = 0;
    const owner = (): string => `${runPrefix}-owner-${n++}`;
    const mid = (): string => `${runPrefix}-msg-${n++}`;

    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    it('add then listActive returns the watch for its owner', async () => {
      if (skip) return;
      const store = makeStore();
      const o = owner();
      const m = mid();
      await store.add({ msg_id: m, owner_id: o, pattern: 'apps/**', trigger: 'any', created_ts: '2026-01-01T00:00:00.000Z' });
      const active = await store.listActive({ owner: o });
      expect(active.map((s) => s.msg_id)).toEqual([m]);
      expect(active[0].pattern).toBe('apps/**');
      expect(active[0].trigger).toBe('any');
    });

    it('cancel removes a watch from listActive (and is owner-scoped)', async () => {
      if (skip) return;
      const store = makeStore();
      const o = owner();
      const m = mid();
      await store.add({ msg_id: m, owner_id: o, pattern: 'x', trigger: 'any', created_ts: '2026-01-01T00:00:00.000Z' });
      await store.cancel('someone-else', m); // wrong owner → no-op
      expect((await store.listActive({ owner: o })).map((s) => s.msg_id)).toEqual([m]);
      await store.cancel(o, m);
      expect(await store.listActive({ owner: o })).toEqual([]);
    });

    it('an expired watch is excluded; a future-expiry and a null-expiry watch are included', async () => {
      if (skip) return;
      const store = makeStore();
      const o = owner();
      const expired = mid();
      const future = mid();
      const never = mid();
      await store.add({ msg_id: expired, owner_id: o, pattern: 'a', trigger: 'any', created_ts: '2026-01-01T00:00:01.000Z', expires_ts: FAR_PAST });
      await store.add({ msg_id: future, owner_id: o, pattern: 'b', trigger: 'any', created_ts: '2026-01-01T00:00:02.000Z', expires_ts: FAR_FUTURE });
      await store.add({ msg_id: never, owner_id: o, pattern: 'c', trigger: 'any', created_ts: '2026-01-01T00:00:03.000Z', expires_ts: null });
      const active = await store.listActive({ owner: o });
      expect(active.map((s) => s.msg_id)).toEqual([future, never]);
    });

    it('listActive sorts by (created_ts, msg_id)', async () => {
      if (skip) return;
      const store = makeStore();
      const o = owner();
      const a = mid();
      const b = mid();
      // b created earlier than a → b sorts first regardless of msg_id order.
      await store.add({ msg_id: a, owner_id: o, pattern: 'a', trigger: 'any', created_ts: '2026-01-02T00:00:00.000Z' });
      await store.add({ msg_id: b, owner_id: o, pattern: 'b', trigger: 'any', created_ts: '2026-01-01T00:00:00.000Z' });
      expect((await store.listActive({ owner: o })).map((s) => s.msg_id)).toEqual([b, a]);
    });
  });
}
