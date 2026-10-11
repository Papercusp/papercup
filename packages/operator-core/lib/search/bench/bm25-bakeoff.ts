/**
 * bm25-bakeoff.ts — the pure half of the BM25 engine bake-off (WI-10008294), which
 * executes the measurement half of plan bm25-lexical-search-evoke-adoption-2026-10-10
 * item P-001 and feeds its decision D-001. `bm25-bakeoff-cli.ts` runs the arms inside a
 * throwaway container (SQL under `bm25-bakeoff/`); this file owns the engine roster, the
 * metric definitions, the paired statistics and the D-001 engine-choice rule, so they
 * are unit-tested rather than living in ad-hoc SQL.
 *
 * Method: known-item retrieval over the work-item corpus. The query is an item's title
 * (full, or its 4 longest distinct words); the index holds bodies WITHOUT titles; a hit
 * is the target or any document with a byte-identical body. Known-item search is a
 * proxy for real queries, not a substitute for the real-query hybrid benches.
 */
import {
  mcnemarExact,
  pairedBootstrapCI,
  wilsonInterval,
  type Interval,
  type McNemarResult,
  type PairedComparison,
} from '@papercusp/bench-metrics';

export type BakeoffVariant = 'title' | 'short';
export const BAKEOFF_VARIANTS: readonly BakeoffVariant[] = ['title', 'short'];

export interface BakeoffEngine {
  /** Arm id; the SQL defines `search_<method>(text) RETURNS text[]`. */
  method: string;
  /** Database inside the container; one per engine family (two extensions both define a `bm25` access method). */
  database: string;
  /** Setup file under `bm25-bakeoff/`, run once per database after `common.sql`. */
  setupFile: string;
  label: string;
  licence: string;
  /** False when the licence rules the engine out of the desktop distribution. */
  shippable: boolean;
  analyzer: string;
}

export const BM25_BAKEOFF_ENGINES: readonly BakeoffEngine[] = [
  {
    method: 'tsv_and', database: 'bake_sql', setupFile: 'engine-sql.sql',
    label: "today's lexical leg: tsvector + plainto_tsquery (AND) + ts_rank_cd",
    licence: 'PostgreSQL (core)', shippable: true, analyzer: "Postgres 'english' (stem + stopwords)",
  },
  {
    method: 'sqlbm25_tsv', database: 'bake_sql', setupFile: 'engine-sql.sql',
    label: 'pure-SQL BM25 scored off the tsvector (OR candidates via GIN)',
    licence: 'PostgreSQL (core)', shippable: true, analyzer: "Postgres 'english' (stem + stopwords)",
  },
  {
    method: 'sqlbm25_post', database: 'bake_sql', setupFile: 'engine-sql.sql',
    label: 'pure-SQL BM25 over a postings side-table (btree, covering)',
    licence: 'PostgreSQL (core)', shippable: true, analyzer: "Postgres 'english' (stem + stopwords)",
  },
  {
    method: 'evoke', database: 'bake_evoke', setupFile: 'engine-evoke.sql',
    label: 'Evoke 0.2.5, defaults, preloaded',
    licence: 'Apache-2.0', shippable: true, analyzer: 'Evoke default: lowercase, no stemming, no stopwords',
  },
  {
    method: 'evoke_stem', database: 'bake_evoke', setupFile: 'engine-evoke.sql',
    label: 'Evoke 0.2.5, text_stem_english, preloaded',
    licence: 'Apache-2.0', shippable: true, analyzer: 'Evoke: lowercase + English Porter stemming, no stopwords',
  },
  {
    method: 'pgts', database: 'bake_pgts', setupFile: 'engine-pgts.sql',
    label: 'pg_textsearch 1.5.1',
    licence: 'PostgreSQL', shippable: true, analyzer: "Postgres 'english' (stem + stopwords)",
  },
  {
    method: 'pgsearch', database: 'bake_pgsearch', setupFile: 'engine-pgsearch.sql',
    label: 'ParadeDB pg_search 0.26.1 (reference only)',
    licence: 'AGPL-3.0', shippable: false, analyzer: 'pdb.simple + English stemmer (Tantivy)',
  },
];

/** The baseline every arm is compared against: what papercusp ranks with today. */
export const BASELINE_METHOD = 'tsv_and';

