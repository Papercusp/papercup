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
  /**
   * Per-leg time inside the call, keyed `<leg>:<ranker>` (e.g. `lexical:lexical`,
   * `semantic:embeddings`), from the search engine's own `legs.*.sourceCalls[].durationMs`
   * (see {@link legDurations}). Legs run concurrently, so these do not sum to `latencyMs`.
   * It attributes an R-18 tail to a leg; artifacts written before it was recorded omit it.
   */
  legMs?: Record<string, number>;
  /**
   * Where this call's time went, measured OUTSIDE the timed window (D-026): the lexical
   * statements' pg_stat_statements deltas, the bench process's CPU time and event-loop delay,
   * and host I/O pressure at call start. Artifacts written before D-026 omit it.
   */
  attrib?: CallAttribution;
  /**
   * D-027: whether a full-database dump (application `pcbackup`, a transaction open) was in
   * progress just before this call, sampled outside the timed window. `null` when the check
   * failed; absent in artifacts written before D-027.
   */
  dumpActive?: boolean | null;
}

/**
 * D-027: whether a full-database dump overlapped these calls. `true` if any call saw one;
 * `false` only if every call was checked and none did; `null` if some call could not be
 * checked; `undefined` when no call carries the check (an artifact written before D-027).
 */
export function dumpOverlapOf(pairs: readonly PairResult[]): boolean | null | undefined {
  const seen = pairs.flatMap((p) => ARMS.flatMap((a) => (p.arms[a] ? [p.arms[a]!.dumpActive] : [])));
  if (seen.length === 0 || seen.every((d) => d === undefined)) return undefined;
  if (seen.some((d) => d === true)) return true;
  if (seen.some((d) => d !== false)) return null;
  return false;
}

/** Per-call attribution of an R-18 observation (D-026). See {@link callAttribution}. */
export interface CallAttribution {
  /** Execution time of the lexical statements that ran during the call (pg_stat_statements). */
  pgExecMs: number;
  /** Of which: time reading blocks not in shared buffers. Can exceed pgExecMs under parallel query. */
  pgReadMs: number;
  pgBlksRead: number;
  /** Statement executions in the window; above the call's own count means a peer ran the same statement. */
  pgCalls: number;
  /** User + system CPU time of the bench process over the call. */
  clientCpuMs?: number;
  /** Largest event-loop delay sampled during the call: the bench process waiting for a CPU. */
  loopDelayMaxMs?: number;
  /** `/proc/pressure/io` some avg10 at call start. */
  psiIoAvg10?: number;
  /** D-030: what the bench's own backends waited on during the call. See {@link summarizeWaitSamples}. */
  waits?: WaitProfile;
  /** D-030: on-CPU time of the bench's backends over the call (`/proc/<pid>/schedstat`, summed). */
  pgCpuMs?: number;
  /** D-030: run-queue wait of those backends: runnable, but waiting for a CPU. */
  pgRunqMs?: number;
  /** D-030: run-queue wait of the bench process's main thread over the call. */
  clientRunqMs?: number;
  /**
   * D-030: backends of this process that did not exist before the call: the pool opened a
   * connection for it. Their schedstat counts from zero, so connection setup is in pgCpuMs.
   */
  pgBackendsBorn?: number;
}

/** One pg_stat_activity row of an active bench backend, sampled during a timed call (D-030). */
export interface WaitSample {
  waitEventType: string | null;
  waitEvent: string | null;
}

/** One poll of the wait sampler: when it ran (ms, any monotonic clock) and the active backends it saw. */
export interface WaitPoll {
  atMs: number;
  samples: readonly WaitSample[];
}

/**
 * D-030: what the bench's own backends were doing while a timed call ran. Counts are samples, so
 * a key's share is its share of sampled backend-time, not of wall time.
 */
export interface WaitProfile {
  /** Polls taken, including those that found no active backend (client, transit, between statements). */
  polls: number;
  /** Active-backend samples across all polls. */
  activeSamples: number;
  /** Samples per {@link waitEventKey}. */
  byEvent: Record<string, number>;
  /** Largest gap between consecutive polls: well above the interval, the sampler itself was stalled. */
  maxPollGapMs: number | null;
}

