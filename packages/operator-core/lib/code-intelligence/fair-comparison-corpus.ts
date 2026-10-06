/**
 * P-017 fair-comparison CORPUS (D-011): the ~50 stratified raw-query cases every
 * code-intelligence arm answers, frozen at one commit, plus the SEED sites each
 * answer key starts from before pooled adjudication completes it.
 *
 * Why a seed and not a full key: a key written up front from one tool favours
 * that tool. The key is completed by pooling every arm's answers and ruling on
 * each new site (`poolCandidates` / `applyAdjudication` in fair-comparison.ts).
 * Seeds are the sites a human verified BEFORE any arm ran, so an arm that finds
 * nothing cannot shrink the key to nothing.
 *
 * ANSWER UNIT per intent — the one identity every arm is scored on. Engines
 * report at different granularities (GitNexus names the calling FUNCTION, LSP
 * names the call LINE); adjudication aliases each to the unit below so neither
 * granularity is punished for being the other one.
 *   callers     one unit per calling SCOPE (function / method / module top level),
 *               canonical = the first line in that scope that calls the subject.
 *               Other call lines in the scope and the scope's declaration line
 *               are aliases of it.
 *   callees     one unit per first-party callee, canonical = its declaration line.
 *               Calls into node built-ins / third-party packages are neutral.
 *   impact      one unit per upstream scope within `depth`, canonical = that
 *               scope's declaration line.
 *   definition  the declaration line(s) of the subject (all overloads alias the
 *               first).
 *   references  one unit per referencing line (imports, re-exports, usages and
 *               type positions). The subject's own declaration is neutral.
 *   symbol-search  declaration lines of every symbol whose name is exactly the
 *               subject.
 *   text-search one unit per line containing the literal.
 *
 * Every non-absence case carries >= 1 seed. A case with NO seeds is an absence
 * claim and must be tagged `absence` — an empty key is never produced by
 * omission.
 */
import type { AnswerKey, FairCase, FairIntent, HardnessTag, SiteKey } from './fair-comparison';
import { FAIR_INTENTS } from './fair-comparison';

/** The commit every arm indexes and every seed is pinned to (staging, 2026-10-06T05:15Z). */
export const FAIR_CORPUS_COMMIT = '90e6465ad21b79142bac4853bb1c9c958f868f41';

/** A verified site: `text` must occur on `line1` of `path` at FAIR_CORPUS_COMMIT. */
export interface SeedSite {
  readonly path: string;
  readonly line1: number;
  readonly text: string;
}

export interface FairCorpusEntry {
  readonly kase: FairCase;
  /** What a wrong engine gets wrong here — the reason the case is in the corpus. */
  readonly why: string;
  readonly seeds: readonly SeedSite[];
  /** Sites neither credited nor penalised (the subject declaration for callers/references). */
  readonly neutral: readonly SeedSite[];
  /** Where the case came from: an earlier corpus id, or the mined demand behind it. */
  readonly origin: string;
}

/** The preregistered shape the corpus must keep (D-011: ~50 stratified, absence + hard cases). */
export const FAIR_CORPUS_SHAPE = Object.freeze({
  minTotal: 45,
  maxTotal: 60,
  minPerIntent: Object.freeze<Record<FairIntent, number>>({
    callers: 10,
    callees: 5,
    impact: 4,
    definition: 5,
    references: 5,
    'symbol-search': 3,
    'text-search': 3,
  }),
  minAbsence: 6,
  /** Every hardness tag appears at least this often. */
  minPerTag: 2,
});

const ALL_TAGS: readonly HardnessTag[] = [
  'absence',
  'barrel-reexport',
  'same-name',
  'dynamic-dispatch',
  'cross-package',
  'submodule',
];

const seedKey = (s: SeedSite): SiteKey => `${s.path}:${s.line1}`;

export interface CorpusShapeReport {
  readonly total: number;
  readonly byIntent: Readonly<Record<FairIntent, number>>;
  readonly byTag: Readonly<Record<HardnessTag, number>>;
  readonly absence: number;
}

export function corpusShape(corpus: readonly FairCorpusEntry[]): CorpusShapeReport {
  const byIntent = Object.fromEntries(FAIR_INTENTS.map((i) => [i, 0])) as Record<FairIntent, number>;
  const byTag = Object.fromEntries(ALL_TAGS.map((t) => [t, 0])) as Record<HardnessTag, number>;
  for (const e of corpus) {
    byIntent[e.kase.intent] += 1;
    for (const t of e.kase.tags) byTag[t] += 1;
  }
  return { total: corpus.length, byIntent, byTag, absence: byTag.absence };
}

