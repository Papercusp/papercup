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

import { pairedBootstrapCI } from '@papercusp/bench-metrics';
import { isDeepStrictEqual } from 'node:util';

/** The three prompt-side token fields, plus their sum. */
export type LaunchUsage = {
  /** False/absent means the numeric sum is only a known lower bound, not a complete prompt count. */
  usageCountsComplete?: boolean;
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
  /** Samples with missing/invalid usage fields; totals/medians are lower bounds when nonzero. */
  incompleteCount?: number;
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
    usageCountsComplete: ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
      .every(key => typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0),
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
    incompleteCount: samples.filter(s => s.usageCountsComplete !== true).length,
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

export interface CarryUsageObservation {
  inputTotalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Zero before the first observed compaction; null means unknown. */
  contextGeneration: number | null;
}

/**
 * Diagnose the pre-compaction input-volume class separately from cache misses.
 * Routing/TTL can alter cached reads, but cannot remove inherited prompt bytes.
 * This is a diagnostic, NOT the matched-task savings/quality acceptance verdict.
 */
export function diagnoseCarryUsage(
  observations: readonly CarryUsageObservation[],
  inheritedHistory: boolean | null,
  oversizedThreshold = 600_000,
) {
  const first = observations.slice(0, 2);
  const count = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
  const fullFirstTwo = first.length === 2 && first.every(event => count(event.inputTotalTokens));
  const splitKnown = fullFirstTwo && first.every(event => count(event.cacheReadTokens) && count(event.cacheWriteTokens) &&
    event.cacheReadTokens! + event.cacheWriteTokens! <= event.inputTotalTokens!);
  const after = observations.find(event => event.contextGeneration !== null && event.contextGeneration > 0 && count(event.inputTotalTokens));
  const beforeGenerationKnown = first.length === 2 && first.every(event => event.contextGeneration === 0);
  const oversizedThenCompacted = inheritedHistory === true && fullFirstTwo && beforeGenerationKnown &&
    first.every(event => event.inputTotalTokens! >= oversizedThreshold) && after !== undefined &&
    after.inputTotalTokens! < Math.min(...first.map(event => event.inputTotalTokens!));
  return {
    observedRequests: observations.length,
    firstTwoTotalInput: fullFirstTwo ? first.reduce((sum, event) => sum + event.inputTotalTokens!, 0) : null,
    firstTwoUncachedInput: splitKnown ? first.reduce((sum, event) => sum + event.inputTotalTokens! - event.cacheReadTokens! - event.cacheWriteTokens!, 0) : null,
    firstAfterCompactionInput: after?.inputTotalTokens ?? null,
    oversizedThenCompacted,
    // Do not manufacture a remote-cache cause from usage counters alone.
    cacheMissCause: 'undetermined' as const,
    coverage: { firstTwoInput: fullFirstTwo, firstTwoCacheSplit: splitKnown,
      inheritedHistory: inheritedHistory !== null, preCompactionGeneration: beforeGenerationKnown },
  };
}

export type CarryStartupObservation = CarryUsageObservation & {
  requestOrdinal: number | null;
  predecessorSessionId: string | null;
};

/** Provisional structural guard, not a savings verdict or a remote cache-cause diagnosis.
 * Ordinals come from a witnessed source header, never the first row in a report window.
 */
export function evaluateCarryStartup(observations: readonly CarryStartupObservation[]) {
  const ordered = [...observations].sort((a, b) => (a.requestOrdinal ?? Infinity) - (b.requestOrdinal ?? Infinity));
  const first = ordered.filter(row => row.requestOrdinal === 1 || row.requestOrdinal === 2);
  const count = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
  const startupKnown = first.length === 2 && first[0].requestOrdinal === 1 && first[1].requestOrdinal === 2 &&
    first.every(row => count(row.inputTotalTokens) && row.contextGeneration === 0) &&
    first[0].predecessorSessionId === first[1].predecessorSessionId;
  const history = startupKnown ? Boolean(first[0].predecessorSessionId) : null;
  const diagnosis = diagnoseCarryUsage(ordered, history);
  const readKnown = startupKnown && first.every(row => count(row.cacheReadTokens) && row.cacheReadTokens <= row.inputTotalTokens!);
  const large = startupKnown && first.every(row => row.inputTotalTokens! >= 600_000);
  // This is read reuse, not uncached input: unreported write counts remain unknown.
  const coldFork = history === true && large && readKnown &&
    first.every(row => row.cacheReadTokens! / row.inputTotalTokens! <= 0.1);
  const third = ordered.filter(row => row.requestOrdinal === 3);
  const immediateCompaction = history === true && large && third.length === 1 &&
    third[0].contextGeneration === 1 && count(third[0].inputTotalTokens) &&
    third[0].predecessorSessionId === first[0].predecessorSessionId &&
    third[0].inputTotalTokens < Math.min(...first.map(row => row.inputTotalTokens!));
  const unknown: string[] = [];
  if (!startupKnown) unknown.push('startup-prefix-unavailable');
  if (!readKnown) unknown.push('startup-cache-read-unknown');
  if (third.length !== 1 || !count(third[0].contextGeneration) || !count(third[0].inputTotalTokens)) {
    unknown.push('third-request-unavailable');
  }
  const signals = [...(coldFork ? ['cold-inherited-startup'] : []),
    ...(immediateCompaction ? ['oversized-startup-immediately-compacted'] : [])];
  return { state: signals.length ? 'regression' : unknown.length ? 'unknown' : 'ok', signals, unknown,
    firstTwoTotalInput: startupKnown ? diagnosis.firstTwoTotalInput : null,
    firstTwoUncachedInput: startupKnown ? diagnosis.firstTwoUncachedInput : null,
    cacheMissCause: diagnosis.cacheMissCause };
}

export interface CarryNativeTurnEvidence {
  threadId: string;
  turnId: string;
  /** Raw app-server frames, captured before any UI projection. */
  events: readonly unknown[];
  /** Actual thread/read response with includeTurns, not an authored summary. */
  threadRead: unknown;
  /** Exact call signatures fixed in the trial manifest before execution. */
  allowedMcpCalls: readonly { server: string; tool: string; arguments: unknown }[];
}

/** Verify the native ACTION TRACE only. A verified trace is not proof of tool
 * result correctness, source-read success, serving-account identity, complete
 * charges, or task quality. Those still need their independent receipts/oracle.
 * In particular, readOnlyHint is metadata, not permission or evidence.
 */
export function inspectCarryNativeTurn(input: CarryNativeTurnEvidence) {
  const violations = new Set<string>();
  const missing = new Set<string>();
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (value: unknown): string => typeof value === 'string' ? value : '';
  const passive = new Set(['userMessage', 'hookPrompt', 'agentMessage', 'reasoning', 'plan', 'contextCompaction']);
  const forbidden = new Set(['commandExecution', 'fileChange', 'dynamicToolCall', 'collabToolCall',
    'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageView', 'imageGeneration', 'sleep',
    'enteredReviewMode', 'exitedReviewMode', 'functionCallOutput']);
  const checkItem = (item: Record<string, unknown>, completed: boolean) => {
    const id = text(item.id), type = text(item.type);
    if (!id || !type) missing.add('malformed-item');
    if (forbidden.has(type)) violations.add(`forbidden-item:${type}:${id}`);
    else if (type === 'mcpToolCall') {
      if (!input.allowedMcpCalls.some(call => call.server === item.server && call.tool === item.tool &&
        isDeepStrictEqual(call.arguments, item.arguments))) violations.add(`unapproved-mcp-call:${id}`);
      if (completed && (item.status !== 'completed' || item.error != null || !Array.isArray(record(item.result).content))) {
        missing.add(`unsuccessful-mcp-item:${id}`);
      }
    } else if (!passive.has(type)) missing.add(`unknown-item-type:${type}`);
  };
  if (!input.threadId.trim() || !input.turnId.trim()) missing.add('missing-native-identity');
  const thread = record(record(input.threadRead).thread);
  if (thread.id !== input.threadId) missing.add('thread-read-identity-mismatch');
  const turns = Array.isArray(thread.turns) ? thread.turns.filter(turn => record(turn).id === input.turnId) : [];
  if (turns.length !== 1) missing.add('missing-or-duplicate-persisted-turn');
  const turn = record(turns[0]);
  // The native schema defaults an omitted itemsView to full for older rollouts.
  // Explicit summary/notLoaded (and future values) cannot establish completeness.
  if (turn.itemsView !== undefined && turn.itemsView !== 'full') missing.add('persisted-items-not-full');
  if (turn.status !== 'completed' || turn.error != null) missing.add('persisted-turn-not-completed');
  if (!Array.isArray(turn.items)) missing.add('missing-persisted-items');
  const items = Array.isArray(turn.items) ? turn.items.map(record) : [];
  const persisted = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const id = text(item.id);
    if (persisted.has(id)) missing.add(`duplicate-persisted-item:${id}`);
    persisted.set(id, item);
    checkItem(item, true);
  }

  const started = new Map<string, Record<string, unknown>>();
  const completed = new Map<string, Record<string, unknown>>();
  let turnStarts = 0, turnEnds = 0;
  for (const raw of input.events) {
    const frame = record(raw), method = text(frame.method), params = record(frame.params);
    if (!method) { missing.add('malformed-native-event'); continue; }
    if (frame.id != null) { violations.add(`native-server-request:${method}`); continue; }
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)) {
      if (method === 'error') missing.add('native-error-event');
      continue; // Deltas and informational notifications are not completion receipts.
    }
    const isTurn = method.startsWith('turn/');
    const eventTurn = record(params.turn);
    if (params.threadId !== input.threadId || (isTurn ? eventTurn.id : params.turnId) !== input.turnId) {
      missing.add('native-event-identity-mismatch'); continue;
    }
    if (method === 'turn/started') {
      turnStarts++;
      if (eventTurn.status !== 'inProgress') missing.add('native-turn-start-not-in-progress');
      if (turnEnds) missing.add('turn-start-after-completion');
    } else if (method === 'turn/completed') {
      turnEnds++;
      if (turnStarts !== 1 || eventTurn.status !== 'completed' || eventTurn.error != null) missing.add('native-turn-not-completed');
      // Native 0.156 emits summary here. Completeness comes from the full
      // thread/read witness AND the item lifecycle census below, not this empty
      // notification. A supplied full terminal witness must agree as well.
      if (eventTurn.itemsView === 'notLoaded') {
        if (!Array.isArray(eventTurn.items) || eventTurn.items.length) missing.add('malformed-unloaded-terminal-items');
      } else if (eventTurn.itemsView === 'summary') {
        if (!Array.isArray(eventTurn.items) || eventTurn.items.some(item =>
          !isDeepStrictEqual(record(item), persisted.get(text(record(item).id))))) missing.add('terminal-summary-mismatch');
      } else {
        if (eventTurn.itemsView !== undefined && eventTurn.itemsView !== 'full') missing.add('terminal-items-not-full');
        if (!Array.isArray(eventTurn.items) || !isDeepStrictEqual(eventTurn.items, turn.items)) missing.add('terminal-items-mismatch');
      }
      // Inspect both witnesses: an action present only in a terminal event is
      // still an attempted action, even if the persisted read omitted it.
      if (Array.isArray(eventTurn.items)) for (const item of eventTurn.items) checkItem(record(item), true);
    } else {
      const item = record(params.item), id = text(item.id);
      checkItem(item, method === 'item/completed');
      if (turnStarts !== 1 || turnEnds) missing.add('item-outside-active-turn');
      const target = method === 'item/started' ? started : completed;
      if (target.has(id)) missing.add(`duplicate-item-event:${method}:${id}`);
      if (method === 'item/completed' && !started.has(id)) missing.add(`completion-without-start:${id}`);
      target.set(id, item);
    }
  }
  if (turnStarts !== 1 || turnEnds !== 1) missing.add('missing-or-duplicate-turn-boundary');
  for (const id of new Set([...persisted.keys(), ...started.keys(), ...completed.keys()])) {
    const before = started.get(id), after = completed.get(id), stored = persisted.get(id);
    if (!before || !after || !stored) { missing.add(`incomplete-item-lifecycle:${id}`); continue; }
    if (before.type !== after.type || !isDeepStrictEqual(after, stored)) missing.add(`item-receipt-mismatch:${id}`);
    if (before.type === 'mcpToolCall' && (before.server !== after.server || before.tool !== after.tool ||
      !isDeepStrictEqual(before.arguments, after.arguments))) missing.add(`mcp-signature-changed:${id}`);
  }
  let final = items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer');
  // phase is optional in the native protocol. Do not reinterpret commentary;
  // only a single unphased reply at the end of the completed turn is usable.
  if (!final.length) final = items.filter(item => item.type === 'agentMessage' && item.phase == null);
  if (final.length !== 1 || final[0] !== items.at(-1) || typeof final[0]?.text !== 'string' || !final[0].text.trim()) {
    missing.add('missing-or-ambiguous-final-response');
  }
  const status = violations.size ? 'violation' as const : missing.size ? 'incomplete' as const : 'verified' as const;
  return { status, violations: [...violations], missing: [...missing],
    finalResponse: status === 'verified' ? text(final[0].text) : null,
    mcpItemIds: status === 'verified' ? items.filter(item => item.type === 'mcpToolCall').map(item => text(item.id)) : [] };
}