/**
 * The profile key of one sample. An active backend with no wait event is on a CPU or queued for
 * one: 'CPU' (schedstat's run-queue wait splits the two). Otherwise `<type>:<event>`, e.g.
 * `IO:DataFileRead`, `LWLock:BufferMapping`, `IPC:BufferIO`, `Lock:relation`.
 */
export function waitEventKey(s: WaitSample): string {
  if (!s.waitEventType) return 'CPU';
  return s.waitEvent ? `${s.waitEventType}:${s.waitEvent}` : s.waitEventType;
}

export function summarizeWaitSamples(polls: readonly WaitPoll[]): WaitProfile {
  const byEvent: Record<string, number> = {};
  let activeSamples = 0;
  let maxGap: number | null = null;
  for (const [i, p] of polls.entries()) {
    for (const s of p.samples) {
      const k = waitEventKey(s);
      byEvent[k] = (byEvent[k] ?? 0) + 1;
      activeSamples += 1;
    }
    if (i > 0) {
      const gap = p.atMs - polls[i - 1]!.atMs;
      if (maxGap === null || gap > maxGap) maxGap = gap;
    }
  }
  return { polls: polls.length, activeSamples, byEvent, maxPollGapMs: maxGap === null ? null : round1(maxGap) };
}

/** Sum wait profiles (e.g. over the tail calls of one pass). */
export function mergeWaitProfiles(profiles: readonly WaitProfile[]): WaitProfile {
  const byEvent: Record<string, number> = {};
  let polls = 0;
  let activeSamples = 0;
  let maxGap: number | null = null;
  for (const p of profiles) {
    polls += p.polls;
    activeSamples += p.activeSamples;
    for (const [k, n] of Object.entries(p.byEvent)) byEvent[k] = (byEvent[k] ?? 0) + n;
    if (p.maxPollGapMs !== null && (maxGap === null || p.maxPollGapMs > maxGap)) maxGap = p.maxPollGapMs;
  }
  return { polls, activeSamples, byEvent, maxPollGapMs: maxGap };
}

/** `/proc/<pid>/schedstat`: nanoseconds on a CPU, nanoseconds runnable but waiting for one. */
export interface Schedstat {
  cpuNs: number;
  runqNs: number;
}

/** Parse `/proc/<pid>/schedstat` ("<on-cpu ns> <run-queue ns> <timeslices>"); null if malformed. */
export function parseSchedstat(text: string | null | undefined): Schedstat | null {
  const m = /^\s*(\d+)\s+(\d+)(\s+\d+)?\s*$/.exec(text ?? '');
  return m ? { cpuNs: Number(m[1]), runqNs: Number(m[2]) } : null;
}

/**
 * Summed schedstat deltas, in ms, over the pids present in BOTH snapshots: a backend that appeared
 * or exited mid-call is left out rather than counted from zero (a recycled pid would otherwise add
 * another process's whole lifetime).
 */
export function schedstatDeltaMs(
  before: ReadonlyMap<number, Schedstat>,
  after: ReadonlyMap<number, Schedstat>,
): { cpuMs: number; runqMs: number; pids: number } {
  let cpuNs = 0;
  let runqNs = 0;
  let pids = 0;
  for (const [pid, b] of before) {
    const a = after.get(pid);
    if (!a || a.cpuNs < b.cpuNs || a.runqNs < b.runqNs) continue;
    cpuNs += a.cpuNs - b.cpuNs;
    runqNs += a.runqNs - b.runqNs;
    pids += 1;
  }
  return { cpuMs: round1(cpuNs / 1e6), runqMs: round1(runqNs / 1e6), pids };
}

/**
 * The lexical statements' share of one call, from pg_stat_statements snapshots taken just before
 * and just after it (both outside the timed window). Uses {@link statementDeltas}, so evicted or
 * reset counters count from zero.
 */
