/**
 * Corpus loading + deterministic sampling for the equivalence harness
 * (plan `bash-to-tool-substitution-2026-07-26`, P-004).
 *
 * The raw corpus is a JSONL extract of every `Bash` tool_use block from the su
 * session transcripts (`{sid, ts, cmd, desc, bg}` per line). It is large
 * (~24k calls / 11MB) and lives outside the repo, so the TEST never reads it:
 * `buildFixture` freezes a small, deterministic, human-auditable sample into
 * `fixtures/*.sample.json`, and that committed file is the evidence a verdict
 * cites.
 *
 * WHY FREEZE RATHER THAN RE-EXTRACT: transcripts roll off, so re-extracting at
 * test time would make a verdict silently change meaning as history ages —
 * and would make the test depend on a 9M-line scan. A frozen sample is
 * reviewable in a diff, which is what makes "cite your sample" real.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomize } from './atomize';
import type { SampledCommand, SubstitutionPair } from './types';

/** One line of the audit extract. */
interface RawCall {
  sid: string;
  ts: string;
  cmd: string;
}

/** Where the committed samples live. */
export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Read one pair's frozen sample. Throws if the fixture is missing — a pair
 *  without evidence must never silently audit as `unaudited`. */
export function loadFixture(pairId: string): CorpusFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${pairId}.sample.json`), 'utf8')) as CorpusFixture;
}

/** Pair every given pair with its committed sample. */
export function loadPairFixtures(pairs: SubstitutionPair[]): Array<{ pair: SubstitutionPair; fixture: CorpusFixture }> {
  return pairs.map((pair) => ({ pair, fixture: loadFixture(pair.id) }));
}

/** A frozen fixture file: the sample plus the population it was drawn from. */
export interface CorpusFixture {
  /** What this sample is for — the plan item that produced it. */
  evidenceRef: string;
  /** When the corpus was extracted (the 7d audit window end). */
  extractedAt: string;
  /** Total atoms in the full corpus, for baseline math. */
  totalAtoms: number;
  /** Total distinct sessions in the full corpus. */
  totalSessions: number;
  sample: SampledCommand[];
}

/**
 * Read the raw JSONL extract and flatten it to normalised atoms.
 * Malformed lines are skipped rather than throwing — the extract is machine
 * generated but transcripts contain arbitrary user text.
 */
export function loadCorpusAtoms(jsonlPath: string): SampledCommand[] {
  const out: SampledCommand[] = [];
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let call: RawCall;
    try {
      call = JSON.parse(line) as RawCall;
    } catch {
      continue;
    }
    if (typeof call?.cmd !== 'string') continue;
    for (const atom of atomize(call.cmd)) {
      out.push({ sid: call.sid, ts: call.ts, atom });
    }
  }
  return out;
}

/**
 * Deterministically sample up to `size` atoms, preferring DISTINCT commands and
 * spreading across the population.
 *
 * Distinctness matters more than proportionality here: the harness is probing a
 * tool's capability envelope, and fifty identical `git status` atoms test it
 * exactly as well as one. Deduplicating first means a 20-command sample probes
 * 20 genuinely different shapes — which is what actually finds the gap.
 *
 * Deterministic (an even stride over a sorted list, no RNG) so regenerating the
 * fixture from the same corpus reproduces it byte-for-byte, and a fixture diff
 * therefore means the CORPUS changed, not the sampler.
 */
export function sampleDistinct(atoms: SampledCommand[], size: number): SampledCommand[] {
  const byAtom = new Map<string, SampledCommand>();
  for (const entry of atoms) {
    if (!byAtom.has(entry.atom)) byAtom.set(entry.atom, entry);
  }
  const distinct = [...byAtom.values()].sort((a, b) => (a.atom < b.atom ? -1 : a.atom > b.atom ? 1 : 0));
  if (distinct.length <= size) return distinct;

  const stride = distinct.length / size;
  const picked: SampledCommand[] = [];
  for (let i = 0; i < size; i += 1) {
    picked.push(distinct[Math.floor(i * stride)]);
  }
  return picked;
}

/**
 * Build a fixture for one pattern from the raw corpus.
 *
 * Regenerate with (from the repo root, corpus present):
 *   npx tsx -e "import('./packages/operator-core/lib/bash-substitution/corpus').then(m => …)"
 * The exact invocation lives in the fixture's own `evidenceRef`.
 */
export function buildFixture(opts: {
  jsonlPath: string;
  pattern: RegExp;
  size: number;
  evidenceRef: string;
  extractedAt: string;
}): CorpusFixture {
  const all = loadCorpusAtoms(opts.jsonlPath);
  const pattern = new RegExp(opts.pattern.source, opts.pattern.flags.replace(/g/g, ''));
  const matching = all.filter((entry) => pattern.test(entry.atom));
  return {
    evidenceRef: opts.evidenceRef,
    extractedAt: opts.extractedAt,
    totalAtoms: matching.length,
    totalSessions: new Set(matching.map((entry) => entry.sid)).size,
    sample: sampleDistinct(matching, opts.size),
  };
}