export interface CarryTaskEvaluation {
  /** Stable workload identity shared ONLY by the control/candidate pair. */
  taskId: string;
  arm: 'control' | 'candidate';
  model: string | null;
  transport: string | null;
  authorizationScope: string | null;
  workloadFingerprint: string | null;
  completed: boolean;
  /** Independent task-specific correctness checks, not a self-rated score. */
  quality: 'pass' | 'fail' | 'unverified';
  qualityEvidenceRef: string | null;
  firstUsefulResponseMs: number | null;
  /** Every charged request, including work done BEFORE creating the successor. */
  requests: readonly {
    /** Canonical source-event identity, unique across the entire evaluation. */
    id: string;
    phase: 'preparation' | 'startup' | 'work' | 'compaction' | 'recovery' | 'retry';
    uncachedInputTokens: number | null;
  }[];
  accountingComplete: boolean;
}

/** R-4/R-8 acceptance arithmetic. A passing synthetic test is not a passing live cohort. */
export function evaluateCarryTaskPairs(samples: readonly CarryTaskEvaluation[], minimumPairs = 30) {
  if (!Number.isSafeInteger(minimumPairs) || minimumPairs < 2) throw new Error('minimumPairs must be at least two');
  const insufficient: string[] = [];
  const failures: string[] = [];
  const chargedRequests = new Set<string>();
  const byTask = new Map<string, CarryTaskEvaluation[]>();
  for (const sample of samples) byTask.set(sample.taskId, [...(byTask.get(sample.taskId) ?? []), sample]);
  const pairs: Array<{ control: CarryTaskEvaluation; candidate: CarryTaskEvaluation }> = [];
  for (const [taskId, rows] of byTask) {
    const control = rows.filter(row => row.arm === 'control');
    const candidate = rows.filter(row => row.arm === 'candidate');
    if (!taskId || control.length !== 1 || candidate.length !== 1) {
      insufficient.push(`unpaired-or-duplicate:${taskId}`); continue;
    }
    const a = control[0], b = candidate[0];
    const dimensions = ['model', 'transport', 'authorizationScope', 'workloadFingerprint'] as const;
    if (dimensions.some(key => !a[key] || !b[key] || a[key] !== b[key])) {
      insufficient.push(`unmatched-dimensions:${taskId}`); continue;
    }
    if (!a.completed || !b.completed) failures.push(`incomplete-task:${taskId}`);
    if (a.quality === 'fail' || b.quality === 'fail') failures.push(`quality-failure:${taskId}`);
    if (a.quality === 'unverified' || b.quality === 'unverified' || !a.qualityEvidenceRef || !b.qualityEvidenceRef) {
      insufficient.push(`unverified-quality:${taskId}`);
    }
    for (const row of [a, b]) {
      if (!row.accountingComplete || row.requests.some(request => !request.id ||
        request.uncachedInputTokens === null || !Number.isSafeInteger(request.uncachedInputTokens) || request.uncachedInputTokens < 0) ||
        !Number.isSafeInteger(row.requests.reduce((sum, request) => sum + (request.uncachedInputTokens ?? NaN), 0))) {
        insufficient.push(`incomplete-accounting:${taskId}:${row.arm}`);
      }
      for (const request of row.requests) {
        if (chargedRequests.has(request.id)) insufficient.push(`reused-request:${taskId}:${row.arm}:${request.id}`);
        chargedRequests.add(request.id);
      }
      if (row.requests.filter(request => request.phase === 'startup').length < 2) {
        insufficient.push(`missing-startup:${taskId}:${row.arm}`);
      }
      if (row.firstUsefulResponseMs === null || !Number.isFinite(row.firstUsefulResponseMs) || row.firstUsefulResponseMs < 0) {
        insufficient.push(`missing-latency:${taskId}:${row.arm}`);
      }
    }
    pairs.push({ control: a, candidate: b });
  }
  if (pairs.length < minimumPairs) insufficient.push(`too-few-pairs:${pairs.length}/${minimumPairs}`);
  if (insufficient.length) return { status: failures.length ? 'fail' as const : 'insufficient' as const,
    pairs: pairs.length, insufficient, failures, metrics: null };
  // Seeded resampling must not change when the same ledger rows arrive in a
  // different order. The two arms stay index-aligned by their workload identity.
  pairs.sort((a, b) => a.control.taskId < b.control.taskId ? -1 : a.control.taskId > b.control.taskId ? 1 : 0);
  const total = (arm: 'control' | 'candidate') => pairs.reduce((sum, pair) => sum +
    pair[arm].requests.reduce((n, request) => n + request.uncachedInputTokens!, 0), 0);
  const startup = (arm: 'control' | 'candidate') => pairs.reduce((sum, pair) => sum +
    pair[arm].requests.filter(request => request.phase === 'startup').slice(0, 2)
      .reduce((n, request) => n + request.uncachedInputTokens!, 0), 0);
  const latency = (arm: 'control' | 'candidate') => percentile(pairs.map(pair => pair[arm].firstUsefulResponseMs!), 0.95);
  const controlTotal = total('control'), controlStartup = startup('control'), controlP95 = latency('control');
  const candidateTotal = total('candidate'), candidateStartup = startup('candidate'), candidateP95 = latency('candidate');
  if (![controlTotal, controlStartup, candidateTotal, candidateStartup].every(Number.isSafeInteger)) return {
    status: 'insufficient' as const, pairs: pairs.length, insufficient: ['unsafe-aggregate-token-total'], failures, metrics: null,
  };
  if (controlTotal <= 0 || controlStartup <= 0 || controlP95 <= 0) return {
    status: 'insufficient' as const, pairs: pairs.length, insufficient: ['zero-control-denominator'], failures, metrics: null,
  };
  const bootstrap = { ci: 0.95, iterations: 10_000, seed: 12345 };
  const taskCounts = (arm: 'control' | 'candidate', startupOnly: boolean) => pairs.map(pair => {
    const requests = startupOnly ? pair[arm].requests.filter(request => request.phase === 'startup').slice(0, 2)
      : pair[arm].requests;
    return requests.reduce((sum, request) => sum + request.uncachedInputTokens!, 0);
  });
  const uncertainty = {
    method: 'paired-bootstrap-mean-difference' as const,
    resamplingUnit: 'task-pair' as const,
    ...bootstrap,
    // Candidate minus control; these intervals describe mean token differences,
    // not the pooled reduction ratios or the p95 latency metric below.
    firstTwo: pairedBootstrapCI(taskCounts('control', true), taskCounts('candidate', true), bootstrap),
    task: pairedBootstrapCI(taskCounts('control', false), taskCounts('candidate', false), bootstrap),
  };
  const metrics = { controlTotal, candidateTotal, controlStartup, candidateStartup, controlP95, candidateP95,
    firstTwoUncachedReduction: 1 - candidateStartup / controlStartup,
    taskUncachedReduction: 1 - candidateTotal / controlTotal,
    p95LatencyChange: candidateP95 / controlP95 - 1, uncertainty };
  if (metrics.firstTwoUncachedReduction < 0.5) failures.push('first-two-reduction-below-50-percent');
  if (metrics.taskUncachedReduction < 0.25) failures.push('task-reduction-below-25-percent');
  if (metrics.p95LatencyChange > 0.1 + Number.EPSILON) failures.push('p95-latency-regression-above-10-percent');
  if (uncertainty.firstTwo.delta.upper >= 0) insufficient.push('first-two-improvement-not-supported-by-paired-95-ci');
  if (uncertainty.task.delta.upper >= 0) insufficient.push('task-improvement-not-supported-by-paired-95-ci');
  return { status: failures.length ? 'fail' as const : insufficient.length ? 'insufficient' as const : 'pass' as const,
    pairs: pairs.length, insufficient, failures, metrics };
}