export function callAttribution(
  before: readonly StatementStat[],
  after: readonly StatementStat[],
): Pick<CallAttribution, 'pgExecMs' | 'pgReadMs' | 'pgBlksRead' | 'pgCalls'> {
  const d = statementDeltas(before, after);
  return {
    pgExecMs: round1(d.reduce((s, x) => s + x.totalExecMs, 0)),
    pgReadMs: round1(d.reduce((s, x) => s + x.sharedBlkReadMs, 0)),
    pgBlksRead: d.reduce((s, x) => s + x.sharedBlksRead, 0),
    pgCalls: d.reduce((s, x) => s + x.calls, 0),
  };
}

/** Sum over a set of observations: how much of the lexical leg was statement execution. */
export interface AttributionSummary {
  calls: number;
  wallMs: number;
  lexicalMs: number;
  pgExecMs: number;
  pgReadMs: number;
  /** 1 - pgExecMs / lexicalMs: the lexical leg's time spent outside statement execution. */
  outsideExecShare: number | null;
  /** D-030: summed over the calls that recorded them; absent when none did (an artifact before D-030). */
  pgCpuMs?: number;
  pgRunqMs?: number;
  clientRunqMs?: number;
  waits?: WaitProfile;
}

export function summarizeAttribution(observations: readonly ArmObservation[]): AttributionSummary {
  const with_ = observations.filter((o) => o.attrib && o.legMs && 'lexical:lexical' in o.legMs);
  const lexicalMs = round1(with_.reduce((s, o) => s + (o.legMs!['lexical:lexical'] ?? 0), 0));
  const pgExecMs = round1(with_.reduce((s, o) => s + o.attrib!.pgExecMs, 0));
  const sumOf = (k: 'pgCpuMs' | 'pgRunqMs' | 'clientRunqMs'): number | undefined => {
    const xs = with_.map((o) => o.attrib![k]).filter((v): v is number => typeof v === 'number');
    return xs.length ? round1(xs.reduce((s, v) => s + v, 0)) : undefined;
  };
  const waits = with_.map((o) => o.attrib!.waits).filter((w): w is WaitProfile => !!w);
  const sched = { pgCpuMs: sumOf('pgCpuMs'), pgRunqMs: sumOf('pgRunqMs'), clientRunqMs: sumOf('clientRunqMs') };
  return {
    calls: with_.length,
    wallMs: round1(with_.reduce((s, o) => s + o.latencyMs, 0)),
    lexicalMs,
    pgExecMs,
    pgReadMs: round1(with_.reduce((s, o) => s + o.attrib!.pgReadMs, 0)),
    outsideExecShare: lexicalMs > 0 ? Math.round((1 - pgExecMs / lexicalMs) * 1000) / 1000 : null,
    ...Object.fromEntries(Object.entries(sched).filter(([, v]) => v !== undefined)),
    ...(waits.length ? { waits: mergeWaitProfiles(waits) } : {}),
  };
}

/**
 * D-030: the slowest calls of one pass, slowest first, with what they waited on: the calls a p95
 * over `observations` rests on (the top 5%, at least `min`). Only calls that recorded attribution
 * are listed; `count` says how many were eligible.
 */
export function tailAttribution(
  observations: readonly ArmObservation[],
  min = 3,
): { count: number; calls: Array<{ latencyMs: number; lexicalMs: number | null; attrib: CallAttribution }> } {
  const with_ = observations.filter((o): o is ArmObservation & { attrib: CallAttribution } => !!o.attrib);
  const n = Math.max(min, Math.ceil(observations.length * 0.05));
  const calls = [...with_]
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, n)
    .map((o) => ({ latencyMs: o.latencyMs, lexicalMs: o.legMs?.['lexical:lexical'] ?? null, attrib: o.attrib }));
  return { count: with_.length, calls };
}

/**
 * Sum the engine's per-source durations for every source call that actually RAN, keyed
 * `<leg>:<ranker>`. Input is `runHybridSearch(...).legs`; anything else yields `{}` (an
 * absent instrument is not a zero-millisecond leg, so callers should omit an empty result).
 */
