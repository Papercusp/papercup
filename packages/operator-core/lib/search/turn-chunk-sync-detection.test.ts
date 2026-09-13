/**
 * The LIVE-SQL half of turn-chunk-sync — the half that had no test.
 *
 * turn-chunk-sync.test.ts's header points at `turn-chunk-sync.integration.test.ts`
 * for "sync staleness". That file does not exist and never did, so every
 * behaviour below was uncovered while `syncTurnChunks` was rewritten from
 * sha-based detection to the `chunked_at` marker (migration 1117,
 * EI-19456024312507672). This file closes that gap WITHOUT a database, by
 * injecting a recording `sql` — the seam `syncTurnChunks(sql, opts)` already
 * exposes.
 *
 * WHY THESE FIVE PROPERTIES. The rewrite bought ~9s/tick (measured live:
 * 8964ms -> 0.253ms, buffers 2,053,702 -> 47) by trading a self-verifying
 * predicate for a STORED MARKER. A sha-based predicate could not lie: it
 * recomputed the truth every tick, so a bug meant wasted work, never lost work.
 * A marker can lie, and every way it can lie is silent — the turn simply stops
 * being selected and its chunks go stale forever, with nothing thrown and
 * nothing logged. So the marker's write ordering is now load-bearing in a way
 * the old code's was not, and that is precisely what is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { splitTurnChunks, syncTurnChunks } from './turn-chunk-sync';

interface Recorded {
  query: string;
  params: readonly unknown[];
}

/**
 * Minimal stand-in for the postgres.js handle `syncTurnChunks` uses. It records
 * every statement in order (order is the point of three of the tests below) and
 * returns `rows` for the first call — the detection SELECT — and [] afterwards.
 *
 * `throwOn` injects a failure into one statement so the failure path can be
 * observed rather than argued.
 */
function fakeSql(rows: unknown[], throwOn?: RegExp) {
  const calls: Recorded[] = [];
  let first = true;
  const unsafe = async (query: string, params: readonly unknown[] = []) => {
    calls.push({ query, params });
    if (throwOn?.test(query)) throw new Error('injected failure');
    if (first) {
      first = false;
      return rows;
    }
    return [];
  };
  return { sql: { unsafe } as never, calls };
}

const TURN = {
  workspace_id: 'ws-1',
  source_kind: 'claude',
  session_id: 'sess-1',
  turn_idx: 7,
};

const longText = `${'lorem ipsum dolor sit amet '.repeat(200)}`;

const isDetect = (q: string) => /FROM harness_shared\.session_turns/i.test(q) && /SELECT/i.test(q);
const isMark = (q: string) => /UPDATE\s+harness_shared\.session_turns/i.test(q);
const isInsertChunks = (q: string) => /INSERT INTO harness_shared\.session_turn_chunks/i.test(q);

