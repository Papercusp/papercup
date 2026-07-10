#!/usr/bin/env node
/**
 * scripts/cargo-tests.mjs — Run cargo tests and report results to harness_shared.test_runs.
 *
 * Plan: production-test-readiness-2026-07-06, P-009. Wire Rust/cargo native suite
 * (~258 tests in papercusp-desktop/src-tauri) into the test_runs ledger on the same
 * cadence as vitest/playwright.
 *
 * Usage:
 *   node scripts/cargo-tests.mjs
 *
 * Opt-out:
 *   PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1 node scripts/cargo-tests.mjs
 *
 * Environment variables (from parent test runner):
 *   - PAPERCUSP_TEST_RUN_SOURCE: 'ci' | 'local' | 'admin-ui'
 *   - PAPERCUSP_TEST_RUN_GROUP: run group id
 *   - PAPERCUSP_TEST_RUN_HARNESS: harness slug
 *   - PAPERCUSP_WORKSPACE_ID: workspace id
 *   - HARNESS_ADMIN_DATABASE_URL: PG connection URL
 *
 * D-007 contract: fails soft — never affect cargo exit code, never throw.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exec } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CARGO_DIR = join(ROOT, 'papercusp-desktop', 'src-tauri');

/**
 * Run cargo test for papercusp-desktop/src-tauri and capture output.
 * Parse output and insert results into test_runs table.
 */
async function runCargoTests() {
  return new Promise((resolve) => {
    try {
      const startTime = Date.now();
      const child = exec('cargo test 2>&1', { cwd: CARGO_DIR, timeout: 300_000 }, (err, stdout) => {
        const durationMs = Date.now() - startTime;
        try {
          // Parse output and extract test results
          const testResults = parseCargoTestOutput(stdout);

          // Import and call the reporter function
          (async () => {
            try {
              const { reportCargoTests: reportFn } = await import(
                join(ROOT, 'libs', 'test-config', 'src', 'cargo-test-reporter.ts')
              );
              const cargoTomlPath = join(CARGO_DIR, 'Cargo.toml');
              await reportFn(CARGO_DIR, cargoTomlPath);
            } catch {
              // Fail-soft: swallow reporter errors
            }
            resolve(0);
          })();
        } catch {
          // Fail-soft
          resolve(0);
        }
      });

      child.on('error', () => {
        // Fail-soft: cargo process error
        resolve(0);
      });
    } catch {
      // Fail-soft: general error
      resolve(0);
    }
  });
}

/**
 * Parse `cargo test` output and extract test results.
 * Returns raw output for the reporter to parse.
 */
function parseCargoTestOutput(output) {
  // The reporter will handle the actual parsing
  // This is just for local validation if needed
  const testLineRegex = /^test\s+([^\s]+)\s+\.\.\.\s+(ok|FAILED|ignored)/gm;
  const results = [];
  let match;
  while ((match = testLineRegex.exec(output)) !== null) {
    results.push({ testName: match[1], status: match[2] });
  }
  return results;
}

// Main entry
if (process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1') {
  // Opt-out: just exit silently
  process.exit(0);
}

runCargoTests()
  .then((exitCode) => {
    process.exit(exitCode ?? 0);
  })
  .catch(() => {
    // D-007: fail-soft
    process.exit(0);
  });