export function legDurations(legs: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!legs || typeof legs !== 'object') return out;
  for (const [legName, leg] of Object.entries(legs as Record<string, unknown>)) {
    const calls = (leg as { sourceCalls?: unknown } | null)?.sourceCalls;
    if (!Array.isArray(calls)) continue;
    for (const c of calls as Array<{ ranker?: unknown; status?: unknown; durationMs?: unknown }>) {
      if (c?.status !== 'ran' || typeof c.durationMs !== 'number') continue;
      const key = `${legName}:${String(c.ranker)}`;
      out[key] = (out[key] ?? 0) + c.durationMs;
    }
  }
  return out;
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
  /**
   * p95 of each leg's own time (`ArmObservation.legMs`) over the observations that recorded
   * it. Attribution only: R-18 judges `latencyP95Ms`, the whole call.
   */
  legP95Ms: Record<string, number | null>;
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
 * R-18 clause (c), D-029: the cold paired pass's BM25-arm p95 may not exceed these, so a cold
 * call users would call slow still fails the bar even when legacy is slower still. About 1.6x
 * and 1.7x the highest cold p95 measured on the current search path (634 / 689.1 ms, five runs
 * on 2026-10-11), inside the 3.4x run-to-run swing D-028 measured on this host. Judged on every
 * run, dump overlap or not. A source with no entry has no cold ceiling.
 */
export const COLD_LATENCY_P95_CEILING_MS: Readonly<Record<string, number>> = {
  work_item: 1000,
  session_turn: 1200,
};

/**
 * R-18's judgment, separate from R-13's recall verdict. Both bounds time the whole
 * `runHybridSearch` call (the BM25 list, the D-016 exact list and the fusion):
 * - D-019: on the paired cold pass, the BM25 arm's p95 may not exceed the legacy arm's p95 on
 *   the same pairs. Judged on every run: both arms meet the same host conditions.
 * - D-020: the source's absolute ceiling in `LATENCY_P95_CEILING_MS`. D-028: it bounds the
 *   warm-repeat pass's p95, the timed repeat of each paired query's BM25-arm call after an
 *   untimed one loaded its pages. That measures the path's own work (CPU and buffer hits) and
 *   not the host's per-block read latency, which run 8 showed swings the cold p95 3.4x with
 *   unchanged code. The cold paired p95 is reported against the ceiling, not judged.
 * - Before D-028 (no warm-repeat pass in the run) the ceiling bounds the paired p95, judged only
 *   when no full-database dump overlapped the paired calls (D-027): such artifacts are judged
 *   as they were then.
 * The steady pass (D-024/D-025) is reported data only; D-026 retracted the premise that it
 * isolates the path's own cost, so it judges nothing.
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
  /**
   * The steady pass (D-024/D-025): the BM25 arm over this source's steady sample, or null when
   * none was run. Reported data only since D-026; it judges nothing.
   */
  steady: ArmSummary | null;
  /** Why the steady pass is not a sound sample (see {@link steadyPassProblems}); empty when none was run. */
  steadyProblems: string[];
  /** D-027: whether a full-database dump overlapped this source's paired calls (see {@link dumpOverlapOf}). */
  dumpOverlap: boolean | null | undefined;
  /**
   * D-028: the warm-repeat pass, the timed second BM25-arm call of each paired query (the
   * untimed first one loaded its pages). The D-020 ceiling judges its p95. Null when the run
   * had no warm-repeat pass (an artifact written before D-028).
   */
  warmRepeat: ArmSummary | null;
  /** Why the warm-repeat pass cannot carry the ceiling (see {@link bm25PassProblems}); empty when sound or absent. */
  warmRepeatProblems: string[];
  /**
   * D-028: timed warm repeats whose lexical statements read blocks not in shared buffers, by
   * the pg_stat_statements delta. An upper bound (the delta also counts peers running the
   * same statement), so it is reported, not judged; null when no repeat recorded attribution.
   */
  warmRepeatReadCalls: number | null;
  /** R-18: the paired relative bound (D-019) and the absolute ceiling (D-020; D-027, D-028). */
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
  const legKeys = [...new Set(observed.flatMap((o) => Object.keys(o.legMs ?? {})))].sort();
  const legP95Ms = Object.fromEntries(legKeys.map((k) => [
    k,
    percentile(observed.flatMap((o) => (o.legMs && k in o.legMs ? [o.legMs[k]!] : [])).sort((a, b) => a - b), 95),
  ]));
  return {
    scored: observed.length,
    hitsAtK,
    recallAtK: observed.length ? hitsAtK / observed.length : 0,
    mrrAtK: observed.length ? mrr / observed.length : 0,
    zeroHit: observed.filter((o) => o.hits === 0).length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    engines: [...new Set(observed.map((o) => o.engine))].sort(),
    legP95Ms,
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
  steadyPairs: readonly PairResult[] | null = null,
  warmPairs: readonly PairResult[] | null = null,
): SourceSummary {
  const mine = pairs.filter((p) => p.source === source);
  const steadyMine = steadyPairs?.filter((p) => p.source === source) ?? null;
  const steady = steadyMine ? summarizeArm(steadyMine, 'bm25') : null;
  const warmMine = warmPairs?.filter((p) => p.source === source) ?? null;
  const warmRepeat = warmMine ? summarizeArm(warmMine, 'bm25') : null;
  const warmRepeatProblems = warmMine ? bm25PassProblems(warmMine, minPairs, 'warm-repeat') : [];
  const warmObs = (warmMine ?? []).flatMap((p) => (p.arms.bm25?.attrib ? [p.arms.bm25.attrib] : []));
  const warmRepeatReadCalls = warmObs.length ? warmObs.filter((a) => a.pgBlksRead > 0).length : null;
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
  const dumpOverlap = dumpOverlapOf(mine);
  const latency: LatencyJudgment = verdict === 'invalid'
    ? { verdict: 'invalid', reason: 'the comparison is invalid (see reasons), so latency is not judged' }
    : judgeLatency(
        arms,
        LATENCY_P95_CEILING_MS[source] ?? null,
        dumpOverlap,
        warmRepeat ? { summary: warmRepeat, problems: warmRepeatProblems } : null,
        COLD_LATENCY_P95_CEILING_MS[source] ?? null,
      );
  const steadyProblems = steadyMine ? steadyPassProblems(steadyMine, minPairs) : [];
  return {
    source,
    scored: mine.length,
    arms,
    paired: pairedCounts(mine),
    verdict,
    reasons,
    steady,
    steadyProblems,
    dumpOverlap,
    warmRepeat,
    warmRepeatProblems,
    warmRepeatReadCalls,
    latency,
  };
}

