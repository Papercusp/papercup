/**
 * WI-37403 / migration 771 — the two injection-telemetry gaps that together
 * made a relevance audit unrunnable:
 *
 *   (a) the PRE-FUSION COSINE score, persisted in its OWN column. The cosine
 *       similarity is computed, used to admit against the 0.58 floor, and then
 *       overwritten by the fused RRF value — so the recall table recorded only
 *       a number whose ceiling is 0.0328 and could not answer "how relevant was
 *       what we injected?". Comparing the two already produced a false "99.9%
 *       below the floor" report (2026-07-28).
 *
 *   (b) the query TEXT, on a bounded window — previously only its sha + length,
 *       which is why a live finding about query CONTENT had to be evidenced
 *       from an agent transcript rather than measured.
 *
 * The load-bearing property throughout is SCALE PURITY: `top_cosine_score` must
 * contain a cosine similarity or nothing at all. Several tests below are
 * controls that pass under the buggy implementations this replaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { MemoryEntry } from './backend';

const getFlagMock = vi.fn<(key: string, id: string) => Promise<boolean>>();
vi.mock('@papercusp/flags/server', () => ({ getFlag: (k: string, i: string) => getFlagMock(k, i) }));

const { cosineScoresOf, recordRecallStats, recordRecallQueryText, QUERY_TEXT_MAX_CHARS } =
  await import('./recall-stats');

const entry = (id: string, score?: number, retrieval?: MemoryEntry['retrieval']): MemoryEntry => ({
  id,
  text: id,
  scope: 's',
  ...(score !== undefined ? { score } : {}),
  ...(retrieval !== undefined ? { retrieval } : {}),
});

/** Records every statement's interpolated values; returns `rows` for the INSERT…RETURNING. */
function sqlSpy(rows: Array<Record<string, unknown>> = [{ id: 42 }]) {
  const calls: unknown[][] = [];
  const texts: string[] = [];
  const sql = ((s: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    texts.push(s.join('?'));
    return Promise.resolve(rows);
  }) as unknown as Sql;
  return { sql, calls, texts };
}

beforeEach(() => {
  getFlagMock.mockReset();
  getFlagMock.mockResolvedValue(true);
});

describe('cosineScoresOf — the PRE-FUSION relevance, on one scale', () => {
  it('reads the stamped cosine score off a fused hit', () => {
    const entries = [
      entry('a', 0.0164, { cosineRank: 1, cosineScore: 0.91 }),
      entry('b', 0.0161, { cosineRank: 2, cosineScore: 0.62 }),
    ];
    // NB the `score` values are RRF (~0.016). The point is that NEITHER of them
    // reaches the output: the column must carry similarity, not rank-fusion.
    expect(cosineScoresOf(entries, 'rrf')).toEqual([0.91, 0.62]);
  });

  it('falls back to `score` ONLY when the caller declares the cosine scale', () => {
    // The unfused paths (mem0, a single-leg cosine backend) never go through
    // fusion, so nothing stamps provenance — there the native score IS the
    // similarity, and the caller's own declared scale is what says so.
    const entries = [entry('a', 0.72), entry('b', 0.61)];
    expect(cosineScoresOf(entries, 'cosine')).toEqual([0.72, 0.61]);
  });

  it('CONTROL: refuses to treat an rrf/lexical score as a cosine', () => {
    // The whole defect being fixed is one column holding two scales. An
    // implementation that just returned `finiteScores(entries)` passes every
    // other test in this describe and fails here — 0.0164 is a fused rank
    // score, and admitting it would rebuild the mixed-scale column in a new
    // place while looking like a working relevance metric.
    const fusedNoProvenance = [entry('a', 0.0164), entry('b', 0.0161)];
    expect(cosineScoresOf(fusedNoProvenance, 'rrf')).toEqual([]);
    expect(cosineScoresOf(fusedNoProvenance, 'lexical' as never)).toEqual([]);
    expect(cosineScoresOf(fusedNoProvenance, null)).toEqual([]);
  });

  it('CONTROL: skips a lexical-ONLY admit rather than borrowing its score', () => {
    // `floored-union` admits entries the cosine leg never returned; they carry a
    // lexicalRank and NO cosineScore. Counting them would inject lexical-scale
    // numbers into the cosine column — the same mixed-scale trap, one level in.
    const mixed = [
      entry('cos', 0.0164, { cosineRank: 1, cosineScore: 0.88 }),
      entry('lex', 0.0161, { lexicalRank: 1, lexicalScore: 0.42 }),
    ];
    expect(cosineScoresOf(mixed, 'rrf')).toEqual([0.88]);
  });

  it('prefers the STAMPED score over the raw one when both are available', () => {
    // A cosine-scale caller whose entries also carry provenance: the stamp is
    // the pre-fusion truth, `score` may already have been overwritten.
    const entries = [entry('a', 0.0164, { cosineRank: 1, cosineScore: 0.77 })];
    expect(cosineScoresOf(entries, 'cosine')).toEqual([0.77]);
  });

  it('treats a non-finite score as absent, never as zero', () => {
    // 0 is inside the real value range and would read as "maximally irrelevant,
    // admitted anyway" — a defect-shaped reading of a missing measurement.
    expect(cosineScoresOf([entry('a'), entry('b', NaN)], 'cosine')).toEqual([]);
  });
});

