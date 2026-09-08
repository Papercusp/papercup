/**
 * corpus-term-df.test.ts — the DF signal behind banded term selection
 * (P-018 / D-064).
 *
 * The pure fold is tested directly; the lookup's CACHE and DEGRADE semantics
 * are tested against a fake `sql`, because those are the behaviours that decide
 * what happens on the injection hot path when the table is missing, empty or
 * unreadable — and every one of them must leave the leg working.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  accumulateDf,
  foldDf,
  foldDfAsync,
  refreshCorpusTermDf,
  corpusTermDfLookup,
  resetCorpusTermDfCache,
  CORPUS_TERM_DF_CACHE_TTL_MS,
  CORPUS_TERM_DF_FETCH_ROWS,
} from './corpus-term-df';
import { corpusQueryText } from './corpus-recall';

describe('foldDf — DF over RAW corpusTerms tokens', () => {
  it('counts DOCUMENTS, not occurrences', () => {
    // `corpusTerms` de-duplicates within a document, so a term repeated five
    // times in one document is still df 1. Getting this wrong would make a
    // single verbose document look like corpus-wide attestation.
    const { df, ndocs } = foldDf(['session session session session session turns'], 1);
    expect(ndocs).toBe(1);
    expect(df.get('session')).toBe(1);
  });

  it('drops the unattested tail — absence IS the filter verdict', () => {
    const docs = [
      'retrieval budget exhausted on the corpus leg',
      'retrieval budget was fine here',
      'a1b2c3d4e5f6a7b8 appeared exactly once',
    ];
    const { df, distinctSeen } = foldDf(docs, 2);

    expect(df.get('retrieval')).toBe(2);
    expect(df.get('budget')).toBe(2);
    // The hapax hex digest — precisely what naive rarity would have selected.
    expect(df.has('a1b2c3d4e5f6a7b8')).toBe(false);
    expect(distinctSeen).toBeGreaterThan(df.size);
  });

  it('is tokenizer-identical to the selector it feeds — the ts_stat trap', () => {
    // The whole reason DF is built with `corpusTerms` rather than `ts_stat`:
    // a stemmed table would key this document's terms as "session"/"queri"
    // while selection looks up "sessions"/"queries", and every miss reads as
    // df 0 ⇒ maximal rarity ⇒ SELECTED. Here the keys must match verbatim.
    const doc = 'sessions and queries were retried';
    const { df } = foldDf([doc, doc], 2);
    for (const term of ['sessions', 'queries', 'retried']) {
      expect(df.has(term)).toBe(true);
    }
    expect(df.has('session')).toBe(false);
    expect(df.has('queri')).toBe(false);
  });

  it('accumulateDf folds incrementally to the same place', () => {
    const acc = new Map<string, number>();
    accumulateDf(acc, 'corpus retrieval budget');
    accumulateDf(acc, 'corpus retrieval ceiling');
    expect(acc.get('corpus')).toBe(2);
    expect(acc.get('budget')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

type Row = { term: string; df: number; ndocs: number };

/** A tagged-template stand-in for `postgres`'s `sql`. */
function fakeSql(rows: Row[] | (() => Row[] | never)) {
  let calls = 0;
  const fn = (() => {
    calls += 1;
    const r = typeof rows === 'function' ? rows() : rows;
    return Promise.resolve(r);
  }) as unknown as Parameters<typeof corpusTermDfLookup>[0] & { calls: () => number };
  (fn as unknown as { calls: () => number }).calls = () => calls;
  return fn;
}

