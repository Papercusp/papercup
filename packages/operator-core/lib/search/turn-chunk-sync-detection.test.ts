/**
 * The LIVE-SQL half of session-turn chunk sync, without a database.
 *
 * Since generic-rag-chunking P-007 the generic engine (@papercusp/search
 * syncChunkSurface) syncs session turns through ./chunks/session-turn-store.ts.
 * This file drives that exact path — the registry entry, its store, the engine
 * — with a recording `sql`, and pins the properties the old hand-written loop
 * was tested for, plus the ones the engine adds.
 *
 * WHY THESE PROPERTIES. Detection is a STORED MARKER (session_turns.chunked_at,
 * migration 1117), bought for ~9s/tick (8964ms -> 0.253ms). A sha-based
 * predicate could not lie: it recomputed the truth every tick. A marker can, and
 * every way it lies is silent — the turn stops being selected and its chunks go
 * stale forever. So the marker's write ordering is load-bearing, and that is
 * what is pinned here. The real-Postgres half (zero re-embeds on re-sync, R-21)
 * is chunks/session-turn-parity.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { resolveChunkSurface, splitWindows, splitterVersionOf, syncChunkSurface, type ChunkSurface } from '@papercusp/search';
import { SESSION_TURN_CHUNK_SURFACE, TURN_WINDOW, turnSha } from './turn-chunk-sync';
import { INDEXED_MIN_CHARS, STORED_SPLITTER_VERSION, sessionTurnSurfaceProblem } from './chunks/session-turn-store';

interface Recorded {
  query: string;
  params: readonly unknown[];
}

interface FakeOpts {
  /** Rows the detection SELECT returns. */
  stale?: unknown[];
  /** Rows readExisting (the FOR UPDATE read of the chunk table) returns. */
  existing?: unknown[];
  /** Inject a failure into the first statement matching this. */
  throwOn?: RegExp;
}

/**
 * Minimal stand-in for the postgres.js handle the store uses. It records every
 * statement in order (order is the point of several tests below), answers the
 * detection SELECT and the existing-chunk read, and runs `begin` as a
 * transaction that propagates a throw (a real one rolls back).
 */
function fakeSql(opts: FakeOpts = {}) {
  const calls: Recorded[] = [];
  const unsafe = async (query: string, params: readonly unknown[] = []) => {
    calls.push({ query, params });
    if (opts.throwOn?.test(query)) throw new Error('injected failure');
    if (isDetect(query)) return opts.stale ?? [];
    if (isReadExisting(query)) return opts.existing ?? [];
    return [];
  };
  const handle = { unsafe } as Record<string, unknown>;
  handle.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(handle);
  return { sql: handle as never, calls };
}

const KEY = ['ws-1', 'claude', 'sess-1', '7'];
const KEY_PARAMS = ['ws-1', 'claude', 'sess-1', 7];

const longText = `${'lorem ipsum dolor sit amet '.repeat(200)}`;

const isDetect = (q: string) => /FROM harness_shared\.session_turns p/i.test(q) && /SELECT/i.test(q);
const isReadExisting = (q: string) => /FROM harness_shared\.session_turn_chunks/i.test(q) && /FOR UPDATE/i.test(q);
const isMark = (q: string) => /UPDATE\s+harness_shared\.session_turns/i.test(q);
const isInsertChunks = (q: string) => /INSERT INTO harness_shared\.session_turn_chunks/i.test(q);
const isDeleteChunks = (q: string) => /DELETE FROM harness_shared\.session_turn_chunks/i.test(q);

const store = SESSION_TURN_CHUNK_SURFACE.store!;
const sync = (sql: never, surface: ChunkSurface = SESSION_TURN_CHUNK_SURFACE) =>
  syncChunkSurface(sql, surface, store, {
    hash: turnSha,
    batchPerSurface: 10,
    logger: { warn: () => {}, error: () => {} },
  });

