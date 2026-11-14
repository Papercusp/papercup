/**
 * The git-sync CONTENT GUARD (git-sync-content-guard-2026-06-13 P-001).
 *
 * Before git-sync's `git add -A && commit`, this enumerates the dirty
 * content-bearing files and runs each registered content detector whose scope
 * matches. Offenders ({ file, detectorKey, error }) are returned so the commit
 * path can EXCLUDE them (D-001: quarantine-don't-stall) and the action layer can
 * escalate + dispatch a content-fixer — instead of git-sync auto-committing a
 * file that hard-fails a downstream build (EI-438: a bare `<date>` broke every
 * agent's docs build for hours).
 *
 * PURE + seam-injected (runGit, readText, detectors) so it unit-tests without a
 * real repo. FAILS OPEN by design: a detector — or a file read — that THROWS is
 * logged and skipped (the file commits normally), so a content-check bug can
 * never wedge the whole fleet's commit. Only a clean "this file is broken"
 * verdict excludes a file.
 */
import { createHash } from 'node:crypto';
import type { RunGit } from './run-git-sync';
import type { ContentDetector, ContentDetectorContext } from '../../content-lint/registry';
import { DEFAULT_SCAN_CHUNK_BYTES, partitionBlobsForScan } from '../../sync/pot-git/chunked-blob-scan';
import type { RunGitStdin } from '../../sync/pot-git/storage';

/** One dirty file that failed a content detector — excluded from the commit + handed to the fixer. */
export interface ContentOffender {
  /** Repo-relative path within the (sub)repo. */
  file: string;
  /** Which detector flagged it (e.g. 'mdx', 'smart-quotes'). */
  detectorKey: string;
  /** Human-readable error — fed to the escalation body + the content-fixer prompt. */
  error: string;
  /** The role git-sync dispatches to fix this offender (the detector's fixerRole). */
  fixerRole: string;
  /**
   * SHA-256 of the exact working-tree text that produced this finding.
   * Optional because structural guards (deletion/import findings) have no
   * content snapshot to hash.
   */
  contentHash?: string;
  /**
   * SHA-256 of the detector identity + result that produced this finding.
   * Binding the result as well as the text prevents a dispatch from silently
   * following a detector whose verdict changed while the work was queued.
   */
  detectorResultHash?: string;
  /**
   * WI-6554700010008496: for a `quarantined-importer` finding, the EXCLUDED path
   * at the bottom of the import chain — not the intermediate importer this file
   * imports directly. Without it, a held file names only its neighbour, and
   * finding the file that actually blocks the chain meant walking imports by hand.
   */
  excludedRoot?: string;
  /** Why `excludedRoot` itself was excluded (turn hold, live lock, content error, …). */
  excludedRootReason?: string;
}

/** Stable content CAS token shared by the guard and action-layer revalidation. */
export function contentSnapshotHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable detector-result token shared by the guard and action-layer revalidation. */
export function detectorResultHash(detectorKey: string, error: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ detectorKey, error }), 'utf8')
    .digest('hex');
}

export interface ContentGuardDeps {
  runGit: RunGit;
  /** Absolute path of the (sub)repo being guarded. */
  repoPath: string;
  /** Read a repo-relative file's working-tree text; null when unreadable/gone. */
  readText: (relPath: string) => Promise<string | null>;
  /**
   * Write a repo-relative file's working-tree text (WI-276 deterministic pre-pass).
   * When provided, an offender whose detector declares an `autoFix` that FULLY
   * resolves the error is repaired in place — written back so it commits this tick
   * instead of being quarantined for the LLM fixer. Omit to disable auto-repair
   * (the guard then only detects + quarantines, exactly as before).
   */
  writeText?: (relPath: string, text: string) => Promise<void>;
  /** The registered content detectors to run (default registry in production). */
  detectors: ContentDetector[];
  log?: (m: string) => void;
  /** Monotonic millisecond clock seam for deterministic slow-pass diagnostics tests. */
  clock?: () => number;
  /**
   * EI-21230011589307899: optional sink, filled with `path → contentSnapshotHash(text)`
   * for every file this pass actually judged (the text the detectors saw, after any
   * auto-repair). The post-stage rescan ({@link detectUnscannedStagedOffenders}) uses
   * it to tell a staged blob this pass already judged from one it never saw.
   */
  scanned?: Map<string, string>;
}