describe('corpusTermDfLookup — degrade paths that must never break the leg', () => {
  beforeEach(() => resetCorpusTermDfCache());

  it('returns null when NO table has been built — a real answer, not a failure', async () => {
    const df = await corpusTermDfLookup(fakeSql([]), 'ws-empty');
    expect(df).toBeNull();
  });

  it('a null lookup leaves corpusQueryText on its original length ordering', async () => {
    // The whole degrade contract: an un-refreshed workspace behaves EXACTLY as
    // it did before P-018 — never an empty query, never a query on noise.
    const text = 'the aftercompaction envelope mentions updatechip in passing';
    const df = await corpusTermDfLookup(fakeSql([]), 'ws-empty');
    const query = df ? corpusQueryText(text, undefined, { df }) : corpusQueryText(text);
    expect(query).toBe(corpusQueryText(text));
    expect(query).not.toBe('');
  });

  it('NEVER throws when the read fails — it degrades to null', async () => {
    const exploding = fakeSql(() => {
      throw new Error('connect-phase-deadline');
    });
    await expect(corpusTermDfLookup(exploding, 'ws-broken')).resolves.toBeNull();
  });

  it('serves from cache within the TTL and re-reads after it', async () => {
    const sql = fakeSql([{ term: 'retrieval', df: 12, ndocs: 100 }]);
    const t0 = 1_000_000;

    const a = await corpusTermDfLookup(sql, 'ws', t0);
    expect(a!('retrieval')).toBe(12);
    await corpusTermDfLookup(sql, 'ws', t0 + CORPUS_TERM_DF_CACHE_TTL_MS - 1);
    expect((sql as unknown as { calls: () => number }).calls()).toBe(1);

    await corpusTermDfLookup(sql, 'ws', t0 + CORPUS_TERM_DF_CACHE_TTL_MS + 1);
    expect((sql as unknown as { calls: () => number }).calls()).toBe(2);
  });

  it('reports df 0 for an unseen term — which the band then rejects', async () => {
    const sql = fakeSql([{ term: 'retrieval', df: 12, ndocs: 100 }]);
    const df = await corpusTermDfLookup(sql, 'ws');
    expect(df!('20c4f13019f25684')).toBe(0);
  });

  it('collapses a concurrent stampede into ONE read', async () => {
    const sql = fakeSql([{ term: 'retrieval', df: 12, ndocs: 100 }]);
    await Promise.all([
      corpusTermDfLookup(sql, 'ws'),
      corpusTermDfLookup(sql, 'ws'),
      corpusTermDfLookup(sql, 'ws'),
    ]);
    expect((sql as unknown as { calls: () => number }).calls()).toBe(1);
  });

  it('keeps serving a STALE snapshot rather than falling back to length', async () => {
    // Stale RANKS still beat length ordering, which D-064 measured as strictly
    // worse (19.3% of its picks unretrievable). A transient read failure after
    // a good load must not silently downgrade the leg.
    let fail = false;
    const sql = fakeSql(() => {
      if (fail) throw new Error('transient');
      return [{ term: 'retrieval', df: 12, ndocs: 100 }];
    });
    const t0 = 1_000_000;
    await corpusTermDfLookup(sql, 'ws', t0);

    fail = true;
    const after = await corpusTermDfLookup(sql, 'ws', t0 + CORPUS_TERM_DF_CACHE_TTL_MS + 1);
    expect(after).not.toBeNull();
    expect(after!('retrieval')).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WI-10000802 — the refresh must bound BYTES, not just rows.
//
// `LIMIT CORPUS_TERM_DF_SAMPLE_DOCS` (40k) caps DOCUMENTS, but nothing caps
// their total size, so materialising the sample held ~100 MB of turn text
// (measured 2026-09-08 against the live corpus; streaming holds ~2.8 MB). The
// fold only ever needed the term Map, so holding the texts bought nothing.
//
// ⚠ These assert the STREAMING SHAPE, not a byte threshold — the corpus grows
// and the column permits 20,000 chars per row, so the size that matters is
// whatever it becomes. Do NOT relax them into "it fits today".
// ─────────────────────────────────────────────────────────────────────────────
describe('refreshCorpusTermDf — streams the sample instead of materialising it', () => {
  /** A sql whose query object is DELIBERATELY not awaitable: it exposes only
   *  `.cursor()`. Re-introducing `await sql\`…\`` therefore FAILS here rather
   *  than passing quietly, which is the whole point of the guard. */
  function cursorOnlySql(texts: string[], chunkCap = CORPUS_TERM_DF_FETCH_ROWS) {
    const seen = { chunkSizes: [] as number[], peakChunk: 0, cursorCalls: 0, inserted: [] as unknown[] };
    const query = {
      cursor(n: number) {
        seen.cursorCalls += 1;
        seen.chunkSizes.push(n);
        return (async function* () {
          for (let i = 0; i < texts.length; i += Math.min(n, chunkCap)) {
            const chunk = texts.slice(i, i + Math.min(n, chunkCap)).map((text) => ({ text }));
            seen.peakChunk = Math.max(seen.peakChunk, chunk.length);
            yield chunk;
          }
        })();
      },
    };
    const tx = (..._a: unknown[]) => Promise.resolve([]);
    const fn = (() => query) as unknown as Parameters<typeof refreshCorpusTermDf>[0];
    (fn as unknown as { begin: (cb: (t: unknown) => Promise<unknown>) => Promise<unknown> }).begin = (cb) =>
      Promise.resolve(cb(tx));
    return { sql: fn, seen };
  }

  it('never holds more than one bounded chunk of texts at a time', async () => {
    const texts = Array.from({ length: 4_500 }, (_, i) => `alpha beta document number ${i} retrieval corpus`);
    const { sql, seen } = cursorOnlySql(texts);

    const result = await refreshCorpusTermDf(sql, { workspaceId: 'ws-stream', minDf: 1 });

    expect(seen.cursorCalls).toBe(1);
    // The bound that actually caps memory — a chunk, not the 40k sample.
    expect(seen.peakChunk).toBeLessThanOrEqual(CORPUS_TERM_DF_FETCH_ROWS);
    expect(seen.chunkSizes[0]).toBeLessThanOrEqual(CORPUS_TERM_DF_FETCH_ROWS);
    // …and every document still reached the fold: bounding bytes must not
    // silently shrink the sample, which is the tempting wrong fix.
    expect(result.ndocs).toBe(texts.length);
  });

  it('folds an empty corpus without wiping the existing table', async () => {
    const { sql } = cursorOnlySql([]);
    const result = await refreshCorpusTermDf(sql, { workspaceId: 'ws-empty', minDf: 1 });
    expect(result.ndocs).toBe(0);
    expect(result.stored).toBe(0);
  });
});

describe('foldDfAsync — byte-bounded twin of foldDf', () => {
  const texts = [
    'retrieval corpus alpha beta',
    'retrieval gamma corpus',
    'alpha delta retrieval',
    'epsilon',
  ];

  async function* stream(xs: string[]) {
    for (const x of xs) yield x;
  }

  it('produces a table IDENTICAL to the synchronous fold', async () => {
    for (const minDf of [1, 2, 3]) {
      const sync = foldDf(texts, minDf);
      const async_ = await foldDfAsync(stream(texts), minDf);

      expect(async_.ndocs).toBe(sync.ndocs);
      expect(async_.distinctSeen).toBe(sync.distinctSeen);
      expect([...async_.df.entries()].sort()).toEqual([...sync.df.entries()].sort());
    }
  });

  it('counts DOCUMENTS not occurrences, exactly as the sync fold does', async () => {
    const r = await foldDfAsync(stream(['retrieval retrieval retrieval', 'retrieval']), 1);
    expect(r.ndocs).toBe(2);
    expect(r.df.get('retrieval')).toBe(2);
  });
});
