// Per-test-file PASS reuse — gate-file-level-test-reuse-2026-09-27 P-008 (WI-10003476).
//
// A harness_shared.test_executed_sources row is a per-file pass proof: the reporter
// (libs/test-config/src/executed-source-map-reporter.ts) records it only for a PASSED, isolated
// test file on a CLEAN checkout, together with the modules vitest executed and (P-009) the repo
// paths the file read at runtime. This module decides which selected test files may be SKIPPED
// at a judged sha because such a proof is still valid there (D-004):
//
//   1. the proof is from the same run context, the same runner identity, and younger than
//      maxAgeMs (so every file re-runs at least that often: the P-012 backstop);
//   2. its inputs were captured and it is not opaque;
//   3. drift(recordedSha, judgedSha) is computable and disjoint from: the file, every executed
//      module, every runtime read (a trailing '/' = directory prefix), the package.json and
//      tsconfig*.json of every package directory an executed module lives under, and the global
//      runner inputs.
//
// Everything else runs. PURE: every input is a value or a seam, so the unit tests pin the rule.

import path from "node:path";

/** Env kill switch: `0`/`false`/`off`/`no` disables reuse entirely (default: ON). */
export const TEST_REUSE_ENV = "AFFECTED_TEST_REUSE";
/** The channel that carries the skip list to vitest-config (a JSON array of repo-relative paths). */
export const TEST_REUSE_SKIP_LIST_ENV = "PC_TEST_REUSE_SKIP_LIST";
/** Maximum proof age; default 24h. */
export const TEST_REUSE_MAX_AGE_ENV = "AFFECTED_TEST_REUSE_MAX_AGE_HOURS";
export const TEST_REUSE_MAX_AGE_MS_DEFAULT = 24 * 3600 * 1000;

const OFF = new Set(["0", "false", "off", "no"]);

/** @param {Record<string, string | undefined>} [env] */
export function testReuseEnabled(env = process.env) {
  const raw = env[TEST_REUSE_ENV];
  return raw == null || !OFF.has(String(raw).trim().toLowerCase());
}

/** @param {Record<string, string | undefined>} [env] */
export function testReuseMaxAgeMs(env = process.env) {
  const h = Number(env[TEST_REUSE_MAX_AGE_ENV]);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1000 : TEST_REUSE_MAX_AGE_MS_DEFAULT;
}

/**
 * Global runner inputs: a drift path matching this invalidates EVERY proof. Kept narrow on
 * purpose (P-007 measured that "any package.json or libs/test-config file" discards 12 of 38
 * hourly pairs): per-package manifests are handled by the per-module ancestor rule instead, and
 * libs/test-config TEST files are ordinary tests, not runner inputs.
 */
