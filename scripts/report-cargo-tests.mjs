#!/usr/bin/env node
/**
 * report-cargo-tests.mjs — run a Rust crate's `cargo test` and record one row
 * PER TEST FUNCTION into harness_shared.test_runs (framework='cargo'), so the
 * Tests tab picks up native Rust coverage the same way it already does for
 * vitest (admin-test-runs-reporter.ts) and playwright
 * (admin-test-runs-reporter-playwright.ts).
 *
 * Plan production-test-readiness-2026-07-06 P-009: ~151-205 cargo #[test] fns
 * exist (papercusp-desktop/src-tauri, the Tauri shell) but harness_shared.test_runs
 * had ZERO framework=cargo rows — the desktop shell's native test signal was
 * invisible to the Tests tab. There is no cargo-nextest on this box and no
 * stable-toolchain machine-readable test output (`--format json` needs nightly
 * `-Z unstable-options`), so this parses PLAIN `cargo test` stdout — the
 * `test <qualified::name> ... ok|FAILED|ignored` lines plus the trailing
 * `---- <name> stdout ----` failure-detail blocks for output_tail.
 *
 * D-007 fail-soft contract (mirrors admin-test-runs-reporter.ts):
 *   - the recorder's own DB/network faults NEVER change this script's exit code
 *     — that exit code is cargo test's real pass/fail, for CI/agent use.
 *   - short connect timeout, swallow every PG error, never throw out of the
 *     insert path.
 *
 * Usage: node scripts/report-cargo-tests.mjs --manifest-path <path/to/Cargo.toml> [-- <cargo test args>]
 * Example: node scripts/report-cargo-tests.mjs --manifest-path papercusp-desktop/src-tauri/Cargo.toml
 *
 * Granularity note: stable `cargo test` gives no per-test source-file or duration
 * — only a qualified test path (e.g. `app_role::tests::role_from_env_defaults_to_gui`)
 * and pass/fail/ignored. Each test's `file_path` row is therefore
 * `<crate-dir>::<qualified::test::path>` (not a real filesystem path) so it stays
 * unique + greppable; duration_ms is null per-row (unknown), and the WHOLE
 * binary's wall-clock elapsed is recorded as one extra aggregate row
 * (`<crate-dir> (cargo aggregate)`) so the Tests tab still has a duration signal.
 */
import { spawn } from 'node:child_process';
import { resolve, dirname, relative, sep, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * Resolve an actual `cargo` binary rather than trusting a bare `spawn('cargo', ...)`
 * to find it on inherited PATH. A rustup-managed toolchain lives at `~/.cargo/bin/cargo`
 * (a shim), but a service-managed PATH (a systemd --user unit, a routine ticker host,
 * CI) can easily omit that dir — the exact same ENOENT class that already hit `node`
 * once (EI-2048) and hit `cargo` here (WI-3206, 2026-07-06: the scheduled routine's
 * first live fire recorded a single `spawn cargo ENOENT` error row instead of running
 * the suite, because papercup-bg-host.service's PATH override didn't include
 * ~/.cargo/bin). Falling back to well-known install dirs makes this recorder resilient
 * to that class of environment drift wherever it runs, not just on this one box's
 * systemd drop-in fix.
 */
function resolveCargoBin() {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((d) => join(d, 'cargo')),
    process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin', 'cargo') : null,
    join(homedir(), '.cargo', 'bin', 'cargo'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'cargo'; // last resort — let spawn's own ENOENT surface if truly absent
}

function parseArgs(argv) {
  const out = { manifestPath: null, cargoArgs: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === '--manifest-path') {
      out.manifestPath = argv[++i];
    } else if (argv[i] === '--') {
      out.cargoArgs = argv.slice(i + 1);
      break;
    }
  }
  return out;
}

function runCargoTest(manifestAbs, extraArgs) {
  return new Promise((resolvePromise) => {
    const args = ['test', '--manifest-path', manifestAbs, '--no-fail-fast', '--', '--test-threads=4', ...extraArgs];
    const startedAt = new Date();
    const child = spawn(resolveCargoBin(), args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr, startedAt, finishedAt: new Date() });
    });
    child.on('error', (err) => {
      resolvePromise({ code: 1, stdout, stderr: `${stderr}\nspawn error: ${err.message}`, startedAt, finishedAt: new Date() });
    });
  });
}

