/**
 * Self-test of the v1-core multi-peer harness (p2p-v1-core-release-2026-11-13
 * P-002). Proves the harness is fit to carry R-1..R-9 in P-005: N real peers
 * replicate and settle to zero pending work, and every fault it offers acts on
 * the case's own traffic and leaves a receipt. The requirement assertions
 * themselves (R-1..R-9) live in P-005's suite, not here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIVE_SLUG, pollUntil, WORKSPACE_ID } from '../../sync/hyperbee/__tests__/_hive-substrate-rig';
import { createMultiPeerHarness, harnessAfterEach, type MultiPeerHarness } from './_multi-peer-harness';

// Each peer boots inside its own cell scope (runWithCellSql in the harness). Route every
// getOrgPg() to the current peer's throwaway database, and refuse any call made outside a
// peer's scope instead of falling back to the live Postgres target.
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const { currentCellSql } = await import('../../shared-pot-loop/cell-scope');
  return {
    ...actual,
    getOrgPg: () => {
      const sql = currentCellSql();
      if (!sql) throw new Error('getOrgPg outside a harness peer scope: boot and drive peers through the harness');
      return { sql };
    },
  };
});

afterEach(harnessAfterEach);

const CASE_TIMEOUT_MS = 180_000;

async function waitForHeld(h: MultiPeerHarness, receiver: string, writer: string, atLeast: number): Promise<void> {
  const ok = await pollUntil(
    async () => {
      await h.live(writer).drain();
      await h.live(receiver).handle.mergeNow();
      return h.peer(receiver).held.length >= atLeast || undefined;
    },
    { timeoutMs: 60_000, intervalMs: 50 },
  );
  expect(ok, `${receiver} never held ${atLeast} op(s) from ${writer}`).toBe(true);
}

describe('v1-core multi-peer harness (P-002)', () => {
  it(
    'three peers replicate a multi-key fixture and settle to zero pending work',
    async () => {
      const h = await createMultiPeerHarness(['a', 'b', 'c']);
      await h.writeSetting('a', 'k1', 'one');
      await h.writeSetting('b', 'k2', { n: 2 });
      await h.writeSetting('a', 'k1', 'one-changed');
      await h.settle();
      const pending = await h.pendingWork();
      expect(pending.total).toBe(0);
      const want = await h.dump('a');
      expect(want.settings).toEqual([
        { key: 'k1', value: 'one-changed' },
        { key: 'k2', value: { n: 2 } },
      ]);
      expect(await h.dump('b')).toEqual(want);
      expect(await h.dump('c')).toEqual(want);
      expect(h.receipts).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'delay, reorder and duplicate act on the traffic and leave receipts naming those ops',
    async () => {
      const h = await createMultiPeerHarness(['a', 'c']);
      await h.settle();
      h.setDeliveryFaults('c', { hold: true, reorder: true, duplicate: true });
      await h.writeSetting('a', 'k1', 'v1');
      await waitForHeld(h, 'c', 'a', 1);
      await h.writeSetting('a', 'k1', 'v2');
      await waitForHeld(h, 'c', 'a', 2);
      expect(h.receiptsOf('delay').length).toBeGreaterThanOrEqual(2);
      await h.flush('c');
      const [reorder] = h.receiptsOf('reorder');
      expect(reorder, 'a flush of 2+ held ops under reorder records the changed order').toBeDefined();
      const arrival = reorder!.detail.arrivalOrder as string[];
      const delivery = reorder!.detail.deliveryOrder as string[];
      expect(delivery).toEqual([...arrival].reverse());
      expect(arrival.every((id) => id.includes('k1'))).toBe(true);
      expect(h.receiptsOf('duplicate').length).toBeGreaterThanOrEqual(2);
      h.setDeliveryFaults('c', { hold: false, reorder: false, duplicate: false });
      await h.settle();
      expect((await h.dump('c')).settings).toEqual([{ key: 'k1', value: 'v2' }]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'a skewed clock stamps its ops ahead and the receiver records the skew on arrival',
    async () => {
      const h = await createMultiPeerHarness(['a', 'b']);
      await h.settle();
      await h.skewClock('a', 120_000);
      await h.writeSetting('a', 'skewed', true);
      await h.settle();
      const arrived = h.receiptsOf('clock-skew').filter((r) => r.peer === 'b');
      expect(arrived.length).toBeGreaterThanOrEqual(1);
      expect(arrived[0]!.detail.from).toBe('a');
      expect(arrived[0]!.detail.aheadMs as number).toBeGreaterThanOrEqual(60_000);
      expect((await h.dump('b')).settings).toEqual([{ key: 'skewed', value: true }]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'a partition keeps writes on one side until heal, then the peers converge',
    async () => {
      const h = await createMultiPeerHarness(['a', 'b', 'c']);
      await h.settle();
      h.partition(['a'], ['b', 'c']);
      expect(h.receiptsOf('partition').length).toBeGreaterThanOrEqual(1);
      await h.writeSetting('a', 'during', 'partition');
      await h.settle();
      const aLog = h.live('a').handle.ownLog;
      for (const other of ['b', 'c']) {
        const have = h.live(other).handle.admitted.get(aLog.keyHex)?.length ?? 0;
        expect(have, `${other} received a's partition-time write across the partition`).toBeLessThan(aLog.length);
        expect((await h.dump(other)).settings).toEqual([]);
      }
      expect((await h.pendingWork()).partitionedPairs.length).toBe(2);
      h.heal();
      await h.settle();
      for (const other of ['b', 'c']) {
        expect((await h.dump(other)).settings).toEqual([{ key: 'during', value: 'partition' }]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'a restart builds a fresh instance from the same storage with the same own-log key',
    async () => {
      const h = await createMultiPeerHarness(['a', 'b']);
      await h.settle();
      const before = h.live('b');
      await h.restart('b');
      const after = h.live('b');
      expect(after).not.toBe(before);
      expect(after.handle).not.toBe(before.handle);
      const [receipt] = h.receiptsOf('restart');
      expect(receipt!.detail.incarnation).toBe(2);
      expect(receipt!.detail.ownLogKeyAfter).toBe(receipt!.detail.ownLogKeyBefore);
      await h.writeSetting('b', 'after-restart', 1);
      await h.settle();
      expect((await h.dump('a')).settings).toEqual([{ key: 'after-restart', value: 1 }]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'revoke-during-sync refuses with nothing in flight and records the frontier when work is in flight',
    async () => {
      const h = await createMultiPeerHarness(['a', 'b']);
      await h.settle();
      await expect(h.revokeDuringSync('b')).rejects.toThrow(/needs replication work in flight/);
      h.setDeliveryFaults('b', { hold: true });
      await h.writeSetting('a', 'before-revoke', 1);
      await waitForHeld(h, 'b', 'a', 1);
      const frontier = await h.revokeDuringSync('b');
      expect(frontier.pendingAtRevocation).toBeGreaterThan(0);
      expect(frontier.ownLogLengths.a).toBe(h.live('a').handle.ownLog.length);
      expect(h.isRevoked('b')).toBe(true);
      expect(h.receiptsOf('revoke-during-sync')).toHaveLength(1);
      await h.settle();
      expect((await h.pendingWork()).total).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'a row the drain refuses by design does not block settle and is reported as refused',
    async () => {
      const h = await createMultiPeerHarness(['a', 'b']);
      await h.settle();
      const a = h.live('a');
      const realWarn = console.warn.bind(console);
      const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).startsWith('[outbox-drain] skipping outbox rows')) realWarn(...args);
      });
      try {
        // An outbox row for a table this build has no mapper for: the drain skips it and
        // leaves it undrained on purpose (the same skip path as a P-003 no-rule table).
        await a.pg`INSERT INTO harness_shared.substrate_outbox (workspace_id, harness_slug, table_name, op, key, row, ts)
                   VALUES (${WORKSPACE_ID}, ${HIVE_SLUG}, 'mph_refused_table', 'put', 'mph-refused-row', '{}'::jsonb, ${Date.now()})`;
        await h.writeSetting('a', 'after-refused', 'replicates');
        await h.settle();
        const pending = await h.pendingWork();
        expect(pending.total).toBe(0);
        expect(pending.perPeer.a).toMatchObject({ undrained: 0, refusedUndrained: 1 });
        const [row] = await a.pg<Array<{ drained: boolean }>>`
          SELECT drained_at IS NOT NULL AS drained FROM harness_shared.substrate_outbox WHERE key = 'mph-refused-row'`;
        expect(row?.drained).toBe(false);
        expect((await h.dump('b')).settings).toEqual([{ key: 'after-refused', value: 'replicates' }]);
        expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
          "[outbox-drain] skipping outbox rows for unmapped table 'mph_refused_table' " +
            '(forward-compat: this build has no projection for it; a newer build will federate them). ' +
            'Rows stay undrained.',
        );
      } finally {
        warn.mockRestore();
      }
    },
    CASE_TIMEOUT_MS,
  );
});
