/**
 * shared-presence-reaper unit — bind-param regression guard.
 *
 * Live-run finding (WI-1544 rig, frame a, 2026-07-02): every reaper tick failed
 * with `The "string" argument must be of type string … Received an instance of
 * Date` because the TTL floor was bound as a raw JS Date. The org PG client
 * (`getOrgPg`) REJECTS a raw Date param for a timestamptz — it must be bound as
 * an ISO string (+ `::timestamptz` cast). The sibling integration test uses a
 * VANILLA postgres.js client (which DOES coerce Dates), so it cannot catch this;
 * this test captures the tagged-template values and asserts no raw Date is ever
 * bound. Same guard style as `hive-eval/store-pg.test.ts`; see the
 * `org-pg-client-rejects-raw-date` memory / EI-2549.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { reapStaleSharedPresence } from '../shared-presence-reaper';

function captureSql(): { tag: postgres.Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const tag = ((_s: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    const rows: unknown[] & { count?: number } = [];
    rows.count = 0;
    return Promise.resolve(rows);
  }) as unknown as postgres.Sql;
  return { tag, calls };
}

describe('shared-presence-reaper — bind params', () => {
  it('never binds a raw Date (TTL floor goes over as an ISO string)', async () => {
    const { tag, calls } = captureSql();
    const nowMs = 1_800_000_000_000;
    const ttlMs = 4 * 60 * 60 * 1000;

    await reapStaleSharedPresence({ ttlMs, maxRowsPerDevice: 128, nowMs, sql: tag });

    // 2 TTL deletes + 2 cap deletes.
    expect(calls).toHaveLength(4);
    const bound = calls.flat();
    for (const v of bound) {
      expect(v).not.toBeInstanceOf(Date);
    }
    // The TTL floor is the ISO string of (now - ttl), on both TTL deletes.
    const expectedFloor = new Date(nowMs - ttlMs).toISOString();
    expect(calls[0]).toEqual([expectedFloor]);
    expect(calls[1]).toEqual([expectedFloor]);
    // The cap deletes bind the numeric cap.
    expect(calls[2]).toEqual([128]);
    expect(calls[3]).toEqual([128]);
  });
});
