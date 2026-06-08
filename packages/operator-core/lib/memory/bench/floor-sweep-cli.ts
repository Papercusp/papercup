/**
 * FP-floor sweep CLI (memory-backend-improve-and-hybrid P-031 / D-006).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/floor-sweep-cli.ts \
 *     [--backend hybrid|mem0] [--floors 0,0.40,0.42,0.45,0.48] [--seed-concurrency 8]
 *
 * Seeds ONE store (default the hybrid) with the frozen real corpus, then replays
 * the frozen gold set at each candidate floor (a search-time param — no re-seed),
 * reporting FP@5 / R@10 / MRR / exact-id MRR / query-level F1 per floor and the
 * F1-max value to lock as the default. Needs PG + an embedder key (the cosine leg).
 * Artifacts land under .papercusp/bench-reports/.
 */
import fs from 'node:fs';
import path from 'node:path';

import { runFloorSweep, renderFloorSweepMarkdown, seedCorpus } from '@papercusp/memory/bench';

import { makeBackendCtx, BENCH_SCOPE, type BenchBackendName } from './run-bench';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const backend = (argValue('--backend') as BenchBackendName | undefined) ?? 'hybrid';
const floors = (argValue('--floors')?.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0))
  ?? [0, 0.4, 0.42, 0.45, 0.48];
const seedConcurrency = argValue('--seed-concurrency') ? Number.parseInt(argValue('--seed-concurrency')!, 10) : 8;
const keep = process.argv.includes('--keep');
const log = (m: string) => console.log(new Date().toISOString().slice(11, 19), m);

const corpus = loadCorpusFixture();
const gold = loadGoldSetFixture().queries;

const ctx = await makeBackendCtx(backend, keep);
try {
  log(`[${backend}] seeding ${corpus.length} corpus entries…`);
  await seedCorpus(ctx.backend, corpus, { scope: BENCH_SCOPE, verbatim: true, concurrency: seedConcurrency });

  log(`[${backend}] sweeping floors ${floors.join(', ')} over ${gold.length} gold queries…`);
  const result = await runFloorSweep(ctx.backend, gold, {
    scope: BENCH_SCOPE,
    floors,
    limit: 10,
    onProgress: (floor, done, total) => {
      if (done === total) log(`  floor ${floor.toFixed(2)} — ${total} queries replayed`);
    },
  });

  const md = renderFloorSweepMarkdown(result);
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
  const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `floor-sweep-${backend}-${stamp}.json`);
  const mdPath = path.join(dir, `floor-sweep-${backend}-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, `# FP-floor sweep — ${backend} — ${stamp}\n\ncorpus ${corpus.length} · gold ${gold.length}\n\n${md}\n`, 'utf8');

  console.log('\n' + md + '\n');
  console.log('wrote', jsonPath);
  console.log('wrote', mdPath);
} finally {
  await ctx.cleanup();
}
process.exit(0);
