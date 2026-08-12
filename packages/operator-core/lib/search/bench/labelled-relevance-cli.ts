/**
 * labelled-relevance-cli.ts — run P-038's labelled relevance pass against the
 * LIVE hybrid stack (plan semantic-search-fingerprint-coverage-2026-08-03,
 * D-079 / WI-37638).
 *
 * Samples REAL mid/long queries from `tool_invocations` per D-079's strata,
 * runs each through the same engine path `search:semantic` uses, judges the
 * top-k with the frozen `search-relevance.v1` rubric, and scores each ranking
 * with `evaluateRelevance` from `@papercusp/search-core`.
 *
 * READ-ONLY against PG. It writes one JSON artifact to disk and nothing else.
 *
 * ⚠ COSTS MONEY: ~1,500 judge calls at 150 queries x k=10 ≈ $12-15. Always
 * `--dry-run` first — it does the sampling and the retrieval, prints what would
 * be judged, and spends nothing.
 *
 *   npx tsx packages/operator-core/lib/search/bench/labelled-relevance-cli.ts --dry-run
 *   npx tsx ... --queries 150 --k 10 --seed p038-labelled-v1
 *   npx tsx ... --secondary            # the memory/recipes strata, REPORTED SEPARATELY
 */
import fs from 'node:fs';

import { llmCall } from '../../llm-testing/llm-client';
import { judgeRelevance } from './judge-agreement';
import {
  DOC_CHARS,
  formatLabelledReport,
  runLabelledPass,
  type QueryOutcome,
  type RankedHit,
  type RetrievalResult,
} from './labelled-relevance';
import {
  allocateProportional,
  queryCensusSql,
  querySampleSql,
  SEARCH_STACK_TOOLS,
  SECONDARY_STRATUM_TOOLS,
  type QueryStratum,
  type SampledQuery,
} from './query-sample';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * The text the judge scores.
 *
 * ⚠ This is the RESULT AS PRESENTED — the 200-char excerpt plus the
 * match-centred `ts_headline` — not the full document. `SearchHit` carries no
 * body, and re-fetching one per source would mean writing per-source SQL, i.e.
 * forking the source registry to run a bench against it.
 *
 * It is also arguably the right thing to measure: the rubric asks whether a
 * person issuing this query would be satisfied to find this among the results,
 * and this is what they would actually see. But it biases in ONE direction and
 * the report must say so — a document whose relevance only becomes visible
 * deeper in its body can be under-scored here. See the caveat emitted below.
 */
function judgedText(hit: { excerpt: string; highlight: string; source: string }): string {
  const marked = hit.highlight.replace(/<\/?mark>/g, '');
  const parts = [hit.excerpt.trim(), marked.trim()].filter(Boolean);
  const deduped = parts[1] && parts[0]?.includes(parts[1]) ? [parts[0]] : parts;
  return `[${hit.source}] ${deduped.join('\n…\n')}`.slice(0, DOC_CHARS);
}

