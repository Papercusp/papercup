#!/usr/bin/env node
/**
 * lint:tsc — Gate NEW TypeScript type errors in operator-core against a PER-FILE baseline.
 *
 * ## Why per-file, not a global count (P-010 / WI-4535)
 *
 * The old gate compared ONE integer — the total operator-core error count — against a single
 * pinned number (224). On this heavily-parallel shared tree that number cannot attribute a
 * regression and it inherently FLAPS: the count shuffles ±N as peers edit the type-graph
 * concurrently, so a run that reads "231 vs 224" tells you seven errors appeared but NOT which
 * files, NOT whether YOUR change caused them, and NOT whether it is just the same deep-
 * instantiation ripple shuffling again. That drove a documented series of false-reds and
 * baseline-pinning wars (see the old .tsc-baseline.json note; EI-379 / EI-1984).
 *
 * The fix records the baseline PER FILE (`{ "packages/operator-core/lib/x.ts": 2, … }`) and
 * gates each file against its own count. A regression is therefore ATTRIBUTED to the file that
 * caused it — the gate NAMES it (`lib/x.ts: 2 → 4  (+2)`) — and a concurrent ±1 flap in file A
 * never reds an agent who only edited file B. `--mine` scopes the FAILURE to the files you
 * actually changed (from `git status`), so you can cheaply verify "my change is tsc-clean" even
 * while the shared tree carries unrelated peer drift.
 *
 * Two hard rules carry over (audit P-073, EI-104 — a frozen baseline must not neutralize strictness):
 *
 *   1. RATCHET-ONLY-DOWN, on an EXPLICIT `--update` only. When a file is BELOW its baseline,
 *      `--update` tightens that file's baseline to the new count — improvements lock in and can't
 *      silently regress; RAISING a file's baseline is a deliberate hand-edit of the JSON with a
 *      justification. A BARE run (CI / a peer's `npm run lint:tsc`) only CHECKS — it never
 *      rewrites the baseline. Per-file makes this safe where the global count could not be:
 *      auto-ratcheting a global count locked in a transient tree-wide low and then false-red the
 *      fleet when it reappeared; a per-file ratchet only ever lowers a file that genuinely improved.
 *   2. SYNTAX HARD-FAIL: any file with a parse-level error (TS1xxx — the file fails to compile at
 *      all, so tsc under-reports everything behind it) fails the lint regardless of the counts.
 *
 * Usage:
 *   npm run lint:tsc              # CI gate: any file above its baseline fails, and is NAMED
 *   npm run lint:tsc -- --mine    # only fail on regressions in files YOU changed (git status)
 *   npm run lint:tsc -- --update  # lower each improved file's baseline to current (never raises)
 *
 * Exit codes:
 *   0 — OK (every file at/under its baseline; or --mine and your files are clean; or ratcheted down)
 *   1 — a file regressed above its baseline, a syntax-broken file, or a script/toolchain error
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'packages/operator-core/.tsc-baseline.json');

/** Parse tsc output into { file, code } entries (file null when unattributable). */
export function parseTscErrors(tscOutput) {
  const errors = [];
  for (const line of String(tscOutput).split('\n')) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+):/);
    if (m) {
      errors.push({ file: m[1], code: m[4] });
      continue;
    }
    const bare = line.match(/error (TS\d+):/);
    if (bare) errors.push({ file: null, code: bare[1] });
  }
  return errors;
}

/** Files carrying parse-level (TS1xxx) errors — they fail to compile at all. */
export function syntaxBrokenFiles(errors) {
  const files = new Set();
  for (const e of errors) {
    if (/^TS1\d{3}$/.test(e.code)) files.add(e.file ?? '(unattributed)');
  }
  return [...files].sort();
}