/**
 * Why a BM25-only pass cannot carry a judgment: too few calls, a call that did not record the
 * BM25 arm, or a call whose seam ran another engine (the flag did not reach it). `label` names
 * the pass in the messages. Empty when the pass is usable.
 */
export function bm25PassProblems(passPairs: readonly PairResult[], minPairs: number = MIN_PAIRS_PER_SOURCE, label = 'steady'): string[] {
  const problems: string[] = [];
  const missing = passPairs.filter((p) => !p.arms.bm25).length;
  if (missing > 0) problems.push(`${missing} ${label} call(s) recorded no BM25 observation`);
  const scored = passPairs.length - missing;
  if (scored < minPairs) problems.push(`only ${scored} ${label} call(s); at least ${minPairs} are needed`);
  const engines = [...new Set(passPairs.flatMap((p) => (p.arms.bm25 ? [p.arms.bm25.engine] : [])))].sort();
  if (scored > 0 && engines.join() !== 'bm25') problems.push(`${label} calls ran engine(s) [${engines.join(', ')}], expected [bm25]`);
  return problems;
}

/** The steady pass's problems (D-024/D-025); reported only since D-026. See {@link bm25PassProblems}. */
export function steadyPassProblems(steadyPairs: readonly PairResult[], minPairs: number = MIN_PAIRS_PER_SOURCE): string[] {
  return bm25PassProblems(steadyPairs, minPairs, 'steady');
}

/** D-028: the warm-repeat pass as {@link judgeLatency} reads it. */
export interface WarmRepeatPass {
  summary: ArmSummary;
  problems: string[];
}