async function main(): Promise<void> {
  const wanted = argInt('--queries', 150);
  const k = argInt('--k', 10);
  const seed = argValue('--seed') ?? 'p038-labelled-v1';
  const dryRun = process.argv.includes('--dry-run');
  const secondary = process.argv.includes('--secondary');
  // WI-37638 follow-up: the CONTROL ARM for Stage B. The v1 pass applied
  // `rerankProseHits` to every stratum uniformly, which measured a pipeline the
  // live tools do not all run — `docs:search`, `plans:search` and
  // `work_items:search` have NO rerank stage at all. Without an off-arm the v1
  // numbers cannot say what Stage B is worth on any surface.
  //
  // The control is the fused RRF order truncated at k — deliberately NOT a
  // second retrieval path: it is byte-identical to what `rerankProseHits`
  // already returns through its own fail-safe passthrough, so the arms differ
  // in exactly one thing. Over-fetch stays at `rerankCandidateCount(k)` in BOTH
  // arms so the fused pool being cut is the same pool.
  const noRerank = process.argv.includes('--no-rerank');
  const tools = secondary ? SECONDARY_STRATUM_TOOLS : SEARCH_STACK_TOOLS;

  const [{ runHybridSearch }, { SEARCH_SOURCES }, { buildQueryEmbedder }, { activeWorkspaceId }, { getOrgPg }] =
    await Promise.all([
      import('@papercusp/search'),
      import('../../agent-tools/search/sources'),
      import('../../agent-tools/search/embedder'),
      import('../../workspace-registry'),
      import('@papercusp/db-org'),
    ]);
  const { rerankProseHits, rerankCandidateCount } = await import('../../agent-tools/search/rerank');

  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();

  // ---- Sample -------------------------------------------------------------
  // Re-measure the census rather than hard-coding D-079's table: it is a
  // property of a growing telemetry table, and an allocation computed from a
  // stale denominator mis-weights every stratum.
  const census = await sql.unsafe<QueryStratum[]>(queryCensusSql(workspaceId, tools));
  // `--tools a,b` RESTRICTS the census to named strata before allocation.
  //
  // Why this exists: allocation is PROPORTIONAL to each stratum's distinct-query
  // count, which is correct for a headline number but makes a small stratum
  // unstudiable. Measured 2026-08-12 at --queries 40 the census was
  // sessions=16 fulltext=11 work_items=8 docs=4 plans=1 semantic=0 — so the two
  // strata that carry NO rerank stage live (docs, plans), i.e. exactly the ones
  // an adoption decision is about, drew n=4 and n=1. No amount of total N fixes
  // that ratio; the small strata stay small.
  //
  // Restricting the census first makes `--queries` spend entirely WITHIN the
  // named strata, so `--tools docs:search,plans:search --queries 30` is a real
  // 15/15 study instead of 4/1 buried in a run dominated by other surfaces.
  // Proportional allocation is unchanged for every existing invocation.
  const onlyTools = (argValue('--tools') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  let censusForAlloc = census;
  if (onlyTools.length) {
    censusForAlloc = census.filter((c) => onlyTools.includes(c.tool));
    const missing = onlyTools.filter((t) => !census.some((c) => c.tool === t));
    if (censusForAlloc.length === 0) {
      // Fail loudly. A silently-empty restriction would sample nothing and the
      // pass would report a clean, confident zero — the failure shape this
      // bench has already been bitten by twice.
      console.error(
        `[labelled] --tools matched NO stratum in the census. asked=${JSON.stringify(onlyTools)} ` +
          `available=${JSON.stringify(census.map((c) => c.tool))}`,
      );
      process.exitCode = 1;
      return;
    }
    if (missing.length) console.warn(`[labelled] --tools: no census rows for ${JSON.stringify(missing)} — ignoring those`);
    console.log(`[labelled] --tools restriction ACTIVE: ${censusForAlloc.map((c) => c.tool).join(',')}`);
  }
  const allocation = allocateProportional(censusForAlloc, wanted);
  console.log(
    `[labelled] census: ` +
      allocation.map((a) => `${a.tool}=${a.want}/${a.distinct}`).join(' ') +
      ` (total ${allocation.reduce((s, a) => s + a.want, 0)})`,
  );

  const queries: SampledQuery[] = [];
  for (const a of allocation) {
    if (a.want === 0) continue;
    queries.push(...(await sql.unsafe<SampledQuery[]>(querySampleSql(workspaceId, a.tool, a.want, seed))));
  }
  if (queries.length === 0) {
    console.error('[labelled] nothing to measure — the sample is empty');
    process.exitCode = 1;
    return;
  }

  // ---- Retrieval ----------------------------------------------------------
  // ⚠ THE DEGRADE TRAP. A null embedder silently degrades the engine to
  // lexical-only. This pass would then rank with keywords and report it as
  // hybrid — the same class D-031 caught from the other side. It is not
  // guarded per query only: acquiring it is attempted ONCE here, and a failure
  // aborts rather than measuring 150 queries of the wrong system.
  const embedder = await buildQueryEmbedder({ acquireBudgetMs: 30_000 }).catch(() => null);
  if (!embedder && !dryRun) {
    console.error(
      `[labelled] REFUSING TO RUN: the query embedder is unavailable, so the engine would degrade ` +
        `to lexical-only. That measures a DIFFERENT system than the hybrid stack this pass is ` +
        `about, and would spend ~$12-15 to do it. Bring the embed sidecar up and re-run.`,
    );
    process.exitCode = 1;
    return;
  }

  // Every registered source, not `search:semantic`'s 4-surface no-scope
  // default: the sampled queries were issued to six different search tools
  // (docs, work-items, plans, sessions, …), and restricting the corpus to four
  // surfaces would make a large share of them structurally unanswerable and
  // then score that as poor relevance.
  const sources = SEARCH_SOURCES;

  const retrieve = async (query: string): Promise<RetrievalResult> => {
    const startedAt = Date.now();
    const { results, legs } = await runHybridSearch(sources, {
      sql,
      query,
      workspaceId,
      scopeFilter: null,
      // Stage B over-fetch, exactly as the live tool sizes it.
      limit: rerankCandidateCount(k),
      mode: 'hybrid' as const,
      embedder,
      embedTimeoutMs: 30_000,
      signal: new AbortController().signal,
      deferHighlight: false,
    });

    // `attempted` is necessary-not-sufficient (WI-37670): a call that resolved
    // an engine but scored zero rows returns the retrieval order, which is
    // byte-identical to no reranking at all. Require BOTH.
    let rerankApplied = false;
    const reranked = noRerank
      ? results.slice(0, k)
      : await rerankProseHits(query, results, k, {
          onOutcome: (o) => {
            rerankApplied = o.attempted && (o.scored ?? 0) > 0;
          },
        });

    return {
      hits: reranked.map(
        (h, i): RankedHit => ({
          docId: `${h.source}:${h.source_id}`,
          docText: judgedText(h),
          rank: i + 1,
          source: h.source,
        }),
      ),
      degraded: Boolean(legs?.degraded),
      degradeWarning: legs?.warning ?? null,
      rerankApplied,
      latencyMs: Date.now() - startedAt,
    };
  };

  // ---- Dry run ------------------------------------------------------------
  if (dryRun) {
    console.log(`[labelled] --dry-run: sampled ${queries.length} queries; retrieving 3 of them.\n`);
    for (const q of queries.slice(0, 3)) {
      const r = await retrieve(q.query);
      console.log(
        `--- ${q.tool} (${q.terms} terms) degraded=${r.degraded} rerank=${r.rerankApplied} ` +
          `hits=${r.hits.length} ${r.latencyMs}ms\nquery: ${q.query}`,
      );
      for (const h of r.hits.slice(0, 3)) {
        console.log(`   #${h.rank} ${h.docId}: ${h.docText.slice(0, 160).replace(/\s+/g, ' ')}…`);
      }
    }
    console.log(
      `\n[labelled] would judge ~${queries.length * k} pairs. No judge calls made, nothing spent.`,
    );
    return;
  }

  // ---- Judge + score ------------------------------------------------------
  const out = argValue('--out') ?? `/tmp/claude-1000/p038-labelled-${Date.now()}.json`;
  const rowsPath = `${out}.rows.jsonl`;
  // Persist EVERY row AS IT LANDS, not only at the end. A paid run that dies at
  // query 120 must still be worth 120 queries — and it is the per-hit rows plus
  // the judge's own rationale, never the aggregates, that adjudicate a
  // surprising number. The pilot learned this the expensive way.
  const rowStream = fs.createWriteStream(rowsPath, { flags: 'a' });

  const report = await runLabelledPass({
    queries,
    retrieve,
    judge: (input) => judgeRelevance(input, llmCall),
    k,
    judgeConcurrency: argInt('--concurrency', 4),
    sampleSeed: seed,
    log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
    onQueryDone: (o: QueryOutcome) => rowStream.write(JSON.stringify(o) + '\n'),
  });

  if (secondary) {
    report.caveats.unshift(
      `⚠ SECONDARY STRATA (${SECONDARY_STRATUM_TOOLS.join(', ')}): long agent-written INTENTS aimed at ` +
        `the memory/recipe backends, NOT queries put to the search stack. D-079 requires these be ` +
        `reported separately and NEVER pooled into the headline number.`,
    );
  }
  report.caveats.push(
    `The judge scored the RESULT AS PRESENTED (200-char excerpt + match-centred headline, ` +
      `capped at ${DOC_CHARS} chars), not the full document. This biases in one direction: a ` +
      `document whose relevance is only visible deeper in its body can be under-scored.`,
    `Corpus = every registered SearchSource (${sources.length}), not search:semantic's 4-surface ` +
      `no-scope default — the sampled queries were issued to six different search tools.`,
  );

  rowStream.end();
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\n' + formatLabelledReport(report) + '\n');
  console.log(`wrote full report: ${out}\nwrote per-query rows as they landed: ${rowsPath}`);
}

await main();
process.exit(0);