/** Parse `test <name> ... ok|FAILED|ignored` result lines (there may be several
 *  such blocks — one per compiled test binary target — so accumulate across all). */
function parseTestResultLines(output) {
  const results = [];
  const re = /^test (\S+) \.\.\. (ok|FAILED|ignored)\s*$/gm;
  let m;
  while ((m = re.exec(output))) {
    results.push({ name: m[1], outcome: m[2] });
  }
  return results;
}

/** Parse the `---- <name> stdout ----\n<body>` failure-detail blocks cargo prints
 *  under a trailing `failures:` section, keyed by test name, for output_tail. */
function parseFailureDetails(output) {
  const details = new Map();
  const re = /---- (\S+) stdout ----\n([\s\S]*?)(?=\n---- \S+ stdout ----|\nfailures:|\ntest result:|$)/g;
  let m;
  while ((m = re.exec(output))) {
    details.set(m[1], m[2].trim().slice(-4000));
  }
  return details;
}

async function tryGetPg() {
  try {
    const mod = await import('postgres');
    const pg = mod.default ?? mod;
    const url =
      process.env.HARNESS_ADMIN_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
    return pg(url, { max: 2, connect_timeout: 2, onnotice: () => {} });
  } catch {
    return null;
  }
}

async function insertRows(sql, rows) {
  if (!sql) return 0;
  let inserted = 0;
  for (const row of rows) {
    try {
      await Promise.race([
        sql`
          INSERT INTO harness_shared.test_runs
            (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, source)
          VALUES
            (${row.filePath}, 'cargo', ${row.status}, ${row.durationMs}, ${row.startedAt}, ${row.finishedAt}, ${row.outputTail}, ${row.source})
        `,
        new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 2000)),
      ]);
      inserted++;
    } catch {
      /* swallow — D-007: a broken ledger must never fail the test run */
    }
  }
  return inserted;
}

async function main() {
  const { manifestPath, cargoArgs } = parseArgs(process.argv.slice(2));
  if (!manifestPath) {
    console.error('usage: report-cargo-tests.mjs --manifest-path <path/to/Cargo.toml> [-- <cargo test args>]');
    process.exit(2);
  }
  const manifestAbs = resolve(REPO_ROOT, manifestPath);
  const crateDir = relative(REPO_ROOT, dirname(manifestAbs)).split(sep).join('/');

  console.log(`[report-cargo-tests] running: cargo test --manifest-path ${manifestPath} --no-fail-fast`);
  const { code, stdout, stderr, startedAt, finishedAt } = await runCargoTest(manifestAbs, cargoArgs);
  const combined = `${stdout}\n${stderr}`;
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const results = parseTestResultLines(combined);
  const failureDetails = parseFailureDetails(combined);
  const source = process.env.CI ? 'ci' : 'local';

  const rows = results.map((r) => ({
    filePath: `${crateDir}::${r.name}`,
    status: r.outcome === 'ok' ? 'pass' : r.outcome === 'ignored' ? 'skip' : 'fail',
    durationMs: null,
    startedAt,
    finishedAt,
    outputTail: r.outcome === 'FAILED' ? (failureDetails.get(r.name) ?? null) : null,
    source,
  }));

  // One aggregate row for the whole binary so the Tests tab has a duration signal
  // even though stable `cargo test` gives no per-test timing.
  const anyFail = results.some((r) => r.outcome === 'FAILED');
  rows.push({
    filePath: `${crateDir} (cargo aggregate)`,
    status: results.length === 0 ? 'error' : anyFail ? 'fail' : 'pass',
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    startedAt,
    finishedAt,
    outputTail: results.length === 0 ? combined.slice(-4000) : null,
    source,
  });

  if (results.length === 0) {
    console.error(`[report-cargo-tests] WARNING: parsed 0 test result lines from cargo test output (exit code ${code}) — recording a single error aggregate row.`);
  }

  const sql = await tryGetPg();
  const inserted = await insertRows(sql, rows);
  if (sql) {
    try { await sql.end({ timeout: 2 }); } catch { /* swallow */ }
  }
  console.log(`[report-cargo-tests] parsed ${results.length} test results; inserted ${inserted}/${rows.length} rows (framework=cargo) into harness_shared.test_runs.`);

  // The wrapper's exit code reflects cargo test's REAL outcome — never the
  // recorder's own DB fault (D-007: ledger health must never gate the test run).
  process.exit(code ?? 0);
}

main();