/**
 * R-18: `fail` when the paired BM25 p95 exceeds the legacy arm's (D-019, judged on every run),
 * or when the ceiling-judged p95 exceeds `ceilingMs` (D-020). `invalid` with no samples;
 * `ceilingMs: null` judges against legacy only.
 *
 * With a warm-repeat pass (`warm`, D-028) the ceiling judges `warm.summary.latencyP95Ms`; a
 * warm-repeat pass with problems is `invalid` for the ceiling unless the relative bound already
 * failed. The dump overlap is not a precondition then: the repeat's pages are already cached.
 *
 * Without one (`warm` null: an artifact written before D-028) the ceiling judges the paired p95
 * as D-027 did: only when `dumpOverlap` is `false`, or `undefined` (an artifact written before
 * D-027); with a dump overlapping (`true`) or unchecked (`null`) the ceiling is `invalid`.
 *
 * `coldCeilingMs` (D-029) bounds the paired p95 absolutely on every run, dump or not: a breach
 * is `fail` and outranks an unsound warm-repeat pass. `null` means no cold ceiling.
 */
export function judgeLatency(
  arms: Record<Arm, ArmSummary>,
  ceilingMs: number | null = null,
  dumpOverlap: boolean | null | undefined = undefined,
  warm: WarmRepeatPass | null = null,
  coldCeilingMs: number | null = null,
): LatencyJudgment {
  const bm25 = arms.bm25.latencyP95Ms;
  const legacy = arms.legacy.latencyP95Ms;
  if (bm25 == null || legacy == null) {
    return { verdict: 'invalid', reason: 'an arm has no latency samples' };
  }
  const warmP95 = warm?.summary.latencyP95Ms ?? null;
  const coldBreach = coldCeilingMs != null && bm25 > coldCeilingMs
    ? `the cold paired BM25 p95 ${bm25} ms exceeds the ${coldCeilingMs} ms cold ceiling (D-029)`
    : null;
  if (bm25 > legacy) {
    const judged = warm ? warmP95 : bm25;
    const what = warm ? `the warm-repeat p95 ${warmP95} ms also exceeds` : 'it also exceeds';
    const ceiling = ceilingMs != null && judged != null && judged > ceilingMs ? `; ${what} the ${ceilingMs} ms ceiling` : '';
    const cold = coldBreach ? `; ${coldBreach}` : '';
    return { verdict: 'fail', reason: `BM25-arm p95 ${bm25} ms exceeds legacy p95 ${legacy} ms${ceiling}${cold}` };
  }
  const relative = `BM25-arm p95 ${bm25} ms <= legacy p95 ${legacy} ms`;
  if (coldBreach) return { verdict: 'fail', reason: `${relative}, but ${coldBreach}` };
  const coldOk = coldCeilingMs != null ? `cold paired BM25 p95 ${bm25} ms <= the ${coldCeilingMs} ms cold ceiling (D-029)` : null;
  if (ceilingMs == null) {
    return { verdict: 'pass', reason: `${relative}${coldOk ? `; ${coldOk}` : ''} (no absolute ceiling for this source)` };
  }
  if (warm) {
    if (warm.problems.length > 0 || warmP95 == null) {
      const why = warm.problems.length ? warm.problems.join('; ') : 'it has no latency samples';
      const coldPart = coldOk ? `; ${coldOk}` : '';
      return { verdict: 'invalid', reason: `${relative}${coldPart}; the ${ceilingMs} ms ceiling is not judged: the warm-repeat pass is unsound: ${why} (D-028)` };
    }
    const cold = coldOk ?? `cold paired p95 ${bm25} ms reported, not judged (D-028)`;
    if (warmP95 > ceilingMs) {
      return { verdict: 'fail', reason: `${relative}, but the warm-repeat BM25 p95 ${warmP95} ms exceeds the ${ceilingMs} ms ceiling; ${cold}` };
    }
    return { verdict: 'pass', reason: `${relative}; warm-repeat BM25 p95 ${warmP95} ms <= the ${ceilingMs} ms ceiling; ${cold}` };
  }
  if (dumpOverlap === true || dumpOverlap === null) {
    const why = dumpOverlap
      ? 'a full-database dump (pcbackup) was in progress during the paired calls'
      : 'whether a full-database dump overlapped the paired calls could not be checked';
    return { verdict: 'invalid', reason: `${relative}; the ${ceilingMs} ms ceiling is not judged on this run: ${why} (D-027)` };
  }
  if (bm25 > ceilingMs) return { verdict: 'fail', reason: `${relative}, but it exceeds the ${ceilingMs} ms ceiling` };
  return { verdict: 'pass', reason: `${relative} and the ${ceilingMs} ms ceiling` };
}

