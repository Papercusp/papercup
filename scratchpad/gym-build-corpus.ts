/**
 * P-001 — regenerate packages/operator-core/lib/gym/corpus/papercusp-real-corpus.json
 * from the probe's two measured artifacts.
 *
 * Inputs (both produced by scratchpad/gym-probe-candidates.sh + gym-capture-failing-its.sh):
 *   .gym-probe/results.jsonl     — one row per mined candidate + its discrimination verdict
 *   .gym-probe/failing-its.jsonl — which oracle requirements the rewind ACTUALLY breaks
 *
 * The admission rules live in buildDescriptorsFromProbe, NOT here, so this script
 * cannot mint a task the gate rejected: it only feeds the builder and writes the
 * result. In particular a candidate whose failing-set was never measured
 * (failingCount === -1) is simply absent from the map, and the builder drops it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDescriptorsFromProbe,
  type ProbeResultRow,
} from '../packages/operator-core/lib/gym/papercusp-descriptors';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(REPO, '..', '.gym-probe');
const SUBSTRATE = join(BASE, 'substrate');
// Overridable so the generator can be validated end-to-end against a partial
// measurement without writing a half-built corpus into the repo (git-sync
// commits the whole tree on a timer, so a scratch write here really would ship).
const OUT = process.env.GYM_CORPUS_OUT ?? join(REPO, 'packages/operator-core/lib/gym/corpus/papercusp-real-corpus.json');

const readJsonl = (p: string): any[] =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const rows = readJsonl(join(BASE, 'results.jsonl')) as ProbeResultRow[];
const measured = readJsonl(join(BASE, 'failing-its.jsonl'));

// Only a POSITIVE measurement counts. `failingCount: -1` is this pipeline's
// explicit "did not measure" marker (empty substrate, oracle absent, router
// executed nothing, parser found no FAIL lines) — the whole point of which is
// that it must never be read as "zero requirements".
const failingIts = new Map<string, readonly string[]>();
for (const m of measured) {
  if (typeof m.failingCount === 'number' && m.failingCount > 0 && Array.isArray(m.failing) && m.failing.length > 0) {
    failingIts.set(m.implPath, m.failing);
  }
}

const pinCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SUBSTRATE, encoding: 'utf8' }).trim();

// Read each oracle AT THE PIN from the object store rather than the working
// tree: the probe scripts rewind files in a clone, and a stray working-tree
// state must not leak into the spec.
const readTestSource = (testPath: string): string | null => {
  try {
    return execFileSync('git', ['show', `${pinCommit}:${testPath}`], {
      cwd: SUBSTRATE,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

const descriptors = buildDescriptorsFromProbe({ rows, pinCommit, readTestSource, failingIts });

const admitted = rows.filter((r) => r.verdict === 'admitted').length;
const unmeasured = measured.filter((m) => m.failingCount === -1);

writeFileSync(OUT, `${JSON.stringify({ pinCommit, generatedAt: new Date().toISOString(), descriptors }, null, 2)}\n`);

const specLens = descriptors.map((d) => d.spec.length);
console.log(`pin=${pinCommit}`);
console.log(`rows=${rows.length} admitted=${admitted} measured-positive=${failingIts.size} unmeasured=${unmeasured.length}`);
console.log(`descriptors=${descriptors.length}`);
console.log(`spec chars: min=${Math.min(...specLens)} max=${Math.max(...specLens)}`);
console.log(`pools: ${JSON.stringify(descriptors.reduce<Record<string, number>>((a, d) => ((a[d.pool] = (a[d.pool] ?? 0) + 1), a), {}))}`);
for (const u of unmeasured) console.log(`  UNMEASURED ${u.implPath} — ${u.why ?? 'no reason recorded'}`);
console.log(`wrote ${OUT}`);
