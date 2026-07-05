/**
 * substrate-peer-log-compaction-2026-06-13 P-004 (Brief E) — the PROPERTY-BASED half of
 * the "pure + exhaustively unit-testable" mandate for `buildSnapshotRows`. The example
 * suite (log-snapshot.test.ts) pins the named cases; this suite asserts the ALGEBRAIC LAWS
 * the compaction design rests on, over thousands of random op sequences (fast-check).
 *
 * The load-bearing law is PREFIX-REPLACEMENT FAITHFULNESS: a snapshot op that covers a log
 * prefix must fold IDENTICALLY to that prefix — i.e. replacing `ops[0..k)` with one snapshot
 * op of it never changes the reconstituted state. That is exactly what makes design-A
 * compaction safe (a new joiner that starts at the snapshot index, skipping the prefix,
 * reaches the same state as one that replayed from 0). If this law holds for arbitrary op
 * sequences AND arbitrary split points AND stacked snapshots, the builder is correct.
 *
 * Winner semantics under test (single-writer own-log): the LATEST op BY POSITION wins per
 * (table, hbKey) — NOT by `ts` (ts is preserved for the reader's cross-peer LWW, never used
 * to pick a within-log winner). The independent oracle below is a REVERSE scan (first-from-
 * the-end per key), a different formulation of "last wins" than the builder's forward fold.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildSnapshotRows,
  buildSnapshotOp,
  isSnapshotOp,
  SNAPSHOT_TABLE_TAG,
  type SnapshotRow,
  type SnapshotPayload,
} from '../log-snapshot';
import type { PeerLogOp } from '../peer-log';

// ── arbitraries ─────────────────────────────────────────────────────────────────
// A SMALL key space so random sequences overwrite + delete the SAME keys often (the
// interesting cases — collisions, put→del→put, del-only). A wide space would mostly
// produce disjoint keys and never exercise the fold.
const TABLES = ['queue', 'presence', 'coord'] as const;
const KEYS = ['K1', 'K2', 'K3', 'K4', 'K5'] as const;
const valueArb = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.record({ a: fc.integer(), b: fc.string() }),
);

const opArb: fc.Arbitrary<PeerLogOp> = fc
  .record({
    type: fc.constantFrom('put', 'del') as fc.Arbitrary<'put' | 'del'>,
    table: fc.constantFrom(...TABLES),
    hbKey: fc.constantFrom(...KEYS),
    value: valueArb,
    ts: fc.integer({ min: 0, max: 1_000 }),
    hlc: fc.option(fc.string(), { nil: undefined }),
  })
  .map(
    (o): PeerLogOp => ({
      type: o.type,
      table: o.table,
      hbKey: o.hbKey,
      ts: o.ts,
      schema_version: 1,
      author_pubkey: 'me',
      ...(o.type === 'put' ? { value: o.value } : {}),
      ...(o.hlc ? { hlc: o.hlc } : {}),
    }),
  );

const opsArb = fc.array(opArb, { maxLength: 40 });

// ── the independent oracle (reverse scan; expands snapshot ops) ───────────────────
const keyOf = (o: { table?: string; hbKey?: string }) => `${o.table}::${o.hbKey}`;
const sortRows = (rows: SnapshotRow[]): SnapshotRow[] =>
  [...rows].sort((a, b) =>
    a.table === b.table ? (a.hbKey < b.hbKey ? -1 : a.hbKey > b.hbKey ? 1 : 0) : a.table < b.table ? -1 : 1,
  );

/** Flatten a stream, expanding each snapshot op into its rows as positional puts. */
function expand(ops: readonly PeerLogOp[]): PeerLogOp[] {
  const flat: PeerLogOp[] = [];
  for (const op of ops) {
    if (isSnapshotOp(op)) {
      const payload = op.value as SnapshotPayload | undefined;
      if (payload && Array.isArray(payload.rows)) {
        for (const r of payload.rows) {
          // EI-1688: a tombstone snapshot row re-expands to a `del` op (not a put), so
          // the reverse-scan oracle treats it as the deletion it reconstitutes.
          flat.push(
            r.deleted
              ? {
                  type: 'del',
                  table: r.table,
                  hbKey: r.hbKey,
                  ts: r.ts,
                  schema_version: r.schema_version,
                  author_pubkey: 'x',
                  ...(r.hlc ? { hlc: r.hlc } : {}),
                }
              : {
                  type: 'put',
                  table: r.table,
                  hbKey: r.hbKey,
                  value: r.value,
                  ts: r.ts,
                  schema_version: r.schema_version,
                  author_pubkey: 'x',
                  ...(r.hlc ? { hlc: r.hlc } : {}),
                },
          );
        }
      }
      continue;
    }
    flat.push(op);
  }
  return flat;
}

