// TEMP experiment (answers "why not 0.99 on exact-id") — delete after use.
// Sweeps lexWeight × RRF-k to find the exact-id ceiling + the paraphrase cost.
import { ClaudeFileMemoryBackend, Mem0Backend, HybridBackend } from '@papercusp/memory';
import { seedCorpus, runGoldSet } from '@papercusp/memory/bench';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchPgClient, dropBenchSchema, ensureBenchSchema, setupBenchMemoryHost } from './bench-host';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';

interface Cfg { label: string; k: number; lexWeight: number; minScore?: number }
const CONFIGS: Cfg[] = [
  { label: 'k60 w1  (shipped, unfloored)', k: 60, lexWeight: 1 },
  { label: 'k60 w2  (unfloored)', k: 60, lexWeight: 2 },
  { label: 'k60 w4  (unfloored)', k: 60, lexWeight: 4 },
  { label: 'k60 w8  (unfloored)', k: 60, lexWeight: 8 },
  { label: 'k10 w1  (unfloored)', k: 10, lexWeight: 1 },
  { label: 'k10 w4  (unfloored)', k: 10, lexWeight: 4 },
  { label: 'k5  w8  (unfloored)', k: 5, lexWeight: 8 },
  // best-looking weight, but floored at the push value — does FP stay sane?
  { label: 'k60 w4  @floor0.45', k: 60, lexWeight: 4, minScore: 0.45 },
];
const log = (m: string) => console.log(new Date().toISOString().slice(11, 19), m);

async function main() {
  setupBenchMemoryHost();
  const pg = await benchPgClient();
  await ensureBenchSchema(pg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwexp-'));
  const lexical = new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true });
  const cosine = new Mem0Backend();
  const corpus = loadCorpusFixture();
  const gold = loadGoldSetFixture().queries;
  try {
    log(`seeding ${corpus.length}…`);
    await seedCorpus(new HybridBackend(lexical, cosine), corpus, { scope: 'bench', verbatim: true, concurrency: 8 });
    console.log('\n| config | exact-id MRR | paraphrase MRR | session MRR | overall MRR | FP@5 |');
    console.log('| --- | --- | --- | --- | --- | --- |');
    for (const c of CONFIGS) {
      const hy = new HybridBackend(lexical, cosine, { fusionMode: 'floored-union', minLexScore: 0.3, rrfK: c.k, lexWeight: c.lexWeight });
      const res = await runGoldSet(hy, gold, { scope: 'bench', limit: 10, ...(c.minScore ? { minScore: c.minScore } : {}) });
      const exact = res.byClass['exact-identifier']?.mrr ?? 0;
      const para = res.byClass['lexical-gap']?.mrr ?? 0;
      const sess = res.byClass['session-start-intent']?.mrr ?? 0;
      const fp = res.byClass['hard-negative']?.fpAt5 ?? 0;
      console.log(`| ${c.label} | ${exact.toFixed(2)} | ${para.toFixed(2)} | ${sess.toFixed(2)} | ${res.overall.mrr.toFixed(2)} | ${(fp * 100).toFixed(0)}% |`);
    }
    console.log('\nreference: claude-file alone exact-id 0.99 / paraphrase 0.43; mem0 alone 0.87 / 0.81');
  } finally {
    await dropBenchSchema(pg); await pg.end(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