describe('recordRecallStats — persisting the cosine columns (migration 771)', () => {
  // Appended AFTER the pre-existing columns, so every prior positional index in
  // recall-stats.test.ts stays valid.
  const TOP_COSINE = 16;
  const COSINE_SCORES = 17;

  it('writes top_cosine_score + the full list, derived from the stamps', async () => {
    const { sql, calls } = sqlSpy();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      scoreScale: 'rrf',
      entries: [
        entry('a', 0.0164, { cosineRank: 2, cosineScore: 0.62 }),
        entry('b', 0.0161, { cosineRank: 1, cosineScore: 0.91 }),
      ],
    });
    expect(calls[0]![TOP_COSINE]).toBe(0.91);
    expect(JSON.parse(calls[0]![COSINE_SCORES] as string)).toEqual([0.62, 0.91]);
  });

  it('keeps top_score and top_cosine_score INDEPENDENT — the two scales stay apart', async () => {
    // The regression guard for the reported defect: a push row's top_score is
    // RRF (ceiling 0.0328) while its top_cosine_score is the similarity the
    // floor was applied to. Folding either into the other is what produced
    // "99.9% of injections are below the 0.58 floor".
    const { sql, calls } = sqlSpy();
    await recordRecallStats(sql, {
      surface: 'mid-turn',
      scoreScale: 'rrf',
      entries: [entry('a', 0.0164, { cosineRank: 1, cosineScore: 0.83 })],
    });
    const TOP_SCORE = 2;
    expect(calls[0]![TOP_SCORE]).toBe(0.0164);
    expect(calls[0]![TOP_COSINE]).toBe(0.83);
  });

  it('records NULL (not 0, not []) when no cosine was measured', async () => {
    // A lexical-only fallback recall. NULL means "not measured"; every
    // scale-aware read excludes it rather than pooling a zero into the
    // distribution.
    const { sql, calls } = sqlSpy();
    await recordRecallStats(sql, {
      surface: 'search',
      scoreScale: 'lexical' as never,
      entries: [entry('a', 0.4)],
    });
    expect(calls[0]![TOP_COSINE]).toBeNull();
    expect(calls[0]![COSINE_SCORES]).toBeNull();
  });

  it('still never throws when the insert fails', async () => {
    // The writer warns (throttled) on a swallowed failure — assert it rather
    // than silencing it, so the never-throws contract and the it-still-tells-you
    // contract are both pinned here.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = (() => Promise.reject(new Error('boom'))) as unknown as Sql;
    await expect(
      recordRecallStats(sql, { surface: 'search', entries: [entry('a', 0.5)] }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capture failed'), 'boom');
    warn.mockRestore();
  });
});