export function isGlobalRunnerInput(rel) {
  if (rel === "package-lock.json" || rel === "package.json" || rel === "tsconfig.json") return true;
  if (/^tsconfig\.[^/]*\.json$/.test(rel)) return true;
  if (/^vitest\.[^/]*$/.test(rel)) return true;
  if (/(^|\/)vitest\.[^/]*config[^/]*\.[cm]?[jt]s$/.test(rel)) return true;
  if (/^libs\/test-config\/(src\/|package\.json|tsconfig)/.test(rel) && !/\.test\.[cm]?[jt]sx?$/.test(rel)) {
    return true;
  }
  if (/^patches\//.test(rel)) return true;
  return false;
}

/** The package.json / tsconfig*.json names that configure every file beneath their directory. */
const CONFIG_BASENAME_RE = /^(package\.json|tsconfig[^/]*\.json|\.babelrc|babel\.config\.[cm]?js)$/;

/**
 * Does a drift path invalidate a proof whose inputs are `modules` + `reads`? `dirs` is the set of
 * directories containing an executed module (and all their ancestors), used for the config rule.
 */
function invalidates(rel, o) {
  if (o.inputs.has(rel)) return true;
  for (const prefix of o.readDirs) if (rel === prefix.slice(0, -1) || rel.startsWith(prefix)) return true;
  const base = path.posix.basename(rel);
  if (CONFIG_BASENAME_RE.test(base) && o.dirs.has(path.posix.dirname(rel))) return true;
  return false;
}

/**
 * @typedef {object} ReuseProof
 * @property {string}   recordedSha
 * @property {number}   recordedAtMs
 * @property {string[]} executedModules   repo-relative, includes the test file
 * @property {string[]} readPaths         repo-relative; a trailing '/' is a directory read
 * @property {boolean}  inputsCaptured
 * @property {string[]} opaqueReasons
 * @property {string | null} runContext
 * @property {string | null} runnerIdentity
 */

/**
 * @param {object} o
 * @param {string[]}                      o.candidates    repo-relative test files the run would execute
 * @param {Map<string, ReuseProof>}       o.proofs        newest proof per repo-relative test file
 * @param {string}                        o.judgedSha
 * @param {(a: string, b: string) => Set<string> | null} o.changedBetween  repo-RELATIVE drift, null = unknown
 * @param {string}                        o.runContext
 * @param {string}                        o.runnerIdentity
 * @param {number}                        o.nowMs
 * @param {number}                        o.maxAgeMs
 * @returns {{ skip: string[], summary: Record<string, number> }}
 */
export function selectReusablePasses({
  candidates,
  proofs,
  judgedSha,
  changedBetween,
  runContext,
  runnerIdentity,
  nowMs,
  maxAgeMs,
}) {
  const summary = {
    candidates: 0,
    reused: 0,
    noProof: 0,
    otherContext: 0,
    otherRunner: 0,
    expired: 0,
    notCaptured: 0,
    opaque: 0,
    unknownDrift: 0,
    globalInput: 0,
    inputChanged: 0,
  };
  const skip = [];
  /** @type {Map<string, { drift: Set<string> | null, global: boolean }>} */
  const driftCache = new Map();
  const driftFor = (sha) => {
    if (!driftCache.has(sha)) {
      let drift = null;
      if (sha === judgedSha) drift = new Set();
      else {
        try {
          const d = changedBetween(sha, judgedSha);
          drift = d == null ? null : new Set(d);
        } catch {
          drift = null;
        }
      }
      const global = drift !== null && [...drift].some(isGlobalRunnerInput);
      driftCache.set(sha, { drift, global });
    }
    return driftCache.get(sha);
  };
  for (const file of new Set(candidates)) {
    summary.candidates += 1;
    const p = proofs.get(file);
    if (!p || typeof p.recordedSha !== "string" || !Array.isArray(p.executedModules)) {
      summary.noProof += 1;
      continue;
    }
    if (!p.executedModules.includes(file)) {
      summary.noProof += 1; // not a run of THIS file
      continue;
    }
    if (p.runContext !== runContext) {
      summary.otherContext += 1;
      continue;
    }
    if (p.runnerIdentity !== runnerIdentity) {
      summary.otherRunner += 1;
      continue;
    }
    if (!Number.isFinite(p.recordedAtMs) || nowMs - p.recordedAtMs > maxAgeMs || p.recordedAtMs > nowMs + 60_000) {
      summary.expired += 1;
      continue;
    }
    if (p.inputsCaptured !== true) {
      summary.notCaptured += 1;
      continue;
    }
    if (Array.isArray(p.opaqueReasons) && p.opaqueReasons.length > 0) {
      summary.opaque += 1;
      continue;
    }
    const { drift, global } = driftFor(p.recordedSha);
    if (drift === null) {
      summary.unknownDrift += 1;
      continue;
    }
    if (global) {
      summary.globalInput += 1;
      continue;
    }
    const inputs = new Set([file, ...p.executedModules]);
    const readDirs = [];
    for (const r of p.readPaths ?? []) {
      if (r.endsWith("/")) readDirs.push(r);
      else inputs.add(r);
    }
    const dirs = new Set();
    for (const m of p.executedModules) {
      let d = path.posix.dirname(m);
      while (!dirs.has(d)) {
        dirs.add(d);
        if (d === "." || d === "/") break;
        d = path.posix.dirname(d);
      }
    }
    let changed = false;
    for (const rel of drift) {
      if (invalidates(rel, { inputs, readDirs, dirs })) {
        changed = true;
        break;
      }
    }
    if (changed) {
      summary.inputChanged += 1;
      continue;
    }
    summary.reused += 1;
    skip.push(file);
  }
  skip.sort();
  return { skip, summary };
}

/** One greppable line per workspace: how many selected files were reused, and why others ran. */
export function formatTestReuseLine(wsName, summary, extra = "") {
  const s = summary;
  return (
    `TEST_PASS_REUSE ws=${wsName} candidates=${s.candidates} reused=${s.reused} noProof=${s.noProof} ` +
    `otherContext=${s.otherContext} otherRunner=${s.otherRunner} expired=${s.expired} ` +
    `notCaptured=${s.notCaptured} opaque=${s.opaque} unknownDrift=${s.unknownDrift} ` +
    `globalInput=${s.globalInput} inputChanged=${s.inputChanged}${extra}`
  );
}
