import { describe, expect, it } from 'vitest';
import {
  applyD001Rule,
  bakeoffDatabases,
  BM25_BAKEOFF_ENGINES,
  comparePaired,
  createDatabaseSql,
  parseCsv,
  parseEvalRows,
  percentileCont,
  rankAgreement,
  renderSummaryTable,
  summarize,
  type BakeoffVariant,
  type EvalRow,
  type MethodSummary,
} from './bm25-bakeoff';

const row = (method: string, target: string, rank: number | null, opts: Partial<EvalRow> = {}): EvalRow => ({
  method, variant: 'title', target, rank, ms: 1, err: false, errmsg: null, ...opts,
});

describe('createDatabaseSql (engine isolation)', () => {
  it('clones from template0 so no engine inherits an extension the image put in template1', () => {
    for (const { database } of bakeoffDatabases()) {
      expect(createDatabaseSql(database)).toBe(`CREATE DATABASE ${database} TEMPLATE template0`);
    }
  });

  it('refuses a name that is not a plain lower-case identifier', () => {
    expect(() => createDatabaseSql('bake; DROP DATABASE postgres')).toThrow(/invalid database name/);
    expect(() => createDatabaseSql('Bake')).toThrow(/invalid database name/);
  });
});

describe('parseCsv (Postgres COPY csv)', () => {
  it('distinguishes COPY NULL (unquoted empty) from a quoted empty string', () => {
    expect(parseCsv('a,,"",b\n')).toEqual([['a', null, '', 'b']]);
  });

  it('handles quoted commas, doubled quotes, embedded newlines and CRLF', () => {
    expect(parseCsv('"x,y","say ""hi""","line1\nline2"\r\nz,1,2')).toEqual([
      ['x,y', 'say "hi"', 'line1\nline2'],
      ['z', '1', '2'],
    ]);
  });

  it('refuses an unterminated quote instead of returning a short row', () => {
    expect(() => parseCsv('"open,1')).toThrow(/unterminated/);
  });
});

describe('parseEvalRows', () => {
  it('maps a NULL rank to null and t/f to booleans', () => {
    const rows = parseEvalRows('evoke,title,h:WI-1,,3.5,f,\npgts,short,h:WI-2,2,1.25,t,"XX000 boom, bang"\n');
    expect(rows).toEqual([
      { method: 'evoke', variant: 'title', target: 'h:WI-1', rank: null, ms: 3.5, err: false, errmsg: null },
      { method: 'pgts', variant: 'short', target: 'h:WI-2', rank: 2, ms: 1.25, err: true, errmsg: 'XX000 boom, bang' },
    ]);
  });

  it('rejects a row with the wrong field count or an unknown variant', () => {
    expect(() => parseEvalRows('evoke,title,x,1,1,f\n')).toThrow(/7/);
    expect(() => parseEvalRows('evoke,body,x,1,1,f,\n')).toThrow(/variant/);
  });
});

