/**
 * Launch-cost metrics — the PURE half of the baseline instrument
 * (plan `agent-launch-context-cost-2026-09-18`, P-001).
 *
 * WHAT THIS MEASURES. A Claude session's *launch cost* is the prompt it pays before doing any
 * work: the system prompt, the advertised tool schemas, the injected playbook/carry prose and
 * the first user message. That total is observable exactly once per transcript — at the FIRST
 * assistant entry carrying a `message.usage` block — as
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
 *
 * WHY ALL THREE FIELDS AND NOT `input_tokens`. Under prompt caching, `input_tokens` on a cached
 * turn is a handful of tokens (measured: 2) because the cached prefix is billed under
 * `cache_read_input_tokens` instead. Reading `input_tokens` alone therefore reports a ~232,000
 * token launch as 2 — the single most dangerous misreading available here, because "2" looks
 * like a healthy number rather than a broken instrument.
 *
 * WHY THIS FILE HAS NO `fs` IMPORT. Everything here is a pure function over already-parsed
 * values so the arithmetic can be tested against hand-computed fixtures without touching a
 * transcript tree. The streaming/IO half lives in `scan-launch-transcripts.ts`.
 *
 * HONESTY RAILS (this module is the acceptance instrument for every later item in the plan, so
 * its own false-zero modes matter more than its convenience):
 *  - `summarize*` returns `null` over an empty sample set rather than 0. A median of `0` and a
 *    median over no data are indistinguishable once printed, and the whole plan is graded on a
 *    median moving downward — a silent empty set would read as a spectacular success.
 *  - `extractLaunchUsage` returns `null` when no usage object is present, and never coerces a
 *    missing field to 0 *in a way that can produce a qualifying sample*: a row whose three
 *    fields are all absent totals 0 and is rejected by the `minPromptTokens` floor.
 */

/** The three prompt-side token fields, plus their sum. */
export type LaunchUsage = {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** `inputTokens + cacheCreationTokens + cacheReadTokens` — what "launch cost" means here. */
  totalPromptTokens: number;
};

/** One measured session launch. */
export type LaunchSample = LaunchUsage & {
  ownerId: string;
  sessionId: string;
  filePath: string;
  /** ISO-8601 timestamp of the measured entry, verbatim from the transcript. */
  timestamp: string;
  /** `YYYY-MM-DD` in UTC, derived from `timestamp`. Grouping key for the per-day report. */
  day: string;
  model: string | null;
  entrypoint: string | null;
  cliVersion: string | null;
  cwd: string | null;
  /** 1-based line number the sample was read from — lets a reader re-open the exact row. */
  lineNumber: number;
  /** Bytes consumed before the sample was found. Evidence for the "must stream" constraint. */
  bytesBeforeSample: number;
};

export type LaunchStats = {
  count: number;
  medianTotal: number;
  p10Total: number;
  p90Total: number;
  minTotal: number;
  maxTotal: number;
  medianCacheRead: number;
  medianCacheCreation: number;
  medianInput: number;
};

export type DayStats = LaunchStats & { day: string };

/**
 * Percentile by linear interpolation between closest ranks (the "R type 7" definition, which is
 * what numpy/pandas `quantile` and most spreadsheet `PERCENTILE` implementations use).
 *
 * Chosen over nearest-rank so that `percentile(xs, 0.5)` is the conventional median — the mean of
 * the two middle values for an even-sized sample — rather than the lower-middle value. A reader
 * comparing this script's median against one computed in a notebook should get the same number.
 *
 * `values` need not be sorted; this sorts a copy.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile: empty sample set has no percentile');
  if (!(p >= 0 && p <= 1)) throw new Error(`percentile: p must be in [0,1], received ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = p * (sorted.length - 1);
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sorted[lowIndex]!;
  if (lowIndex === highIndex) return low;
  const high = sorted[highIndex]!;
  return low + (high - low) * (rank - lowIndex);
}

/** Convenience wrapper; same definition as `percentile(values, 0.5)`. */
export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

function readFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull the prompt-side usage out of one parsed transcript entry.
 *
 * Returns `null` when the entry carries no `message.usage` object at all — the common case, since
 * user turns, tool results, summaries and hook rows have no usage. A present-but-empty usage
 * object yields a zero total, which the `minPromptTokens` floor in `isLaunchCandidate` rejects.
 */
