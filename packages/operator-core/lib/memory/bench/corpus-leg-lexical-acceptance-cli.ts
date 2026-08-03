/**
 * P-017 acceptance — does coverage-graded lexical retrieval improve the CORPUS
 * injection leg? (context-injection-retrieval-reach-and-visibility-2026-08-03,
 * bounded by D-062 and D-063.)
 *
 *   npx tsx packages/operator-core/lib/memory/bench/corpus-leg-lexical-acceptance-cli.ts \
 *     --queries 120 --terms 2,5 --seed 17 [--hybrid] [--workspace <id>]
 *
 * ⚠ WHY THIS EXISTS RATHER THAN `corpus.v1` (D-063). The frozen corpus.v1 /
 * gold-set.v1 bench retrieves through `LexicalLegBackend` →
 * `Mem0Backend.searchLexical` → `canonical-store.ts`, which queries
 * `memory_canonical` — the MEMORY injection leg. The change under test is in
 * `agent-tools/search/sources.ts`, reached only via `corpus-recall-io.ts` →
 * `runHybridSearch(SEARCH_SOURCES)` over `session_turns` + `engineer_issues`.
 * Nothing under `bench/` imports that path, so corpus.v1 would return a null
 * delta BY CONSTRUCTION — and a null reads as "the change doesn't help", not
 * "the instrument cannot see it". This CLI replays the REAL corpus instead.
 *
 * WHAT IT MEASURES, and why these numbers rather than an MRR:
 *
 *   NULL CONTROL  `'and'` run twice, independently. Every arm-level number must
 *                 come out exactly zero. It validates the arm-isolation
 *                 mechanism the whole run depends on — not merely harness noise
 *                 — and it runs FIRST, per D-051/D-053.
 *   CONTAINMENT   Every control hit must reappear under the treatment. The
 *                 integration test proves this for one fixture query; here it is
 *                 checked against the live 400k-row corpus at production query
 *                 shape. A single violation falsifies the superset property the
 *                 design rests on, and the run says so loudly.
 *   FILL          How often the AND query under-fills the leg's 6 admitted
 *                 slots, and how many the treatment fills. This is the number
 *                 that decides adoption: when control under-fills, the extra
 *                 graded rows displace NOTHING — they occupy slots that were
 *                 empty. "Does it push out good results" is not a live risk in
 *                 that regime, and this measures how large that regime is.
 *   DISPLACEMENT  The ONE real regression channel. Control orders by
 *                 `ts_rank_cd(andq)`, treatment by `ts_rank_cd(orq)` WITHIN the
 *                 top coverage tier, so a hit can move rank inside a tier whose
 *                 members all match every term. Reported as top-1 churn and mean
 *                 rank movement of the control's own hits.
 *   LATENCY       p50/p95 against `corpusRecallTimeoutMs()` — the leg's 2s WHOLE
 *                 -leg bound is part of P-017's acceptance, not a footnote.
 *
 * ⚠ NO MRR IS REPORTED, DELIBERATELY. A known-item gold set whose query is
 * derived FROM the gold document is worthless for a recall-WIDENING change: the
 * document then matches every query term by construction, so it is always a hit
 * under the AND control and the recall win can never appear — only the
 * regression channel would be measured. Producing a confident 0.00 ΔMRR that way
 * would be worse than reporting nothing. Judging whether the RECOVERED documents
 * are useful (D-063 R4) needs labels this run does not have; it reports how many
 * there are and what they look like, and stops there.
 *
 * ⚠ TWO QUERY SHAPES, per D-062 R3 / D-063 R5. `--terms 2` is production today
 * (`CORPUS_QUERY_MAX_TERMS`, kept BY LENGTH — P-007/WI-7237). `--terms 5` is the
 * shape P-018 would produce. Under AND, more terms means FEWER documents; under
 * coverage-grading it means more evidence. The delta BETWEEN the two shapes is
 * the coupling D-062 R3 asserts, and it is the headline of this run.
 *
 * READ-ONLY. Touches no bench schema, seeds nothing, writes nothing.
 */
import { getOrgPg } from '@papercusp/db-org';
import { runHybridSearch, type Embedder } from '@papercusp/search';