/**
 * Drop `superproject-only` detectors when `repoPath` is a submodule (or unknown).
 * Shared by the pre-stage pass and the post-stage rescan so both judge with the
 * SAME detector set — a rescan that ran a wider set would quarantine files the
 * pre-stage pass deliberately lets through.
 */
async function resolveActiveDetectors(
  runGit: RunGit,
  repoPath: string,
  detectors: ContentDetector[],
  log?: (m: string) => void,
): Promise<ContentDetector[]> {
  if (!detectors.some((d) => d.repoScope === 'superproject-only')) return detectors;
  const superproject = await isSuperprojectRepo(runGit, repoPath, log);
  if (superproject) return detectors;
  const active = detectors.filter((d) => d.repoScope !== 'superproject-only');
  log?.(
    `[content-guard] ${repoPath}: skipping ${detectors.length - active.length} ` +
      `superproject-only detector(s) here`,
  );
  return active;
}

/** The detectors whose `matches` targets `file` (a throwing `matches` is logged + skipped). */
async function detectorsTargeting(
  file: string,
  active: ContentDetector[],
  repoPath: string,
  log?: (m: string) => void,
  recordMatch?: (detector: ContentDetector, elapsedMs: number, matched: boolean, errored: boolean) => void,
  clock: () => number = () => performance.now(),
): Promise<ContentDetector[]> {
  const dets: ContentDetector[] = [];
  for (const d of active) {
    const startedAt = clock();
    let matched = false;
    let errored = false;
    try {
      matched = await d.matches(file, { repoPath });
      if (matched) dets.push(d);
    } catch (e) {
      errored = true;
      log?.(`[content-guard] detector "${d.key}" match() threw on ${file} — skipping: ${errMsg(e)}`);
    } finally {
      recordMatch?.(d, Math.max(0, clock() - startedAt), matched, errored);
    }
  }
  return dets;
}

/**
 * Parse `git status --porcelain -z -uall` into the dirty, content-bearing
 * repo-relative paths. Skips DELETIONS (no content to check) and resolves the
 * `-z` rename/copy pair encoding ("XY new\0old") — the SAME parse
 * findOversizedDirtyFiles uses, kept independent so neither well-tested path
 * perturbs the other.
 */
export function parseDirtyPaths(porcelainZ: string): string[] {
  const entries = porcelainZ.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy.includes('R') || xy.includes('C')) i++; // -z renames: "XY new\0old" — skip the origin path
    if (xy.includes('D')) continue; // deletion — no working-tree blob to check
    out.push(path);
  }
  return out;
}

/** Bounded-concurrency map (avoid a serial fs loop — CLAUDE.md perf anti-patterns). */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

const MAX_READ_CONCURRENCY = 16;

/**
 * Run every registered detector whose `matches` is true over the dirty files,
 * collecting offenders. Only reads files at least one detector targets (no fs
 * cost for the rest). FAILS OPEN — a throwing detector/read is skipped, never an
 * offender.
 */
