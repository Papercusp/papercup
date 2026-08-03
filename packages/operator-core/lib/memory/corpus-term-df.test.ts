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
  corpusTermDfLookup,
  resetCorpusTermDfCache,
  CORPUS_TERM_DF_CACHE_TTL_MS,
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
