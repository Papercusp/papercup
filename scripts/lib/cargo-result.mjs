// cargo-result.mjs — the pure classification behind the native cargo-test
// reporter and the affected-tests wrapper. Keep this dependency-free: both
// scripts are gate entry points, so a helper import must not pull in a service
// or database module and turn a diagnostic into a runner failure.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GIB = 1024 ** 3;

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
 * Keep native-suite admission aligned with the standing disk alarm. WI-5080
 * deliberately keeps Cargo targets warm during normal operation, so this is an
 * admission guard, not an unconditional cache cleaner.
 */
export const DEFAULT_CARGO_DISK_POLICY = Object.freeze({
  freePctMin: 0.1,
  freeBytesMin: 5 * GIB,
});

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
  if (freePct < policy.freePctMin) reasons.push('free-percent');
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
    policy,
  };
}

export function formatCargoDiskRefusal(admission) {
  const minFreePct = Math.round(admission.policy.freePctMin * 1000) / 10;
  const minFreeGiB = Math.round((admission.policy.freeBytesMin / GIB) * 10) / 10;
  return (
    `[report-cargo-tests] REFUSED before spawning Cargo: filesystem is ${admission.usedPct}% used ` +
    `with ${admission.freeGiB} GiB available; admission requires at least ${minFreePct}% and ${minFreeGiB} GiB free. ` +
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
