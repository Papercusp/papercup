// Executed-source map — the runner side of P-002 (gate-latency-selection-and-retry-policy-2026-09-06).
//
// libs/test-config/src/executed-source-map-reporter.ts records, per test file, the modules
// vitest actually executed on a clean-checkout run, into harness_shared.test_executed_sources
// (migration 1132). This module LOADS that map for one workspace and supplies the git drift
// seam, in exactly the shape `selectRelatedTests({ executedMap, judgedSha, changedBetween })`
// consumes (scripts/lib/related-tests.mjs, `pruneWithExecutedMap`). The pruning rule itself
// lives there, next to the static selection it narrows, so the selector's unit tests pin both.
//
// Every failure here is fail-OPEN toward the static selection: an unreachable database, a
// missing table, an unparsable row, a sha git cannot diff — each yields "no map" (or "unknown
// drift" for one entry), and the static superset runs. Nothing in this file can shrink a run
// on its own.

import { execFileSync } from "node:child_process";
import path from "node:path";

/** Set to `0`/`false`/`off` to leave the static selection un-pruned (default: pruning ON). */
export const EXECUTED_MAP_ENV = "AFFECTED_EXECUTED_MAP";
/** Stamped on a spawned vitest task so the reporter records this workspace's map (default: ON). */
export const EXECUTED_MAP_RECORD_ENV = "AFFECTED_RECORD_EXECUTED_SOURCES";
/** The reporter's arming channel: the npm workspace name whose runs it should record. */
export const EXECUTED_MAP_WORKSPACE_ENV = "PC_EXECUTED_SOURCE_MAP_WORKSPACE";
/** Optional: also write the recorded rows as JSON to this path (replay/inspection; no DB needed). */
export const EXECUTED_MAP_OUT_ENV = "PC_EXECUTED_SOURCE_MAP_OUT";

const OFF = new Set(["0", "false", "off", "no"]);

/** @param {Record<string, string | undefined>} [env] */
export function executedMapEnabled(env = process.env) {
  const raw = env[EXECUTED_MAP_ENV];
  return raw == null || !OFF.has(String(raw).trim().toLowerCase());
}

/** @param {Record<string, string | undefined>} [env] */
export function executedMapRecordingEnabled(env = process.env) {
  const raw = env[EXECUTED_MAP_RECORD_ENV];
  return raw == null || !OFF.has(String(raw).trim().toLowerCase());
}

/**
 * The database the map is read from — the SAME precedence the recording reporter uses
 * (libs/test-config/src/admin-test-runs-reporter.ts `tryGetPg`), so reader and writer can
 * never disagree about which database holds the rows. Pure over an env.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ url: string, source: 'HARNESS_ADMIN_DATABASE_URL' | 'PAPERCUSP_TEST_RUNS_DB_URL' | 'default' }}
 */
export function resolveExecutedMapPgUrl(env = process.env) {
  if (env.HARNESS_ADMIN_DATABASE_URL) {
    return { url: env.HARNESS_ADMIN_DATABASE_URL, source: "HARNESS_ADMIN_DATABASE_URL" };
  }
  if (env.PAPERCUSP_TEST_RUNS_DB_URL) {
    return { url: env.PAPERCUSP_TEST_RUNS_DB_URL, source: "PAPERCUSP_TEST_RUNS_DB_URL" };
  }
  return {
    url: "postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp",
    source: "default",
  };
}

/**
 * Open a short-lived `pg` client for the selection read. Bounded: a database that does not
 * answer within `timeoutMs` is "no map", never a stalled selection.
 *
 * @param {{ env?: Record<string, string | undefined>, timeoutMs?: number }} [o]
 * @returns {Promise<import('pg').Client>}
 */
export async function connectExecutedMapPg({ env = process.env, timeoutMs = 5_000 } = {}) {
  const { Client } = await import("pg");
  const { url } = resolveExecutedMapPgUrl(env);
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: 15_000,
    application_name: "affected-tests executed-source-map",
  });
  await client.connect();
  return client;
}

/**
 * Turn stored rows into the selector's map. Pure — exported for the unit tests.
 *
 * Rows arrive newest-first per (workspace, test file); the first row wins. Paths are
 * repo-root-relative POSIX in the table and ABSOLUTE in the selector (it compares against
 * `changedPaths`, which are absolute), so this is where they are re-anchored.
 *
 * @param {Array<{ test_file: string, recorded_sha: string, executed_modules: string[] | null }>} rows
 * @param {{ repoRoot: string }} o
 * @returns {import('./related-tests.mjs').ExecutedMap}
 */
