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

/**
 * Build the `changedBetween` seam over a real git checkout. `git diff --name-only A B` names
 * every path that differs between the two commits (a rename appears as both names); an
 * unknown sha — one gc'd away, or from a lineage this checkout never had — makes the diff
 * fail, and that reads as `null` ("cannot tell"), which the pruning rule treats as stale.
 *
 * @param {{ repoRoot: string, exec?: (file: string, args: string[], opts: object) => string }} o
 * @returns {import('./related-tests.mjs').ChangedBetween}
 */
export function gitChangedBetween({ repoRoot, exec = defaultExec }) {
  /** @type {Map<string, Set<string> | null>} */
  const cache = new Map();
  return (recordedSha, judgedSha) => {
    const key = `${recordedSha}..${judgedSha}`;
    if (cache.has(key)) return cache.get(key);
    let result = null;
    try {
      const out = exec("git", ["diff", "--name-only", recordedSha, judgedSha], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
      result = new Set(
        String(out)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((rel) => path.resolve(repoRoot, rel)),
      );
    } catch {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
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