/** Aggregate parsed errors into a { file: count } map. Unattributable errors bucket under '(unattributed)'. */
export function countByFile(errors) {
  const map = {};
  for (const e of errors) {
    const key = e.file ?? '(unattributed)';
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
}

function sumValues(map) {
  let total = 0;
  for (const v of Object.values(map)) total += v;
  return total;
}

/**
 * The set of repo-relative paths the caller has changed (staged, unstaged, or untracked), for
 * `--mine` scoping. Fail-SOFT: a git failure (packaged install, detached state) returns an empty
 * set, which under `--mine` means "attribute nothing to me" — never a crash, never a false pass on
 * a real CI gate (CI runs bare, without `--mine`).
 */
export function gitChangedFiles(root = ROOT) {
  try {
    const out = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const files = new Set();
    for (const line of out.split('\n')) {
      if (line.length < 4) continue;
      // "XY <path>" or "XY <old> -> <new>" for renames — take the destination path.
      const rest = line.slice(3).trim();
      const path = rest.includes(' -> ') ? rest.split(' -> ').pop().trim() : rest;
      if (path) files.add(path.replace(/^"|"$/g, ''));
    }
    return files;
  } catch {
    return new Set();
  }
}

/**
 * Pure per-file gate decision — the ONE place the policy lives, so it is unit-testable (EI-104).
 * A file is a REGRESSION when its current error count exceeds its baseline (a file absent from the
 * baseline has an implicit baseline of 0, so any new error in a fresh file is a named regression).
 * Regressions always win over improvements, preserving ratchet-only-down.
 *
 * @param {{
 *   currentByFile: Record<string, number>,
 *   baselineByFile: Record<string, number>,
 *   brokenFiles: string[],
 *   updateFlag?: boolean,
 *   changedFiles?: Set<string> | null,
 * }} args
 * @returns {{
 *   verdict: 'fail-syntax'|'fail-regressed'|'fail-attributed'|'ok-peer-drift'|'ok-ratchet'|'ok-below'|'ok',
 *   regressions: {file:string,baseline:number,current:number,delta:number}[],
 *   improvements: {file:string,baseline:number,current:number,delta:number}[],
 *   attributed?: {file:string,baseline:number,current:number,delta:number}[],
 *   peerDrift?: {file:string,baseline:number,current:number,delta:number}[],
 *   total: number,
 *   baselineTotal: number,
 *   newBaselineByFile?: Record<string, number>,
 *   brokenFiles?: string[],
 * }}
 */
export function decidePerFile({ currentByFile, baselineByFile, brokenFiles, updateFlag = false, changedFiles = null }) {
  const total = sumValues(currentByFile);
  const baselineTotal = sumValues(baselineByFile);
  if (brokenFiles.length > 0) {
    return { verdict: 'fail-syntax', brokenFiles, regressions: [], improvements: [], total, baselineTotal };
  }

  const allFiles = new Set([...Object.keys(currentByFile), ...Object.keys(baselineByFile)]);
  const regressions = [];
  const improvements = [];
  for (const file of allFiles) {
    const current = currentByFile[file] ?? 0;
    const baseline = baselineByFile[file] ?? 0;
    if (current > baseline) regressions.push({ file, baseline, current, delta: current - baseline });
    else if (current < baseline) improvements.push({ file, baseline, current, delta: current - baseline });
  }
  regressions.sort((a, b) => b.delta - a.delta || a.file.localeCompare(b.file));
  improvements.sort((a, b) => a.delta - b.delta || a.file.localeCompare(b.file));

  const base = { regressions, improvements, total, baselineTotal };

  if (regressions.length > 0) {
    if (changedFiles) {
      const attributed = regressions.filter((r) => changedFiles.has(r.file));
      const peerDrift = regressions.filter((r) => !changedFiles.has(r.file));
      // Under --mine the gate fails ONLY when a regression lands in a file you changed. Peer drift
      // in files you did not touch is reported, not gated — that is the "verify MY change is clean"
      // affordance (EI-1984), and it is why --mine is opt-in and never the CI default.
      return attributed.length > 0
        ? { verdict: 'fail-attributed', ...base, attributed, peerDrift }
        : { verdict: 'ok-peer-drift', ...base, attributed: [], peerDrift };
    }
    return { verdict: 'fail-regressed', ...base };
  }

  if (improvements.length > 0) {
    return updateFlag
      ? { verdict: 'ok-ratchet', ...base, newBaselineByFile: { ...currentByFile } }
      : { verdict: 'ok-below', ...base };
  }
  return { verdict: 'ok', ...base };
}

function formatRow(r) {
  return `   ${r.file}: ${r.baseline} → ${r.current}  (${r.delta > 0 ? '+' : ''}${r.delta})`;
}

function main() {
  const args = process.argv.slice(2);
  const updateFlag = args.includes('--update');
  const mineFlag = args.includes('--mine');

  let tscOutput = '';
  let tscThrew = false;
  try {
    // `--incremental false` (WI-4488): operator-core's tsconfig has `incremental: true`, and a
    // warm/stale tsconfig.tsbuildinfo makes `tsc --noEmit` UNDER-REPORT errors in files affected-
    // but-not-edited — on the shared dev tree this masked +29 real errors as green for days. A gate
    // count must not depend on cache warmth: always measure fresh, so a hand-run and CI agree.
    tscOutput = execSync('npx tsc -p packages/operator-core/tsconfig.json --noEmit --incremental false 2>&1', {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    tscThrew = true;
    tscOutput = e.stdout || '';
  }
  if (tscThrew && !tscOutput) {
    // tsc itself failed to run (no diagnostics at all) — never treat that as zero errors, it would
    // ratchet every file's baseline to 0 and mask everything.
    console.error('❌ tsc produced no output — toolchain failure, not a clean run.');
    process.exit(1);
  }

  const errors = parseTscErrors(tscOutput);
  const brokenFiles = syntaxBrokenFiles(errors);
  const currentByFile = countByFile(errors);

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
  } catch {
    console.error(`❌ Failed to read baseline file: ${baselineFile}`);
    process.exit(1);
  }
  const baselineByFile = baseline.files ?? {};
  const changedFiles = mineFlag ? gitChangedFiles(ROOT) : null;

  const result = decidePerFile({ currentByFile, baselineByFile, brokenFiles, updateFlag, changedFiles });
  console.log(
    `TSC operator-core: ${result.total} type errors across ${Object.keys(currentByFile).length} file(s) ` +
      `(baseline total ${result.baselineTotal})${mineFlag ? ' [--mine]' : ''}`,
  );

  const writeBaseline = (byFile, why) => {
    baseline.files = Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b)));
    baseline.operatorCoreErrorCount = sumValues(byFile); // derived total, kept for humans/back-compat
    baseline.updatedAt = new Date().toISOString();
    writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`✓ ${why}: baseline → ${sumValues(byFile)} errors across ${Object.keys(byFile).length} file(s)`);
  };

  switch (result.verdict) {
    case 'fail-syntax':
      console.error(`❌ ${result.brokenFiles.length} file(s) fail to COMPILE (TS1xxx parse errors) — hard fail regardless of baseline:`);
      for (const f of result.brokenFiles) console.error(`   - ${f}`);
      process.exit(1);
      break;
    case 'fail-regressed':
      console.error(`❌ ${result.regressions.length} file(s) added type errors above their baseline:`);
      for (const r of result.regressions) console.error(formatRow(r));
      console.error(`   Fix the new errors in the named file(s). The baseline only ratchets DOWN (raising a file is a hand-edit of ${baselineFile} with justification).`);
      process.exit(1);
      break;
    case 'fail-attributed':
      console.error(`❌ ${result.attributed.length} file(s) YOU changed added type errors above their baseline:`);
      for (const r of result.attributed) console.error(formatRow(r));
      if (result.peerDrift.length > 0) {
        console.error(`   (also ${result.peerDrift.length} regressed file(s) you did NOT change — peer drift, not gated under --mine)`);
      }
      process.exit(1);
      break;
    case 'ok-peer-drift':
      console.log(`✓ Your changed files are tsc-clean. ${result.peerDrift.length} file(s) regressed in the shared tree but you did not touch them:`);
      for (const r of result.peerDrift) console.log(formatRow(r));
      console.log('   (peer drift — not your regression. A bare `npm run lint:tsc` will still gate these for whoever owns them.)');
      process.exit(0);
      break;
    case 'ok-ratchet':
      // Reached ONLY on an explicit `--update` with at least one improved file (decidePerFile gates it).
      writeBaseline(result.newBaselineByFile, 'Ratcheted improved file(s) down (--update)');
      for (const r of result.improvements) console.log(formatRow(r));
      process.exit(0);
      break;
    case 'ok-below':
      console.log(`✓ ${result.improvements.length} file(s) below baseline — NOT locked in. Run \`npm run lint:tsc -- --update\` on a quiet tree to lower them deliberately:`);
      for (const r of result.improvements) console.log(formatRow(r));
      process.exit(0);
      break;
    default:
      if (updateFlag) console.log('✓ --update: every file is at its baseline — nothing to lower.');
      console.log('✓ Every operator-core file is at or under its type-error baseline.');
      process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
