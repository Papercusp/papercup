import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BM25_CORPORA, bm25Corpus, bm25CorpusSqlRow, bm25TextColumns, renderBm25TextExpr } from './corpora';

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../libs/papercusp/libs/db/sql');
const DEFINES = 'FUNCTION harness_shared.bm25_corpus_indexes()';

/**
 * The newest migration that (re)defines bm25_corpus_indexes(). Armed `.sql` files win; an
 * in-progress `.sql.DRAFT` is used only when no armed file defines the function yet.
 */
function latestCorpusMigration(): { file: string; body: string } {
  const pick = (suffix: string) =>
    readdirSync(SQL_DIR)
      .filter(f => f.endsWith(suffix) && /^\d+-/.test(f))
      .map(f => ({ file: f, n: Number(f.split('-')[0]), sql: readFileSync(path.join(SQL_DIR, f), 'utf8') }))
      .filter(m => m.sql.includes(DEFINES))
      .sort((a, b) => b.n - a.n)[0];
  const m = pick('.sql') ?? pick('.sql.DRAFT');
  if (!m) throw new Error(`no migration in ${SQL_DIR} defines ${DEFINES}`);
  const start = m.sql.indexOf(DEFINES);
  const end = m.sql.indexOf('$fn$;', start);
  return { file: m.file, body: m.sql.slice(start, end) };
}

describe('BM25 corpus registry ↔ migration', () => {
  const { file, body } = latestCorpusMigration();

  it(`every registry corpus appears verbatim in ${file}`, () => {
    for (const corpus of BM25_CORPORA) expect(body, corpus.table).toContain(bm25CorpusSqlRow(corpus));
  });

  it('the migration defines no corpus the registry lacks', () => {
    const rows = [...body.matchAll(/\('([a-z0-9_]+)', '([a-z0-9_]+)', \$e\$/g)].map(m => m[1]);
    expect(rows.sort()).toEqual(BM25_CORPORA.map(c => c.indexName).sort());
  });
});

describe('BM25 corpus registry', () => {
  it('has one entry per table and per index name, each named <table>_bm25', () => {
    expect(new Set(BM25_CORPORA.map(c => c.table)).size).toBe(BM25_CORPORA.length);
    for (const c of BM25_CORPORA) expect(c.indexName).toBe(`${c.table}_bm25`);
  });

  it('renders unqualified and alias-qualified expressions', () => {
    const wi = bm25Corpus('work_items');
    expect(renderBm25TextExpr(wi)).toBe("coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, '')");
    expect(renderBm25TextExpr(wi, 'w')).toBe("coalesce(w.title, '') || ' ' || coalesce(w.summary, '') || ' ' || coalesce(w.notes, '')");
    expect(bm25TextColumns(wi)).toEqual(['title', 'summary', 'notes']);
  });

  it('refuses an alias that is not a plain identifier', () => {
    expect(() => renderBm25TextExpr(bm25Corpus('documents'), "d; DROP TABLE x")).toThrow(/unsafe alias/);
  });

  it('leaves no unrendered placeholder in any expression', () => {
    for (const c of BM25_CORPORA) {
      expect(renderBm25TextExpr(c)).not.toMatch(/[{}]/);
      expect(renderBm25TextExpr(c, 't')).not.toMatch(/[{}]/);
    }
  });
});
