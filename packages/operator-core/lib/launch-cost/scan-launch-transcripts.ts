/**
 * Launch-cost metrics — the STREAMING half of the baseline instrument
 * (plan `agent-launch-context-cost-2026-09-18`, P-001).
 *
 * ⚠ WHY THIS STREAMS, AND WHY THAT IS THE WHOLE POINT OF THE FILE.
 * A psu Claude transcript's first entry is the system prompt, and it is ~580 KB on ONE line. The
 * first row carrying `message.usage` — the launch measurement — sits after it. So any reader that
 * looks at a bounded prefix of the file (a 600 KB read window, a `head -c`, a capped file-read
 * tool) never reaches the usage row and returns ZERO ROWS. Zero rows is indistinguishable from
 * "this session has no usage data", which is exactly the reading that makes an agent conclude the
 * corpus is empty and move on. Every read here is a `createReadStream` + `readline` pass that
 * stops at the first qualifying row, so the window can never be the reason a file measures empty.
 * `scan-launch-transcripts.test.ts` pins this with a fixture whose usage row sits past 600 KB.
 *
 * SKIPS ARE COUNTED, NOT SWALLOWED. Every file that yields no sample lands in `skipped` with a
 * typed reason. An instrument that silently drops files reports a smaller, cleaner-looking corpus
 * than it measured, and the difference is invisible at the call site.
 */

import { createReadStream } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

import {
  DEFAULT_MIN_PROMPT_TOKENS,
  extractLaunchUsage,
  extractSampleContext,
  isLaunchCandidate,
  utcDay,
  type LaunchSample,
} from './launch-cost-metrics';

export type SkipReason =
  /** File was read to EOF and carried no `message.usage` row at all. */
  | 'no-usage-row'
  /** Usage rows existed but every one sat at or below the `minPromptTokens` floor. */
  | 'all-below-threshold'
  /** No qualifying sample and at least one incomplete usage row: size cannot be established. */
  | 'incomplete-usage'
  /** The only qualifying rows were sub-agent turns and sidechains were excluded. */
  | 'sidechain-only'
  /** A sample was found but excluded by a caller filter (day window, model, owner prefix). */
  | 'filtered-out'
  /** The measured row had no parseable timestamp, so it cannot be placed on a day. */
  | 'undatable'
  /** The file could not be read (permissions, disappeared mid-scan, IO error). */
  | 'unreadable';

export type SkippedFile = {
  filePath: string;
  reason: SkipReason;
  detail?: string;
};

export type ScanOptions = {
  /** Transcript root, e.g. `~/.papercusp/session-claude`. */
  root: string;
  minPromptTokens?: number;
  includeSidechains?: boolean;
  /** Inclusive UTC `YYYY-MM-DD` lower bound on the measured entry's day. */
  since?: string;
  /** Inclusive UTC `YYYY-MM-DD` upper bound on the measured entry's day. */
  until?: string;
  /** Keep only owners whose id starts with this (e.g. `su-` for superuser sessions). */
  ownerPrefix?: string;
  /** Keep only samples whose model contains this substring (e.g. `opus`). */
  modelContains?: string;
  /** Max files read in parallel. Defaults to 8. */
  concurrency?: number;
  /** Bound the walk depth below `root`. Defaults to 8; the real layout needs 3. */
  maxDepth?: number;
};

export type ScanReport = {
  root: string;
  samples: LaunchSample[];
  filesScanned: number;
  filesMeasured: number;
  skipped: SkippedFile[];
  /** Skip counts by reason — the census a reader needs before trusting a small sample set. */
  skippedByReason: Record<SkipReason, number>;
};

/**
 * Recursively collect `*.jsonl` paths under `root`.
 *
 * Does NOT follow directory symlinks. The repo guide's `find -L` incident (a symlink DAG through
 * `node_modules/@papercusp/*` that ran 32h and consumed 1.86 TB of swap) is the reason: a
 * transcript tree has no legitimate need to traverse a link, and an unbounded symlink walk is
 * indistinguishable from a hang. `maxDepth` is a second, independent bound.
 */
export async function collectTranscriptFiles(root: string, maxDepth = 8): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    for await (const entry of handle) {
      // isSymbolicLink() is checked BEFORE isDirectory(): a symlink to a directory reports
      // isDirectory() === false from opendir's dirent, but being explicit keeps the intent
      // readable and survives a future switch to a stat-following API.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  found.sort();
  return found;
}

/**
 * Derive the owner id from a transcript path: the first segment below `root`.
 * Layout is `<root>/<ownerId>/projects/<munged-cwd>/<sessionId>.jsonl`.
 */
export function ownerIdFromPath(root: string, filePath: string): string {
  const rel = relative(root, filePath);
  const first = rel.split(sep)[0];
  return first && first !== '..' ? first : 'unknown';
}

type FileOutcome = { sample: LaunchSample } | { skip: SkippedFile };

/**
 * Read ONE transcript and return its launch sample, or a typed skip.
 *
 * Exported so a caller can measure a single session without walking a tree, and so the streaming
 * guarantee can be tested in isolation.
 */