/** One normalized statement's cumulative counters from `pg_stat_statements`. */
export interface StatementStat {
  queryid: string;
  calls: number;
  totalExecMs: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  /** `shared_blk_read_time`: time spent reading blocks not in shared buffers (needs track_io_timing). */
  sharedBlkReadMs: number;
  /** Normalized query text, whitespace-collapsed and truncated. */
  query: string;
}

export interface StatementDelta extends StatementStat {
  meanExecMs: number | null;
  /** sharedBlkReadMs / totalExecMs: the share of execution spent waiting on block reads. */
  readTimeShare: number | null;
}

/**
 * Per-statement change between two `pg_stat_statements` snapshots, statements with calls in
 * the window only, slowest total first. A statement absent from `before`, or whose counters
 * went backwards (evicted or reset in between), counts from zero. The view is cluster-wide, so
 * a delta also contains any concurrent calls of the same normalized statement by other
 * sessions; compare `calls` with the calls the bench made.
 */
export function statementDeltas(before: readonly StatementStat[], after: readonly StatementStat[]): StatementDelta[] {
  const prior = new Map(before.map((s) => [s.queryid, s]));
  const out: StatementDelta[] = [];
  for (const a of after) {
    const b0 = prior.get(a.queryid);
    const b = b0 && b0.calls <= a.calls && b0.totalExecMs <= a.totalExecMs ? b0 : null;
    const calls = a.calls - (b?.calls ?? 0);
    if (calls <= 0) continue;
    const totalExecMs = round1(a.totalExecMs - (b?.totalExecMs ?? 0));
    const sharedBlkReadMs = round1(a.sharedBlkReadMs - (b?.sharedBlkReadMs ?? 0));
    out.push({
      queryid: a.queryid,
      calls,
      totalExecMs,
      sharedBlksHit: a.sharedBlksHit - (b?.sharedBlksHit ?? 0),
      sharedBlksRead: a.sharedBlksRead - (b?.sharedBlksRead ?? 0),
      sharedBlkReadMs,
      query: a.query,
      meanExecMs: round1(totalExecMs / calls),
      readTimeShare: totalExecMs > 0 ? Math.round((sharedBlkReadMs / totalExecMs) * 1000) / 1000 : null,
    });
  }
  return out.sort((x, y) => y.totalExecMs - x.totalExecMs);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Split one source's derivable candidates, in their seeded order, into the three disjoint
 * samples of D-025: `paired` (the first `n`, identical to the pre-D-024 sample for the same
 * seed), `warmup` (the next `n`) and `steady` (the next `n`). A later candidate whose query
 * text repeats an earlier one is skipped, so the three are disjoint by target id and by query.
 * A set may come up short when the source has too few candidates; the steady pass's validity
 * check then reports it.
 */
export function splitDisjointSamples<P extends Pick<PairResult, 'targetId' | 'query'>>(
  candidates: readonly P[],
  n: number,
): { paired: P[]; warmup: P[]; steady: P[] } {
  const ids = new Set<string>();
  const queries = new Set<string>();
  const taken: P[] = [];
  for (const c of candidates) {
    if (taken.length >= n * 3) break;
    if (ids.has(c.targetId) || queries.has(c.query)) continue;
    ids.add(c.targetId);
    queries.add(c.query);
    taken.push(c);
  }
  return { paired: taken.slice(0, n), warmup: taken.slice(n, 2 * n), steady: taken.slice(2 * n, 3 * n) };
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