describe('turn-chunk-sync detection + marking (migration 1117)', () => {
  it('POSITIVE CONTROL: the fake sql is actually exercised', async () => {
    // Without this, a syncTurnChunks that returned early (or a fake that was
    // never awaited) makes every assertion below pass against zero statements.
    const { sql, calls } = fakeSql([]);
    const stats = await syncTurnChunks(sql, { batch: 10 });
    expect(calls.length, 'no SQL was issued at all').toBeGreaterThan(0);
    expect(calls.some((c) => isDetect(c.query))).toBe(true);
    expect(stats).toMatchObject({ turns: 0, chunks: 0, errors: 0 });
  });

  it('detection never reads turn text to decide whether there is work', async () => {
    // This is the whole performance property. Reading `text` in the predicate
    // is what cost 8.9s/tick and forfeited the parallel index-only plan; the
    // predicate must stay a marker lookup.
    const { sql, calls } = fakeSql([]);
    await syncTurnChunks(sql, { batch: 10 });
    const detect = calls.find((c) => isDetect(c.query))!;

    expect(detect.query).toMatch(/chunked_at IS NULL/i);
    expect(detect.query).not.toMatch(/sha256/i);
    expect(detect.query).not.toMatch(/NOT EXISTS/i);
    // ...and it must still be the freshest-first, bounded scan.
    expect(detect.query).toMatch(/ORDER BY st\.ingested_at DESC/i);
    expect(detect.query).toMatch(/LIMIT/i);
  });

  it('marks a processed turn chunked, and only AFTER its chunks are written', async () => {
    // Ordering is crash-safety: marking first, then failing to write chunks,
    // strands the turn silently forever. Marking last means a crash re-selects
    // it next tick. An assertion on ORDER is the only thing that catches a
    // future refactor that hoists the marker for tidiness.
    const { sql, calls } = fakeSql([{ ...TURN, text: longText }]);
    const stats = await syncTurnChunks(sql, { batch: 10 });

    const insertAt = calls.findIndex((c) => isInsertChunks(c.query));
    const markAt = calls.findIndex((c) => isMark(c.query));
    expect(insertAt, 'chunks were never inserted').toBeGreaterThan(-1);
    expect(markAt, 'turn was never marked chunked').toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(insertAt);

    const mark = calls[markAt]!;
    expect(mark.query).toMatch(/SET chunked_at = now\(\)/i);
    // Scoped to exactly this turn's key — not a blanket update.
    expect(mark.params).toEqual([
      TURN.workspace_id,
      TURN.source_kind,
      TURN.session_id,
      TURN.turn_idx,
    ]);
    expect(stats.turns).toBe(1);
  });

  it('marks a turn that yields ZERO chunks, so it cannot be re-selected forever', async () => {
    // A zero-chunk turn is finished work. Left NULL it sits at the head of the
    // freshest-first scan and is re-processed on every future tick — a silent
    // treadmill that looks exactly like a healthy sync doing nothing. That is
    // why the marker write lives OUTSIDE the `chunks.length > 0` branch, and
    // this test is what stops a future refactor tucking it back inside.
    //
    // Empty text is the ONLY input that reaches this path (splitTurnChunks
    // returns [] only for length 0), and the detection query's own
    // `length(text) > minChars` means production cannot produce it — so this
    // pins DEFENSIVE behaviour, not a reachable case. It is still worth pinning:
    // the branch placement it protects is reachable by edit, which is the
    // failure mode in question.
    const zeroChunk = '';
    expect(splitTurnChunks(zeroChunk), 'precondition: this input yields no chunks').toEqual([]);

    const { sql, calls } = fakeSql([{ ...TURN, text: zeroChunk }]);
    const stats = await syncTurnChunks(sql, { batch: 10 });

    expect(calls.some((c) => isInsertChunks(c.query)), 'nothing should be inserted').toBe(false);
    expect(calls.some((c) => isMark(c.query)), 'zero-chunk turn was left unmarked').toBe(true);
    expect(stats.turns).toBe(1);
    expect(stats.chunks).toBe(0);
  });

  it('CONTROL: the ordering/absence assertions actually fail on the mutations they target', () => {
    // The two assertions above that matter most — "mark AFTER insert" and "no
    // mark on failure" — have only ever run against correct behaviour, so a
    // green run is not yet evidence they discriminate. Here the same predicates
    // are pointed at synthetic call sequences representing the exact refactors
    // they exist to catch. If a future edit weakens them, THIS test goes red
    // even if the subject happens to still be correct.
    //
    // This is the tier-2 "deliberately-wrong control kept in the test file"
    // pattern: it proves falsifiability without mutating the shared tree, which
    // on a swept checkout can be committed mid-probe.
    const insertQ = 'INSERT INTO harness_shared.session_turn_chunks (...) VALUES (...)';
    const markQ = 'UPDATE harness_shared.session_turns SET chunked_at = now() WHERE ...';

    // MUTATION 1 — marker hoisted above the chunk write ("tidier", and silently
    // strands any turn whose insert then fails).
    const hoisted = [{ query: markQ }, { query: insertQ }];
    const hoistedInsertAt = hoisted.findIndex((c) => isInsertChunks(c.query));
    const hoistedMarkAt = hoisted.findIndex((c) => isMark(c.query));
    expect(hoistedMarkAt).toBeGreaterThan(-1);
    expect(hoistedInsertAt).toBeGreaterThan(-1);
    expect(
      hoistedMarkAt > hoistedInsertAt,
      'the ordering assertion does NOT catch a hoisted marker — it is vacuous',
    ).toBe(false);

    // MUTATION 2 — marker written despite a failed rewrite (mark moved outside
    // the try, or the catch made to mark anyway).
    const markedDespiteFailure = [{ query: insertQ }, { query: markQ }];
    expect(
      markedDespiteFailure.some((c) => isMark(c.query)),
      'the absence assertion does NOT catch a turn marked after failure',
    ).toBe(true);

    // And the predicates must not fire on unrelated statements, or every
    // sequence "passes" for the wrong reason.
    const unrelated = [{ query: 'DELETE FROM harness_shared.session_turn_chunks WHERE ...' }];
    expect(unrelated.some((c) => isMark(c.query))).toBe(false);
    expect(unrelated.some((c) => isInsertChunks(c.query))).toBe(false);
  });

  it('does NOT mark the turn when the chunk rewrite fails (retry, never strand)', async () => {
    // The safe direction. If the insert throws, chunked_at must stay NULL so the
    // turn comes back next tick; swallowing the error AND marking it would lose
    // the turn permanently.
    const { sql, calls } = fakeSql([{ ...TURN, text: longText }], /INSERT INTO harness_shared\.session_turn_chunks/i);
    const stats = await syncTurnChunks(sql, { batch: 10 });

    expect(calls.some((c) => isMark(c.query)), 'a failed turn must not be marked chunked').toBe(
      false,
    );
    expect(stats.errors).toBe(1);
    expect(stats.turns).toBe(0);
  });

  it('invalidates exact embedding profile together with vector and mode on a rewritten chunk', async () => {
    const { sql, calls } = fakeSql([{ ...TURN, text: longText }]);
    const stats = await syncTurnChunks(sql, { batch: 10 });
    expect(stats.errors).toBe(0);
    const insert = calls.find((c) => isInsertChunks(c.query));
    expect(insert?.query).toMatch(/embedding\s*=\s*NULL/i);
    expect(insert?.query).toMatch(/embedding_mode\s*=\s*NULL/i);
    expect(insert?.query).toMatch(/embedding_profile\s*=\s*NULL/i);
  });
});
