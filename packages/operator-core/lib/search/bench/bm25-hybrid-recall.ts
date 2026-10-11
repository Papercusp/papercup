/**
 * bm25-hybrid-recall.ts — the pure half of requirement R-13's instrument
 * (plan bm25-lexical-search-evoke-adoption-2026-10-10; decisions D-004, D-006).
 *
 * R-13: on a known-item sample, HYBRID recall (lexical leg + cosine leg, fused by
 * RRF) with the BM25 lexical leg is at least the recall with the legacy ts_rank_cd
 * leg (BM25 flag off), measured on the identical sample in one session.
 * `bm25-hybrid-recall-cli.ts` runs both arms for every pair in one process, through
 * the same engine path `search:semantic` uses; this module scores and judges.
 *
 * WHY THE VERDICT CAN BE `invalid`. The instrument R-13 first named
 * (memory/bench/ab-live-recall-cli.ts) ranks `memory_canonical` with
 * canonical-store `lexicalSearch`, which never reads the BM25 flag: both arms ran
 * the same code and would have "passed" by construction. So a comparison counts
 * only when each arm's seam actually reported its engine (legacy arm = 'legacy',
 * BM25 arm = 'bm25') and both arms scored the identical pairs. Anything else is
 * `invalid`, never `pass`.
 */
import { createHash } from 'node:crypto';

// The same matcher the commit-time identity lints use, so what this scrubs at write time and
// what git-sync's content lint refuses cannot drift (see prose-corpus.ts for the same pattern).
import { redactIdentityLeaks } from '../../../../../scripts/lib/identity-leak-patterns.mjs';

export type Arm = 'legacy' | 'bm25';
export const ARMS: readonly Arm[] = ['legacy', 'bm25'];

/** Recall cut-off: the target must be in the top K of the fused list. */
export const RECALL_K = 10;

/** Below this many scored pairs a source's comparison is too small to read. */
export const MIN_PAIRS_PER_SOURCE = 20;

export type QueryStyle = 'fragment' | 'keyword';

export interface ArmObservation {
  /** 1-based rank of the target in the fused list (top RECALL_K), or null when absent. */
  rank: number | null;
  latencyMs: number;
  /** The lexical engine the seam (`lexicalEngine`) reported for this arm and source. */
  engine: 'bm25' | 'legacy';
  /** Length of the fused list; 0 is a zero-hit query. */
  hits: number;
}

export interface PairResult {
  /** Search source name, e.g. `work_item`, `session_turn`. */
  source: string;
  /** The known item's `source_id` as the source emits it. */
  targetId: string;
  style: QueryStyle;
  query: string;
  arms: Partial<Record<Arm, ArmObservation>>;
}

export interface ArmSummary {
  scored: number;
  hitsAtK: number;
  recallAtK: number;
  mrrAtK: number;
  zeroHit: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Distinct engines this arm's seam reported across the source's pairs. */
  engines: string[];
}

export interface PairedCounts {
  bm25Only: number;
  legacyOnly: number;
  both: number;
  neither: number;
}

export type Verdict = 'pass' | 'fail' | 'invalid';

/**
 * R-18's absolute ceilings (D-020), per source: the BM25 arm's end-to-end p95 may not exceed
 * these even when legacy is slower. They are D-016's measured p95 (152 / 324 ms) with about 30%
 * headroom. A source with no entry is judged against legacy only, and its reason says so.
 */
export const LATENCY_P95_CEILING_MS: Readonly<Record<string, number>> = {
  work_item: 200,
  session_turn: 400,
};

/**
 * R-18's judgment, separate from R-13's recall verdict: the BM25 arm's end-to-end p95 (the
 * whole `runHybridSearch` call, so the BM25 list, the D-016 exact list and the fusion) may not
 * exceed the legacy arm's p95 measured in the same run on the same pairs (D-019), nor the
 * source's absolute ceiling in `LATENCY_P95_CEILING_MS` (D-020).
 */
export interface LatencyJudgment {
  verdict: Verdict;
  reason: string;
}