describe('session-turn chunk sync through the engine: detection + marking (migration 1117)', () => {
  it('POSITIVE CONTROL: the fake sql is actually exercised', async () => {
    // Without this, a sync that returned early (or a fake that was never
    // awaited) makes every assertion below pass against zero statements.
    const { sql, calls } = fakeSql();
    const stats = await sync(sql);
    expect(calls.length, 'no SQL was issued at all').toBeGreaterThan(0);
    expect(calls.some((c) => isDetect(c.query))).toBe(true);
    expect(stats).toMatchObject({ parentsSynced: 0, chunksWritten: 0, errors: 0 });
  });

  it('detection never hashes turn text or anti-joins the chunk table to decide whether there is work', async () => {
    // This is the whole performance property: hashing in the predicate is what
    // cost 8.9s/tick and forfeited the parallel index-only plan. It must stay a
    // marker lookup on the partial index's own predicate.
    const { sql, calls } = fakeSql();
    await sync(sql);
    const detect = calls.find((c) => isDetect(c.query))!;

    expect(detect.query).toMatch(/chunked_at IS NULL/i);
    expect(detect.query).not.toMatch(/sha256/i);
    expect(detect.query).not.toMatch(/NOT EXISTS/i);
    expect(detect.params[0], 'the length cut is the indexed one').toBe(INDEXED_MIN_CHARS);
    // ...and it must still be the freshest-first, bounded scan.
    expect(detect.query).toMatch(/ORDER BY \(p\.ingested_at\) DESC/i);
    expect(detect.query).toMatch(/LIMIT/i);
  });

  it('marks a processed turn chunked, and only AFTER its chunks are written', async () => {
    // Ordering is crash-safety: marking first, then failing to write chunks,
    // strands the turn silently forever. Marking last means a crash re-selects
    // it next tick.
    const { sql, calls } = fakeSql({ stale: [{ parent_key: KEY, text: longText }] });
    const stats = await sync(sql);

    const insertAt = calls.findIndex((c) => isInsertChunks(c.query));
    const markAt = calls.findIndex((c) => isMark(c.query));
    expect(insertAt, 'chunks were never inserted').toBeGreaterThan(-1);
    expect(markAt, 'turn was never marked chunked').toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(insertAt);

    const mark = calls[markAt]!;
    expect(mark.query).toMatch(/SET chunked_at = now\(\)/i);
    // Scoped to exactly this turn's key — not a blanket update.
    expect(mark.params).toEqual(KEY_PARAMS);
    expect(stats.parentsSynced).toBe(1);
    expect(stats.chunksWritten).toBe(splitWindows(longText, TURN_WINDOW).length);
  });

  it('writes the turn sha as turn_sha and the splitter output as content', async () => {
    const { sql, calls } = fakeSql({ stale: [{ parent_key: KEY, text: longText }] });
    await sync(sql);
    const insert = calls.find((c) => isInsertChunks(c.query))!;
    expect(insert.params.slice(0, 5)).toEqual([...KEY_PARAMS, turnSha(longText)]);
    expect(insert.params[6], 'content').toEqual(splitWindows(longText, TURN_WINDOW));
  });

  it('marks a turn that yields ZERO chunks, so it cannot be re-selected forever', async () => {
    // A zero-chunk turn is finished work. Left NULL it sits at the head of the
    // freshest-first scan and is re-processed on every future tick. Empty text
    // is the only input that reaches this path, and the detection query's own
    // length cut means production cannot produce it — so this pins DEFENSIVE
    // behaviour, reachable by edit.
    const zeroChunk = '';
    expect(splitWindows(zeroChunk, TURN_WINDOW), 'precondition: this input yields no chunks').toEqual([]);

    const { sql, calls } = fakeSql({ stale: [{ parent_key: KEY, text: zeroChunk }] });
    const stats = await sync(sql);

    expect(calls.some((c) => isInsertChunks(c.query)), 'nothing should be inserted').toBe(false);
    expect(calls.some((c) => isMark(c.query)), 'zero-chunk turn was left unmarked').toBe(true);
    expect(stats.parentsEmpty).toBe(1);
    expect(stats.chunksWritten).toBe(0);
  });

  it('an unchanged turn is only marked: no chunk row is deleted or written (zero re-embeds)', async () => {
    // The engine's reuse path. Stored chunks carrying the turn's sha are the
    // current cut, so re-reading such a turn must not touch the chunk table.
    const windows = splitWindows(longText, TURN_WINDOW);
    const existing = windows.map((content, i) => ({
      chunk_idx: i,
      chunk_sha: turnSha(content),
      parent_sha: turnSha(longText),
      embedding: '[0.1,0.2]',
      embedding_mode: 'gemma:document',
      embedding_profile: 'profile-1',
    }));
    const { sql, calls } = fakeSql({ stale: [{ parent_key: KEY, text: longText }], existing });
    const stats = await sync(sql);

    expect(calls.some((c) => isDeleteChunks(c.query)), 'an unchanged turn lost its chunks').toBe(false);
    expect(calls.some((c) => isInsertChunks(c.query)), 'an unchanged turn was rewritten').toBe(false);
    const mark = calls.find((c) => isMark(c.query))!;
    expect(mark.query).toMatch(/chunked_at IS NULL/i);
    expect(mark.params).toEqual(KEY_PARAMS);
    expect(stats).toMatchObject({ parentsUnchanged: 1, parentsSynced: 0, embeddingsReused: 0, errors: 0 });
  });

  it('CONTROL: the ordering/absence assertions actually fail on the mutations they target', () => {
    // Tier-2 control kept in the test file: the predicates above pointed at
    // synthetic sequences representing the refactors they exist to catch. If a
    // future edit weakens them, THIS test goes red even if the subject is fine.
    const insertQ = 'INSERT INTO harness_shared.session_turn_chunks (...) VALUES (...)';
    const markQ = 'UPDATE harness_shared.session_turns SET chunked_at = now() WHERE ...';

    // MUTATION 1 — marker hoisted above the chunk write.
    const hoisted = [{ query: markQ }, { query: insertQ }];
    const hoistedInsertAt = hoisted.findIndex((c) => isInsertChunks(c.query));
    const hoistedMarkAt = hoisted.findIndex((c) => isMark(c.query));
    expect(hoistedMarkAt).toBeGreaterThan(-1);
    expect(hoistedInsertAt).toBeGreaterThan(-1);
    expect(
      hoistedMarkAt > hoistedInsertAt,
      'the ordering assertion does NOT catch a hoisted marker — it is vacuous',
    ).toBe(false);

    // MUTATION 2 — marker written despite a failed rewrite.
    const markedDespiteFailure = [{ query: insertQ }, { query: markQ }];
    expect(
      markedDespiteFailure.some((c) => isMark(c.query)),
      'the absence assertion does NOT catch a turn marked after failure',
    ).toBe(true);

    // And the predicates must not fire on unrelated statements.
    const unrelated = [{ query: 'DELETE FROM harness_shared.session_turn_chunks WHERE ...' }];
    expect(unrelated.some((c) => isMark(c.query))).toBe(false);
    expect(unrelated.some((c) => isInsertChunks(c.query))).toBe(false);
  });

  it('does NOT mark the turn when the chunk rewrite fails (retry, never strand)', async () => {
    // If the insert throws, the transaction rolls back and chunked_at stays
    // NULL, so the turn comes back next tick. The failure is counted, not
    // swallowed.
    const { sql, calls } = fakeSql({
      stale: [{ parent_key: KEY, text: longText }],
      throwOn: /INSERT INTO harness_shared\.session_turn_chunks/i,
    });
    const stats = await sync(sql);

    expect(calls.some((c) => isMark(c.query)), 'a failed turn must not be marked chunked').toBe(false);
    expect(stats.errors).toBe(1);
    expect(stats.parentsSynced).toBe(0);
  });

  it('a rewritten chunk carries embedding, mode AND profile as one triple: reused together or invalidated together', async () => {
    // versioned-embedding-profiles-2026-09-12 R-5: the exact embedding profile
    // must never outlive its vector. The engine copies a vector only from an
    // old chunk with the same chunk_sha, and copies its mode and profile with
    // it; every other chunk is written with all three NULL.
    const windows = splitWindows(longText, TURN_WINDOW);
    expect(windows.length, 'precondition: at least two chunks').toBeGreaterThan(1);
    const existing = [
      // Same text as the new chunk 0: its triple must be reused whole.
      { chunk_idx: 0, chunk_sha: turnSha(windows[0]!), parent_sha: 'old-turn-sha', embedding: '[0.5,0.5]', embedding_mode: 'gemma:document', embedding_profile: 'profile-A' },
      // Text no new chunk has: its triple must not leak onto any new chunk.
      { chunk_idx: 1, chunk_sha: 'no-longer-cut', parent_sha: 'old-turn-sha', embedding: '[0.9,0.9]', embedding_mode: 'gemma:document', embedding_profile: 'profile-B' },
    ];
    const { sql, calls } = fakeSql({ stale: [{ parent_key: KEY, text: longText }], existing });
    const stats = await sync(sql);
    expect(stats.errors).toBe(0);

    const insert = calls.find((c) => isInsertChunks(c.query))!;
    expect(insert.query).toMatch(/embedding,\s*embedding_mode,\s*embedding_profile/i);
    const [embeddings, modes, profiles] = [insert.params[7], insert.params[8], insert.params[9]] as (string | null)[][];
    const none = windows.slice(1).map(() => null);
    expect(embeddings).toEqual(['[0.5,0.5]', ...none]);
    expect(modes).toEqual(['gemma:document', ...none]);
    expect(profiles).toEqual(['profile-A', ...none]);
    expect(stats.embeddingsReused).toBe(1);
  });
});