/** Databases in setup order: bake_sql first, because it freezes the query set the others load. */
export function bakeoffDatabases(engines: readonly BakeoffEngine[] = BM25_BAKEOFF_ENGINES): { database: string; setupFile: string }[] {
  const seen = new Map<string, string>();
  for (const e of engines) if (!seen.has(e.database)) seen.set(e.database, e.setupFile);
  const out = [...seen].map(([database, setupFile]) => ({ database, setupFile }));
  out.sort((a, b) => Number(b.database === 'bake_sql') - Number(a.database === 'bake_sql'));
  return out;
}

/**
 * Each engine's database is cloned from template0, never the default template1: the Evoke
 * base image installs `evoke` into template1, so a template1 clone silently puts a second
 * engine into every arm's database (and makes the Evoke arm's `CREATE EXTENSION evoke`
 * fail with "already exists" — run 1 of WI-10008294).
 */
export function createDatabaseSql(database: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error(`invalid database name: ${JSON.stringify(database)}`);
  return `CREATE DATABASE ${database} TEMPLATE template0`;
}

/** Extensions a freshly created engine database already holds; anything here broke isolation. */
export const INHERITED_EXTENSIONS_SQL =
  "SELECT coalesce(string_agg(extname, ',' ORDER BY extname), '') FROM pg_extension WHERE extname <> 'plpgsql'";

// ─── CSV (Postgres COPY ... WITH (FORMAT csv)) ────────────────────────────────

/**
 * RFC 4180 parser for Postgres `COPY ... (FORMAT csv)` output. A field is `null` when it
 * was UNQUOTED and empty (COPY's NULL marker) and `''` when it was a quoted empty string,
 * so a NULL rank can never be confused with a value.
 */
