/**
 * P-031 step 1 — embed the prose corpus ONCE with gemma@768 and cache to disk.
 *
 *   ./node_modules/.bin/tsx packages/operator-core/lib/memory/bench/fusion-score-aware-cache.ts
 *
 * The score-aware-fusion evaluation replays many fusion configs over the SAME
 * vectors; re-embedding 2029 docs per config would cost ~10.5 min each. This
 * writes one cache the evaluator memory-maps instead.
 *
 * Deliberately the SAME embedder construction the 2026-08-03 bake-off used
 * (`buildGemmaEmbedder`, asymmetric doc/query prompts, MRL width 768) so the
 * fusion numbers sit on the same measurement basis as D-012's leaderboard.
 */
import fs from 'node:fs';

import { buildGemmaEmbedder } from '@papercusp/memory';

import { loadProseCorpusFixture } from './prose-corpus';
import { loadProseGoldSetFixture } from './prose-gold-set';

const OUT = process.env.FUSION_CACHE_PATH ?? '/tmp/p031-gemma768-prose-vectors.json';

function l2norm(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

const log = (m: string): void => console.log(new Date().toISOString().slice(11, 19), m);

const corpus = loadProseCorpusFixture();
const gold = loadProseGoldSetFixture();
log(`corpus=${corpus.length} docs, gold=${gold.queries.length} queries → ${OUT}`);

const docEmbed = buildGemmaEmbedder({ kind: 'document', dims: 768 });
const queryEmbed = buildGemmaEmbedder({ kind: 'query', dims: 768 });

const docVecs: number[][] = [];
const t0 = Date.now();
for (let i = 0; i < corpus.length; i++) {
  docVecs.push(l2norm(await docEmbed(corpus[i]!.text)));
  if ((i + 1) % 100 === 0) log(`  [doc] ${i + 1}/${corpus.length}`);
}
log(`docs embedded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const queryVecs: number[][] = [];
for (let i = 0; i < gold.queries.length; i++) {
  queryVecs.push(l2norm(await queryEmbed(gold.queries[i]!.query)));
}
log(`queries embedded (${gold.queries.length})`);

fs.writeFileSync(
  OUT,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: 'gemma@768',
    corpusVersion: gold.corpusVersion,
    goldVersion: gold.version,
    corpusKeys: corpus.map((e) => e.key),
    corpusTexts: corpus.map((e) => e.text),
    docVecs,
    queryVecs,
  }),
  'utf8',
);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
process.exit(0);