export async function measureTranscriptFile(
  filePath: string,
  options: ScanOptions,
): Promise<FileOutcome> {
  const minPromptTokens = options.minPromptTokens ?? DEFAULT_MIN_PROMPT_TOKENS;
  const includeSidechains = options.includeSidechains ?? false;
  const ownerId = ownerIdFromPath(options.root, filePath);

  if (options.ownerPrefix && !ownerId.startsWith(options.ownerPrefix)) {
    return { skip: { filePath, reason: 'filtered-out', detail: `owner ${ownerId}` } };
  }

  let sawUsageRow = false;
  let sawBelowThreshold = false;
  let sawIncompleteUsage = false;
  let sawSidechainOnly = false;
  let found: { entry: unknown; lineNumber: number; bytesBefore: number } | null = null;
  let readError: string | null = null;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let bytesConsumed = 0;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      // +1 for the newline the reader stripped. Approximate for multi-byte content, which is
      // fine: this figure is evidence for "the usage row sits deep in the file", not an exact
      // byte offset anyone indexes with.
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) {
        bytesConsumed += lineBytes;
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        bytesConsumed += lineBytes;
        continue;
      }
      const usage = extractLaunchUsage(entry);
      if (!usage) {
        bytesConsumed += lineBytes;
        continue;
      }
      sawUsageRow = true;
      if (usage.usageCountsComplete !== true) sawIncompleteUsage = true;
      if (usage.totalPromptTokens <= minPromptTokens) {
        sawBelowThreshold = true;
        bytesConsumed += lineBytes;
        continue;
      }
      if (!isLaunchCandidate(entry, usage, { minPromptTokens, includeSidechains })) {
        // Passed the token floor, so the only remaining rejection is the sidechain rule.
        sawSidechainOnly = true;
        bytesConsumed += lineBytes;
        continue;
      }
      found = { entry, lineNumber, bytesBefore: bytesConsumed };
      break;
    }
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  } finally {
    // Close both ends. `reader.close()` alone leaves the underlying stream open, and a
    // partially-drained readline can still emit one more buffered line to a stale listener —
    // the exact behaviour that made an earlier ad-hoc probe print two "first" rows.
    reader.close();
    stream.destroy();
  }

  if (readError) return { skip: { filePath, reason: 'unreadable', detail: readError } };
  if (!found) {
    if (sawSidechainOnly) return { skip: { filePath, reason: 'sidechain-only' } };
    if (sawIncompleteUsage) return { skip: { filePath, reason: 'incomplete-usage' } };
    if (sawBelowThreshold) return { skip: { filePath, reason: 'all-below-threshold' } };
    if (sawUsageRow) return { skip: { filePath, reason: 'all-below-threshold' } };
    return { skip: { filePath, reason: 'no-usage-row' } };
  }

  const usage = extractLaunchUsage(found.entry)!;
  const context = extractSampleContext(found.entry);
  const day = utcDay(context.timestamp);
  if (!day) {
    return { skip: { filePath, reason: 'undatable', detail: String(context.timestamp) } };
  }
  if (options.since && day < options.since) {
    return { skip: { filePath, reason: 'filtered-out', detail: `day ${day} < since` } };
  }
  if (options.until && day > options.until) {
    return { skip: { filePath, reason: 'filtered-out', detail: `day ${day} > until` } };
  }
  if (options.modelContains && !(context.model ?? '').includes(options.modelContains)) {
    return { skip: { filePath, reason: 'filtered-out', detail: `model ${context.model}` } };
  }

  return {
    sample: {
      ...usage,
      ownerId,
      sessionId: context.sessionId ?? basename(filePath, '.jsonl'),
      filePath,
      timestamp: context.timestamp!,
      day,
      model: context.model,
      entrypoint: context.entrypoint,
      cliVersion: context.cliVersion,
      cwd: context.cwd,
      lineNumber: found.lineNumber,
      bytesBeforeSample: found.bytesBefore,
    },
  };
}

const EMPTY_SKIP_CENSUS: Record<SkipReason, number> = {
  'no-usage-row': 0,
  'all-below-threshold': 0,
  'incomplete-usage': 0,
  'sidechain-only': 0,
  'filtered-out': 0,
  undatable: 0,
  unreadable: 0,
};

/** Walk `root`, measure every transcript, and return samples plus a full skip census. */
export async function scanLaunchTranscripts(options: ScanOptions): Promise<ScanReport> {
  const files = await collectTranscriptFiles(options.root, options.maxDepth ?? 8);
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const samples: LaunchSample[] = [];
  const skipped: SkippedFile[] = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= files.length) return;
      const outcome = await measureTranscriptFile(files[index]!, options);
      if ('sample' in outcome) samples.push(outcome.sample);
      else skipped.push(outcome.skip);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));

  samples.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const skippedByReason = { ...EMPTY_SKIP_CENSUS };
  for (const skip of skipped) skippedByReason[skip.reason] += 1;

  return {
    root: options.root,
    samples,
    filesScanned: files.length,
    filesMeasured: samples.length,
    skipped,
    skippedByReason,
  };
}