describe('percentileCont matches Postgres percentile_cont', () => {
  it('interpolates linearly', () => {
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileCont(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBeCloseTo(19.05, 10);
    expect(percentileCont([7], 0.95)).toBe(7);
    expect(Number.isNaN(percentileCont([], 0.5))).toBe(true);
  });
});

describe('summarize', () => {
  it('divides recall@1 by ALL queries: a miss (NULL rank) and an error both count as 0 (WI-10008233 trap)', () => {
    const rows = [
      row('m', 'a', 1),
      row('m', 'b', null),
      row('m', 'c', 3),
      row('m', 'd', null, { err: true, errmsg: 'XX000 oops', ms: 0.1 }),
    ];
    const [s] = summarize(rows);
    // avg((rank = 1)::int) over non-NULL ranks would say 0.5 here.
    expect(s.recallAt1).toBe(0.25);
    expect(s.recallAt10).toBe(0.5);
    expect(s.mrrAt10).toBeCloseTo((1 + 1 / 3) / 4, 12);
    expect(s.n).toBe(4);
    expect(s.errors).toBe(1);
    expect(s.errorSamples).toEqual(['XX000 oops']);
  });

  it('computes latency over non-error queries only and reports a Wilson CI around recall@10', () => {
    const rows = [row('m', 'a', 1, { ms: 2 }), row('m', 'b', 2, { ms: 4 }), row('m', 'c', null, { ms: 100, err: true })];
    const [s] = summarize(rows);
    expect(s.p50Ms).toBe(3);
    expect(s.meanMs).toBe(3);
    expect(s.recallAt10CI.point).toBeCloseTo(2 / 3, 12);
    expect(s.recallAt10CI.lower).toBeLessThan(2 / 3);
    expect(s.recallAt10CI.upper).toBeGreaterThan(2 / 3);
  });

  it('groups by method AND variant', () => {
    const rows = [row('m', 'a', 1), row('m', 'a', null, { variant: 'short' }), row('k', 'a', 2)];
    expect(summarize(rows).map(s => `${s.variant}:${s.method}`)).toEqual(['short:m', 'title:k', 'title:m']);
  });
});

describe('comparePaired / rankAgreement', () => {
  it('aligns the two arms on target and ignores queries only one arm answered', () => {
    const rows = [
      row('base', 'a', null), row('base', 'b', 1), row('base', 'c', null), row('base', 'only-base', 1),
      row('cand', 'a', 1), row('cand', 'b', 1), row('cand', 'c', 4),
    ];
    const p = comparePaired(rows, 'base', 'cand', 'title')!;
    expect(p.n).toBe(3);
    expect(p.hitAt10.onlyA).toBe(0);
    expect(p.hitAt10.onlyB).toBe(2);
    expect(p.mrrAt10.meanA).toBeCloseTo(1 / 3, 12);
    expect(p.mrrAt10.meanB).toBeCloseTo((1 + 1 + 0.25) / 3, 12);
    expect(rankAgreement(rows, 'base', 'cand', 'title')).toEqual({ n: 3, agree: 1 / 3 });
  });

  it('returns null when fewer than two queries are shared', () => {
    expect(comparePaired([row('base', 'a', 1), row('cand', 'a', 1)], 'base', 'cand', 'title')).toBeNull();
  });
});

const summary = (method: string, variant: BakeoffVariant, recallAt10: number, mrrAt10: number, p50Ms = 3, p95Ms = 20): MethodSummary => ({
  method, variant, n: 1000, errors: 0, recallAt1: 0, recallAt10, mrrAt10, p50Ms, p95Ms, meanMs: p50Ms,
  recallAt10CI: { point: recallAt10, lower: recallAt10, upper: recallAt10, ci: 0.95 }, errorSamples: [],
});

const both = (method: string, r: number, m: number, p50?: number, p95?: number) =>
  (['title', 'short'] as const).map(v => summary(method, v, r, m, p50, p95));

describe('applyD001Rule (plan D-001)', () => {
  it('chooses pg_textsearch when it is within 10% of Evoke on recall@10 and MRR@10 on every form and meets R-2', () => {
    const v = applyD001Rule([...both('evoke', 0.46, 0.34), ...both('pgts', 0.42, 0.31)]);
    expect(v.choice).toBe('pg_textsearch');
    expect(v.checks.every(c => c.pass)).toBe(true);
    expect(v.chosenMeetsR2).toBe(true);
  });

  it('chooses Evoke when pg_textsearch falls more than 10% behind on ANY metric of ANY form', () => {
    const rows = [
      ...both('evoke', 0.46, 0.34),
      summary('pgts', 'title', 0.45, 0.33),
      summary('pgts', 'short', 0.45, 0.30), // 0.30 < 0.9 * 0.34 = 0.306
    ];
    const v = applyD001Rule(rows);
    expect(v.choice).toBe('evoke');
    expect(v.reasons.join(' ')).toMatch(/short mrrAt10/);
  });

  it('chooses Evoke when pg_textsearch ranks well but misses the R-2 latency budget', () => {
    const v = applyD001Rule([...both('evoke', 0.46, 0.34), ...both('pgts', 0.46, 0.34, 4, 60)]);
    expect(v.choice).toBe('evoke');
    expect(v.reasons.join(' ')).toMatch(/latency/);
  });

  it('holds pg_textsearch to the BETTER Evoke configuration, not the default one', () => {
    const rows = [...both('evoke', 0.40, 0.25), ...both('evoke_stem', 0.50, 0.40), ...both('pgts', 0.44, 0.33)];
    const v = applyD001Rule(rows);
    expect(v.evokeMethod).toBe('evoke_stem');
    expect(v.choice).toBe('evoke'); // 0.33 < 0.9 * 0.40; it would have passed against the default
  });

  it('flags when the chosen engine itself misses R-2', () => {
    const v = applyD001Rule([...both('evoke', 0.46, 0.34, 3, 80), ...both('pgts', 0.2, 0.1)]);
    expect(v.choice).toBe('evoke');
    expect(v.chosenMeetsR2).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/does NOT meet R-2/);
  });

  it('refuses to decide without a complete Evoke and pg_textsearch reading', () => {
    expect(() => applyD001Rule(both('pgts', 0.4, 0.3))).toThrow(/Evoke/);
    expect(() => applyD001Rule([...both('evoke', 0.4, 0.3), summary('pgts', 'title', 0.4, 0.3)])).toThrow(/pgts/);
  });
});

describe('roster', () => {
  it('sets up bake_sql first (it freezes the query set) and each database once', () => {
    const dbs = bakeoffDatabases();
    expect(dbs[0].database).toBe('bake_sql');
    expect(new Set(dbs.map(d => d.database)).size).toBe(dbs.length);
    expect(dbs.map(d => d.database).sort()).toEqual(['bake_evoke', 'bake_pgsearch', 'bake_pgts', 'bake_sql']);
  });

  it('marks only the AGPL engine as not shippable', () => {
    expect(BM25_BAKEOFF_ENGINES.filter(e => !e.shippable).map(e => e.method)).toEqual(['pgsearch']);
  });

  it('renders one table row per summary', () => {
    const md = renderSummaryTable([summary('pgts', 'title', 0.4, 0.3)]);
    expect(md.split('\n')).toHaveLength(3);
    expect(md).toContain('pg_textsearch 1.5.1');
  });
});