/** Structural problems in a corpus — an empty list means it may be preregistered. */
export function validateCorpus(corpus: readonly FairCorpusEntry[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const e of corpus) {
    const { id, intent, tags, depth } = e.kase;
    if (ids.has(id)) problems.push(`duplicate case id ${id}`);
    ids.add(id);
    const absence = tags.includes('absence');
    if (absence && e.seeds.length > 0) problems.push(`${id}: tagged absence but carries ${e.seeds.length} seed(s)`);
    if (!absence && e.seeds.length === 0) problems.push(`${id}: no seeds and not tagged absence — an empty key by omission`);
    if (intent === 'impact' && (depth === undefined || depth < 1)) problems.push(`${id}: impact case needs depth >= 1`);
    if (intent !== 'impact' && depth !== undefined) problems.push(`${id}: depth only applies to impact`);
    if (tags.includes('same-name') && !e.kase.anchorFile) problems.push(`${id}: same-name case needs an anchorFile`);
    if (!e.why.trim()) problems.push(`${id}: no why`);
    const seen = new Set<SiteKey>();
    for (const s of [...e.seeds, ...e.neutral]) {
      const k = seedKey(s);
      if (seen.has(k)) problems.push(`${id}: site ${k} listed twice`);
      seen.add(k);
      if (!s.text.trim()) problems.push(`${id}: site ${k} has no anchor text`);
      if (s.path.startsWith('/') || s.path.includes('\\')) problems.push(`${id}: site ${k} is not repo-relative POSIX`);
    }
  }
  const shape = corpusShape(corpus);
  if (shape.total < FAIR_CORPUS_SHAPE.minTotal || shape.total > FAIR_CORPUS_SHAPE.maxTotal) {
    problems.push(`total ${shape.total} outside [${FAIR_CORPUS_SHAPE.minTotal}, ${FAIR_CORPUS_SHAPE.maxTotal}]`);
  }
  for (const i of FAIR_INTENTS) {
    if (shape.byIntent[i] < FAIR_CORPUS_SHAPE.minPerIntent[i]) {
      problems.push(`intent ${i}: ${shape.byIntent[i]} < ${FAIR_CORPUS_SHAPE.minPerIntent[i]}`);
    }
  }
  if (shape.absence < FAIR_CORPUS_SHAPE.minAbsence) problems.push(`absence: ${shape.absence} < ${FAIR_CORPUS_SHAPE.minAbsence}`);
  for (const t of ALL_TAGS) {
    if (shape.byTag[t] < FAIR_CORPUS_SHAPE.minPerTag) problems.push(`tag ${t}: ${shape.byTag[t]} < ${FAIR_CORPUS_SHAPE.minPerTag}`);
  }
  return problems;
}

/**
 * Every seed/neutral site's anchor text must sit on its pinned line in the frozen
 * snapshot. `read` returns a file's text at FAIR_CORPUS_COMMIT (or null when the
 * path does not exist there).
 */
export function verifyCorpusSites(corpus: readonly FairCorpusEntry[], read: (path: string) => string | null): string[] {
  const problems: string[] = [];
  const cache = new Map<string, string[] | null>();
  const lines = (p: string): string[] | null => {
    if (!cache.has(p)) {
      const t = read(p);
      cache.set(p, t === null ? null : t.split('\n'));
    }
    return cache.get(p) ?? null;
  };
  for (const e of corpus) {
    for (const s of [...e.seeds, ...e.neutral]) {
      const ls = lines(s.path);
      if (ls === null) {
        problems.push(`${e.kase.id}: ${s.path} absent at ${FAIR_CORPUS_COMMIT.slice(0, 12)}`);
        continue;
      }
      const line = ls[s.line1 - 1];
      if (line === undefined || !line.includes(s.text)) {
        problems.push(`${e.kase.id}: ${seedKey(s)} does not contain ${JSON.stringify(s.text)}`);
      }
    }
  }
  return problems;
}

/** The pre-pooling key for every case: seeds are valid, neutral sites are neutral. */
export function initialKeys(corpus: readonly FairCorpusEntry[]): AnswerKey[] {
  return corpus.map((e) => ({
    caseId: e.kase.id,
    sites: [...new Set(e.seeds.map(seedKey))].sort(),
    aliases: {},
    rejected: [],
    neutral: [...new Set(e.neutral.map(seedKey))].sort(),
  }));
}

export const FAIR_CORPUS: readonly FairCorpusEntry[] = Object.freeze([]);