export async function detectContentOffenders(deps: ContentGuardDeps): Promise<ContentOffender[]> {
  const { runGit, repoPath, readText, writeText, detectors, log } = deps;
  if (detectors.length === 0) return [];

  const clock = deps.clock ?? (() => performance.now());
  const passStartedAt = clock();
  const perDetector = new Map<string, {
    key: string;
    matchCalls: number;
    matchedPathCount: number;
    matchMs: number;
    matchErrors: number;
    detectCalls: number;
    detectMs: number;
    detectErrors: number;
    autoFixCalls: number;
    autoFixMs: number;
  }>();
  const detectorMetrics = (key: string) => {
    let metric = perDetector.get(key);
    if (!metric) {
      metric = {
        key,
        matchCalls: 0,
        matchedPathCount: 0,
        matchMs: 0,
        matchErrors: 0,
        detectCalls: 0,
        detectMs: 0,
        detectErrors: 0,
        autoFixCalls: 0,
        autoFixMs: 0,
      };
      perDetector.set(key, metric);
    }
    return metric;
  };
  const metrics = {
    activeDetectorResolutionMs: 0,
    statusCalls: 0,
    statusMs: 0,
    statusError: false,
    dirtyPathCount: 0,
    targetMatchingMs: 0,
    targetedPathCount: 0,
    detectorTargetCount: 0,
    readCalls: 0,
    readMs: 0,
    readMissingCount: 0,
    readErrorCount: 0,
    detectorCalls: 0,
    detectorMs: 0,
    offenderCount: 0,
  };
  const emitSlowPassMetrics = (activeDetectorCount: number): void => {
    const elapsedMs = Math.max(0, clock() - passStartedAt);
    if (elapsedMs < 10_000 || !log) return;
    const summary = {
      event: 'slow-pass',
      repoPath,
      elapsedMs: Math.round(elapsedMs),
      registeredDetectorCount: detectors.length,
      activeDetectorCount,
      activeDetectorResolutionMs: Math.round(metrics.activeDetectorResolutionMs),
      statusCalls: metrics.statusCalls,
      statusMs: Math.round(metrics.statusMs),
      statusError: metrics.statusError,
      dirtyPathCount: metrics.dirtyPathCount,
      targetMatchingMs: Math.round(metrics.targetMatchingMs),
      targetedPathCount: metrics.targetedPathCount,
      detectorTargetCount: metrics.detectorTargetCount,
      readConcurrency: MAX_READ_CONCURRENCY,
      readCalls: metrics.readCalls,
      readMs: Math.round(metrics.readMs),
      readMissingCount: metrics.readMissingCount,
      readErrorCount: metrics.readErrorCount,
      detectorCalls: metrics.detectorCalls,
      detectorMs: Math.round(metrics.detectorMs),
      offenderCount: metrics.offenderCount,
      perDetector: Array.from(perDetector.values())
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((metric) => ({
          ...metric,
          matchMs: Math.round(metric.matchMs),
          detectMs: Math.round(metric.detectMs),
          autoFixMs: Math.round(metric.autoFixMs),
        })),
    };
    try {
      log('[git-sync:content-guard] ' + JSON.stringify(summary));
    } catch {
      // Diagnostics never change whether a dirty file is quarantined or committed.
    }
  };

  // EI-19381677675617429 — honour `repoScope`. git-sync runs this guard for the
  // superproject AND for every submodule with the SAME detector list, while `matches`
  // only ever sees a path relative to whichever repo is being guarded — so a
  // superproject-only rule cannot scope itself and must be filtered here, where
  // `repoPath` is known.
  //
  // Resolved ONCE per invocation and ONLY when some detector actually asks, so a repo
  // with no scoped detector pays no extra git call. FAILS OPEN IN THE SAFE DIRECTION:
  // "unknown" is treated like "submodule" and DROPS the scoped detector, because the
  // costly mistake is the other way round — 45 submodule files carry identity literals
  // by design (redacted at tar time), so wrongly running a superproject-only detector
  // inside a submodule would quarantine them from every commit, fleet-wide.
  const activeStartedAt = clock();
  const active = await resolveActiveDetectors(runGit, repoPath, detectors, log);
  metrics.activeDetectorResolutionMs = Math.max(0, clock() - activeStartedAt);
  if (active.length === 0) {
    emitSlowPassMetrics(0);
    return [];
  }

  metrics.statusCalls++;
  const statusStartedAt = clock();
  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  metrics.statusMs = Math.max(0, clock() - statusStartedAt);
  if (r.code !== 0) {
    metrics.statusError = true;
    emitSlowPassMetrics(active.length);
    return []; // can't list — fail open (the commit proceeds as today)
  }

  // Pair each dirty path with the detectors that target it; drop paths no detector wants.
  const targets: Array<{ file: string; dets: ContentDetector[] }> = [];
  const dirtyPaths = parseDirtyPaths(r.stdout);
  metrics.dirtyPathCount = dirtyPaths.length;
  const targetMatchingStartedAt = clock();
  for (const file of dirtyPaths) {
    const dets = await detectorsTargeting(
      file,
      active,
      repoPath,
      log,
      (detector, elapsedMs, matched, errored) => {
        const metric = detectorMetrics(detector.key);
        metric.matchCalls++;
        metric.matchMs += elapsedMs;
        if (matched) metric.matchedPathCount++;
        if (errored) metric.matchErrors++;
      },
      clock,
    );
    if (dets.length > 0) {
      metrics.targetedPathCount++;
      metrics.detectorTargetCount += dets.length;
      targets.push({ file, dets });
    }
  }
  metrics.targetMatchingMs = Math.max(0, clock() - targetMatchingStartedAt);

  const offenders: ContentOffender[] = [];
  await mapPool(targets, MAX_READ_CONCURRENCY, async ({ file, dets }) => {
    let text: string | null;
    const readStartedAt = clock();
    metrics.readCalls++;
    try {
      text = await readText(file);
    } catch (e) {
      metrics.readErrorCount++;
      metrics.readMs += Math.max(0, clock() - readStartedAt);
      log?.(`[content-guard] could not read ${file} — skipping (not blocking): ${errMsg(e)}`);
      return;
    }
    metrics.readMs += Math.max(0, clock() - readStartedAt);
    if (text == null) {
      metrics.readMissingCount++;
      return; // gone/unreadable — nothing to check
    }
    // The working-tree text we detected on — the CAS baseline for a deterministic
    // auto-repair write, so we never clobber a concurrent editor's newer content.
    let baseline = text;
    for (const d of dets) {
      const measuredDetector: ContentDetector = {
        ...d,
        detect: async (targetFile, targetText, context) => {
          const metric = detectorMetrics(d.key);
          metric.detectCalls++;
          metrics.detectorCalls++;
          const detectStartedAt = clock();
          try {
            return await d.detect(targetFile, targetText, context);
          } catch (error) {
            metric.detectErrors++;
            throw error;
          } finally {
            const elapsedMs = Math.max(0, clock() - detectStartedAt);
            metric.detectMs += elapsedMs;
            metrics.detectorMs += elapsedMs;
          }
        },
        ...(d.autoFix
          ? {
              autoFix: (targetText: string, targetFile: string) => {
                const metric = detectorMetrics(d.key);
                metric.autoFixCalls++;
                const repairStartedAt = clock();
                try {
                  return d.autoFix!(targetText, targetFile);
                } finally {
                  metric.autoFixMs += Math.max(0, clock() - repairStartedAt);
                }
              },
            }
          : {}),
      };
      try {
        const error = await measuredDetector.detect(file, text, { repoPath });
        if (!error) continue;
        // WI-276 deterministic pre-pass: try the detector's own safe repair BEFORE
        // quarantining + dispatching the LLM fixer. Applied only to an ALREADY-failing
        // file, and kept only when it FULLY resolves the error (re-detect clean).
        if (measuredDetector.autoFix && writeText) {
          const repaired = await tryAutoFix(measuredDetector, file, text, baseline, { repoPath }, { readText, writeText, log });
          if (repaired != null) {
            text = repaired; // subsequent detectors see the repaired text
            baseline = repaired; // and future writes CAS against the just-written content
            continue; // no offender recorded — the file commits normally this tick
          }
        }
        // Not (fully) auto-repairable — quarantine + dispatch the LLM fixer, as before.
        offenders.push({
          file,
          detectorKey: d.key,
          error,
          fixerRole: d.fixerRole,
          contentHash: contentSnapshotHash(text),
          detectorResultHash: detectorResultHash(d.key, error),
        });
      } catch (e) {
        // FAIL OPEN — a content-check bug must never block the whole tree's commit.
        log?.(`[content-guard] detector "${d.key}" threw on ${file} — skipping (not blocking): ${errMsg(e)}`);
      }
    }
    // The text every detector above judged (post-repair). Recorded for offenders too:
    // their exclusion keeps them out of the index, so the hash is never consulted.
    deps.scanned?.set(file, contentSnapshotHash(text));
  });
  metrics.offenderCount = offenders.length;
  emitSlowPassMetrics(active.length);
  return offenders;
}