export function rowsToExecutedMap(rows, { repoRoot }) {
  /** @type {Map<string, { recordedSha: string, executed: Set<string> }>} */
  const map = new Map();
  for (const row of rows ?? []) {
    if (!row || typeof row.test_file !== "string" || typeof row.recorded_sha !== "string") continue;
    if (!Array.isArray(row.executed_modules) || row.executed_modules.length === 0) continue;
    const key = path.resolve(repoRoot, row.test_file);
    if (map.has(key)) continue; // newest-first: keep the first
    const executed = new Set();
    for (const m of row.executed_modules) {
      if (typeof m === "string" && m.length > 0) executed.add(path.resolve(repoRoot, m));
    }
    if (executed.size === 0) continue;
    map.set(key, { recordedSha: row.recorded_sha, executed });
  }
  return map;
}

/**
 * Load the newest executed map per test file for one workspace.
 *
 * @param {object} o
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }} o.client
 *        a `pg` Client (scripts/lib/pg-url.mjs `connectScriptPg`)
 * @param {string} o.workspaceName npm workspace name
 * @param {string} o.repoRoot
 * @returns {Promise<{ map: import('./related-tests.mjs').ExecutedMap, rows: number }>}
 */
export async function loadExecutedSourceMap({ client, workspaceName, repoRoot }) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (test_file) test_file, recorded_sha, executed_modules
       FROM harness_shared.test_executed_sources
      WHERE workspace_name = $1
      ORDER BY test_file, recorded_at DESC`,
    [workspaceName],
  );
  return { map: rowsToExecutedMap(rows, { repoRoot }), rows: rows.length };
}

/** @param {unknown} v @returns {string[]} */
function stringArray(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.length > 0) : [];
}

/**
 * Newest pass proof per test file, keyed REPO-RELATIVE (gate-file-level-test-reuse-2026-09-27
 * P-008): the input `selectReusablePasses` (scripts/lib/test-pass-reuse.mjs) judges. Rows
 * arrive newest-first per test file; the first wins. A row that cannot be read is dropped,
 * which the rule reads as "no proof" (the file runs).
 *
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Map<string, import('./test-pass-reuse.mjs').ReuseProof>}
 */
export function rowsToReuseProofs(rows) {
  /** @type {Map<string, import('./test-pass-reuse.mjs').ReuseProof>} */
  const proofs = new Map();
  for (const row of rows ?? []) {
    if (!row || typeof row.test_file !== "string" || typeof row.recorded_sha !== "string") continue;
    if (proofs.has(row.test_file)) continue;
    const at = row.recorded_at instanceof Date ? row.recorded_at.getTime() : Date.parse(String(row.recorded_at));
    proofs.set(row.test_file, {
      recordedSha: row.recorded_sha,
      recordedAtMs: Number.isFinite(at) ? at : Number.NaN,
      executedModules: stringArray(row.executed_modules),
      readPaths: stringArray(row.read_paths),
      inputsCaptured: row.inputs_captured === true,
      opaqueReasons: stringArray(row.opaque_reasons),
      runContext: typeof row.run_context === "string" ? row.run_context : null,
      runnerIdentity: typeof row.runner_identity === "string" ? row.runner_identity : null,
    });
  }
  return proofs;
}

/**
 * Load the newest pass proof per test file for one workspace and ONE run context (D-004 rule 1:
 * reuse only consumes proofs its own runner class recorded).
 *
 * @param {object} o
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }} o.client
 * @param {string} o.workspaceName
 * @param {string} o.runContext
 * @returns {Promise<{ proofs: Map<string, import('./test-pass-reuse.mjs').ReuseProof>, rows: number }>}
 */
export async function loadReuseProofs({ client, workspaceName, runContext }) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (test_file) test_file, recorded_sha, recorded_at, executed_modules,
            read_paths, inputs_captured, opaque_reasons, run_context, runner_identity
       FROM harness_shared.test_executed_sources
      WHERE workspace_name = $1 AND run_context = $2
      ORDER BY test_file, recorded_at DESC`,
    [workspaceName, runContext],
  );
  return { proofs: rowsToReuseProofs(rows), rows: rows.length };
}

