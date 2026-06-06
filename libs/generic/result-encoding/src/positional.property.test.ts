import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  encodePositionalRows,
  reconstructArgs,
  type ColumnSpec,
} from './index';

/**
 * Round-trip property (P-010): for any in-scope positional shape, a row that the
 * server ENCODES from typed values reconstructs back to those values (string-
 * coerced where CSV is lossy). The encoder and the reconstruct shim are the two
 * ends of the write protocol; this proves they agree for arbitrary data.
 */

const scalarCols: ColumnSpec[] = [
  { name: 'id', type: 'id', optional: false, nullable: false },
  { name: 'state', type: 'string', optional: false, nullable: false },
  { name: 'n', type: 'number', optional: false, nullable: false },
];

/** Encode a single row of typed values into the positional value line (drop the [N] guard line). */
function encodeRow(row: Record<string, unknown>, cols: ColumnSpec[]): string {
  return encodePositionalRows([row], cols).split('\n')[1] ?? '';
}

describe('positional round-trip — encode → reconstruct is lossless (string-coerced)', () => {
  it('all-scalar rows recover their values', () => {
    fc.assert(
      fc.property(
        fc.record({
          // ids/strings without commas, quotes, or newlines (the all-scalar contract)
          id: fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
          state: fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/),
          n: fc.integer({ min: -1000, max: 1000 }),
        }),
        (row) => {
          const line = encodeRow(row, scalarCols);
          const r = reconstructArgs(line, scalarCols);
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(r.args).toEqual({ id: row.id, state: row.state, n: row.n });
          }
        },
      ),
    );
  });

  it('trailing free-text recovers VERBATIM incl. embedded commas', () => {
    // WRITE direction: the model emits the row RAW (D-006 — no escaping). The
    // server splits on the first N-1 commas; the free-text tail is verbatim, so
    // it is built by raw-joining, NOT via the read encoder (which RFC-quotes).
    const cols: ColumnSpec[] = [
      { name: 'id', type: 'id', optional: false, nullable: false },
      { name: 'body', type: 'text', optional: false, nullable: false },
    ];
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
        // free text: any printable incl. commas/quotes, one line, no EDGE
        // whitespace (reconstruct normalizes edges — internal content is kept).
        fc
          .string({ minLength: 1, maxLength: 80 })
          .filter((s) => !s.includes('\n') && !s.includes('\r') && s === s.trim()),
        (id, body) => {
          const line = `${id},${body}`; // exactly what the model emits
          const r = reconstructArgs(line, cols);
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.args).toEqual({ id, body });
        },
      ),
    );
  });

  it('quoted scalars carrying a comma still round-trip', () => {
    const cols: ColumnSpec[] = [
      { name: 'id', type: 'id', optional: false, nullable: false },
      { name: 'label', type: 'string', optional: false, nullable: false },
    ];
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
        // No edge whitespace (reconstruct normalizes it) and no embedded quote/newline.
        fc
          .string({ minLength: 1, maxLength: 40 })
          .filter((s) => !s.includes('\n') && !s.includes('\r') && !s.includes('"') && s === s.trim()),
        (id, label) => {
          const line = encodeRow({ id, label }, cols);
          const r = reconstructArgs(line, cols);
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.args).toEqual({ id, label });
        },
      ),
    );
  });
});
