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
 * algorithm now lives in @papercusp/search (`splitWindows`, pinned there to the
 * reference oracle and to golden output taken before the move —
 * generic-rag-chunking-2026-09-29 P-002). This file pins the other half: the
 * constants the turn chunker applies it at.
 */

import { describe, it, expect } from 'vitest';
import { splitWindows } from '@papercusp/search';
import {
  TURN_WINDOW,
  turnSha,
  TURN_CHUNK_CHARS,
  TURN_CHUNK_OVERLAP,
  TURN_CHUNK_MIN_TEXT_CHARS,
  MAX_CHUNKS_PER_TURN,
} from './turn-chunk-sync';

const lorem = (n: number): string => {
  // Deterministic, non-repeating filler: repeated text would make an
  // off-by-one in the windowing invisible (every slice would look alike).
  let s = '';
  let i = 0;
  while (s.length < n) s += `${i++} the quick brown fox jumps over the lazy dog. `;
  return s.slice(0, n);
};

describe('the constants are the ones D-016 measured', () => {
  it('pins chunk width and overlap to the measured arm', () => {
    // Changing either invalidates D-016's +216-230% result for the shipped
    // path. That may still be the right call — but it requires re-running
    // packages/operator-core/lib/memory/bench/turn-truncation-width-cli.ts and
    // recording a new decision, not editing a constant.
    expect(TURN_CHUNK_CHARS).toBe(1500);
    expect(TURN_CHUNK_OVERLAP).toBe(250);
  });

  it('the turn window is exactly those constants', () => {
    expect(TURN_WINDOW).toEqual({ size: TURN_CHUNK_CHARS, overlap: TURN_CHUNK_OVERLAP, maxChunks: MAX_CHUNKS_PER_TURN });
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
    expect(splitWindows(lorem(TURN_CHUNK_MIN_TEXT_CHARS + 1), TURN_WINDOW).length).toBeGreaterThanOrEqual(2);
  });

  it('the chunk cap is headroom for the longest turn the table can hold', () => {
    // Live-measured 2026-08-03: max(length(text)) over 409,002 rows is 8000.
    // 7 chunks at 1500/250. If this ever equals the cap, the cap has started
    // truncating real turns.
    const chunks = splitWindows(lorem(8000), TURN_WINDOW);
    expect(chunks).toHaveLength(7);
    expect(chunks.length).toBeLessThan(MAX_CHUNKS_PER_TURN);
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