export function parseCsv(text: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let i = 0;
  const endField = () => { row.push(field === '' && !quoted ? null : field); field = ''; quoted = false; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; quoted = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\n' || c === '\r') {
      endField(); rows.push(row); row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (inQuotes) throw new Error('parseCsv: unterminated quoted field');
  if (field !== '' || quoted || row.length > 0) { endField(); rows.push(row); }
  return rows;
}

export interface EvalRow {
  method: string;
  variant: BakeoffVariant;
  target: string;
  /** 1-based rank of the target (or a byte-identical duplicate) in the top 10; null = miss. */
  rank: number | null;
  ms: number;
  err: boolean;
  errmsg: string | null;
}

/** Parse `COPY (SELECT method, variant, target, rank, ms, err, errmsg FROM res) TO STDOUT csv`. */
export function parseEvalRows(csv: string): EvalRow[] {
  return parseCsv(csv).map((f, i) => {
    if (f.length !== 7) throw new Error(`parseEvalRows: row ${i} has ${f.length} fields, expected 7`);
    const [method, variant, target, rank, ms, err, errmsg] = f;
    if (variant !== 'title' && variant !== 'short') throw new Error(`parseEvalRows: row ${i} has variant ${String(variant)}`);
    if (!method || !target || ms === null || (err !== 't' && err !== 'f')) throw new Error(`parseEvalRows: row ${i} is malformed`);
    return {
      method, variant, target,
      rank: rank === null ? null : Number(rank),
      ms: Number(ms),
      err: err === 't',
      errmsg,
    };
  });
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

/** Postgres `percentile_cont` (linear interpolation) over an ASCENDING-sorted array. */
export function percentileCont(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const pos = p * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

export interface MethodSummary {
  method: string;
  variant: BakeoffVariant;
  /** Every evaluated query, misses and errors included: the denominator of every rate. */
  n: number;
  errors: number;
  recallAt1: number;
  recallAt10: number;
  recallAt10CI: Interval;
  mrrAt10: number;
  /** Latency over NON-error queries, after the discarded warm-up pass. */
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  /** Up to 3 distinct error messages, so an error count is never reported without its cause. */
  errorSamples: string[];
}

const isHit = (r: EvalRow, k: number) => r.rank !== null && r.rank <= k;
const reciprocal = (r: EvalRow) => (r.rank !== null && r.rank <= 10 ? 1 / r.rank : 0);

/**
 * Per (method, variant) metrics. Every rate divides by ALL queries: a miss (rank NULL)
 * and an error both count as 0. The WI-10008233 trial computed recall@1 as
 * `avg((rank = 1)::int)`, which skips NULL ranks and overstated it; this cannot.
 */
export function summarize(rows: readonly EvalRow[]): MethodSummary[] {
  const groups = new Map<string, EvalRow[]>();
  for (const r of rows) {
    const key = `${r.method}\u0000${r.variant}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  const out: MethodSummary[] = [];
  for (const g of groups.values()) {
    const n = g.length;
    const hits1 = g.filter(r => isHit(r, 1)).length;
    const hits10 = g.filter(r => isHit(r, 10)).length;
    const lat = g.filter(r => !r.err).map(r => r.ms).sort((a, b) => a - b);
    const errs = g.filter(r => r.err);
    out.push({
      method: g[0].method,
      variant: g[0].variant,
      n,
      errors: errs.length,
      recallAt1: hits1 / n,
      recallAt10: hits10 / n,
      recallAt10CI: wilsonInterval(hits10, n),
      mrrAt10: g.reduce((s, r) => s + reciprocal(r), 0) / n,
      p50Ms: percentileCont(lat, 0.5),
      p95Ms: percentileCont(lat, 0.95),
      meanMs: lat.length ? lat.reduce((s, x) => s + x, 0) / lat.length : Number.NaN,
      errorSamples: [...new Set(errs.map(r => r.errmsg ?? '(no message)'))].slice(0, 3),
    });
  }
  out.sort((a, b) => a.variant.localeCompare(b.variant) || a.method.localeCompare(b.method));
  return out;
}

export interface PairedResult {
  baseline: string;
  candidate: string;
  variant: BakeoffVariant;
  /** Queries both arms answered (aligned on target). */
  n: number;
  hitAt10: McNemarResult;
  mrrAt10: PairedComparison;
}

/** Paired comparison on the SAME queries: McNemar on hit@10, paired bootstrap on reciprocal rank. */
export function comparePaired(rows: readonly EvalRow[], baseline: string, candidate: string, variant: BakeoffVariant): PairedResult | null {
  const a = new Map(rows.filter(r => r.method === baseline && r.variant === variant).map(r => [r.target, r]));
  const pairs: [EvalRow, EvalRow][] = [];
  for (const r of rows) {
    if (r.method !== candidate || r.variant !== variant) continue;
    const base = a.get(r.target);
    if (base) pairs.push([base, r]);
  }
  if (pairs.length < 2) return null;
  pairs.sort((x, y) => x[0].target.localeCompare(y[0].target));
  return {
    baseline, candidate, variant, n: pairs.length,
    hitAt10: mcnemarExact(pairs.map(([x]) => isHit(x, 10)), pairs.map(([, y]) => isHit(y, 10))),
    mrrAt10: pairedBootstrapCI(pairs.map(([x]) => reciprocal(x)), pairs.map(([, y]) => reciprocal(y)), { seed: 42 }),
  };
}

/** Fraction of shared queries on which two arms put the target at the same rank (self-check for equivalent scorers). */
export function rankAgreement(rows: readonly EvalRow[], a: string, b: string, variant: BakeoffVariant): { n: number; agree: number } {
  const left = new Map(rows.filter(r => r.method === a && r.variant === variant).map(r => [r.target, r.rank]));
  let n = 0;
  let agree = 0;
  for (const r of rows) {
    if (r.method !== b || r.variant !== variant || !left.has(r.target)) continue;
    n++;
    if (left.get(r.target) === r.rank) agree++;
  }
  return { n, agree: n ? agree / n : Number.NaN };
}

// ─── D-001 engine-choice rule ──────────────────────────────────────────────────

/** Plan R-2: lexical query p50 <= 10 ms and p95 <= 50 ms in the production configuration. */
export const R2_LATENCY_BUDGET = { p50Ms: 10, p95Ms: 50 } as const;
export const D001_WITHIN_FRACTION = 0.1;

export interface D001Check {
  variant: BakeoffVariant;
  metric: 'recallAt10' | 'mrrAt10' | 'latency';
  evoke: number;
  pgts: number;
  pass: boolean;
  note: string;
}

export interface D001Verdict {
  choice: 'pg_textsearch' | 'evoke';
  /** The Evoke arm the rule compared against (the better-ranking configuration). */
  evokeMethod: string;
  checks: D001Check[];
  /** Does the chosen engine itself meet R-2 on every query form? Reported, not part of the rule. */
  chosenMeetsR2: boolean;
  reasons: string[];
}

const meetsR2 = (s: MethodSummary) => s.p50Ms <= R2_LATENCY_BUDGET.p50Ms && s.p95Ms <= R2_LATENCY_BUDGET.p95Ms;

/**
 * D-001: choose pg_textsearch if it is within 10% of Evoke on recall@10 AND MRR@10 and
 * meets R-2 latency; otherwise Evoke. Applied per query form, and pg_textsearch must pass
 * on EVERY form. "Evoke" is whichever preloaded Evoke configuration ranks better (mean
 * MRR@10 across forms), so pg_textsearch is held to Evoke's best, not its default.
 */
export function applyD001Rule(
  summaries: readonly MethodSummary[],
  opts: { evokeMethods?: readonly string[]; pgtsMethod?: string; within?: number } = {},
): D001Verdict {
  const evokeMethods = opts.evokeMethods ?? ['evoke', 'evoke_stem'];
  const pgtsMethod = opts.pgtsMethod ?? 'pgts';
  const within = opts.within ?? D001_WITHIN_FRACTION;
  const get = (m: string, v: BakeoffVariant) => summaries.find(s => s.method === m && s.variant === v);
  const meanMrr = (m: string) => {
    const xs = BAKEOFF_VARIANTS.map(v => get(m, v)?.mrrAt10);
    return xs.every((x): x is number => typeof x === 'number') ? xs.reduce((s, x) => s + x, 0) / xs.length : -1;
  };
  const evokeMethod = [...evokeMethods].sort((a, b) => meanMrr(b) - meanMrr(a))[0];
  if (meanMrr(evokeMethod) < 0) throw new Error(`applyD001Rule: no complete Evoke arm among ${evokeMethods.join(', ')}`);
  if (meanMrr(pgtsMethod) < 0) throw new Error(`applyD001Rule: no complete ${pgtsMethod} arm`);

  const checks: D001Check[] = [];
  for (const v of BAKEOFF_VARIANTS) {
    const e = get(evokeMethod, v)!;
    const p = get(pgtsMethod, v)!;
    for (const metric of ['recallAt10', 'mrrAt10'] as const) {
      const floor = (1 - within) * e[metric];
      checks.push({
        variant: v, metric, evoke: e[metric], pgts: p[metric], pass: p[metric] >= floor,
        note: `pg_textsearch ${p[metric].toFixed(3)} vs floor ${floor.toFixed(3)} (${(100 * (1 - within)).toFixed(0)}% of Evoke ${e[metric].toFixed(3)})`,
      });
    }
    checks.push({
      variant: v, metric: 'latency', evoke: e.p95Ms, pgts: p.p95Ms, pass: meetsR2(p),
      note: `pg_textsearch p50 ${p.p50Ms.toFixed(2)} ms / p95 ${p.p95Ms.toFixed(2)} ms vs R-2 budget ${R2_LATENCY_BUDGET.p50Ms} / ${R2_LATENCY_BUDGET.p95Ms} ms`,
    });
  }
  const choice = checks.every(c => c.pass) ? 'pg_textsearch' : 'evoke';
  const chosenMethod = choice === 'pg_textsearch' ? pgtsMethod : evokeMethod;
  const chosenMeetsR2 = BAKEOFF_VARIANTS.every(v => meetsR2(get(chosenMethod, v)!));
  const reasons = checks.filter(c => !c.pass).map(c => `${c.variant} ${c.metric}: ${c.note}`);
  if (choice === 'pg_textsearch') reasons.push('pg_textsearch passed every D-001 check on every query form');
  if (!chosenMeetsR2) reasons.push(`the chosen engine (${chosenMethod}) does NOT meet R-2 latency on every form; P-004 must close that gap`);
  return { choice, evokeMethod, checks, chosenMeetsR2, reasons };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '—');
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

/** The results table for the report: one row per arm × query form. */
export function renderSummaryTable(summaries: readonly MethodSummary[], engines: readonly BakeoffEngine[] = BM25_BAKEOFF_ENGINES): string {
  const label = (m: string) => engines.find(e => e.method === m)?.label ?? m;
  const lines = [
    '| Query form | Arm | n | recall@1 | recall@10 (95% CI) | MRR@10 | p50 / p95 ms | errors |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const s of summaries) {
    lines.push(
      `| ${s.variant === 'title' ? 'Full title' : '4 keywords'} | ${s.method}: ${label(s.method)} | ${s.n} | ${f3(s.recallAt1)} | ` +
      `${f3(s.recallAt10)} (${f3(s.recallAt10CI.lower)}–${f3(s.recallAt10CI.upper)}) | ${f3(s.mrrAt10)} | ` +
      `${f1(s.p50Ms)} / ${f1(s.p95Ms)} | ${s.errors} |`,
    );
  }
  return lines.join('\n');
}
