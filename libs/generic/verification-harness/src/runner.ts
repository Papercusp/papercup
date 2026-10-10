/**
 * The shared verification-harness runner.
 *
 * Runs a contract's phases in declaration order under never-abort discipline (the
 * eval-battery rule, applied to a phase graph): a failing or throwing phase is recorded and
 * the run continues, and only the phases whose dependencies did not pass are marked
 * `blocked`. Every run owns ONE evidence dir (`<evidenceRoot>/<runId>`, a `phases/<id>/`
 * subdir per phase, `result.json` rewritten after every phase so a killed run still leaves
 * its partial result) and repoints `<evidenceRoot>/latest` at it when it ends.
 */
import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
export { defaultEvidenceRoot } from './evidence-root.js';
import {
  type HarnessContract,
  type HarnessRunResult,
  type HarnessSelection,
  HarnessContractError,
  type PhaseResult,
  phaseTiers,
  type Tier,
  TIERS,
  validateContract,
} from './contract.js';
import {
  describeGuardRailFailure,
  GUARD_RAIL_SOURCE_ENV,
  type GuardRailProbe,
  type GuardRailReport,
  loadGuardRailsFromCommand,
  runGuardRails,
  selectGuardRails,
} from './guard-rails.js';
import { applyTier, planSelection } from './select.js';
import {
  defaultTierReceiptsPath,
  describeTierRefusal,
  evaluateTierGate,
  loadTierReceipts,
  type PhaseCodeIdentity,
  phaseCodeIdentity,
  recordTierReceipts,
  resolveTier,
  tierGateBlocks,
} from './tier-gate.js';

export type PhaseOutcome = { ok: true; detail?: string } | { ok: false; reasonCode: string; step?: string; detail?: string };

export interface PhaseContext {
  phase: string;
  runId: string;
  /** This phase's own evidence directory (created before the phase runs). */
  evidenceDir: string;
  /** Record the step the phase is in; a failure or throw reports the last one marked. */
  markStep(step: string): void;
}

export interface RunHarnessArgs {
  contract: HarnessContract;
  /** Parent of every run dir; the run lands at `<evidenceRoot>/<runId>`. */
  evidenceRoot: string;
  runPhase: (ctx: PhaseContext) => Promise<PhaseOutcome>;
  /** Fast checks that run before any phase; a failure blocks every phase. */
  preflight?: (ctx: PhaseContext) => Promise<PhaseOutcome>;
  /**
   * Guard-rail probes (or a loader for them). The preflight runs those sharing a tag with
   * contract.scopeTags. Omitted: the command named by VH_GUARD_RAIL_SOURCE, if set.
   */
  guardRails?: readonly GuardRailProbe[] | (() => Promise<readonly GuardRailProbe[]>);
  /** Working directory for guard-rail probes and the source command. */
  guardRailCwd?: string;
  selection?: HarnessSelection;
  /** A prior run (result or its dir) whose passed reusable phases may satisfy dependencies. */
  reuseFrom?: HarnessRunResult | string | null;
  runId?: string;
  now?: () => Date;
  /** Required when the contract declares tiers: which rig this run is on. */
  tier?: Tier | null;
  /** The tier receipt store shared by both tiers (default `<evidenceRoot>/tier-receipts.json`). */
  tierReceipts?: string;
  /** Where phase `code` paths resolve (default: guardRailCwd, else the process cwd). */
  codeRoot?: string;
  /** Run the expensive tier despite a tier-gate refusal. The reason is kept on the result. */
  overrideTierGate?: { reason: string } | null;
  /**
   * How many phases may run at once (default 1: strictly in declaration order). Above 1, a phase
   * starts as soon as its dependencies have settled — independent scenarios of a battery run side
   * by side while a dependent phase still waits for its setup.
   */
  concurrency?: number;
}

/** A FIFO slot pool: at most `n` callbacks in flight. */
function createSlots(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let free = n;
  const waiters: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (free > 0) free--;
    else await new Promise<void>((resolve) => waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else free++;
    }
  };
}

export const PREFLIGHT_PHASE_ID = 'preflight';

export function newRunId(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
}

/**
 * Claims a run dir EXCLUSIVELY, so no run ever writes into another run's evidence (R-5). The
 * default id is second-resolution + pid, which two runs from one process in the same second
 * share; a non-recursive mkdir fails on EEXIST, and the auto id then takes a `.N` suffix. An
 * explicit `runId` that already exists is refused, never reused.
 */
async function claimRunDir(evidenceRoot: string, explicit: string | undefined, startedAt: Date): Promise<string> {
  await mkdir(evidenceRoot, { recursive: true });
  const isTaken = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'EEXIST';
  if (explicit !== undefined) {
    try {
      await mkdir(path.join(evidenceRoot, explicit));
    } catch (e) {
      if (isTaken(e)) {
        throw new Error(`run ${explicit} already exists under ${evidenceRoot}; a run never reuses another run's evidence dir`);
      }
      throw e;
    }
    return explicit;
  }
  const base = newRunId(startedAt);
  for (let n = 0; ; n++) {
    const runId = n === 0 ? base : `${base}.${n}`;
    try {
      await mkdir(path.join(evidenceRoot, runId));
      return runId;
    } catch (e) {
      if (!isTaken(e)) throw e;
    }
  }
}

