/**
 * The PURE half of the turn-chunking contract (P-034,
 * semantic-search-fingerprint-coverage-2026-08-03, decision D-016).
 *
 * The live-SQL half (sync staleness, the search union's MAX dedupe) lives in
 * turn-chunk-sync.integration.test.ts — split for the same reason as
 * embed-eligibility: the judgement is the part worth testing exhaustively and
 * it should not need a database to test.
 *
 * WHAT THIS FILE IS ACTUALLY DEFENDING. D-016's +216-230% MRR result is a
 * measurement of ONE SPECIFIC ALGORITHM at ONE SPECIFIC PAIR OF CONSTANTS. The
 * result does not transfer to a splitter that is merely similar. So the tests
 * below are not "does the function look right" — they pin the algorithm to the
 * reference implementation the benchmark actually ran, and pin the constants to
 * the values it ran them at.
 */

import { describe, it, expect } from 'vitest';
import {
  splitTurnChunks,
  turnSha,
  TURN_CHUNK_CHARS,
  TURN_CHUNK_OVERLAP,
  TURN_CHUNK_MIN_TEXT_CHARS,
  MAX_CHUNKS_PER_TURN,
} from './turn-chunk-sync';

/**
 * The bench's ORIGINAL inline loop, verbatim as it stood when D-016's numbers
 * were produced (turn-truncation-width-cli.ts, before P-034 replaced it with an
 * import of the shipped splitter).
 *
 * This is a REFERENCE ORACLE, not a duplicate to keep in sync: its whole job is
 * to be the pre-extraction algorithm, frozen. If someone "improves"
 * splitTurnChunks — snapping to word boundaries, dropping a runt final chunk,
 * re-anchoring the last window — these tests go red, and that is the correct
 * outcome: the improvement may well be better, but D-016's measurement would no
 * longer describe it, and shipping it silently would leave the plan asserting a
 * number for code that never produced it.
 */
function referenceSplit(text: string, size: number, overlap: number): string[] {
  const out: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let s = 0; s < text.length; s += step) {
    out.push(text.slice(s, s + size));
    if (s + size >= text.length) break;
  }
  return out;
}

const lorem = (n: number): string => {
  // Deterministic, non-repeating filler: repeated text would make an
  // off-by-one in the windowing invisible (every slice would look alike).
  let s = '';
  let i = 0;
  while (s.length < n) s += `${i++} the quick brown fox jumps over the lazy dog. `;
  return s.slice(0, n);
};