/** Inputs for {@link detectUnscannedStagedOffenders}. */
export interface StagedRescanDeps {
  /** Bound to the index the guarded commit records (an attributed group's private index). */
  runGit: RunGit;
  /** Optional byte-safe `cat-file --batch` runner bound to the same index. */
  runGitStdin?: RunGitStdin;
  repoPath: string;
  /** The staged paths (`git diff --cached --name-only`), deletions included. */
  staged: readonly string[];
  /** The pre-stage pass's `scanned` sink: path → hash of the text it judged. */
  scanned: ReadonlyMap<string, string>;
  detectors: ContentDetector[];
  log?: (m: string) => void;
}

interface StagedIndexEntry {
  mode: string;
  oid: string;
  stage: number;
}

interface StagedBlobBatchEntry {
  oid: string;
  path: string;
  bytes: number;
}

const MAX_STAGED_INDEX_PATHS_PER_QUERY = 256;
const MAX_STAGED_INDEX_PATH_BYTES_PER_QUERY = 64 * 1024;
const MAX_CAT_FILE_BATCH_CHECK_OIDS = 1024;

function stagedPathBatches(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path, 'utf8') + 1;
    if (batch.length > 0 && (batch.length >= MAX_STAGED_INDEX_PATHS_PER_QUERY || bytes + pathBytes > MAX_STAGED_INDEX_PATH_BYTES_PER_QUERY)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += pathBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function parseStagedIndexEntries(output: string): Map<string, StagedIndexEntry[]> | null {
  if (output && !output.endsWith('\0')) return null;
  const byPath = new Map<string, StagedIndexEntry[]>();
  for (const record of output.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) return null;
    const [mode, oid, stageText, ...extra] = record.slice(0, tab).split(' ');
    const stage = Number(stageText);
    if (extra.length > 0 || !/^[0-7]{6}$/.test(mode ?? '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid ?? '') ||
        !Number.isInteger(stage) || stage < 0 || stage > 3) return null;
    const path = record.slice(tab + 1);
    const rows = byPath.get(path) ?? [];
    rows.push({ mode: mode!, oid: oid!, stage });
    byPath.set(path, rows);
  }
  return byPath;
}

function parseCatFileBatchCheck(output: Buffer, expectedOids: readonly string[]): Map<string, { type: string; bytes: number } | null> | null {
  const lines = output.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== expectedOids.length) return null;
  const byOid = new Map<string, { type: string; bytes: number } | null>();
  for (let i = 0; i < expectedOids.length; i++) {
    const fields = lines[i]!.split(' ');
    const oid = expectedOids[i]!;
    if (fields[0] !== oid) return null;
    if (fields.length === 2 && fields[1] === 'missing') {
      byOid.set(oid, null);
      continue;
    }
    if (fields.length !== 3) return null;
    const bytes = Number(fields[2]);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
    byOid.set(oid, { type: fields[1]!, bytes });
  }
  return byOid;
}