/** Reverse-scan oracle: the first op-from-the-end per key decides. A put → a live row;
 *  a del → a TOMBSTONE row (EI-1688: deleted keys are carried, not omitted). */
function oracle(ops: readonly PeerLogOp[]): SnapshotRow[] {
  const flat = expand(ops);
  const seen = new Set<string>();
  const out: SnapshotRow[] = [];
  for (let i = flat.length - 1; i >= 0; i--) {
    const op = flat[i];
    const k = keyOf(op);
    if (seen.has(k)) continue;
    seen.add(k);
    if (op.type === 'put') {
      out.push({
        table: op.table,
        hbKey: op.hbKey,
        value: op.value,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
      });
    } else {
      // EI-1688: a key whose latest op is a del → a tombstone row (value null), NOT omitted.
      out.push({
        table: op.table,
        hbKey: op.hbKey,
        value: null,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
        deleted: true,
      });
    }
  }
  return sortRows(out);
}

/** Wrap a prefix into one snapshot op covering it (mirrors produceLogSnapshot's wrapping). */
const snapOf = (prefix: readonly PeerLogOp[]): PeerLogOp =>
  buildSnapshotOp({ ops: prefix, coversUpTo: prefix.length, author_pubkey: 'me', ts: 0, schema_version: 1 });

// ── properties ────────────────────────────────────────────────────────────────────
describe('buildSnapshotRows — algebraic properties (P-004 exhaustive)', () => {
  it('A. equals an independent reverse-scan oracle (correctness, incl. del + put→del→put)', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        expect(buildSnapshotRows(ops)).toEqual(oracle(ops));
      }),
      { numRuns: 1000 },
    );
  });

  it('B. PREFIX-REPLACEMENT FAITHFULNESS: replacing ops[0..k) with one snapshot op of it folds identically', () => {
    fc.assert(
      fc.property(opsArb, fc.nat(), (ops, kRaw) => {
        const k = ops.length === 0 ? 0 : kRaw % (ops.length + 1);
        const compacted = [snapOf(ops.slice(0, k)), ...ops.slice(k)];
        // The snapshot op stands in for the prefix it covers — same reconstituted state.
        expect(buildSnapshotRows(compacted)).toEqual(buildSnapshotRows(ops));
      }),
      { numRuns: 1000 },
    );
  });

  it('C. STACKED snapshots fold correctly: snapshotting twice at two split points is still faithful', () => {
    fc.assert(
      fc.property(opsArb, fc.nat(), fc.nat(), (ops, k1Raw, k2Raw) => {
        if (ops.length === 0) return;
        const k1 = k1Raw % (ops.length + 1);
        const once = [snapOf(ops.slice(0, k1)), ...ops.slice(k1)];
        const k2 = k2Raw % (once.length + 1);
        const twice = [snapOf(once.slice(0, k2)), ...once.slice(k2)]; // a snapshot whose prefix may CONTAIN a snapshot
        expect(buildSnapshotRows(twice)).toEqual(buildSnapshotRows(ops));
      }),
      { numRuns: 1000 },
    );
  });

  it('D. IDEMPOTENCE: re-snapshotting a full snapshot reproduces it (the k=all case)', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const once = buildSnapshotRows(ops);
        const twice = buildSnapshotRows([snapOf(ops)]);
        expect(twice).toEqual(once);
      }),
      { numRuns: 1000 },
    );
  });

  it('E. MINIMALITY + DETERMINISM: at most one row per key, output strictly sorted by (table,hbKey)', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const rows = buildSnapshotRows(ops);
        // unique keys
        const keys = rows.map(keyOf);
        expect(new Set(keys).size).toBe(keys.length);
        // strictly ascending (table,hbKey) — deterministic byte order
        for (let i = 1; i < rows.length; i++) {
          const prev = `${rows[i - 1].table}\x00${rows[i - 1].hbKey}`;
          const cur = `${rows[i].table}\x00${rows[i].hbKey}`;
          expect(prev < cur).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('F. PRESERVATION: every emitted row is identical to that key’s winning input op (ts/hlc/value/schema/type)', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const flat = expand(ops);
        for (const row of buildSnapshotRows(ops)) {
          // find the winning op = last positional op for this key in the expanded stream
          let winner: PeerLogOp | null = null;
          for (const op of flat) if (keyOf(op) === keyOf(row)) winner = op;
          expect(winner).not.toBeNull();
          if (row.deleted) {
            // EI-1688: a tombstone row ⟺ the key's latest op is a del; carries the del's
            // ts/hlc (so the reader orders it), value null, no input value to preserve.
            expect(winner!.type).toBe('del');
            expect(row.value).toBeNull();
          } else {
            expect(winner!.type).toBe('put'); // a live row ⟺ the latest op is a put
            expect(row.value).toEqual(winner!.value);
          }
          expect(row.ts).toBe(winner!.ts);
          expect(row.schema_version).toBe(winner!.schema_version);
          expect(row.hlc).toBe(winner!.hlc);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('G. PURITY: same input → same output, and the input array/ops are not mutated', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const snapshot = JSON.stringify(ops);
        const a = buildSnapshotRows(ops);
        const b = buildSnapshotRows(ops);
        expect(a).toEqual(b);
        expect(JSON.stringify(ops)).toBe(snapshot); // no mutation of the input
      }),
      { numRuns: 500 },
    );
  });
});

