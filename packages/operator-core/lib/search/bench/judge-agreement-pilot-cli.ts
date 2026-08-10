/**
 * judge-agreement-pilot-cli.ts — runs P-038's judge-agreement pilot against the
 * derived gold set (plan semantic-search-fingerprint-coverage-2026-08-03,
 * D-077 §3 / WI-37638).
 *
 * Reuses D-076's construction verbatim via `ref-expansion-gold.ts` — the gold
 * is NOT re-derived here. Read `judge-agreement.ts`'s header for what the three
 * reported numbers do and do not mean before quoting any of them.
 *
 * Needs: PG reachable + a judge LLM transport (a Claude OAuth session or
 * ANTHROPIC_API_KEY). It does NOT need the embedder — judging a (query,
 * document) pair involves no retrieval, so the embed sidecar stays untouched.
 *
 * READ-ONLY against PG: it selects. It writes nothing, anywhere.
 *
 *   npx tsx packages/operator-core/lib/search/bench/judge-agreement-pilot-cli.ts
 *   npx tsx ... --queries 12 --docs 300 --harness papercusp --self-consistency 8
 *   npx tsx ... --dry-run          # build + print the pairs, spend nothing
 */
import { getOrgPg } from '@papercusp/db-org';

import { llmCall } from '../../llm-testing/llm-client';
import {
  buildGoldQueries,
  buildPool,
  hash32,
  sampleSql,
  type GoldQuery,
  type PoolDoc,
  type SampledRow,
} from './ref-expansion-gold';
import {
  formatReport,
  runJudgeAgreement,
  type JudgedPair,
  type QueryArm,
} from './judge-agreement';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Documents are truncated so one judged pair stays a bounded prompt. */
const DOC_CHARS = 1200;

/**
 * Build the judged pairs for one query: one gold-relevant document and one
 * gold-irrelevant one, per arm.
 *
 * The negative is picked by a SEEDED hash rather than at random so a re-run
 * judges the same pairs — an agreement number that moves because the sample
 * moved is not a measurement of the judge.
 *
 * The referenced item itself is excluded from the negative pool: its presence
 * there is an artifact of sampling (it does not CITE itself), and it is the one
 * document guaranteed to be topically identical to the query, so drawing it as
 * a "negative" would manufacture a disagreement the gold never claimed.
 */
export function buildPairsForQuery(q: GoldQuery, pool: readonly PoolDoc[]): JudgedPair[] {
  const relevant = new Set(q.relevantIds);
  const posDoc = pool.find((d) => relevant.has(d.id));
  const negCandidates = pool.filter((d) => !relevant.has(d.id) && d.id !== q.ref);
  if (!posDoc || negCandidates.length === 0) return [];
  const negDoc = negCandidates[hash32(`neg:${q.ref}`) % negCandidates.length]!;

  const arms: Array<{ arm: QueryArm; query: string }> = [
    { arm: 'verbatim', query: q.text },
    { arm: 'degraded', query: q.degraded },
  ];
  return arms.flatMap(({ arm, query }) => [
    {
      pairId: `${q.ref}:${arm}:pos`,
      ref: q.ref,
      arm,
      query,
      docId: posDoc.id,
      docText: posDoc.v1Text.slice(0, DOC_CHARS),
      goldRelevant: true,
    },
    {
      pairId: `${q.ref}:${arm}:neg`,
      ref: q.ref,
      arm,
      query,
      docId: negDoc.id,
      docText: negDoc.v1Text.slice(0, DOC_CHARS),
      goldRelevant: false,
    },
  ]);
}

async function main(): Promise<void> {
  const docsWanted = argInt('--docs', 300);
  const queriesWanted = argInt('--queries', 12);
  const selfConsistencyN = argInt('--self-consistency', 8);
  const harness = argValue('--harness');
  const dryRun = process.argv.includes('--dry-run');

  const { sql } = getOrgPg();
  // Treated fraction is ~34%, so oversample candidates to land `docsWanted`.
  const rows = await sql.unsafe<SampledRow[]>(sampleSql(docsWanted * 4, docsWanted, harness));
  const pool = buildPool(rows);
  const queries = buildGoldQueries(rows, queriesWanted);
  if (pool.length === 0 || queries.length === 0) {
    console.error(
      `[judge-agreement] nothing to measure — pool=${pool.length} queries=${queries.length}`,
    );
    process.exitCode = 1;
    return;
  }

  const pairs = queries.flatMap((q) => buildPairsForQuery(q, pool));
  console.log(
    `[judge-agreement] pool=${pool.length} queries=${queries.length} pairs=${pairs.length} ` +
      `(2 arms x {pos,neg}) + ${selfConsistencyN} re-judged`,
  );

  if (dryRun) {
    for (const p of pairs.slice(0, 8)) {
      console.log(
        `\n--- ${p.pairId} gold=${p.goldRelevant ? 'RELEVANT' : 'irrelevant'}\n` +
          `query: ${p.query}\ndoc(${p.docId}): ${p.docText.slice(0, 220).replace(/\s+/g, ' ')}…`,
      );
    }
    console.log(`\n[judge-agreement] --dry-run: no judge calls made, nothing spent.`);
    return;
  }

  const report = await runJudgeAgreement({
    pairs,
    llm: llmCall,
    selfConsistencyN,
    log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
  });

  console.log('\n' + formatReport(report) + '\n');
}

await main();
process.exit(0);