import { SEARCH_SOURCES } from '../../agent-tools/search/sources';
import { buildQueryEmbedder } from '../../agent-tools/search/embedder';
import {
  CORPUS_BUDGET_CHARS,
  CORPUS_MAX_ITEMS,
  corpusQueryText,
  selectCorpusLines,
  type CorpusHit,
} from '../corpus-recall';
import { corpusRecallTimeoutMs, recallCorpusContext } from '../corpus-recall-io';

const CORPUS_SOURCE_NAMES = ['session_turn', 'work_item'] as const;

type LexicalMode = 'and' | 'coverage-graded';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERIES = Number(argValue('--queries') ?? 120);
const TERM_SHAPES = (argValue('--terms') ?? '2,5')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const SEED = argValue('--seed') ?? '17';
const WORKSPACE = argValue('--workspace') ?? 'papercusp-workspace';
const USE_EMBEDDER = process.argv.includes('--hybrid');

/** One arm's result for one query. */
interface ArmRun {
  /** Fused candidate keys, in rank order (the raw over-fetch pool). */
  candidates: string[];
  /** Keys of the lines the leg would actually ADMIT, in order. */
  admitted: string[];
  /** Why the leg refused each non-admitted hit — the mechanism behind any loss. */
  drops: Record<string, number>;
  ms: number;
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function runArm(
  sql: ReturnType<typeof getOrgPg>['sql'],
  query: string,
  mode: LexicalMode,
  embedder: Embedder | null,
): Promise<ArmRun> {
  const sources = SEARCH_SOURCES.filter((s) =>
    (CORPUS_SOURCE_NAMES as readonly string[]).includes(s.name),
  );
  const t0 = Date.now();
  // Deliberately the SAME context `recallCorpusContext` builds, differing only
  // in `lexicalMode` — so this measures the shipped leg, not a lookalike.
  const fused = await runHybridSearch(sources, {
    sql,
    query,
    workspaceId: WORKSPACE,
    scopeFilter: null,
    limit: Math.max(CORPUS_MAX_ITEMS * 4, 8),
    mode: 'hybrid',
    embedder,
    embedTimeoutMs: 2_000,
    deferHighlight: true,
    lexicalMode: mode,
  });
  const ms = Date.now() - t0;

  const hits: CorpusHit[] = fused.results.map((r) => ({
    source: r.source,
    sourceId: r.source_id,
    scope: r.scope ?? null,
    excerpt: r.excerpt ?? '',
    highlight: r.highlight ?? null,
    score: r.score,
    ts: r.ts ?? null,
    rankers: r.rankers,
  }));

  const { lines, dropped } = selectCorpusLines({
    hits,
    queryText: query,
    excludeSessionId: null,
    harnessSlugs: [],
    maxItems: CORPUS_MAX_ITEMS,
    budgetChars: CORPUS_BUDGET_CHARS,
  });

  const drops: Record<string, number> = {};
  for (const d of dropped) drops[d.reason] = (drops[d.reason] ?? 0) + 1;

  return {
    candidates: hits.map((h) => `${h.source}:${h.sourceId}`),
    admitted: lines.map((l) => JSON.stringify(l.handle)),
    drops,
    ms,
  };
}

interface ShapeReport {
  maxTerms: number;
  n: number;
  nullControlViolations: number;
  /** Pool-level: a control CANDIDATE missing from the treatment's top-`limit`. */
  containmentViolations: number;
  /** Final: a control ADMITTED line missing from the treatment's admitted set.
   *  This is the one that decides regression — the pool is over-fetched and
   *  truncated, the admitted set is what the agent actually sees. */
  admittedContainmentViolations: number;
  lostAdmitted: number;
  /** 0-based position, in the CONTROL's admitted order, of each lost line.
   *  Losing a tail line to a higher-coverage newcomer is a swap; losing the
   *  control's top-1 is the regression that actually matters. */
  lostAtRank: number[];
  /** Queries where `corpusQueryText(text, maxTerms)` is byte-identical to the
   *  2-term production shape — i.e. where this shape is not a shape at all. */
  sameAsProductionShape: number;
  controlZero: number;
  treatZero: number;
  controlUnderfilled: number;
  controlAdmitted: number[];
  treatAdmitted: number[];
  newAdmitted: number[];
  top1Changed: number;
  top1Comparable: number;
  controlMs: number[];
  treatMs: number[];
  controlDrops: Record<string, number>;
  treatDrops: Record<string, number>;
}

async function measureShape(
  sql: ReturnType<typeof getOrgPg>['sql'],
  texts: string[],
  maxTerms: number,
  embedder: Embedder | null,
): Promise<ShapeReport> {
  const r: ShapeReport = {
    maxTerms,
    n: 0,
    nullControlViolations: 0,
    containmentViolations: 0,
    admittedContainmentViolations: 0,
    lostAdmitted: 0,
    lostAtRank: [],
    sameAsProductionShape: 0,
    controlZero: 0,
    treatZero: 0,
    controlUnderfilled: 0,
    controlAdmitted: [],
    treatAdmitted: [],
    newAdmitted: [],
    top1Changed: 0,
    top1Comparable: 0,
    controlMs: [],
    treatMs: [],
    controlDrops: {},
    treatDrops: {},
  };

  for (const text of texts) {
    const q = corpusQueryText(text, maxTerms);
    if (!q) continue;
    r.n += 1;
    if (q === corpusQueryText(text, 2)) r.sameAsProductionShape += 1;

    // NULL CONTROL FIRST (D-051/D-053): the same arm, twice, independently.
    const controlA = await runArm(sql, q, 'and', embedder);
    const controlB = await runArm(sql, q, 'and', embedder);
    if (
      controlA.candidates.join('|') !== controlB.candidates.join('|') ||
      controlA.admitted.join('|') !== controlB.admitted.join('|')
    ) {
      r.nullControlViolations += 1;
    }

    const treat = await runArm(sql, q, 'coverage-graded', embedder);

    // CONTAINMENT, at BOTH levels — they answer different questions and the
    // pool-level one is EXPECTED to fail: `graded ⊇ and` is a per-source SQL
    // property, but the leg merges two sources and truncates to `limit`, so the
    // treatment's extra rows can push a control candidate out of the pool. Only
    // the ADMITTED level says whether the agent lost something it used to see.
    const treatSet = new Set(treat.candidates);
    if (controlA.candidates.some((k) => !treatSet.has(k))) r.containmentViolations += 1;
    const treatAdmittedSet = new Set(treat.admitted);
    const lost = controlA.admitted.filter((k) => !treatAdmittedSet.has(k));
    if (lost.length > 0) r.admittedContainmentViolations += 1;
    r.lostAdmitted += lost.length;
    for (const k of lost) r.lostAtRank.push(controlA.admitted.indexOf(k));

    if (controlA.candidates.length === 0) r.controlZero += 1;
    if (treat.candidates.length === 0) r.treatZero += 1;
    if (controlA.admitted.length < CORPUS_MAX_ITEMS) r.controlUnderfilled += 1;

    r.controlAdmitted.push(controlA.admitted.length);
    r.treatAdmitted.push(treat.admitted.length);
    const admittedSet = new Set(controlA.admitted);
    r.newAdmitted.push(treat.admitted.filter((k) => !admittedSet.has(k)).length);

    // DISPLACEMENT — only meaningful when the control had a top-1 at all.
    if (controlA.admitted.length > 0 && treat.admitted.length > 0) {
      r.top1Comparable += 1;
      if (controlA.admitted[0] !== treat.admitted[0]) r.top1Changed += 1;
    }

    r.controlMs.push(controlA.ms);
    r.treatMs.push(treat.ms);
    for (const [k, v] of Object.entries(controlA.drops)) r.controlDrops[k] = (r.controlDrops[k] ?? 0) + v;
    for (const [k, v] of Object.entries(treat.drops)) r.treatDrops[k] = (r.treatDrops[k] ?? 0) + v;
  }

  return r;
}

function renderShape(r: ShapeReport, boundMs: number): string {
  const L: string[] = [];
  L.push(`\n### query shape: ${r.maxTerms} term(s)  —  n=${r.n}`);
  L.push('');
  L.push('| metric | control (`and`) | treatment (`coverage-graded`) |');
  L.push('|---|---|---|');
  L.push(
    `| zero-candidate queries | ${r.controlZero} (${pct(r.controlZero, r.n)}) | ${r.treatZero} (${pct(r.treatZero, r.n)}) |`,
  );
  L.push(
    `| mean ADMITTED lines (cap ${CORPUS_MAX_ITEMS}) | ${mean(r.controlAdmitted).toFixed(2)} | ${mean(r.treatAdmitted).toFixed(2)} |`,
  );
  L.push(`| latency p50 / p95 (ms) | ${quantile(r.controlMs, 0.5)} / ${quantile(r.controlMs, 0.95)} | ${quantile(r.treatMs, 0.5)} / ${quantile(r.treatMs, 0.95)} |`);
  L.push('');
  L.push(`- **NULL CONTROL violations: ${r.nullControlViolations}** ${r.nullControlViolations === 0 ? '✓ (arm isolation valid)' : '✗ RUN IS INVALID — the two identical arms disagreed'}`);
  L.push(
    `- **ADMITTED containment violations: ${r.admittedContainmentViolations}/${r.n}** (${r.lostAdmitted} line(s) lost in total) ${r.admittedContainmentViolations === 0 ? '✓ nothing the agent used to see disappeared' : '✗ THE AGENT LOST LINES — a real regression, not a pool artifact'}`,
  );
  L.push(
    `- pool-level containment violations: ${r.containmentViolations}/${r.n} — informational. \`graded ⊇ and\` is a PER-SOURCE SQL property; the leg merges 2 sources and truncates to the over-fetch \`limit\`, so the treatment's extra rows can evict a control candidate from the pool without evicting it from the admitted set.`,
  );
  L.push(
    `- control under-filled the ${CORPUS_MAX_ITEMS} slots on **${r.controlUnderfilled}/${r.n}** queries (${pct(r.controlUnderfilled, r.n)}) — in that regime the extra graded lines displace nothing`,
  );
  L.push(`- mean NEW admitted lines per query: **${mean(r.newAdmitted).toFixed(2)}**`);
  const lostTop1 = r.lostAtRank.filter((i) => i === 0).length;
  L.push(
    `- of the ${r.lostAdmitted} lost line(s), **${lostTop1} were the control's TOP-1**; the rest sat at ranks [${r.lostAtRank.filter((i) => i > 0).sort((a, b) => a - b).join(',') || '—'}]. A tail line swapped for a higher-coverage newcomer is a SWAP; a lost top-1 is the regression that matters.`,
  );
  if (r.maxTerms !== 2) {
    L.push(
      `- ⚠ **${r.sameAsProductionShape}/${r.n}** of these queries are BYTE-IDENTICAL to the 2-term production shape (${pct(r.sameAsProductionShape, r.n)}) — \`corpusQueryText\`'s id-token short-circuit (P-007/WI-7237) ignores \`maxTerms\` entirely on those turns, so this "shape" is partly not a shape.`,
    );
  }
  L.push(
    `- top-1 changed on **${r.top1Changed}/${r.top1Comparable}** comparable queries (${pct(r.top1Changed, r.top1Comparable)}) — the intra-tier reordering channel`,
  );
  const fmtDrops = (d: Record<string, number>): string =>
    Object.entries(d)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') || 'none';
  L.push(`- drop reasons — control: ${fmtDrops(r.controlDrops)}`);
  L.push(`- drop reasons — treatment: ${fmtDrops(r.treatDrops)}`);
  const worst = Math.max(...r.treatMs, 0);
  L.push(
    `- treatment worst-case ${worst}ms against the ${boundMs}ms whole-leg bound → ${worst < boundMs ? '✓ inside' : '✗ OVER BUDGET'}`,
  );
  return L.join('\n');
}

/**
 * The SHIPPED leg (P-017 cascade) vs the leg as it stood BEFORE the change.
 *
 * The "before" is `lexicalMode: 'and'` — stage 1 alone — which is exactly what
 * `recallCorpusContext` used to do. The acceptance bar is absolute rather than
 * statistical: the cascade is additive BY CONSTRUCTION, so a SINGLE lost line
 * falsifies the implementation, and this is the run that would catch it.
 */
async function measureCascade(
  sql: ReturnType<typeof getOrgPg>['sql'],
  texts: string[],
  embedder: Embedder | null,
): Promise<string> {
  let n = 0;
  let lost = 0;
  let lostQueries = 0;
  let gained = 0;
  let beforeZero = 0;
  let afterZero = 0;
  const beforeCount: number[] = [];
  const afterCount: number[] = [];
  const afterMs: number[] = [];

  for (const text of texts) {
    const q = corpusQueryText(text);
    if (!q) continue;
    n += 1;

    const before = await runArm(sql, q, 'and', embedder);
    const t0 = Date.now();
    const after = await recallCorpusContext({
      queryText: text,
      workspaceId: WORKSPACE,
      skipFlagCheck: true,
    });
    afterMs.push(Date.now() - t0);

    const afterKeys = after.lines.map((l) => JSON.stringify(l.handle));
    const afterSet = new Set(afterKeys);
    const missing = before.admitted.filter((k) => !afterSet.has(k));
    if (missing.length > 0) {
      lostQueries += 1;
      lost += missing.length;
    }
    const beforeSet = new Set(before.admitted);
    gained += afterKeys.filter((k) => !beforeSet.has(k)).length;

    if (before.admitted.length === 0) beforeZero += 1;
    if (afterKeys.length === 0) afterZero += 1;
    beforeCount.push(before.admitted.length);
    afterCount.push(afterKeys.length);
  }

  const L: string[] = [];
  L.push(`\n## SHIPPED LEG — cascade vs the pre-P-017 leg (production query shape)  —  n=${n}`);
  L.push('');
  L.push('| metric | before (`and` only) | after (cascade) |');
  L.push('|---|---|---|');
  L.push(`| empty pointer sections | ${beforeZero} (${pct(beforeZero, n)}) | ${afterZero} (${pct(afterZero, n)}) |`);
  L.push(`| mean admitted lines | ${mean(beforeCount).toFixed(2)} | ${mean(afterCount).toFixed(2)} |`);
  L.push(`| leg latency p50 / p95 (ms) | — | ${quantile(afterMs, 0.5)} / ${quantile(afterMs, 0.95)} |`);
  L.push('');
  L.push(
    `- **LINES LOST: ${lost} across ${lostQueries}/${n} queries** ${lost === 0 ? '✓ ADDITIVE — nothing the agent used to see disappeared' : '✗ THE CASCADE IS NOT ADDITIVE — a single loss falsifies it'}`,
  );
  L.push(`- lines GAINED: ${gained} (mean ${(gained / Math.max(n, 1)).toFixed(2)}/query)`);
  const worst = Math.max(...afterMs, 0);
  L.push(
    `- worst-case whole-leg latency ${worst}ms against the ${corpusRecallTimeoutMs()}ms bound → ${worst < corpusRecallTimeoutMs() ? '✓ inside' : '✗ OVER BUDGET'}`,
  );
  return L.join('\n');
}

async function main(): Promise<void> {
  const { sql } = getOrgPg();
  const bound = corpusRecallTimeoutMs();

  // Real turn-start envelopes: the production query distribution, sampled
  // deterministically so a re-run is comparable.
  const rows = (await sql`
    SELECT text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
       AND speaker = 'user'
       AND length(text) BETWEEN 200 AND 8000
     ORDER BY md5(source_kind || session_id || turn_idx::text || ${SEED})
     LIMIT ${QUERIES}
  `) as unknown as Array<{ text: string }>;

  const texts = rows.map((r) => r.text);
  console.log(`sampled ${texts.length} real user turns (seed=${SEED}, workspace=${WORKSPACE})`);

  let embedder: Embedder | null = null;
  if (USE_EMBEDDER) {
    const inner = await buildQueryEmbedder({ acquireBudgetMs: 5_000 });
    if (inner) {
      // Memoise: the query vector depends only on the text, never on the arm, so
      // without this the null control alone would triple the embed bill and add
      // its own latency noise to the arm comparison.
      const cache = new Map<string, Promise<number[]>>();
      embedder = (t: string) => {
        const hit = cache.get(t);
        if (hit) return hit;
        const p = inner(t);
        cache.set(t, p);
        return p;
      };
    }
  }

  const out: string[] = [];
  out.push('# P-017 — corpus-leg lexical acceptance (D-063 instrument)');
  out.push('');
  out.push(
    `arms: \`and\` (control) vs \`coverage-graded\` (treatment) · ranker: ${embedder ? 'hybrid (bm25 + embeddings, RRF)' : 'BM25-only (no embedder — isolates the change)'} · whole-leg bound ${bound}ms`,
  );

  for (const shape of TERM_SHAPES) {
    const r = await measureShape(sql, texts, shape, embedder);
    out.push(renderShape(r, bound));
  }

  out.push(await measureCascade(sql, texts, embedder));

  out.push('');
  out.push(
    '⚠ No MRR: a gold set whose query is derived from the gold document cannot show a recall win (D-063 R4). Whether the recovered documents are USEFUL is not settled here.',
  );

  console.log('\n' + out.join('\n') + '\n');
  process.exit(0);
}

await main();