// ── targeted edge cases the named suite doesn't pin ────────────────────────────────
describe('buildSnapshotRows — additional edge cases (P-004)', () => {
  const put = (table: string, hbKey: string, value: unknown, ts = 1): PeerLogOp => ({
    type: 'put',
    table,
    hbKey,
    value,
    ts,
    schema_version: 1,
    author_pubkey: 'me',
  });
  const del = (table: string, hbKey: string, ts = 1): PeerLogOp => ({
    type: 'del',
    table,
    hbKey,
    ts,
    schema_version: 1,
    author_pubkey: 'me',
  });

  it('EI-1688: a DEL-ONLY key (never put) is carried as a tombstone', () => {
    expect(buildSnapshotRows([del('queue', 'F-9', 1)])).toEqual([
      { table: 'queue', hbKey: 'F-9', value: null, ts: 1, schema_version: 1, deleted: true },
    ]);
  });

  it('two STACKED snapshot ops in one stream both expand (later positional write wins)', () => {
    const s1 = buildSnapshotOp({ ops: [put('queue', 'A', 1), put('queue', 'B', 1)], coversUpTo: 2, author_pubkey: 'me', ts: 1, schema_version: 1 });
    const s2 = buildSnapshotOp({ ops: [s1, put('queue', 'B', 2), put('queue', 'C', 2)], coversUpTo: 3, author_pubkey: 'me', ts: 2, schema_version: 1 });
    const rows = buildSnapshotRows([s2, put('queue', 'C', 3)]);
    const byKey = Object.fromEntries(rows.map((r) => [r.hbKey, r.value]));
    expect(byKey).toEqual({ A: 1, B: 2, C: 3 }); // A from s1-via-s2, B overwritten in s2, C overwritten in tail
  });

  it('a MALFORMED snapshot payload (no rows array / undefined value) contributes nothing, never throws', () => {
    const bad1: PeerLogOp = { type: 'put', table: SNAPSHOT_TABLE_TAG, hbKey: 'snapshot/0', value: undefined, ts: 1, schema_version: 1, author_pubkey: 'me' };
    const bad2: PeerLogOp = { type: 'put', table: SNAPSHOT_TABLE_TAG, hbKey: 'snapshot/0', value: { coversUpTo: 0, rows: 'nope' }, ts: 1, schema_version: 1, author_pubkey: 'me' };
    expect(buildSnapshotRows([bad1, put('queue', 'F-1', { v: 1 })])).toEqual([
      { table: 'queue', hbKey: 'F-1', value: { v: 1 }, ts: 1, schema_version: 1 },
    ]);
    expect(buildSnapshotRows([bad2])).toEqual([]);
  });

  it('preserves a non-default schema_version verbatim', () => {
    const op: PeerLogOp = { type: 'put', table: 'queue', hbKey: 'F-1', value: 1, ts: 1, schema_version: 7, author_pubkey: 'me' };
    expect(buildSnapshotRows([op])[0].schema_version).toBe(7);
  });

  it('interleaved multi-table keys all survive with correct latest values', () => {
    const rows = buildSnapshotRows([
      put('queue', 'F-1', 'q1', 1),
      put('presence', 'dev', 'p1', 1),
      put('queue', 'F-1', 'q2', 2),
      put('coord', 'msg', 'c1', 1),
      del('presence', 'dev', 3),
    ]);
    expect(rows).toEqual([
      { table: 'coord', hbKey: 'msg', value: 'c1', ts: 1, schema_version: 1 },
      { table: 'presence', hbKey: 'dev', value: null, ts: 3, schema_version: 1, deleted: true },
      { table: 'queue', hbKey: 'F-1', value: 'q2', ts: 2, schema_version: 1 },
    ]); // presence/dev del'd → tombstone (EI-1688); sorted (coord < presence < queue)
  });
});
