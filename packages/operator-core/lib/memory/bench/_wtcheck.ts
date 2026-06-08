// TEMP — delete after. Network-free: does the hybrid write-through drop lexical
// projections under concurrency? Fake cosine yields (await) to force interleaving.
import { ClaudeFileMemoryBackend, HybridBackend, type MemoryBackend } from '@papercusp/memory';
import { seedCorpus } from '@papercusp/memory/bench';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCorpusFixture } from './corpus';

const fakeCosine = (): MemoryBackend => ({
  name: 'fake', available: async () => ({ ok: true }),
  remember: async () => { await Promise.resolve(); await Promise.resolve(); return { ids: ['c'] }; }, // yields
  search: async () => [], list: async () => [], get: async () => null, forget: async () => {}, update: async () => {},
});

function countMd(dir: string): number {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
}

async function main() {
  const corpus = loadCorpusFixture();
  // distinct slugs in the corpus (the max possible distinct topic files)
  for (const conc of [1, 6, 12]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wt-${conc}-`));
    const lexical = new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true });
    const hy = new HybridBackend(lexical, fakeCosine());
    await seedCorpus(hy, corpus, { scope: 'bench', verbatim: true, concurrency: conc });
    console.log(`concurrency ${String(conc).padStart(2)} → ${countMd(dir)} topic files (corpus ${corpus.length})`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