export function extractLaunchUsage(entry: unknown): LaunchUsage | null {
  const record = asRecord(entry);
  if (!record) return null;
  const message = asRecord(record.message);
  if (!message) return null;
  const usage = asRecord(message.usage);
  if (!usage) return null;
  const inputTokens = readFiniteNumber(usage.input_tokens);
  const cacheCreationTokens = readFiniteNumber(usage.cache_creation_input_tokens);
  const cacheReadTokens = readFiniteNumber(usage.cache_read_input_tokens);
  return {
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalPromptTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
  };
}

export type LaunchCandidateOptions = {
  /**
   * Floor below which a usage row is not treated as the launch turn. Defaults to 1000.
   *
   * A transcript can carry small-usage rows before the real first inference (for example a
   * cheap title/summary call), and those would otherwise be reported as a ~200-token launch.
   */
  minPromptTokens?: number;
  /**
   * Include sub-agent (`isSidechain: true`) turns. Defaults to false: a sidechain is a *nested*
   * agent whose prompt is not the session's launch prompt, so counting it answers a different
   * question than the one this instrument exists for.
   */
  includeSidechains?: boolean;
};

export const DEFAULT_MIN_PROMPT_TOKENS = 1000;

/** True when this entry is the session-launch usage row we want to measure. */
export function isLaunchCandidate(
  entry: unknown,
  usage: LaunchUsage,
  options: LaunchCandidateOptions = {},
): boolean {
  const minPromptTokens = options.minPromptTokens ?? DEFAULT_MIN_PROMPT_TOKENS;
  if (usage.totalPromptTokens <= minPromptTokens) return false;
  if (!options.includeSidechains) {
    const record = asRecord(entry);
    if (record?.isSidechain === true) return false;
  }
  return true;
}

/** `YYYY-MM-DD` in UTC. Returns null for an unparseable timestamp rather than inventing a day. */
export function utcDay(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Read the descriptive (non-usage) fields off a transcript entry. All are optional in the wild. */
export function extractSampleContext(entry: unknown): {
  timestamp: string | null;
  model: string | null;
  entrypoint: string | null;
  cliVersion: string | null;
  cwd: string | null;
  sessionId: string | null;
} {
  const record = asRecord(entry);
  const message = asRecord(record?.message);
  return {
    timestamp: readString(record?.timestamp),
    model: readString(message?.model),
    entrypoint: readString(record?.entrypoint),
    cliVersion: readString(record?.version),
    cwd: readString(record?.cwd),
    sessionId: readString(record?.sessionId) ?? readString(record?.session_id),
  };
}

function statsOver(samples: readonly LaunchSample[]): LaunchStats {
  const totals = samples.map((s) => s.totalPromptTokens);
  return {
    count: samples.length,
    medianTotal: median(totals),
    p10Total: percentile(totals, 0.1),
    p90Total: percentile(totals, 0.9),
    minTotal: Math.min(...totals),
    maxTotal: Math.max(...totals),
    medianCacheRead: median(samples.map((s) => s.cacheReadTokens)),
    medianCacheCreation: median(samples.map((s) => s.cacheCreationTokens)),
    medianInput: median(samples.map((s) => s.inputTokens)),
  };
}

/**
 * Aggregate over the whole sample set.
 *
 * Returns `null` — never a zero-filled record — when there are no samples. See the honesty rails
 * in this file's header: the plan is graded on a median moving down, so an empty set rendered as
 * `0` would read as total success.
 */
export function summarizeOverall(samples: readonly LaunchSample[]): LaunchStats | null {
  if (samples.length === 0) return null;
  return statsOver(samples);
}

/** Per-UTC-day aggregates, ascending by day. Days with no samples are absent, not zero-filled. */
export function summarizeByDay(samples: readonly LaunchSample[]): DayStats[] {
  const byDay = new Map<string, LaunchSample[]>();
  for (const sample of samples) {
    const bucket = byDay.get(sample.day);
    if (bucket) bucket.push(sample);
    else byDay.set(sample.day, [sample]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, daySamples]) => ({ day, ...statsOver(daySamples) }));
}
