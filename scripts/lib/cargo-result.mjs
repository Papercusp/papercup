// cargo-result.mjs — the pure classification behind the native cargo-test
// reporter and the affected-tests wrapper. Keep this dependency-free: both
// scripts are gate entry points, so a helper import must not pull in a service
// or database module and turn a diagnostic into a runner failure.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const GIB = 1024 ** 3;

/**
 * Resolve an actual `cargo` binary rather than trusting a bare spawn to find it on inherited
 * PATH. Service-managed and Vitest-worker environments can omit rustup's `~/.cargo/bin`; the
 * well-known fallbacks keep every native-test caller on the same resolution contract.
 */
export function resolveCargoBin(env = process.env, home = homedir()) {
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((d) => join(d, 'cargo')),
    env.CARGO_HOME ? join(env.CARGO_HOME, 'bin', 'cargo') : null,
    join(home, '.cargo', 'bin', 'cargo'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'cargo'; // last resort — let spawn's own ENOENT surface if Cargo is truly absent
}

/**
 * Cargo's cache-directory marker. Cargo clean requires this exact tag before
 * it will remove an explicitly selected target directory; keeping the marker
 * on an isolated target makes disk-pressure reclamation safe after the test
 * producer or its cargo child exits.
 */
export const CARGO_CACHE_TAG = [
  'Signature: 8a477f597d28d172789f06886806bc55',
  '# This file is a cache directory tag created by cargo.',
  '# For information about cache directory tags see https://bford.info/cachedir/',
  '',
].join('\n');

/**
 * Initialize or repair Cargo's cache marker in a producer-selected target.
 * The target is a disposable Cargo cache, so an existing regular marker with
 * stale contents is repaired in place. Symlinks and other non-regular entries
 * are rejected rather than followed into an unrelated path.
 */
export function ensureCargoCacheTag(targetDir) {
  if (typeof targetDir !== 'string' || targetDir.length === 0) return null;

  mkdirSync(targetDir, { recursive: true });
  const tagPath = join(targetDir, 'CACHEDIR.TAG');
  if (existsSync(tagPath)) {
    const stat = lstatSync(tagPath);
    if (!stat.isFile()) {
      throw new Error(`CACHEDIR.TAG must be a regular file: ${tagPath}`);
    }
    if (readFileSync(tagPath, 'utf8') === CARGO_CACHE_TAG) return tagPath;
  }

  writeFileSync(tagPath, CARGO_CACHE_TAG, { encoding: 'utf8' });
  return tagPath;
}

/**
 * Keep native-suite admission anchored to the standing disk alarm without turning
 * its percentage warning into an absolute gate on very large filesystems. WI-5080
 * deliberately keeps Cargo targets warm during normal operation, so this is an
 * admission guard, not an unconditional cache cleaner.
 */
export const DEFAULT_CARGO_DISK_POLICY = Object.freeze({
  freePctMin: 0.1,
  freeBytesMin: 5 * GIB,
});

/**
 * EI-21149612505559395: a 7.3 TiB volume at 97% used still had 284 GiB free, yet
 * the percentage leg refused Cargo and red-pinned every release. 128 GiB is a
 * deliberately conservative absolute working-headroom escape hatch: it is far
 * above the hard 5 GiB safety floor and the observed native target footprint,
 * while preserving the percentage refusal for genuinely tight volumes (for
 * example the existing 2 TiB / 80 GiB regression case).
 */
export const CARGO_PERCENT_FLOOR_BYPASS_BYTES = 128 * GIB;

/** EX_TEMPFAIL: the suite did not run and becomes valid after space is reclaimed. */
export const CARGO_DISK_REFUSAL_EXIT_CODE = 75;

function positiveEnvNumber(env, name, fallback) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Reuse the disk alarm's existing tuning keys rather than minting a second
 * configuration surface for the Cargo-test entry point. */
export function cargoDiskPolicyFromEnv(env = process.env) {
  return {
    freePctMin:
      positiveEnvNumber(env, 'PAPERCUSP_DISK_ALARM_FREE_PCT', DEFAULT_CARGO_DISK_POLICY.freePctMin * 100) / 100,
    freeBytesMin:
      positiveEnvNumber(env, 'PAPERCUSP_DISK_ALARM_FREE_GB', DEFAULT_CARGO_DISK_POLICY.freeBytesMin / GIB) * GIB,
  };
}

/**
 * Host-local cleanup is deliberately conservative and bounded.  The Cargo
 * admission guard is one of the few places that still runs when the hourly
 * janitors have fallen behind, so it is the last safe opportunity to reclaim
 * artifacts which their producers explicitly describe as disposable.
 *
 * The limits are intentionally large enough to clear one genuinely bad build
 * backlog, but finite so a malformed path/glob can never turn admission into
 * an unbounded recursive delete.
 */
export const DEFAULT_CARGO_RECLAIM_POLICY = Object.freeze({
  ephemeralTtlMs: 6 * 3_600_000,
  cargoTtlMs: 24 * 3_600_000,
  maxEntries: 12,
  maxBytes: 128 * GIB,
  minCargoArtifactBytes: 512 * 1024 * 1024,
});

const EPHEMERAL_PREFIXES = Object.freeze(['verify-tauri-headless.', 'deb-hzfed.']);
const CARGO_TARGET_NAME_RE = /^\.cargo-target(?:-dev\d+|-pid\d+)?$/;

function safeStat(path) {
  try { return statSync(path); } catch { return null; }
}

function safeDirBytes(path) {
  const stat = (() => {
    try { return lstatSync(path); } catch { return null; }
  })();
  if (!stat || stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) total += safeDirBytes(join(path, entry.name));
  return total;
}

function pathIsInside(root, candidate) {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate.replace(/ \(deleted\)$/, ''));
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

/**
 * Check the kernel's live descriptor/executable/cwd view instead of trusting a
 * pid file or a directory mtime.  This runs only on a low-disk admission path,
 * and returns on the first match; it never emits the raw /proc scan.
 */
function defaultPathIsLive(root) {
  let processes;
  try { processes = readdirSync('/proc'); } catch { return true; }
  for (const name of processes) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const proc = `/proc/${name}`;
    for (const special of ['cwd', 'exe']) {
      try {
        if (pathIsInside(root, readlinkSync(`${proc}/${special}`))) return true;
      } catch { /* process exited or access was denied */ }
    }
    let fds;
    try { fds = readdirSync(`${proc}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        if (pathIsInside(root, readlinkSync(`${proc}/fd/${fd}`))) return true;
      } catch { /* descriptor closed during the scan */ }
    }
  }
  return false;
}

function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return afterComm[19] ?? null; // field 22 (starttime), after field 3 (state)
  } catch { return null; }
}

function activeRunMarker(path) {
  const markerPath = join(path, '.papercusp-run');
  try {
    const values = Object.fromEntries(
      readFileSync(markerPath, 'utf8')
        .split('\n')
        .map((line) => line.split('='))
        .filter(([key, value]) => key && value)
        .map(([key, ...value]) => [key, value.join('=')]),
    );
    const pid = Number(values.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    if (values.start_ticks && processStartTicks(pid) !== values.start_ticks) return false;
    return true;
  } catch { return false; }
}

function freshHeartbeat(path, now, ttlMs) {
  const heartbeat = safeStat(join(path, '.heartbeat'));
  return Boolean(heartbeat && now - heartbeat.mtimeMs < ttlMs);
}

function cargoSlotLockIsHeld(targetDir, homeDir) {
  const name = targetDir.split('/').pop() ?? '';
  const slot = name === '.cargo-target'
    ? 0
    : /^\.cargo-target-dev(\d+)$/.exec(name)?.[1]
      ? Number(/^\.cargo-target-dev(\d+)$/.exec(name)[1]) - 1
      : null;
  if (slot === null) return false;
  const lock = join(homeDir, '.papercusp', 'desktop-dev-slots', `slot${slot}.lock`);
  if (!existsSync(lock)) return false;
  try {
    execFileSync('flock', ['-n', lock, '-c', 'true'], { stdio: 'ignore' });
    return false;
  } catch {
    // Missing flock or a held lock both fail closed.  A cleanup pass must never
    // trade a cold rebuild for corrupting a live desktop target.
    return true;
  }
}

function knownCargoRoots(homeDir, configuredTargetDir) {
  const roots = [];
  if (configuredTargetDir) roots.push(resolve(process.cwd(), configuredTargetDir));
  try {
    for (const entry of readdirSync(homeDir, { withFileTypes: true })) {
      if (entry.isDirectory() && CARGO_TARGET_NAME_RE.test(entry.name)) {
        roots.push(join(homeDir, entry.name));
      }
    }
  } catch { /* no home scan means no default roots */ }
  return [...new Set(roots)];
}

function cargoArtifactCandidates(root) {
  if (/-pid\d+$/.test(root.split('/').pop() ?? '')) {
    // Private overflow targets have no stable slot and are safe to remove as a
    // whole once their owner has died. Removing the root in one operation also
    // avoids re-evaluating a parent whose mtime changed after a child removal.
    return [root];
  }
  const candidates = [];
  const releaseBundle = join(root, 'release', 'bundle');
  if (safeStat(releaseBundle)?.isDirectory()) candidates.push(releaseBundle);
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return candidates; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9_]+-[A-Za-z0-9_]+-/.test(entry.name)) continue;
    const release = join(root, entry.name, 'release');
    if (safeStat(release)?.isDirectory()) candidates.push(release);
  }
  return [...new Set(candidates)];
}

/**
 * Reclaim explicitly-owned, inactive build artifacts before Cargo admission.
 * This is intentionally synchronous: it runs immediately before a child would
 * otherwise be spawned and must finish before the refreshed statfs decision.
 *
 * @param {{ tmpDir?: string, cargoRoots?: string[], configuredTargetDir?: string,
 *   now?: number, policy?: object, dryRun?: boolean,
 *   pathIsLive?: (path: string) => boolean,
 *   slotLockIsHeld?: (path: string, homeDir: string) => boolean }} options
 * @returns {{ scanned: number, reclaimed: number, bytesReclaimed: number,
 *   skipped: Array<{ path: string, reason: string }>, dryRun: boolean }}
 */
export function reclaimInactiveCargoArtifacts(options = {}) {
  const policy = { ...DEFAULT_CARGO_RECLAIM_POLICY, ...(options.policy ?? {}) };
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun === true;
  const tmpRoot = options.tmpDir ?? tmpdir();
  const homeDir = homedir();
  const pathIsLive = options.pathIsLive ?? defaultPathIsLive;
  const slotLockIsHeld = options.slotLockIsHeld ?? cargoSlotLockIsHeld;
  const result = { scanned: 0, reclaimed: 0, bytesReclaimed: 0, skipped: [], dryRun };
  const reclaimed = (path, bytes) => {
    if (!dryRun) {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error('symbolic link');
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        result.skipped.push({ path, reason: `remove failed: ${error.message}` });
        return;
      }
    }
    result.reclaimed += 1;
    result.bytesReclaimed += bytes;
  };
  const canReclaim = (path, ttlMs) => {
    const stat = safeStat(path);
    if (!stat || !stat.isDirectory()) return { ok: false, reason: 'missing or not a directory' };
    result.scanned += 1;
    if (now - stat.mtimeMs < ttlMs) return { ok: false, reason: 'younger than ttl' };
    if (activeRunMarker(path)) return { ok: false, reason: 'active run marker' };
    if (freshHeartbeat(path, now, ttlMs)) return { ok: false, reason: 'fresh heartbeat' };
    if (pathIsLive(path)) return { ok: false, reason: 'live descriptor or executable' };
    if (existsSync(join(path, '.papercusp-keep'))) return { ok: false, reason: 'explicit keep marker' };
    return { ok: true };
  };

  let tmpEntries = [];
  try { tmpEntries = readdirSync(tmpRoot, { withFileTypes: true }); } catch { tmpEntries = []; }
  for (const entry of tmpEntries) {
    if (result.reclaimed >= policy.maxEntries) break;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !EPHEMERAL_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
    const path = join(tmpRoot, entry.name);
    const decision = canReclaim(path, policy.ephemeralTtlMs);
    if (!decision.ok) {
      result.skipped.push({ path, reason: decision.reason });
      continue;
    }
    if (entry.name.startsWith('deb-hzfed.')) {
      let servers = '';
      try {
        servers = readFileSync(join(path, 'servers'), 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          result.skipped.push({ path, reason: 'server ledger unreadable' });
          continue;
        }
      }
      if (servers.trim()) {
        result.skipped.push({ path, reason: 'server ledger is non-empty' });
        continue;
      }
    }
    const bytes = safeDirBytes(path);
    if (result.bytesReclaimed + bytes > policy.maxBytes) {
      result.skipped.push({ path, reason: 'reclaim byte cap' });
      continue;
    }
    reclaimed(path, bytes);
    if (result.reclaimed >= policy.maxEntries) break;
  }

  const roots = options.cargoRoots ?? knownCargoRoots(homeDir, options.configuredTargetDir ?? process.env.CARGO_TARGET_DIR);
  for (const root of roots) {
    if (result.reclaimed >= policy.maxEntries) break;
    const name = root.split('/').pop() ?? '';
    if (!CARGO_TARGET_NAME_RE.test(name) || !safeStat(root)?.isDirectory()) continue;
    if (existsSync(join(root, '.papercusp-keep'))) {
      result.skipped.push({ path: root, reason: 'explicit keep marker' });
      continue;
    }
    const slotHeld = slotLockIsHeld(root, homeDir);
    const live = pathIsLive(root);
    if (slotHeld || live) {
      result.skipped.push({ path: root, reason: slotHeld ? 'target slot is held' : 'live target descriptor' });
      continue;
    }
    for (const path of cargoArtifactCandidates(root)) {
      const decision = canReclaim(path, policy.cargoTtlMs);
      if (!decision.ok) {
        result.skipped.push({ path, reason: decision.reason });
        continue;
      }
      const bytes = safeDirBytes(path);
      if (bytes < policy.minCargoArtifactBytes) {
        result.skipped.push({ path, reason: 'below cargo artifact size floor' });
        continue;
      }
      if (result.bytesReclaimed + bytes > policy.maxBytes) {
        result.skipped.push({ path, reason: 'reclaim byte cap' });
        continue;
      }
      reclaimed(path, bytes);
      if (result.reclaimed >= policy.maxEntries) return result;
    }
    if (result.reclaimed >= policy.maxEntries) break;
  }
  return result;
}

/**
 * Pure disk admission decision. `usedPct` and `freeGiB` intentionally use the
 * same scale and rounding as system-health's readDiskPressure writer.
 */
export function assessCargoDiskAdmission(
  { totalBytes, freeBytes },
  policy = DEFAULT_CARGO_DISK_POLICY,
) {
  if (
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isFinite(freeBytes) ||
    freeBytes < 0
  ) {
    return {
      allowed: true,
      status: 'unknown',
      reasons: ['invalid-statfs'],
      totalBytes,
      freeBytes,
      freePct: null,
      usedPct: null,
      freeGiB: null,
      policy,
    };
  }

  const freePct = Math.min(1, freeBytes / totalBytes);
  const reasons = [];
  if (freePct < policy.freePctMin && freeBytes < CARGO_PERCENT_FLOOR_BYPASS_BYTES) {
    reasons.push('free-percent');
  }
  if (freeBytes < policy.freeBytesMin) reasons.push('free-bytes');
  return {
    allowed: reasons.length === 0,
    status: reasons.length === 0 ? 'ok' : 'blocked',
    reasons,
    totalBytes,
    freeBytes,
    freePct,
    usedPct: Math.round((1 - freePct) * 100),
    freeGiB: Math.floor(freeBytes / GIB),
    percentFloorBypassGiB: Math.floor(CARGO_PERCENT_FLOOR_BYPASS_BYTES / GIB),
    policy,
  };
}

export function formatCargoDiskRefusal(admission) {
  const minFreePct = Math.round(admission.policy.freePctMin * 1000) / 10;
  const minFreeGiB = Math.round((admission.policy.freeBytesMin / GIB) * 10) / 10;
  return (
    `[report-cargo-tests] REFUSED before spawning Cargo: filesystem is ${admission.usedPct}% used ` +
    `with ${admission.freeGiB} GiB available; admission requires at least ${minFreePct}% free ` +
    `unless absolute working headroom is at least ${Math.floor(CARGO_PERCENT_FLOOR_BYPASS_BYTES / GIB)} GiB, ` +
    `and always requires at least ${minFreeGiB} GiB free. ` +
    `Reclaim inactive build caches, then retry. Warm targets are preserved by default (WI-5080).`
  );
}

// Cargo test output can inherit terminal title/color control sequences from a
// child test. Strip the complete sequence before parsing result lines so an
// OSC title (BEL or ST terminated) or CSI color/erase prefix cannot hide a
// `test ... ... ok` record from the anchored parser.
const OSC_SEQUENCE_RE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CSI_SEQUENCE_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE_RE = /\u001B[ -/]*[@-~]/g;

/**
 * @typedef {'ok' | 'FAILED' | 'ignored'} CargoTestOutcome
 * @typedef {{ name: string, outcome: CargoTestOutcome }} CargoTestResult
 */

/**
 * @param {string} output
 * @returns {string}
 */
export function stripCargoTerminalControlSequences(output) {
  return output
    .replace(OSC_SEQUENCE_RE, '')
    .replace(CSI_SEQUENCE_RE, '')
    .replace(ESC_SEQUENCE_RE, '');
}

/**
 * Parse Cargo's `test <name> ... ok|FAILED|ignored` result lines.
 *
 * @param {string} output
 * @returns {CargoTestResult[]}
 */
export function parseCargoTestResultLines(output) {
  /** @type {CargoTestResult[]} */
  const results = [];
  const re = /^test (\S+) \.\.\. (ok|FAILED|ignored)\s*$/gm;
  let match;
  const normalized = stripCargoTerminalControlSequences(output);
  while ((match = re.exec(normalized))) {
    results.push({ name: match[1], outcome: match[2] });
  }
  return results;
}

/**
 * @typedef {{ signal: number, signalName: string }} CargoTermination
 */

/**
 * Extract cargo's own process-signal discriminator from a failed rustc command.
 * Cargo prints this in the `Caused by:` block, for example:
 *   process didn't exit successfully: `...rustc ...` (signal: 15, SIGTERM: termination signal)
 *
 * @param {string} output combined cargo stdout/stderr
 * @returns {CargoTermination | null}
 */
export function detectCargoTermination(output) {
  const re = /\(signal:\s*(\d+),\s*(SIG[A-Z0-9]+)\b[^)]*\)/g;
  let match;
  while ((match = re.exec(output)) !== null) {
    const signal = Number(match[1]);
    const signalName = match[2];
    if (Number.isInteger(signal) && signal > 0) return { signal, signalName };
  }
  return null;
}

/**
 * Classify the cargo task independently of the recorder's database result.
 *
 * @param {{ code: number | null, output: string, resultCount: number }} input
 * @returns {{ status: 'passed' | 'failed' | 'killed' | 'error', termination: CargoTermination | null }}
 */
export function classifyCargoRun({ code, output, resultCount }) {
  const termination = code !== 0 ? detectCargoTermination(output) : null;
  if (termination) return { status: 'killed', termination };
  if (code === 0 && resultCount > 0) return { status: 'passed', termination: null };
  if (code === 0) return { status: 'error', termination: null };
  return { status: 'failed', termination: null };
}

/**
 * A keyed, grep-safe line for the run log. The signal fields are deliberately
 * on the same line as the status so a fixed-size tail cannot leave a reader
 * with only "could not compile" and no cause.
 *
 * @param {{ status: 'passed' | 'failed' | 'killed' | 'error', termination?: CargoTermination | null, cause?: string | null, disk?: { usedPct: number, freeGiB: number } | null }} result
 * @returns {string}
 */
export function formatCargoResultLine({ status, termination = null, cause = null, disk = null }) {
  const fields = [`CARGO_RESULT status=${status}`];
  if (termination) {
    fields.push(
      `signal=${termination.signal}`,
      `signalName=${termination.signalName}`,
      'cause=killed-by-signal',
    );
  }
  if (cause) fields.push(`cause=${cause}`);
  if (disk) fields.push(`diskUsedPct=${disk.usedPct}`, `diskFreeGiB=${disk.freeGiB}`);
  return fields.join(' ');
}