describe('the session-turn store refuses a surface its table cannot hold', () => {
  const resolved = (over: Partial<ChunkSurface> = {}) => resolveChunkSurface({ ...SESSION_TURN_CHUNK_SURFACE, ...over });

  it('accepts the registry entry, whose splitter is the one every stored row was cut with', () => {
    expect(splitterVersionOf(SESSION_TURN_CHUNK_SURFACE)).toBe(STORED_SPLITTER_VERSION);
    expect(sessionTurnSurfaceProblem(resolved())).toBeNull();
  });

  it.each([
    ['a new splitter (no splitter_version column)', { splitter: { kind: 'window' as const, size: 1200, overlap: 200 } }, /splitter/],
    ['a new cap (changes the cut too)', { maxChunks: 8 }, /splitter/],
    ['a header (no header column)', { headerSql: 'p.speaker' }, /header/],
    ['an eligibility filter (prune is the FK)', { eligibleSql: 'p.speaker = $$user$$' }, /eligibleSql/],
    ['another length cut (the partial index is > 2000)', { minChars: 1000 }, /minChars/],
    ['another parent table', { parent: { table: 'harness_shared.other', key: SESSION_TURN_CHUNK_SURFACE.parent.key } }, /parent\.table/],
  ])('refuses %s', (_label, over, message) => {
    expect(sessionTurnSurfaceProblem(resolved(over as Partial<ChunkSurface>))).toMatch(message);
  });

  it('a refused surface fails loudly in the engine: logged, counted, nothing selected or written', async () => {
    const { sql, calls } = fakeSql({ stale: [{ parent_key: KEY, text: longText }] });
    const errors: string[] = [];
    const stats = await syncChunkSurface(sql, { ...SESSION_TURN_CHUNK_SURFACE, maxChunks: 8 }, store, {
      hash: turnSha,
      logger: { warn: () => {}, error: (m) => errors.push(m) },
    });
    expect(stats.errors).toBe(1);
    expect(errors.join('\n')).toMatch(/selecting stale parents failed/);
    expect(calls, 'the store ran SQL for a surface it refuses').toEqual([]);
  });
});
