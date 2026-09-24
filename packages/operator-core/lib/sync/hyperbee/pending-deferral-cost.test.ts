/**
 * pending-deferral-cost.test.ts — P-523 (join-catchup D-009): deferring an op must cost O(1),
 * however full the buffer is.
 *
 * P-007 run #1 measured a fresh join crossing its snapshot set at 3.9 s per chunk while
 * applying nothing: every row waited for an epoch key, and each defer scanned the whole
 * 10,000-entry bucket for a duplicate (`list.some(sameOp)`), then evicted with an array
 * `shift()`. The guard counts reads of the identity fields: each deferred op may read its
 * own fields a bounded number of times, and a scan over the stored ops reads theirs, so the
 * count grows with the buffer size.
 *
 * `LinearScanBuffer` is the pre-P-523 shape kept as a permanent control. It must FAIL the
 * same bound, which proves the counting harness can see a scan.
 */
import { describe, expect, it } from 'vitest';
import { PendingEpochContent } from './pending-epoch-content';
import { PendingMembershipContent, type DeferMemberContentInput } from './pending-membership-content';
import type { OpEnvelope } from './op-envelope-types';

const IDENTITY_FIELDS = ['table', 'hbKey', 'hlc', 'ts', 'type'] as const;
const MEMBER_IDENTITY_FIELDS = ['tableTag', 'rowKey', 'fedHlc', 'fedTs'] as const;

/** An object whose `fields` are getters that bump `counter.reads`. */
function counted<T extends object>(base: T, fields: readonly string[], counter: { reads: number }): T {
  const out = { ...base } as Record<string, unknown>;
  for (const f of fields) {
    const v = (base as Record<string, unknown>)[f];
    delete out[f];
    Object.defineProperty(out, f, {
      enumerable: true,
      get() {
        counter.reads++;
        return v;
      },
    });
  }
  return out as T;
}

function contentOp(i: number, counter: { reads: number }): OpEnvelope {
  return counted(
    {
      type: 'put',
      table: 'features-by-id',
      hbKey: `F-${i}`,
      value: { i },
      ts: 1000 + i,
      schema_version: 1,
      hlc: `hlc-${i}`,
    } as OpEnvelope,
    IDENTITY_FIELDS,
    counter,
  );
}

function memberInput(i: number, counter: { reads: number }): DeferMemberContentInput {
  return counted(
    {
      authorDevice: 'devA',
      tableTag: 'features-by-id',
      rowKey: `F-${i}`,
      fedHlc: `hlc-${i}`,
      fedTs: 1000 + i,
      reapply: async () => {},
    },
    MEMBER_IDENTITY_FIELDS,
    counter,
  );
}

/** Pre-P-523 PendingEpochContent.defer: dedupe by scanning the bucket, evict with shift(). */
class LinearScanBuffer {
  private readonly list: OpEnvelope[] = [];
  constructor(private readonly cap: number) {}
  defer(op: OpEnvelope): boolean {
    const same = (a: OpEnvelope, b: OpEnvelope) =>
      a.table === b.table &&
      a.hbKey === b.hbKey &&
      (a.hlc ?? '') === (b.hlc ?? '') &&
      (a.ts ?? 0) === (b.ts ?? 0) &&
      a.type === b.type;
    if (this.list.some((d) => same(d, op))) return false;
    this.list.push(op);
    if (this.list.length > this.cap) this.list.shift();
    return true;
  }
}

const CAP = 500;
const N = 3 * CAP; // two thirds of the defers land on a full buffer
/** Generous per-op budget: a few reads of the op's own fields, never one per stored op. */
const READS_PER_OP = 4 * IDENTITY_FIELDS.length;

describe('P-523: a defer costs O(1) however full the buffer is', () => {
  it('control: the pre-P-523 linear scan exceeds the per-op bound (the harness can see a scan)', () => {
    const counter = { reads: 0 };
    const buf = new LinearScanBuffer(CAP);
    for (let i = 0; i < N; i++) buf.defer(contentOp(i, counter));
    expect(counter.reads).toBeGreaterThan(N * READS_PER_OP);
  });

  it('PendingEpochContent: deferring N distinct ops into a capped buffer reads O(N) identity fields', () => {
    const counter = { reads: 0 };
    const p = new PendingEpochContent(CAP);
    for (let i = 0; i < N; i++) expect(p.defer(contentOp(i, counter), 'hive', 0)).toBe(true);
    expect(counter.reads).toBeLessThanOrEqual(N * READS_PER_OP);
    // Behaviour is unchanged: the cap holds, the oldest were evicted, and the drain is FIFO.
    expect(p.size()).toBe(CAP);
    expect(p.consumeEvictionSignal()).toBe(true);
    const drained = p.drainEpoch('hive', 0).map((d) => d.op.hbKey);
    expect(drained[0]).toBe(`F-${N - CAP}`);
    expect(drained.at(-1)).toBe(`F-${N - 1}`);
  });

  it('PendingEpochContent: re-deferring a held op is still refused (dedupe survives the Map)', () => {
    const counter = { reads: 0 };
    const p = new PendingEpochContent(CAP);
    for (let i = 0; i < CAP; i++) p.defer(contentOp(i, counter), 'hive', 0);
    counter.reads = 0;
    for (let i = 0; i < CAP; i++) expect(p.defer(contentOp(i, counter), 'hive', 0)).toBe(false);
    expect(counter.reads).toBeLessThanOrEqual(CAP * READS_PER_OP);
    expect(p.size()).toBe(CAP);
  });

  it('PendingMembershipContent: defer, eviction and the TTL sweep read O(N) identity fields', () => {
    const counter = { reads: 0 };
    const TTL = 200;
    const p = new PendingMembershipContent(CAP, TTL);
    // `now` advances one tick per defer, so the sweep that runs on every defer expires one
    // head entry each time and the bucket holds TTL live entries.
    for (let i = 0; i < N; i++) expect(p.defer(memberInput(i, counter), i)).toBe(true);
    expect(counter.reads).toBeLessThanOrEqual(N * 4 * MEMBER_IDENTITY_FIELDS.length);
    expect(p.size()).toBe(TTL);
    expect(p.consumeEvictionSignal()).toBe(true);
    // Exactly the entries with expiresAt > now survive, in insertion order.
    const drained = p.drainForDevices(['devA'], N - 1).map((d) => d.rowKey);
    expect(drained.length).toBe(TTL);
    expect(drained[0]).toBe(`F-${N - TTL}`);
    expect(drained.at(-1)).toBe(`F-${N - 1}`);
  });
});