/** Parse `cat-file --batch` by the byte sizes in its headers; blob bodies may contain any byte. */
function parseCatFileBatch(output: Buffer, expected: readonly StagedBlobBatchEntry[]): Map<string, string> | null {
  const contents = new Map<string, string>();
  let offset = 0;
  for (const entry of expected) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) return null;
    const [oid, type, sizeText, ...extra] = output.toString('ascii', offset, newline).split(' ');
    const size = Number(sizeText);
    if (extra.length > 0 || oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size !== entry.bytes) return null;
    const bodyStart = newline + 1;
    const bodyEnd = bodyStart + size;
    if (bodyEnd >= output.length || output[bodyEnd] !== 0x0a) return null;
    contents.set(entry.oid, output.subarray(bodyStart, bodyEnd).toString('utf8'));
    offset = bodyEnd + 1;
  }
  return offset === output.length ? contents : null;
}

/** Inputs for {@link readStagedIndexTextsFromGit}. */
export interface StagedIndexTextReadDeps {
  /** Bound to the index the guarded commit records (an attributed group's private index). */
  runGit: RunGit;
  /** Optional byte-safe `cat-file --batch` runner bound to the same index. */
  runGitStdin?: RunGitStdin;
  repoPath: string;
  paths: readonly string[];
  log?: (message: string) => void;
  /** Diagnostic prefix for fail-open fallbacks; defaults to the content guard. */
  logLabel?: string;
}