describe('splitTurnChunks — the measured algorithm', () => {
  it('is byte-identical to the reference oracle across the real length range', () => {
    // 8000 is the live max(length(text)) on session_turns (turns are capped at
    // ingest); the rest bracket the boundaries where windowing goes wrong.
    for (const n of [1, 2, 999, 1499, 1500, 1501, 1749, 1750, 1751, 2000, 2001, 3000, 4730, 5000, 7999, 8000]) {
      const text = lorem(n);
      expect(splitTurnChunks(text), `length ${n}`).toEqual(
        referenceSplit(text, TURN_CHUNK_CHARS, TURN_CHUNK_OVERLAP),
      );
    }
  });

  it('agrees with the oracle at non-default sizes too (the bench passes --chunk/--chunk-overlap)', () => {
    const text = lorem(6000);
    for (const [size, overlap] of [[1000, 100], [2000, 500], [1500, 0], [800, 799]]) {
      expect(splitTurnChunks(text, { size, overlap, maxChunks: 10_000 }), `${size}/${overlap}`).toEqual(
        referenceSplit(text, size, overlap),
      );
    }
  });

  /**
   * FALSIFIABILITY CONTROL. A guard that has never failed is a guard you have
   * not tested — and the properties below (coverage, overlap) are exactly the
   * kind that pass trivially against a broken splitter if you assert them
   * loosely. These two deliberately-wrong implementations are kept here
   * PERMANENTLY rather than mutating the real module, per the repo rule against
   * proving falsifiability by mutating the shared tree.
   */
  const noOverlapSplit = (text: string, size: number): string[] => {
    const out: string[] = [];
    for (let s = 0; s < text.length; s += size) out.push(text.slice(s, s + size));
    return out;
  };
  const droppedTailSplit = (text: string, size: number, overlap: number): string[] =>
    referenceSplit(text, size, overlap).slice(0, -1);

  it('the controls FAIL the properties the real splitter passes', () => {
    const text = lorem(5000);
    const real = splitTurnChunks(text);
    const noOverlap = noOverlapSplit(text, TURN_CHUNK_CHARS);
    const droppedTail = droppedTailSplit(text, TURN_CHUNK_CHARS, TURN_CHUNK_OVERLAP);

    // ⚠ Asserted as an EXACT identity, not as a longest-common-overlap search.
    // The search version is wrong here and passes review easily: on text with
    // any periodicity the common region EXTENDS past the intended overlap
    // (filler repeating with a period dividing the 1250 step matches far beyond
    // 250 chars), so it reports a number larger than the real overlap and the
    // property fails against a perfectly correct splitter. Caught exactly that
    // way on first run.
    const overlapsBy = (cs: string[], n: number): boolean =>
      cs.slice(1).every((c, i) => cs[i].slice(-n) === c.slice(0, n));
    const covers = (cs: string[]): boolean => cs.length > 0 && cs.join('').length >= text.length;

    // real: every consecutive pair overlaps by exactly TURN_CHUNK_OVERLAP
    expect(overlapsBy(real, TURN_CHUNK_OVERLAP)).toBe(true);
    // control 1 does not overlap at all -> the property is genuinely falsifiable
    expect(overlapsBy(noOverlap, TURN_CHUNK_OVERLAP)).toBe(false);

    // real reaches the end of the text; the dropped-tail control does not
    expect(real[real.length - 1].endsWith(text.slice(-50))).toBe(true);
    expect(droppedTail[droppedTail.length - 1].endsWith(text.slice(-50))).toBe(false);

    // and a calibration case: the coverage property must be able to PASS,
    // otherwise the two failures above prove nothing about the property itself.
    expect(covers(real)).toBe(true);
  });

  it('covers every character — nothing between the windows is lost', () => {
    const text = lorem(5000);
    const chunks = splitTurnChunks(text);
    // Reconstruct by taking each chunk's non-overlapping head, then the last
    // chunk whole. If any window were mis-stepped this would not equal text.
    const step = TURN_CHUNK_CHARS - TURN_CHUNK_OVERLAP;
    const rebuilt = chunks.slice(0, -1).map((c) => c.slice(0, step)).join('') + chunks[chunks.length - 1];
    expect(rebuilt).toBe(text);
  });

  it('the final chunk always reaches the end of the text', () => {
    for (const n of [1500, 1751, 3000, 4730, 8000]) {
      const text = lorem(n);
      const chunks = splitTurnChunks(text);
      expect(chunks[chunks.length - 1], `length ${n}`).toBe(text.slice(-chunks[chunks.length - 1].length));
      expect(text.endsWith(chunks[chunks.length - 1])).toBe(true);
    }
  });

  it('a turn at or under one chunk yields exactly one chunk', () => {
    expect(splitTurnChunks(lorem(1500))).toHaveLength(1);
    expect(splitTurnChunks(lorem(900))).toEqual([lorem(900)]);
  });

  it('empty text yields no chunks (never one empty chunk)', () => {
    expect(splitTurnChunks('')).toEqual([]);
  });

  it('bounds chunk count for the longest turn the table can hold', () => {
    // Live-measured 2026-08-03: max(length(text)) over 409,002 rows is 8000.
    // 7 chunks at 1500/250. MAX_CHUNKS_PER_TURN is headroom, not a binding cap —
    // if this ever equals the cap, the cap has started truncating real turns.
    const chunks = splitTurnChunks(lorem(8000));
    expect(chunks).toHaveLength(7);
    expect(chunks.length).toBeLessThan(MAX_CHUNKS_PER_TURN);
  });

  it('enforces maxChunks rather than emitting unbounded rows', () => {
    const chunks = splitTurnChunks(lorem(100_000), { maxChunks: 4 });
    expect(chunks).toHaveLength(4);
  });

  it('never emits a zero-length chunk even at degenerate overlap', () => {
    // overlap >= size would make step <= 0 and loop forever without the clamp.
    const chunks = splitTurnChunks(lorem(3000), { size: 100, overlap: 500, maxChunks: 50 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });
});

describe('the constants are the ones D-016 measured', () => {
  it('pins chunk width and overlap to the measured arm', () => {
    // Changing either invalidates D-016's +216-230% result for the shipped
    // path. That may still be the right call — but it requires re-running
    // packages/operator-core/lib/memory/bench/turn-truncation-width-cli.ts and
    // recording a new decision, not editing a constant.
    expect(TURN_CHUNK_CHARS).toBe(1500);
    expect(TURN_CHUNK_OVERLAP).toBe(250);
  });

  it('the chunking threshold equals the parent embed cut', () => {
    // session_turns' bodySql is `left(text, 2000)`. A turn at or below that is
    // already fully covered by its own vector, so chunking it buys zero recall.
    // These are one number wearing two hats; if the parent cut moves, this must.
    expect(TURN_CHUNK_MIN_TEXT_CHARS).toBe(2000);
  });

  it('every chunked turn produces at least two chunks', () => {
    // Follows from threshold(2000) > width(1500): a turn long enough to be
    // chunked at all cannot fit in a single window. If this ever fails, the
    // threshold has dropped below the width and single-chunk rows are being
    // written that exactly duplicate the parent vector.
    const justOver = lorem(TURN_CHUNK_MIN_TEXT_CHARS + 1);
    expect(splitTurnChunks(justOver).length).toBeGreaterThanOrEqual(2);
  });
});

describe('turnSha', () => {
  it("matches the SQL side (encode(sha256(convert_to(text,'UTF8')),'hex'))", () => {
    // ⚠ THIS INPUT IS CHOSEN TO DISCRIMINATE, and that is the whole point of
    // the test. The SQL side was first written as `text::bytea`, which does not
    // ENCODE a string to bytes — it PARSES it as a bytea literal. 'hello' is
    // valid under both readings and hashes identically either way, so asserting
    // on 'hello' passes against the broken expression and proves nothing (it
    // did exactly that here, until the sync died on real data with `invalid
    // input syntax for type bytea`).
    //
    // This input carries a literal backslash, a newline and a non-ASCII char,
    // so it is only valid one way. Verified against the live database
    // 2026-08-03 — both sides produce this digest.
    expect(turnSha('a\\x41b\nhéllo')).toBe(
      '28675fb761f2675f240005800d831457fb9f6bc5351c4d8add5ca4ce7597439e',
    );
  });

  it('is sensitive to the change it exists to detect', () => {
    expect(turnSha('abc')).not.toBe(turnSha('abd'));
    expect(turnSha(lorem(4000))).not.toBe(turnSha(lorem(4000) + '.'));
  });
});