export async function loadRunResult(runDir: string): Promise<HarnessRunResult> {
  const parsed = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as HarnessRunResult;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.phases)) {
    throw new Error(`${runDir}/result.json is not a verification-harness result (schemaVersion 1)`);
  }
  return parsed;
}

export async function writeRunResult(result: HarnessRunResult): Promise<void> {
  await mkdir(result.evidenceDir, { recursive: true });
  const file = path.join(result.evidenceDir, 'result.json');
  const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
  await writeFile(`${file}.tmp`, bytes);
  await rename(`${file}.tmp`, file);
  // Late proof binding may happen after count retention removes the run. Both the
  // shell CLI and TypeScript runner finalize here, before either invokes pruning.
  // Preserve only the small authentic completion receipt in the existing archive.
  if (result.verdict !== 'pass' || !result.endedAt) return;
  const root = await realpath(path.dirname(result.evidenceDir));
  if (path.basename(result.evidenceDir) !== result.runId) throw new Error('invalid retained harness run id');
  const insideRoot = (target: string) => {
    const relative = path.relative(root, target);
    return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  };
  const retainedRoot = path.join(root, 'retained');
  await mkdir(retainedRoot, { recursive: true });
  if (!insideRoot(await realpath(retainedRoot))) throw new Error('retained harness result outside evidence root');
  const parent = path.join(retainedRoot, result.runId);
  await mkdir(parent, { recursive: true });
  if (!insideRoot(await realpath(parent))) throw new Error('retained harness result outside evidence root');
  const destination = path.join(parent, 'result.json');
  const temporary = path.join(parent, `.result-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    // Link a fully written file without replacing an earlier original receipt.
    try { await link(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await lstat(destination);
      if (!existing.isFile() || !(await readFile(destination)).equals(bytes)) {
        throw new Error('retained harness result changed');
      }
    }
  } finally { await rm(temporary, { force: true }); }
}

/** Point `<evidenceRoot>/latest` at the run dir (relative link, replaced atomically). */
export async function linkLatest(evidenceRoot: string, runDir: string): Promise<void> {
  const tmp = path.join(evidenceRoot, `.latest-${process.pid}`);
  await rm(tmp, { force: true });
  await symlink(path.relative(evidenceRoot, runDir), tmp);
  await rename(tmp, path.join(evidenceRoot, 'latest'));
}

/** Run dirs are named by newRunId (and vh.sh): `<yyyymmddThhmmssZ>-<pid>`, `.N` on a same-second collision. */
const RUN_DIR_RE = /^\d{8}T\d{6}Z-\d+(\.\d+)?$/;
export const DEFAULT_KEEP_RUNS = 30;
/** Count retention keeps an incomplete run until its evidence dir is older than this. */
const IN_PROGRESS_GRACE_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
/** An entry with this file at its top level is kept regardless of age. */
export const VH_KEEP_MARKER = '.vh-keep';

export function keepRunsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VH_KEEP_RUNS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_KEEP_RUNS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_KEEP_RUNS;
}

export interface DiskSpaceSnapshot {
  totalBytes: number;
  availableBytes: number;
}

export interface RunPruneOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable for deterministic retention-policy tests. */
  measureDisk?: (evidenceRoot: string) => Promise<DiskSpaceSnapshot | null>;
  /** Injectable reserve calculator; production mirrors the shared disk alarm policy. */
  reserveBytes?: (totalBytes: number, env: NodeJS.ProcessEnv) => number;
}

export interface RunPruneReport {
  removed: string[];
  runDirsSeen: number;
  disk: {
    status: 'healthy' | 'recovered' | 'unresolved' | 'unmeasured';
    reserveBytes: number | null;
    availableBeforeBytes: number | null;
    availableAfterBytes: number | null;
  };
}

/**
 * The shared disk alarm keeps this policy in operator-core. The generic VH package cannot import
 * that server module without creating a dependency cycle, so consume its existing environment
 * knobs and pin the same bounded formula here.
 */
export function vhDiskReserveBytes(totalBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const envNum = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const absolute = envNum('PAPERCUSP_DISK_ALARM_CRITICAL_GB', 2) * GIB;
  const pct = envNum('PAPERCUSP_DISK_ALARM_CRITICAL_PCT', 2) / 100;
  const cap = envNum('PAPERCUSP_DISK_ALARM_CRITICAL_CAP_GB', 64) * GIB;
  const proportional = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes * pct : 0;
  return Math.max(absolute, Math.min(proportional, cap));
}

async function measureDiskSpace(evidenceRoot: string): Promise<DiskSpaceSnapshot | null> {
  try {
    const sample = await statfs(evidenceRoot, { bigint: true });
    const total = sample.blocks * sample.bsize;
    const available = sample.bavail * sample.bsize;
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (total <= 0n || available < 0n || total > maxSafe || available > maxSafe) return null;
    return { totalBytes: Number(total), availableBytes: Number(available) };
  } catch {
    return null;
  }
}

async function latestRunId(evidenceRoot: string): Promise<string | null> {
  try {
    return path.basename(await readlink(path.join(evidenceRoot, 'latest')));
  } catch {
    return null;
  }
}

async function hasKeepMarker(runDir: string): Promise<boolean> {
  return lstat(path.join(runDir, VH_KEEP_MARKER)).then(() => true, () => false);
}

async function hasTerminalResult(evidenceRoot: string, runId: string): Promise<boolean> {
  try {
    const result = JSON.parse(await readFile(path.join(evidenceRoot, runId, 'result.json'), 'utf8')) as {
      schemaVersion?: unknown;
      runId?: unknown;
      endedAt?: unknown;
      verdict?: unknown;
    };
    return result?.schemaVersion === 1 &&
      result.runId === runId &&
      typeof result.endedAt === 'string' &&
      Number.isFinite(Date.parse(result.endedAt)) &&
      typeof result.verdict === 'string';
  } catch {
    return false;
  }
}

async function removeRunIfEligible(
  evidenceRoot: string,
  runId: string,
  now: number,
  requireTerminal: boolean,
): Promise<boolean> {
  if (await latestRunId(evidenceRoot) === runId) return false;
  const runDir = path.join(evidenceRoot, runId);
  const terminal = await hasTerminalResult(evidenceRoot, runId);
  if (await hasKeepMarker(runDir)) return false;
  if (requireTerminal && !terminal) return false;
  // An incomplete checkpoint has no terminal receipt and receives the existing 24-hour
  // grace before count retention can remove it.
  if (!terminal) {
    const born = await stat(runDir).then((s) => s.mtimeMs, () => now);
    if (now - born < IN_PROGRESS_GRACE_MS) return false;
  }
  try {
    // Recheck both protections at the removal boundary; latest can move while another
    // run finalizes, and a caller may pin a run while this sweep is judging it.
    if (await latestRunId(evidenceRoot) === runId || await hasKeepMarker(runDir)) return false;
    await rm(runDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Retention keeps the newest `keep` run dirs by count, then removes the oldest completed runs
 * only as needed to restore the shared critical write-headroom reserve. It always preserves
 * `latest` and a `.vh-keep` marker. Disk-pressure cleanup removes only valid terminal results;
 * count retention keeps incomplete runs through the existing 24-hour grace. If disk pressure
 * remains but no completed run is eligible, the report says unresolved rather than deleting
 * partial or unrecognized evidence. `VH_KEEP_RUNS=0` disables count pruning only; the emergency
 * disk-pressure floor still applies.
 */
export async function pruneRunsWithReport(
  evidenceRoot: string,
  keep = keepRunsFromEnv(),
  now = Date.now(),
  options: RunPruneOptions = {},
): Promise<RunPruneReport> {
  const env = options.env ?? process.env;
  const measure = options.measureDisk ?? measureDiskSpace;
  const reserve = options.reserveBytes ?? vhDiskReserveBytes;
  let names: string[] = [];
  try {
    names = (await readdir(evidenceRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && RUN_DIR_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    // A missing or unreadable evidence root has no safely judged candidates.
  }
  names.sort();
  const report: RunPruneReport = {
    removed: [],
    runDirsSeen: names.length,
    disk: { status: 'unmeasured', reserveBytes: null, availableBeforeBytes: null, availableAfterBytes: null },
  };
  const removed = new Set<string>();
  if (keep > 0) {
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      if (await removeRunIfEligible(evidenceRoot, name, now, false)) {
        removed.add(name);
        report.removed.push(name);
      }
    }
  }

  let sample = await measure(evidenceRoot);
  if (!sample || !Number.isFinite(sample.totalBytes) || sample.totalBytes <= 0 ||
      !Number.isFinite(sample.availableBytes) || sample.availableBytes < 0) {
    return report;
  }
  report.disk.availableBeforeBytes = sample.availableBytes;
  report.disk.availableAfterBytes = sample.availableBytes;
  let reserveBytes = reserve(sample.totalBytes, env);
  if (!Number.isFinite(reserveBytes) || reserveBytes < 0) return report;
  report.disk.reserveBytes = reserveBytes;
  if (sample.availableBytes >= reserveBytes) {
    report.disk.status = 'healthy';
    return report;
  }

  report.disk.status = 'unresolved';
  for (const name of names) {
    if (removed.has(name)) continue;
    if (!(await removeRunIfEligible(evidenceRoot, name, now, true))) continue;
    removed.add(name);
    report.removed.push(name);
    sample = await measure(evidenceRoot);
    if (!sample || !Number.isFinite(sample.totalBytes) || sample.totalBytes <= 0 ||
        !Number.isFinite(sample.availableBytes) || sample.availableBytes < 0) {
      report.disk.status = 'unmeasured';
      report.disk.availableAfterBytes = null;
      break;
    }
    report.disk.availableAfterBytes = sample.availableBytes;
    reserveBytes = reserve(sample.totalBytes, env);
    if (!Number.isFinite(reserveBytes) || reserveBytes < 0) {
      report.disk.status = 'unmeasured';
      report.disk.reserveBytes = null;
      break;
    }
    report.disk.reserveBytes = reserveBytes;
    if (sample.availableBytes >= reserveBytes) {
      report.disk.status = 'recovered';
      break;
    }
  }
  return report;
}

export function formatRunRetentionLine(report: RunPruneReport): string | null {
  const d = report.disk;
  const needsReport = report.removed.length > 0 ||
    (d.status === 'unresolved' || (d.status === 'unmeasured' && report.runDirsSeen > 0));
  if (!needsReport) return null;
  const fmt = (value: number | null) => value === null ? 'unknown' : String(value);
  return 'VH_PRUNED_RUNS removed=' + (report.removed.join(',') || '-') +
    ' disk=' + d.status +
    ' free_before_bytes=' + fmt(d.availableBeforeBytes) +
    ' reserve_bytes=' + fmt(d.reserveBytes) +
    ' free_after_bytes=' + fmt(d.availableAfterBytes);
}

export async function pruneRuns(
  evidenceRoot: string,
  keep = keepRunsFromEnv(),
  now = Date.now(),
  options: RunPruneOptions = {},
): Promise<string[]> {
  return (await pruneRunsWithReport(evidenceRoot, keep, now, options)).removed;
}

/**
 * Entries of an evidence root that no run owns and retention never touches: the `latest` link and
 * `retained/`, where pinned per-run artifacts (proof receipts) outlive their run dirs.
 */
const RESERVED_ROOT_ENTRIES = new Set(['latest', 'retained']);
export const DEFAULT_FOREIGN_MAX_AGE_HOURS = 72;
/**
 * Entries one prune call may visit across ALL foreign entries before it stops judging. Judging a
 * stale entry walks it in full; measured hand-named dirs hold 450k-850k entries each, and 3M
 * entries took 197s on a loaded host, so 1M bounds a finalize's added time to about a minute.
 * Entries the budget does not reach are kept and reported as unjudged.
 */
export const FOREIGN_WALK_BUDGET = 1_000_000;
const LSTAT_BATCH = 256;
/**
 * Per-root cache of freshness proofs: `{ [entry]: freshUntilMs }`. A walk that found a file
 * modified at F proves the entry cannot be stale before F + maxAge, so it is not re-walked until
 * then. Without it, an active entry whose fresh file sits deep (hardlinked shared inodes) is
 * re-walked on every finalize and starves the budget for the entries after it. A dot-entry, so
 * retention never judges it; a lost or corrupt cache only costs a re-walk.
 */
export const FOREIGN_FRESHNESS_CACHE = '.vh-foreign-freshness.json';

export function foreignMaxAgeHoursFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VH_FOREIGN_MAX_AGE_HOURS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_FOREIGN_MAX_AGE_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FOREIGN_MAX_AGE_HOURS;
}

export interface ForeignPruneResult {
  /** Foreign entries removed because nothing under them changed within the max age. */
  removed: string[];
  /** Foreign entries kept WITHOUT a verdict (walk error or budget): a skipped check, not a fresh entry. */
  unjudged: Array<{ name: string; reason: 'walk-budget' | 'walk-error' }>;
}

type Staleness =
  | { verdict: 'fresh'; mtimeMs: number }
  | { verdict: 'stale' | 'walk-budget' | 'walk-error' };

/**
 * Whether anything at or under `top` was modified at or after `cutoffMs` (a fresh verdict carries
 * the mtime that proved it). Never follows symlinks. Breadth-first, returning at the FIRST fresh
 * mtime, so a live entry usually costs little; a stale one is walked in full, which costs no more
 * than removing it. Spends from the shared `budget` (entries visited); exhausting it returns
 * 'walk-budget'. A child vanishing mid-walk is ignored; any other error returns 'walk-error'.
 * Either non-verdict keeps the entry.
 */
async function stalenessOf(top: string, cutoffMs: number, budget: { left: number }): Promise<Staleness> {
  const dirs: string[] = [];
  let st;
  try {
    st = await lstat(top);
  } catch {
    return { verdict: 'walk-error' };
  }
  if (st.mtimeMs >= cutoffMs) return { verdict: 'fresh', mtimeMs: st.mtimeMs };
  if (st.isDirectory()) dirs.push(top);
  for (let head = 0; head < dirs.length; head++) {
    const dir = dirs[head] as string;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { verdict: 'walk-error' };
    }
    budget.left -= names.length;
    if (budget.left < 0) return { verdict: 'walk-budget' };
    for (let i = 0; i < names.length; i += LSTAT_BATCH) {
      const batch = names.slice(i, i + LSTAT_BATCH).map((n) => path.join(dir, n));
      const stats = await Promise.all(
        batch.map((p) =>
          lstat(p).then(
            (s) => ({ p, s, err: null as NodeJS.ErrnoException | null }),
            (err: NodeJS.ErrnoException) => ({ p, s: null, err }),
          ),
        ),
      );
      for (const { p, s, err } of stats) {
        if (!s) {
          if (err?.code === 'ENOENT') continue;
          return { verdict: 'walk-error' };
        }
        if (s.mtimeMs >= cutoffMs) return { verdict: 'fresh', mtimeMs: s.mtimeMs };
        if (s.isDirectory()) dirs.push(p);
      }
    }
  }
  return { verdict: 'stale' };
}

async function readFreshnessCache(evidenceRoot: string): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(evidenceRoot, FOREIGN_FRESHNESS_CACHE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((kv): kv is [string, number] => typeof kv[1] === 'number'),
    );
  } catch {
    return {};
  }
}

async function writeFreshnessCache(evidenceRoot: string, cache: Record<string, number>): Promise<void> {
  const tmp = path.join(evidenceRoot, `${FOREIGN_FRESHNESS_CACHE}.${process.pid}`);
  try {
    await writeFile(tmp, `${JSON.stringify(cache)}\n`);
    await rename(tmp, path.join(evidenceRoot, FOREIGN_FRESHNESS_CACHE));
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export interface ForeignPruneOptions {
  maxAgeHours?: number;
  now?: number;
  walkBudget?: number;
  /** Judge only: `removed` names what WOULD be removed, nothing is deleted, the cache is not written. */
  dryRun?: boolean;
}

/**
 * Retention for FOREIGN entries: anything in an evidence root that is not a run dir, which
 * {@link pruneRuns} never governs. Hand-named scratch and investigation dirs placed beside the
 * runs otherwise grow the root without bound (WI-10007424 measured ~230G of them in one root).
 * Removes a foreign dir or regular file when nothing at or under it was modified within
 * `maxAgeHours`. Never touches run dirs, `latest`, `retained/`, dot-entries, symlinks, or an entry
 * holding a {@link VH_KEEP_MARKER} file. `VH_FOREIGN_MAX_AGE_HOURS` sets the default; 0 disables.
 * Cost is bounded by {@link FOREIGN_WALK_BUDGET} per call and amortised by
 * {@link FOREIGN_FRESHNESS_CACHE}.
 */
export async function pruneStaleForeign(evidenceRoot: string, opts: ForeignPruneOptions = {}): Promise<ForeignPruneResult> {
  const {
    maxAgeHours = foreignMaxAgeHoursFromEnv(),
    now = Date.now(),
    walkBudget = FOREIGN_WALK_BUDGET,
    dryRun = false,
  } = opts;
  const result: ForeignPruneResult = { removed: [], unjudged: [] };
  if (!(maxAgeHours > 0)) return result;
  const cutoffMs = now - maxAgeHours * 60 * 60 * 1000;
  let entries;
  try {
    entries = await readdir(evidenceRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  const candidates: Array<{ name: string; target: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const name = entry.name;
    if (RUN_DIR_RE.test(name) || RESERVED_ROOT_ENTRIES.has(name) || name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue; // symlinks, sockets, fifos: not ours to judge
    const target = path.join(evidenceRoot, name);
    if (entry.isDirectory()) {
      const marked = await lstat(path.join(target, VH_KEEP_MARKER)).then(() => true, () => false);
      if (marked) continue;
    }
    const mtimeMs = await lstat(target).then((s) => s.mtimeMs, () => now);
    candidates.push({ name, target, mtimeMs });
  }
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const cached = await readFreshnessCache(evidenceRoot);
  const nextCache: Record<string, number> = {};
  // Oldest first: the likeliest-stale entries get the walk budget before it runs out.
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  const budget = { left: walkBudget };
  for (const { name, target } of candidates) {
    const until = cached[name];
    // If the proving file was since deleted, trusting the proof only DELAYS removal: the safe side.
    if (until !== undefined && until > now) {
      nextCache[name] = until;
      continue;
    }
    if (budget.left <= 0) {
      result.unjudged.push({ name, reason: 'walk-budget' });
      continue;
    }
    const judged = await stalenessOf(target, cutoffMs, budget);
    if (judged.verdict === 'fresh') {
      nextCache[name] = judged.mtimeMs + maxAgeMs;
      continue;
    }
    if (judged.verdict !== 'stale') {
      result.unjudged.push({ name, reason: judged.verdict });
      continue;
    }
    // A writer may have reached the entry while it was being walked: re-check its own mtime.
    const again = await lstat(target).then((s) => s.mtimeMs, () => null);
    if (again === null || again >= cutoffMs) continue;
    if (!dryRun) await rm(target, { recursive: true, force: true });
    result.removed.push(name);
  }
  if (!dryRun && JSON.stringify(nextCache) !== JSON.stringify(cached)) await writeFreshnessCache(evidenceRoot, nextCache);
  return result;
}

export interface EvidenceRootPruneResult {
  runs: string[];
  runRetention: RunPruneReport;
  foreign: ForeignPruneResult;
}

/** Full retention for an evidence root: {@link pruneRuns} by count, then {@link pruneStaleForeign} by age. */
export async function pruneEvidenceRoot(
  evidenceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  options: RunPruneOptions = {},
): Promise<EvidenceRootPruneResult> {
  const runRetention = await pruneRunsWithReport(evidenceRoot, keepRunsFromEnv(env), now, { ...options, env });
  const foreign = await pruneStaleForeign(evidenceRoot, { maxAgeHours: foreignMaxAgeHoursFromEnv(env), now });
  return { runs: runRetention.removed, runRetention, foreign };
}

/** One stderr-ready line naming what retention removed or could not judge, or null when nothing happened. */
export function formatForeignPruneLine(r: ForeignPruneResult): string | null {
  if (r.removed.length === 0 && r.unjudged.length === 0) return null;
  const unjudged = r.unjudged.map((u) => `${u.name}:${u.reason}`);
  return `VH_PRUNED_FOREIGN removed=${r.removed.join(',') || '-'} unjudged=${unjudged.join(',') || '-'}`;
}

export function deriveVerdict(result: Pick<HarnessRunResult, 'preflight' | 'phases' | 'tierGate'>): {
  verdict: HarnessRunResult['verdict'];
  firstFailure: HarnessRunResult['firstFailure'];
} {
  if (tierGateBlocks(result.tierGate)) {
    const p = result.tierGate!.phases.find((q) => q.status === 'refused')!;
    return { verdict: 'tier-refused', firstFailure: { phase: p.phase, step: null, reasonCode: p.reasonCode } };
  }
  if (result.preflight && result.preflight.status !== 'passed') {
    const p = result.preflight;
    return { verdict: 'preflight-failed', firstFailure: { phase: p.phase, step: p.step, reasonCode: p.reasonCode } };
  }
  const bad = result.phases.find((p) => p.status === 'failed') ?? result.phases.find((p) => p.status === 'blocked');
  if (!bad) return { verdict: 'pass', firstFailure: null };
  return { verdict: 'fail', firstFailure: { phase: bad.phase, step: bad.step, reasonCode: bad.reasonCode } };
}

/** One greppable line: `HARNESS_RESULT harness=… verdict=… first_failure=phase/step/reason … evidence=…`. */
export function formatSummaryLine(result: HarnessRunResult): string {
  const count = (s: PhaseResult['status']) => result.phases.filter((p) => p.status === s).length;
  const ff = result.firstFailure;
  const first = ff ? `${ff.phase}/${ff.step ?? '-'}/${ff.reasonCode ?? '-'}` : 'none';
  const gr = result.guardRails;
  const rails = !gr
    ? ''
    : gr.source === 'unconfigured'
      ? ' guard_rails=unconfigured'
      : ` guard_rails=${gr.results.filter((r) => r.ok).length}/${gr.selected}`;
  const tg = result.tierGate;
  const tier = !result.tier
    ? ''
    : ` tier=${result.tier}` +
      (tg ? ` tier_gate=${tg.refused > 0 ? `refused:${tg.refused}${tg.override ? ':overridden' : ''}` : 'admitted'}` : '');
  return (
    `HARNESS_RESULT harness=${result.harness} verdict=${result.verdict} run=${result.runId} first_failure=${first}` +
    ` passed=${count('passed')} failed=${count('failed')} blocked=${count('blocked')} skipped=${count('skipped')}` +
    ` reused=${count('reused')}${rails}${tier} evidence=${result.evidenceDir}`
  );
}

/** The identifying fields of a `HARNESS_RESULT` line — what {@link parseSummaryLine} reads back. */
export interface SummaryLineFields {
  harness: string;
  verdict: string;
  runId: string;
  /** null when the line says `first_failure=none`. `-` placeholders read back as null. */
  firstFailure: { phase: string; step: string | null; reasonCode: string | null } | null;
}

const SUMMARY_LINE_RE = /\bHARNESS_RESULT\s+harness=(\S+)\s+verdict=(\S+)\s+run=(\S+)\s+first_failure=(\S+)/;

/**
 * The inverse of {@link formatSummaryLine}, for consumers that only have the log (the attempt
 * ledger's failure fingerprint). Keeping both halves here means the line has one owner: a
 * format change that the parser does not follow fails this package's round-trip test.
 * `first_failure` is `phase/step/reason`; the phase is the first segment and the reason the
 * last, so a step containing `/` still reads back whole. Returns null for any other line.
 */
export function parseSummaryLine(line: string): SummaryLineFields | null {
  const m = SUMMARY_LINE_RE.exec(line);
  if (!m) return null;
  const [, harness, verdict, runId, first] = m as unknown as [string, string, string, string, string];
  if (first === 'none') return { harness, verdict, runId, firstFailure: null };
  const a = first.indexOf('/');
  const z = first.lastIndexOf('/');
  if (a < 0 || z === a) return { harness, verdict, runId, firstFailure: null };
  const dash = (s: string): string | null => (s === '-' || s === '' ? null : s);
  return {
    harness,
    verdict,
    runId,
    firstFailure: { phase: first.slice(0, a), step: dash(first.slice(a + 1, z)), reasonCode: dash(first.slice(z + 1)) },
  };
}

/**
 * Runs the guard rails that apply to `tags` into `evidenceDir`. Returns the report plus a
 * preflight outcome: any rail that does not hold (or a source that cannot answer) fails it.
 */
export async function checkGuardRails(args: {
  tags: readonly string[];
  guardRails?: RunHarnessArgs['guardRails'];
  cwd?: string;
  evidenceDir: string;
}): Promise<{ report: GuardRailReport | null; outcome: PhaseOutcome }> {
  if (args.tags.length === 0) return { report: null, outcome: { ok: true } };
  const sourceCmd = process.env[GUARD_RAIL_SOURCE_ENV]?.trim();
  const source: GuardRailReport['source'] = args.guardRails ? 'arg' : sourceCmd ? 'command' : 'unconfigured';
  if (source === 'unconfigured') {
    return { report: { source, selected: 0, results: [] }, outcome: { ok: true, detail: 'guard rails unconfigured' } };
  }
  let probes: readonly GuardRailProbe[];
  try {
    const g = args.guardRails;
    probes = g ? (typeof g === 'function' ? await g() : g) : await loadGuardRailsFromCommand(sourceCmd!, args.tags, { cwd: args.cwd });
  } catch (err) {
    return {
      report: { source, selected: 0, results: [] },
      outcome: { ok: false, reasonCode: 'guard-rail-source-failed', step: 'guard-rails', detail: err instanceof Error ? err.message : String(err) },
    };
  }
  const selected = selectGuardRails(probes, args.tags);
  const run = await runGuardRails(selected, { cwd: args.cwd, evidenceDir: args.evidenceDir });
  const report: GuardRailReport = { source, selected: selected.length, results: run.results };
  if (run.firstFailure) {
    return {
      report,
      outcome: {
        ok: false,
        reasonCode: `guard-rail:${run.firstFailure.key}`,
        step: 'guard-rails',
        detail: run.results.filter((r) => !r.ok).map(describeGuardRailFailure).join('; '),
      },
    };
  }
  return { report, outcome: { ok: true, detail: `${selected.length} guard rail(s) hold` } };
}

async function runOne(
  id: string,
  fn: (ctx: PhaseContext) => Promise<PhaseOutcome>,
  runId: string,
  runDir: string,
  now: () => Date,
): Promise<PhaseResult> {
  const evidenceDir = path.join(runDir, 'phases', id);
  await mkdir(evidenceDir, { recursive: true });
  let step: string | null = null;
  const started = now();
  let outcome: PhaseOutcome;
  try {
    outcome = await fn({ phase: id, runId, evidenceDir, markStep: (s) => { step = s; } });
  } catch (err) {
    outcome = { ok: false, reasonCode: 'threw', detail: err instanceof Error ? err.message : String(err) };
  }
  const ended = now();
  const base = {
    phase: id,
    evidenceDir,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    elapsedMs: Math.max(0, ended.getTime() - started.getTime()),
  };
  if (outcome.ok) return { ...base, status: 'passed', step, reasonCode: null, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  return {
    ...base,
    status: 'failed',
    step: outcome.step ?? step,
    reasonCode: outcome.reasonCode,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

function notRun(id: string, runDir: string, status: 'blocked' | 'skipped' | 'reused', reasonCode: string | null, extra: Partial<PhaseResult> = {}): PhaseResult {
  return {
    phase: id,
    status,
    step: null,
    reasonCode,
    evidenceDir: path.join(runDir, 'phases', id),
    startedAt: null,
    endedAt: null,
    elapsedMs: 0,
    ...extra,
  };
}

export async function runHarness(args: RunHarnessArgs): Promise<HarnessRunResult> {
  const { contract } = args;
  validateContract(contract);
  const now = args.now ?? (() => new Date());
  const selection: HarnessSelection = args.selection ?? { only: null, from: null };
  const tier = resolveTier(contract, args.tier);
  const prior =
    typeof args.reuseFrom === 'string' ? await loadRunResult(args.reuseFrom) : (args.reuseFrom ?? null);
  if (prior && (prior.tier ?? null) !== tier) {
    throw new HarnessContractError(
      `${contract.name}: cannot reuse run ${prior.runId} (${prior.tier ?? 'untiered'}) in a ${tier ?? 'untiered'} run`,
    );
  }
  const plan = applyTier(contract, planSelection(contract, selection, prior), tier, selection);
  const byId = new Map(contract.phases.map((p) => [p.id, p]));
  const gated = (id: string) => tier !== null && phaseTiers(contract, byId.get(id)!).length === TIERS.length;
  const codeRoot = args.codeRoot ?? args.guardRailCwd ?? process.cwd();
  const receiptsPath = args.tierReceipts ?? defaultTierReceiptsPath(args.evidenceRoot);
  await mkdir(args.evidenceRoot, { recursive: true });
  const preRunRetention = await pruneRunsWithReport(args.evidenceRoot);
  const preRunRetentionLine = formatRunRetentionLine(preRunRetention);
  if (preRunRetentionLine) process.stderr.write(preRunRetentionLine + '\n');
  const startedAt = now();
  const runId = await claimRunDir(args.evidenceRoot, args.runId, startedAt);
  const runDir = path.join(args.evidenceRoot, runId);

  const result: HarnessRunResult = {
    schemaVersion: 1,
    harness: contract.name,
    runId,
    evidenceDir: runDir,
    selection,
    reuseFromRunId: prior?.runId ?? null,
    preflight: null,
    phases: [],
    verdict: 'fail',
    firstFailure: null,
    ...(tier ? { tier } : {}),
    startedAt: startedAt.toISOString(),
    endedAt: null,
  };
  const checkpoint = async () => {
    Object.assign(result, deriveVerdict(result));
    await writeRunResult(result);
  };

  // The tier gate runs BEFORE preflight: an expensive run it refuses pays for nothing. It
  // leaves `latest` alone, because a refused run holds no passes to reuse.
  const gatedHashes = new Map<string, string | null>();
  if (tier === 'expensive') {
    const toRun = plan.filter((s) => s.action === 'run').map((s) => s.phase);
    const identities = new Map<string, PhaseCodeIdentity>();
    for (const id of toRun.filter(gated)) identities.set(id, await phaseCodeIdentity(byId.get(id)!, codeRoot));
    for (const [id, ident] of identities) gatedHashes.set(id, ident.hash);
    const store = await loadTierReceipts(receiptsPath, contract.name);
    result.tierGate = evaluateTierGate({ contract, phases: toRun, identities, store, receiptsPath, override: args.overrideTierGate });
    if (tierGateBlocks(result.tierGate)) {
      const refused = new Map(result.tierGate.phases.filter((p) => p.status === 'refused').map((p) => [p.phase, p]));
      for (const step of plan) {
        const r = refused.get(step.phase);
        result.phases.push(
          step.action === 'skip'
            ? notRun(step.phase, runDir, 'skipped', step.reason ?? 'not-selected')
            : step.action === 'reuse'
              ? notRun(step.phase, runDir, 'reused', null, { reusedFromRunId: step.reuseFromRunId! })
              : notRun(step.phase, runDir, 'blocked', r?.reasonCode ?? 'tier-gate:run-refused', r ? { detail: describeTierRefusal(r) } : {}),
        );
      }
      result.endedAt = now().toISOString();
      await checkpoint();
      return result;
    }
  } else if (tier === 'cheap') {
    result.tierReceipts = { tier: 'cheap', receiptsPath, recorded: [], unrecorded: [] };
  }

  // The harness's own preflight and the guard rails both run (never-abort), so one run reports
  // every broken precondition; the first failure names the reason.
  const tags = contract.scopeTags ?? [];
  if (args.preflight || tags.length > 0) {
    const own = args.preflight;
    result.preflight = await runOne(
      PREFLIGHT_PHASE_ID,
      async (ctx) => {
        const first = own ? await own(ctx) : ({ ok: true } as PhaseOutcome);
        const rails = await checkGuardRails({ tags, guardRails: args.guardRails, cwd: args.guardRailCwd, evidenceDir: ctx.evidenceDir });
        result.guardRails = rails.report;
        if (!first.ok) return rails.outcome.ok ? first : { ...first, detail: [first.detail, rails.outcome.detail].filter(Boolean).join('; ') };
        if (!rails.outcome.ok) return rails.outcome;
        return { ok: true, detail: [first.detail, rails.outcome.detail].filter(Boolean).join('; ') || undefined };
      },
      runId,
      runDir,
      now,
    );
    await checkpoint();
  }
  const preflightFailed = result.preflight !== null && result.preflight.status !== 'passed';

  // A gated phase is hashed right before it runs and again after: an expensive phase whose code
  // moved since the gate admitted it is blocked, and a cheap pass is recorded only when the code
  // that passed is the code that was hashed.
  const runTiered = async (id: string): Promise<PhaseResult> => {
    if (!gated(id)) return runOne(id, args.runPhase, runId, runDir, now);
    const before = (await phaseCodeIdentity(byId.get(id)!, codeRoot)).hash;
    if (tier === 'expensive' && gatedHashes.has(id) && before !== gatedHashes.get(id)) {
      return notRun(id, runDir, 'blocked', 'tier-gate:code-changed-during-run', {
        detail: `${id}: code changed after the tier gate admitted it; re-run the cheap tier`,
      });
    }
    const r = await runOne(id, args.runPhase, runId, runDir, now);
    if (tier !== 'cheap' || r.status !== 'passed') return r;
    const after = (await phaseCodeIdentity(byId.get(id)!, codeRoot)).hash;
    const receipts = result.tierReceipts!;
    if (before === null || after !== before) {
      receipts.unrecorded.push({
        phase: id,
        reasonCode: before === null ? 'tier-gate:code-unresolved' : 'tier-gate:code-changed-during-run',
      });
      return r;
    }
    await recordTierReceipts(receiptsPath, contract.name, [{ phase: id, codeHash: before, runId, passedAt: r.endedAt! }]);
    receipts.recorded.push({ phase: id, codeHash: before });
    return r;
  };

  const statusOf = new Map<string, PhaseResult['status']>();
  const notRunFor = (step: (typeof plan)[number]): PhaseResult | null => {
    if (step.action === 'skip') return notRun(step.phase, runDir, 'skipped', step.reason ?? 'not-selected');
    if (step.action === 'reuse') return notRun(step.phase, runDir, 'reused', null, { reusedFromRunId: step.reuseFromRunId! });
    if (preflightFailed) return notRun(step.phase, runDir, 'blocked', 'preflight-failed');
    return null;
  };
  const unmetDependency = (id: string): PhaseResult | null => {
    const unmet = (byId.get(id)!.dependsOn ?? []).find((d) => statusOf.get(d) !== 'passed' && statusOf.get(d) !== 'reused');
    return unmet ? notRun(id, runDir, 'blocked', `dependency:${unmet}:${statusOf.get(unmet) ?? 'unknown'}`) : null;
  };
  const concurrency = Math.max(1, Math.floor(args.concurrency ?? 1));

  if (concurrency === 1) {
    for (const step of plan) {
      const r = notRunFor(step) ?? unmetDependency(step.phase) ?? (await runTiered(step.phase));
      statusOf.set(step.phase, r.status);
      result.phases.push(r);
      await checkpoint();
    }
  } else {
    // A phase starts once every dependency has settled and a slot is free; results stay in
    // declaration order, and result.json is rewritten (serially) as each phase settles.
    const slot = createSlots(concurrency);
    const settled = new Map<string, Promise<PhaseResult>>();
    const ordered: (PhaseResult | undefined)[] = [];
    let writes: Promise<void> = Promise.resolve();
    plan.forEach((step, i) => {
      const run = async (): Promise<PhaseResult> => {
        const early = notRunFor(step);
        if (early) return early;
        await Promise.all((byId.get(step.phase)!.dependsOn ?? []).map((d) => settled.get(d)));
        return unmetDependency(step.phase) ?? slot(() => runTiered(step.phase));
      };
      settled.set(
        step.phase,
        run().then(async (r) => {
          statusOf.set(step.phase, r.status);
          ordered[i] = r;
          result.phases = ordered.filter((x): x is PhaseResult => x !== undefined);
          writes = writes.then(checkpoint);
          await writes;
          return r;
        }),
      );
    });
    await Promise.all(settled.values());
  }

  result.endedAt = now().toISOString();
  await checkpoint();
  await linkLatest(args.evidenceRoot, runDir);
  const pruned = await pruneEvidenceRoot(args.evidenceRoot);
  const runRetentionLine = formatRunRetentionLine(pruned.runRetention);
  if (runRetentionLine) process.stderr.write(runRetentionLine + '\n');
  const prunedLine = formatForeignPruneLine(pruned.foreign);
  if (prunedLine) process.stderr.write(`${prunedLine}\n`);
  return result;
}