/**
 * Build the `changedBetween` seam over a real git checkout. `git diff --name-only A B` names
 * every path that differs between the two commits (a rename appears as both names); an
 * unknown sha — one gc'd away, or from a lineage this checkout never had — makes the diff
 * fail, and that reads as `null` ("cannot tell"), which the pruning rule treats as stale.
 *
 * `relative: true` returns repo-root-relative POSIX paths (the per-file pass-reuse rule's
 * input) instead of absolute ones (the pruning selector's input).
 *
 * @param {{ repoRoot: string, exec?: (file: string, args: string[], opts: object) => string, relative?: boolean }} o
 * @returns {import('./related-tests.mjs').ChangedBetween}
 */
export function gitChangedBetween({ repoRoot, exec = defaultExec, relative = false }) {
  /** @type {Map<string, Set<string> | null>} */
  const cache = new Map();
  return (recordedSha, judgedSha) => {
    const key = `${recordedSha}..${judgedSha}`;
    if (cache.has(key)) return cache.get(key);
    let result = null;
    try {
      const out = new Set();
      result = collectRecursiveDiff({ exec, repoDir: repoRoot, prefix: "", a: recordedSha, b: judgedSha, out })
        ? relative
          ? out
          : new Set([...out].map((rel) => path.resolve(repoRoot, rel)))
        : null;
    } catch {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
}

/** Every-zero object id: git's marker for "absent on this side" in `--raw` output. */
const ZERO_OID_RE = /^0+$/;

/**
 * Collect repo-root-relative paths changed between `a` and `b`, RECURSING into submodules
 * (gate-file-level-test-reuse-2026-09-27 D-003). A superproject `git diff --name-only` names a
 * submodule change as the bare gitlink path, which no executed module ever equals, so a change
 * inside any of the ~38 submodules used to read as "no drift". A moved gitlink is diffed INSIDE
 * the submodule between the two pinned commits. Anything that cannot be diffed (a submodule
 * added, removed or type-changed; a pinned commit missing from the local clone) returns false,
 * and the caller reads that as "cannot tell" (stale), never as "nothing changed".
 *
 * @returns {boolean} true when the full recursive diff was computed
 */
export function collectRecursiveDiff({ exec, repoDir, prefix, a, b, out }) {
  const opts = {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  };
  const raw = String(exec("git", ["diff", "--raw", "--no-renames", "--abbrev=40", "-z", a, b], opts));
  // -z --raw: ":<m1> <m2> <o1> <o2> <status>\0<path>\0" repeated.
  const parts = raw.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].replace(/^\n/, "");
    const rel = parts[i + 1];
    if (!meta || !rel) continue;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) /.exec(meta);
    if (!m) return false;
    const [, modeA, modeB, oidA, oidB] = m;
    out.add(prefix + rel);
    if (modeA !== "160000" && modeB !== "160000") continue;
    if (modeA !== modeB || ZERO_OID_RE.test(oidA) || ZERO_OID_RE.test(oidB)) return false;
    const subDir = path.join(repoDir, rel);
    if (!collectRecursiveDiff({ exec, repoDir: subDir, prefix: `${prefix}${rel}/`, a: oidA, b: oidB, out })) {
      return false;
    }
  }
  return true;
}

function defaultExec(file, args, opts) {
  return execFileSync(file, args, opts);
}

/**
 * One greppable line per workspace selection, so a run that did not narrow is never silent
 * about why.
 *
 * @param {string} wsName
 * @param {import('./related-tests.mjs').ExecutedMapSummary | undefined} summary
 * @param {number} rows
 */
export function formatExecutedMapLine(wsName, summary, rows) {
  if (!summary) return `EXECUTED_SOURCE_MAP ws=${wsName} applied=false reason=no-summary rows=${rows}`;
  const k = summary.kept;
  return (
    `EXECUTED_SOURCE_MAP ws=${wsName} applied=${summary.applied} reason=${summary.reason ?? "ok"} ` +
    `rows=${rows} entries=${summary.entries} pruned=${summary.pruned} prunable=${summary.prunable} ` +
    `wouldEmpty=${summary.wouldEmpty} keptChangedTest=${k.changedTest} keptUnresolved=${k.unresolved} ` +
    `keptNoEntry=${k.noEntry} keptUntrusted=${k.untrusted} keptUnknownDrift=${k.unknownDrift} ` +
    `keptStale=${k.stale} keptIntersects=${k.intersects}`
  );
}