/**
 * Read selected index blobs with the content guard's bounded, byte-safe batch path.
 * Missing index entries stay null (for example, staged deletions); unsupported entries
 * and failed batches fall back to per-path `git show :path` reads.
 */
export async function readStagedIndexTextsFromGit(
  deps: StagedIndexTextReadDeps,
): Promise<ReadonlyMap<string, string | null>> {
  const { runGit, runGitStdin, repoPath, paths, log } = deps;
  const label = deps.logLabel ?? 'content-guard';
  const uniquePaths = [...new Set(paths)];
  const textByPath = new Map<string, string | null>(uniquePaths.map((path) => [path, null]));
  if (uniquePaths.length === 0) return textByPath;

  const readIndividually = async (items: readonly string[]): Promise<void> =>
    mapPool([...items], MAX_READ_CONCURRENCY, async (path) => {
      const blob = await runGit(['show', `:${path}`], repoPath);
      if (blob.code === 0) textByPath.set(path, blob.stdout);
    });

  if (!runGitStdin) {
    await readIndividually(uniquePaths);
    return textByPath;
  }

  let indexRows: Map<string, StagedIndexEntry[]> | null = new Map();
  try {
    for (const chunk of stagedPathBatches(uniquePaths)) {
      const listed = await runGit(['ls-files', '--stage', '-z', '--', ...chunk], repoPath, {
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
      if (listed.code !== 0) { indexRows = null; break; }
      const parsed = parseStagedIndexEntries(listed.stdout);
      if (!parsed) { indexRows = null; break; }
      for (const [path, rows] of parsed) indexRows.set(path, [...(indexRows.get(path) ?? []), ...rows]);
    }
  } catch {
    indexRows = null;
  }
  if (!indexRows) {
    log?.(`[${label}] ${repoPath}: could not list the guarded index for batch reads; falling back to per-file reads`);
    await readIndividually(uniquePaths);
    return textByPath;
  }

  const byOid = new Map<string, string[]>();
  const fallback = new Set<string>();
  const indexedPaths: string[] = [];
  for (const path of uniquePaths) {
    const rows = indexRows.get(path) ?? [];
    // A successful census proves there is no staged blob for this path.
    if (rows.length === 0) continue;
    indexedPaths.push(path);
    if (rows.length !== 1 || rows[0]!.stage !== 0 || rows[0]!.mode === '160000') {
      fallback.add(path);
      continue;
    }
    const linkedPaths = byOid.get(rows[0]!.oid) ?? [];
    linkedPaths.push(path);
    byOid.set(rows[0]!.oid, linkedPaths);
  }

  const uniqueOids = [...byOid.keys()];
  const sizes = new Map<string, { type: string; bytes: number } | null>();
  let checkFailed = false;
  try {
    for (let start = 0; start < uniqueOids.length; start += MAX_CAT_FILE_BATCH_CHECK_OIDS) {
      const oids = uniqueOids.slice(start, start + MAX_CAT_FILE_BATCH_CHECK_OIDS);
      const checked = await runGitStdin(
        ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
        repoPath,
        `${oids.join('\n')}\n`,
      );
      if (checked.code !== 0) throw new Error('cat-file batch-check failed');
      const parsed = parseCatFileBatchCheck(checked.stdout, oids);
      if (!parsed) throw new Error('cat-file batch-check output was malformed');
      for (const [oid, detail] of parsed) sizes.set(oid, detail);
    }
  } catch {
    checkFailed = true;
  }
  if (checkFailed) {
    log?.(`[${label}] ${repoPath}: staged blob batch-check failed; falling back to per-file reads`);
    await readIndividually(indexedPaths);
    return textByPath;
  }

  const blobEntries: StagedBlobBatchEntry[] = [];
  for (const oid of uniqueOids) {
    const detail = sizes.get(oid);
    if (!detail || detail.type !== 'blob') {
      for (const path of byOid.get(oid) ?? []) fallback.add(path);
      continue;
    }
    blobEntries.push({ oid, path: oid, bytes: detail.bytes });
  }
  for (const group of partitionBlobsForScan(blobEntries, DEFAULT_SCAN_CHUNK_BYTES)) {
    const oids = group.map((entry) => entry.oid);
    let contents: Map<string, string> | null = null;
    try {
      const batch = await runGitStdin(['cat-file', '--batch', '--buffer'], repoPath, `${oids.join('\n')}\n`);
      if (batch.code === 0) contents = parseCatFileBatch(batch.stdout, group);
    } catch {
      contents = null;
    }
    if (!contents) {
      for (const oid of oids) for (const path of byOid.get(oid) ?? []) fallback.add(path);
      log?.(`[${label}] ${repoPath}: staged cat-file batch failed; falling back to per-file reads for that chunk`);
      continue;
    }
    for (const oid of oids) {
      const text = contents.get(oid);
      if (text === undefined) {
        for (const path of byOid.get(oid) ?? []) fallback.add(path);
        continue;
      }
      for (const path of byOid.get(oid) ?? []) textByPath.set(path, text);
    }
  }
  if (fallback.size > 0) await readIndividually([...fallback]);
  return textByPath;
}

/**
 * EI-21230011589307899: judge every staged blob the pre-stage pass never saw.
 *
 * {@link detectContentOffenders} runs over the dirty set BEFORE `git add -A`, and the
 * oversized/deletion/import guards and the lock census run in between. A file created
 * (or rewritten) in that window is staged by the add and committed unscanned: on
 * 2026-10-13 a secret-shaped test fixture reached HEAD that way, and the own-head
 * publish guard then froze git egress for the whole fleet. The post-stage drift check
 * cannot see it, because the file did not change AFTER the add.
 *
 * For each staged path some active detector targets, this reads the INDEX blob (what
 * the commit records, not the working tree) and skips it when its hash matches the text
 * the pre-stage pass judged. Anything else is run through the same detectors, without
 * auto-repair: the remedy is to hold the path back, and the next tick quarantines and
 * escalates it through the full pipeline. FAILS OPEN like the pre-stage pass: an
 * unreadable blob or a throwing detector is logged and skipped, never an offender.
 */
export async function detectUnscannedStagedOffenders(deps: StagedRescanDeps): Promise<ContentOffender[]> {
  const { runGit, runGitStdin, repoPath, staged, scanned, detectors, log } = deps;
  if (detectors.length === 0 || staged.length === 0) return [];
  const active = await resolveActiveDetectors(runGit, repoPath, detectors, log);
  if (active.length === 0) return [];

  const targets: Array<{ file: string; dets: ContentDetector[] }> = [];
  for (const file of staged) {
    const dets = await detectorsTargeting(file, active, repoPath, log);
    if (dets.length > 0) targets.push({ file, dets });
  }

  const offenders: ContentOffender[] = [];
  let rescanned = 0;
  const judge = async ({ file, dets }: (typeof targets)[number], text: string): Promise<void> => {
    const hash = contentSnapshotHash(text);
    if (scanned.get(file) === hash) return;
    rescanned++;
    for (const d of dets) {
      try {
        const error = await d.detect(file, text, { repoPath });
        if (!error) continue;
        offenders.push({
          file,
          detectorKey: d.key,
          error,
          fixerRole: d.fixerRole,
          contentHash: hash,
          detectorResultHash: detectorResultHash(d.key, error),
        });
      } catch (e) {
        log?.(`[content-guard] detector "${d.key}" threw on staged ${file} — skipping (not blocking): ${errMsg(e)}`);
      }
    }
  };
  const indexTexts = await readStagedIndexTextsFromGit({
    runGit,
    runGitStdin,
    repoPath,
    paths: targets.map((target) => target.file),
    log,
  });
  await mapPool(targets, MAX_READ_CONCURRENCY, async (target) => {
    const text = indexTexts.get(target.file);
    if (text !== null && text !== undefined) await judge(target, text);
  });
  if (rescanned > 0) {
    log?.(
      `[content-guard] ${repoPath}: post-stage rescan judged ${rescanned} staged path(s) the pre-stage pass ` +
        `did not see; ${offenders.length} finding(s)`,
    );
  }
  return offenders;
}

/**
 * Attempt the detector's deterministic `autoFix` on an already-failing file (WI-276).
 * Returns the repaired text (already written to the working tree) when the fix FULLY
 * resolves the error, or null to fall through to quarantine + the LLM fixer. Never
 * throws (a write/read failure logs + returns null so the file is quarantined instead).
 *
 * CAS-guarded: re-reads the file right before writing and only writes when it still
 * equals `baseline` — so a concurrent editor's newer content is never clobbered (the
 * broken file is simply re-evaluated on the next tick). FAIL-SAFE by construction: the
 * write happens only when the repaired text passes the SAME `detect`, so the guard can
 * never commit a file it would otherwise have quarantined.
 */
async function tryAutoFix(
  d: ContentDetector,
  file: string,
  text: string,
  baseline: string,
  context: ContentDetectorContext,
  io: {
    readText: (relPath: string) => Promise<string | null>;
    writeText: (relPath: string, text: string) => Promise<void>;
    log?: (m: string) => void;
  },
): Promise<string | null> {
  if (!d.autoFix) return null;
  let fixed: string;
  let changed: boolean;
  try {
    ({ fixed, changed } = d.autoFix(text, file));
  } catch (e) {
    io.log?.(`[content-guard] "${d.key}" autoFix threw on ${file} — quarantining instead: ${errMsg(e)}`);
    return null;
  }
  if (!changed) return null; // nothing the deterministic fixer could repair
  // Keep the repair ONLY if it fully clears the error — else the LLM fixer must look.
  let stillErr: string | null;
  try {
    stillErr = await d.detect(file, fixed, context);
  } catch (e) {
    io.log?.(`[content-guard] "${d.key}" re-detect threw on ${file} — quarantining instead: ${errMsg(e)}`);
    return null;
  }
  if (stillErr) return null; // partial fix — leave the whole file for the LLM fixer
  // CAS: never clobber a concurrent edit — only write if the file is unchanged since we read it.
  let onDisk: string | null;
  try {
    onDisk = await io.readText(file);
  } catch {
    onDisk = null;
  }
  if (onDisk !== baseline) {
    io.log?.(`[content-guard] ${file} changed under us mid-tick — skipping auto-repair (re-evaluated next tick)`);
    return null;
  }
  try {
    await io.writeText(file, fixed);
  } catch (e) {
    io.log?.(`[content-guard] auto-repair write failed for ${file} — quarantining instead: ${errMsg(e)}`);
    return null;
  }
  io.log?.(`[content-guard] auto-repaired ${file} [${d.key}] deterministically — committing this tick (no LLM fixer / no build block)`);
  return fixed;
}

/**
 * Is `repoPath` the SUPERPROJECT (rather than a submodule checkout)?
 *
 * `git rev-parse --show-superproject-working-tree` prints the parent's working tree
 * inside a submodule and NOTHING in the superproject — the cheapest reliable
 * discriminator, and it needs no knowledge of where the superproject actually is.
 *
 * @returns true only when we POSITIVELY established this is the superproject. A
 *   non-zero exit or a throw returns false, so the caller drops superproject-only
 *   detectors rather than risk running them where they do not belong.
 */
async function isSuperprojectRepo(
  runGit: RunGit,
  repoPath: string,
  log?: (m: string) => void,
): Promise<boolean> {
  try {
    const r = await runGit(['rev-parse', '--show-superproject-working-tree'], repoPath);
    if (r.code !== 0) {
      log?.(`[content-guard] ${repoPath}: could not resolve repo kind — treating as submodule`);
      return false;
    }
    return r.stdout.trim().length === 0;
  } catch (e) {
    log?.(`[content-guard] ${repoPath}: repo-kind probe threw — treating as submodule: ${errMsg(e)}`);
    return false;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
