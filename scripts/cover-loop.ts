#!/usr/bin/env node
// scripts/cover-loop.ts — P-025, plan design-to-code-coverage-seam-2026-09-02.
//
// The Qodo Cover loop D-004 adopts, fitted to our own gates: judge one
// candidate test on all three legs — does it BUILD, does it PASS, and does it
// RAISE COVERAGE — and keep it only if all three clear.
//
//   npm run gate:cover-loop -- --candidate packages/x/lib/new.test.ts \
//        --baseline-lcov coverage/lcov.baseline.info \
//        --candidate-lcov coverage/lcov.info
//   npm run gate:cover-loop -- --candidate <f> ... --json
//
// THE PRODUCING SEQUENCE for the two lcov artifacts. Take the baseline BEFORE
// the candidate exists — that is the natural order of a generate→verify loop,
// and it means nothing here ever moves a file aside to synthesise a baseline
// (mutating the shared tree for a measurement is how a sweep commits a mutant):
//
//   # 1. baseline — before generating anything
//   npm run test:affected -- --coverage --changed-paths <module under test>
//   npm run coverage:merge -- --out coverage/lcov.baseline.info
//   # 2. write the candidate test, then re-measure
//   npm run test:affected -- --coverage --changed-paths <module under test>
//   npm run coverage:merge
//   # 3. judge
//   npm run gate:cover-loop -- --candidate <the new test> \
//        --baseline-lcov coverage/lcov.baseline.info --candidate-lcov coverage/lcov.info
//
// Both artifacts must be produced the same way, so their source paths are
// comparable; `coverage:merge` normalises them to repo-root-relative.
//
// EXIT CODES — three-valued, matching the sibling patch-coverage gate:
//   0  KEEP         — builds, passes, and reaches lines the suite did not
//   1  DISCARD      — a leg conclusively failed (incl. a passing test that
//                     gains zero coverage, which is the case this loop exists
//                     for: "it passed" is never sufficient)
//   2  UNDETERMINED or misuse — a leg could not be measured. NEVER reported as
//                     keep or discard: per D-048 an unmeasurable coverage delta
//                     and a zero one are opposite meanings with identical
//                     counts, and collapsing them fails toward false confidence.
//
// ⚠ Do NOT be tempted to route the candidate's diff through
// `npm run gate:patch-coverage` instead. That gate excludes `*.test.ts` by
// design, so a candidate test skips every path, measures zero lines, and exits
// 0 — passing every generated test including the ones with no coverage gain.
// D-048 records the measurement.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeCoverLoopVerdict,
  judgeCoverLoop,
  type BuildLegResult,
  type CoverageSnapshot,
  type TestLegResult,
} from '../packages/operator-core/lib/qodo-cover-loop.ts';
import { parseLcov } from './lib/lcov-merge.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Run a command for its output; a non-zero exit is a result here, not a throw. */
function capture(command: string, args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${e.stdout ?? ''}\n${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

/** Last occurrence of a `MARKER key=value ...` line, as a field map. */
function lastMarker(output: string, marker: string): Map<string, string> | null {
  const lines = output.split('\n').filter((line) => line.includes(marker));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const fields = new Map<string, string>();
  for (const match of line.matchAll(/([a-zA-Z][a-zA-Z0-9_]*)=("[^"]*"|\S+)/g)) {
    fields.set(match[1], match[2].replace(/^"|"$/g, ''));
  }
  return fields;
}

/**
 * BUILD leg — `lint:tsc` over the candidate alone.
 *
 * Only `status=clean` is a pass: `partial` means files went unchecked, which is
 * not a verdict about the candidate. An absent marker is undetermined, never a
 * failure — the gate not running is not evidence against the test.
 */
function buildLeg(candidate: string): BuildLegResult {
  const { stdout, code } = capture('node', ['scripts/lint-tsc.mjs', `--files=${candidate}`]);
  const marker = lastMarker(stdout, 'LINT_TSC_RESULT');
  const status = marker?.get('status');

  if (status === 'clean') return { ok: true };
  if (status && status !== 'partial') {
    const errors = stdout.split('\n').filter((l) => /error TS\d+/.test(l));
    if (errors.length > 0) return { ok: false, detail: errors[0].trim() };
    return { ok: false, detail: `lint:tsc status=${status}` };
  }
  if (!marker && code !== 0) {
    const errors = stdout.split('\n').filter((l) => /error TS\d+/.test(l));
    if (errors.length > 0) return { ok: false, detail: errors[0].trim() };
  }
  return {
    ok: null,
    detail: marker ? `lint:tsc status=${status}` : 'lint:tsc emitted no LINT_TSC_RESULT marker',
  };
}

/**
 * TEST leg — the file router on the candidate alone.
 *
 * The router deliberately WITHHOLDS its `TEST_FILE_RESULT` line when a run
 * executed nothing, precisely so a vacuous green cannot be read as a pass. An
 * absent marker is therefore undetermined here, matching that contract.
 */
function testLeg(candidate: string): TestLegResult {
  const { stdout } = capture('npm', ['run', '--silent', 'test:file', '--', candidate]);
  const marker = lastMarker(stdout, 'TEST_FILE_RESULT');
  const status = marker?.get('status');

  if (status === 'passed') return { ok: true, detail: 'TEST_FILE_RESULT status=passed' };
  if (status === 'failed') return { ok: false, detail: 'TEST_FILE_RESULT status=failed' };
  return {
    ok: null,
    detail: 'no TEST_FILE_RESULT marker — the router withholds it when a run executed nothing',
  };
}

/** Read one lcov artifact. A missing file is `null` — absent, not empty. */
function snapshot(path: string | null): CoverageSnapshot {
  if (!path) return null;
  const abs = resolve(ROOT, path);
  if (!existsSync(abs)) return null;
  return parseLcov(readFileSync(abs, 'utf8'));
}

function main(): number {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };
  const asJson = args.includes('--json');

  const candidate = argValue('--candidate');
  if (!candidate) {
    console.error('cover-loop: --candidate <path to the generated test file> is required.');
    console.error('  See the header of scripts/cover-loop.ts for the producing sequence.');
    return 2;
  }
  if (!existsSync(resolve(ROOT, candidate))) {
    console.error(`cover-loop: candidate not found: ${candidate}`);
    return 2;
  }
  if (!/\.(test|spec)\.[^.]+$/.test(candidate)) {
    console.error(`cover-loop: --candidate must be a test file; got ${candidate}`);
    return 2;
  }

  const baselineLcov = argValue('--baseline-lcov');
  const candidateLcov = argValue('--candidate-lcov') ?? 'coverage/lcov.info';

  const build = args.includes('--skip-build') ? { ok: null, detail: '--skip-build' } : buildLeg(candidate);
  const tests =
    build.ok === true && !args.includes('--skip-tests')
      ? testLeg(candidate)
      : { ok: null, detail: build.ok === true ? '--skip-tests' : 'not run: build leg did not pass' };

  const verdict = judgeCoverLoop({
    build,
    tests,
    baseline: snapshot(baselineLcov),
    candidate: snapshot(candidateLcov),
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          candidate,
          baselineLcov,
          candidateLcov,
          ...verdict,
          delta: verdict.delta
            ? { ...verdict.delta, newlyCoveredByFile: verdict.delta.newlyCoveredByFile }
            : null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(describeCoverLoopVerdict(verdict));
    console.log(`  candidate=${candidate}`);
    console.log(`  baseline-lcov=${baselineLcov ?? '(none supplied)'} candidate-lcov=${candidateLcov}`);
    for (const note of verdict.notes) console.log(`  note: ${note}`);
    for (const file of verdict.delta?.newlyCoveredByFile ?? []) {
      console.log(`  +covered ${file.file}: ${file.lines.join(', ')}`);
    }
    if (verdict.decision === 'undetermined') {
      console.log('  UNDETERMINED is not a pass: re-measure before keeping or discarding.');
    }
  }

  if (verdict.decision === 'keep') return 0;
  if (verdict.decision === 'discard') return 1;
  return 2;
}

process.exit(main());