export interface SourceSummary {
  source: string;
  scored: number;
  arms: Record<Arm, ArmSummary>;
  paired: PairedCounts;
  /** R-13: recall@K of the BM25 arm against the legacy arm. */
  verdict: Verdict;
  reasons: string[];
  /** R-18: end-to-end p95 of the BM25 arm against the legacy arm. */
  latency: LatencyJudgment;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function found(o: ArmObservation | undefined): boolean {
  return o?.rank != null && o.rank <= RECALL_K;
}

/** Score one arm over a set of pairs. Pairs missing the arm are not counted. */
export function summarizeArm(pairs: readonly PairResult[], arm: Arm): ArmSummary {
  const observed = pairs.map((p) => p.arms[arm]).filter((o): o is ArmObservation => o !== undefined);
  const hitsAtK = observed.filter(found).length;
  const mrr = observed.reduce((s, o) => s + (found(o) ? 1 / (o.rank as number) : 0), 0);
  const latencies = observed.map((o) => o.latencyMs).sort((a, b) => a - b);
  return {
    scored: observed.length,
    hitsAtK,
    recallAtK: observed.length ? hitsAtK / observed.length : 0,
    mrrAtK: observed.length ? mrr / observed.length : 0,
    zeroHit: observed.filter((o) => o.hits === 0).length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    engines: [...new Set(observed.map((o) => o.engine))].sort(),
  };
}

/** Per-pair agreement between the arms (McNemar's discordant cells are bm25Only / legacyOnly). */
export function pairedCounts(pairs: readonly PairResult[]): PairedCounts {
  const c: PairedCounts = { bm25Only: 0, legacyOnly: 0, both: 0, neither: 0 };
  for (const p of pairs) {
    const b = found(p.arms.bm25);
    const l = found(p.arms.legacy);
    if (b && l) c.both += 1;
    else if (b) c.bm25Only += 1;
    else if (l) c.legacyOnly += 1;
    else c.neither += 1;
  }
  return c;
}

/**
 * Judge one source. `invalid` when the comparison cannot support a verdict (too few
 * pairs, a pair missing an arm, or an arm that did not run its engine); `fail` when the
 * BM25 arm's recall@K is below the legacy arm's; otherwise `pass`.
 */
export function summarizeSource(
  source: string,
  pairs: readonly PairResult[],
  minPairs: number = MIN_PAIRS_PER_SOURCE,
): SourceSummary {
  const mine = pairs.filter((p) => p.source === source);
  const arms = { legacy: summarizeArm(mine, 'legacy'), bm25: summarizeArm(mine, 'bm25') };
  const reasons: string[] = [];
  const incomplete = mine.filter((p) => !p.arms.legacy || !p.arms.bm25).length;
  if (incomplete > 0) reasons.push(`${incomplete} pair(s) were not scored by both arms`);
  if (mine.length < minPairs) reasons.push(`only ${mine.length} pair(s); at least ${minPairs} are needed`);
  if (arms.legacy.engines.join() !== 'legacy') {
    reasons.push(`legacy arm ran engine(s) [${arms.legacy.engines.join(', ')}], expected [legacy]`);
  }
  if (arms.bm25.engines.join() !== 'bm25') {
    reasons.push(`BM25 arm ran engine(s) [${arms.bm25.engines.join(', ')}], expected [bm25]: the flag flip did not reach the lexical seam`);
  }
  let verdict: Verdict;
  if (reasons.length > 0) verdict = 'invalid';
  else if (arms.bm25.hitsAtK < arms.legacy.hitsAtK) {
    verdict = 'fail';
    reasons.push(`BM25 recall@${RECALL_K} ${arms.bm25.hitsAtK}/${arms.bm25.scored} is below legacy ${arms.legacy.hitsAtK}/${arms.legacy.scored}`);
  } else {
    verdict = 'pass';
    reasons.push(`BM25 recall@${RECALL_K} ${arms.bm25.hitsAtK}/${arms.bm25.scored} >= legacy ${arms.legacy.hitsAtK}/${arms.legacy.scored}`);
  }
  const latency: LatencyJudgment = verdict === 'invalid'
    ? { verdict: 'invalid', reason: 'the comparison is invalid (see reasons), so latency is not judged' }
    : judgeLatency(arms, LATENCY_P95_CEILING_MS[source] ?? null);
  return { source, scored: mine.length, arms, paired: pairedCounts(mine), verdict, reasons, latency };
}

/**
 * R-18: `fail` when the BM25 arm's p95 exceeds the legacy arm's (D-019) or `ceilingMs` (D-020);
 * `invalid` with no samples. `ceilingMs: null` judges against legacy only.
 */
export function judgeLatency(arms: Record<Arm, ArmSummary>, ceilingMs: number | null = null): LatencyJudgment {
  const bm25 = arms.bm25.latencyP95Ms;
  const legacy = arms.legacy.latencyP95Ms;
  if (bm25 == null || legacy == null) {
    return { verdict: 'invalid', reason: 'an arm has no latency samples' };
  }
  const failures: string[] = [];
  if (bm25 > legacy) failures.push(`BM25-arm p95 ${bm25} ms exceeds legacy p95 ${legacy} ms`);
  if (ceilingMs != null && bm25 > ceilingMs) failures.push(`BM25-arm p95 ${bm25} ms exceeds the ${ceilingMs} ms ceiling`);
  if (failures.length > 0) return { verdict: 'fail', reason: failures.join('; ') };
  const ceiling = ceilingMs != null ? ` and the ${ceilingMs} ms ceiling` : ' (no absolute ceiling for this source)';
  return { verdict: 'pass', reason: `BM25-arm p95 ${bm25} ms <= legacy p95 ${legacy} ms${ceiling}` };
}

function combine(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return 'invalid';
  if (verdicts.includes('invalid')) return 'invalid';
  if (verdicts.includes('fail')) return 'fail';
  return 'pass';
}

/** The overall R-13 verdict: `invalid` if any source is, else `fail` if any source is, else `pass`. */
export function overallVerdict(sources: readonly SourceSummary[]): Verdict {
  return combine(sources.map((s) => s.verdict));
}

/**
 * Embed every distinct query once, in sample order, BEFORE any arm is timed (D-021). The CLI
 * caches embeddings per query, so without this the arm that runs first in a pair also pays for
 * the in-process embedding: measured 2026-10-11, the session_turn BM25 arm's p95 was 596 ms
 * when it ran first and 303 ms when it ran second. Embedding is identical for both arms and not
 * something this plan changes, so it must not land in either arm's latency. Returns how many
 * distinct queries were embedded.
 */
export async function warmQueryEmbeddings(
  pairs: readonly Pick<PairResult, 'query'>[],
  embed: (text: string) => Promise<unknown>,
): Promise<number> {
  const seen = new Set<string>();
  for (const p of pairs) {
    if (seen.has(p.query)) continue;
    seen.add(p.query);
    await embed(p.query);
  }
  return seen.size;
}

/** The overall R-18 verdict, combined the same way over each source's latency judgment. */
export function overallLatencyVerdict(sources: readonly SourceSummary[]): Verdict {
  return combine(sources.map((s) => s.latency.verdict));
}

/**
 * A fingerprint of the sample (source, target, style, query), order-independent. Both arms
 * read the same in-memory pairs, so this pins WHICH sample the evidence is about.
 */
export function sampleFingerprint(pairs: readonly Pick<PairResult, 'source' | 'targetId' | 'style' | 'query'>[]): string {
  const lines = pairs.map((p) => `${p.source}\t${p.targetId}\t${p.style}\t${p.query}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * The pairs as they may be written to a tracked evidence file. Probe queries are sampled from
 * live rows, so one can carry this box's identity (a home path, the git name or email); the
 * release-bundle identity audit then refuses the file and git-sync quarantines it (measured
 * 2026-10-11: a session-turn query held a home path). Each query is passed through the shared
 * redactor. `sampleFingerprint` is computed on the raw queries BEFORE this, so the recorded
 * fingerprint still names the sample that ran; `redactedQueries` says how many were changed.
 */
export function redactPairsForArtifact<P extends { query: string }>(
  pairs: readonly P[],
  literals?: [string, string][],
): { pairs: P[]; redactedQueries: number } {
  let redactedQueries = 0;
  const out = pairs.map((p) => {
    const query = redactIdentityLeaks(p.query, literals);
    if (query === p.query) return p;
    redactedQueries += 1;
    return { ...p, query };
  });
  return { pairs: out, redactedQueries };
}

/** Run order for pair `i`: alternate which arm goes first so warm caches favour neither. */
export function armOrder(i: number): readonly Arm[] {
  return i % 2 === 0 ? ['legacy', 'bm25'] : ['bm25', 'legacy'];
}

/** The 1-based rank of `targetId` from `source` in a fused hit list, or null. */
export function rankOf(
  hits: readonly { source: string; source_id: string }[],
  source: string,
  targetId: string,
): number | null {
  const i = hits.findIndex((h) => h.source === source && h.source_id === targetId);
  return i >= 0 ? i + 1 : null;
}