describe('recordRecallQueryText — the bounded window', () => {
  it('writes the text against the stats row', async () => {
    const { sql, calls, texts } = sqlSpy();
    await recordRecallQueryText(sql, 42, '  how does the fusion gate work  ');
    expect(texts[0]).toContain('memory_recall_query_text');
    expect(calls[0]).toEqual([42, 'how does the fusion gate work']);
  });

  it('REFUSES credential-shaped text — a secret must not be copied to a 2nd place', async () => {
    // The mid-turn query is derived from raw Bash command lines, which carry
    // connection strings routinely; a corpus scan found 16 real passwords
    // already at rest (EI-10371). Losing one telemetry sample is the cheap side
    // of this trade.
    const { sql, calls } = sqlSpy();
    await recordRecallQueryText(sql, 42, 'psql postgres://admin:hunter2@db.internal:5432/app');
    expect(calls).toHaveLength(0);
  });

  it('writes NOTHING when the kill switch is off', async () => {
    getFlagMock.mockResolvedValue(false);
    const { sql, calls } = sqlSpy();
    await recordRecallQueryText(sql, 42, 'a perfectly ordinary query');
    expect(calls).toHaveLength(0);
  });

  it('fails CLOSED when the flag cannot be read', async () => {
    // Opposite posture to the retention prunes, which fail-safe by continuing to
    // DELETE. The risky direction for a prune is stopping; for a capture it is
    // starting — so an unreadable flag must never be read as consent.
    getFlagMock.mockRejectedValue(new Error('flag backend down'));
    const { sql, calls } = sqlSpy();
    await recordRecallQueryText(sql, 42, 'a perfectly ordinary query');
    expect(calls).toHaveLength(0);
  });

  it('skips empty / whitespace-only text rather than storing a phantom empty query', async () => {
    const { sql, calls } = sqlSpy();
    await recordRecallQueryText(sql, 42, '   \n  ');
    expect(calls).toHaveLength(0);
    expect(getFlagMock).not.toHaveBeenCalled();
  });

  it('clamps absurdly long text', async () => {
    const { sql, calls } = sqlSpy();
    await recordRecallQueryText(sql, 42, 'x'.repeat(QUERY_TEXT_MAX_CHARS * 2));
    expect((calls[0]![1] as string).length).toBe(QUERY_TEXT_MAX_CHARS);
  });

  it('never throws when the insert fails — the stats row is the durable record', async () => {
    const sql = (() => Promise.reject(new Error('no such table'))) as unknown as Sql;
    await expect(recordRecallQueryText(sql, 42, 'hello')).resolves.toBeUndefined();
  });
});

describe('recordRecallStats — the query-text write is SUBORDINATE to the stats row', () => {
  it('writes the text as a SEPARATE statement after the stats insert', async () => {
    const { sql, texts } = sqlSpy();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      entries: [entry('a', 0.5)],
      query: 'what did we decide about the migration?',
    });
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('memory_recall_stats');
    expect(texts[1]).toContain('memory_recall_query_text');
  });

  it('CONTROL: a REFUSED text write still leaves the stats row written', async () => {
    // The reason the text is not part of the stats INSERT. This table already
    // black-holed every write for hours once when a stale CHECK rejected them
    // (583-drop-…-surface-check.sql); a second write that can fail the first
    // re-opens that class. A combined INSERT would write NOTHING here.
    getFlagMock.mockRejectedValue(new Error('flag backend down'));
    const { sql, texts } = sqlSpy();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      entries: [entry('a', 0.5)],
      query: 'a query nobody will store',
    });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('memory_recall_stats');
  });

  it('skips the text write when the stats insert returned no id', async () => {
    // A driver/mock that returns no rows must not produce an orphan write
    // against a NULL/undefined foreign key.
    const { sql, texts } = sqlSpy([]);
    await recordRecallStats(sql, {
      surface: 'turn-start',
      entries: [entry('a', 0.5)],
      query: 'something',
    });
    expect(texts).toHaveLength(1);
  });
});
