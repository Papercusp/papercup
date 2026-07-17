#!/usr/bin/env node
/**
 * Shared PER-FILE tsc baseline gate (extracted from scripts/lint-tsc.mjs, EI-847).
 *
 * `scripts/lint-tsc.mjs` pioneered this for operator-core (P-010/WI-4535 — see that file's
 * header for the full "why per-file, not a global count" rationale + the two hard rules
 * that carry to EVERY consumer of this module:
 *
 *   1. RATCHET-ONLY-DOWN, on an EXPLICIT `--update` only.
 *   2. SYNTAX HARD-FAIL: any TS1xxx parse error fails regardless of the counts.
 *
 * This module is the reusable core so a SECOND project (or a third, a fourth, …) gets the
 * same baseline-gated, `--mine`-scoped, ratchet-only-down typecheck WITHOUT forking the
 * policy logic — only `tscCommand` / `baselineFile` / `label` differ per project. See
 * `scripts/lint-tsc.mjs` (operator-core) and `scripts/lint-tsc-operator-vite.mjs`
 * (operator-vite) for the two thin per-project CLIs built on this.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

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

export function sumValues(map) {
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
export function gitChangedFiles(root) {
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

/**
 * Run the full CLI gate for one project and `process.exit(...)` with its verdict — the shared
 * `main()` every per-project CLI (lint-tsc.mjs, lint-tsc-operator-vite.mjs, …) delegates to.
 *
 * @param {{
 *   root: string,           // cwd the tscCommand runs from (repo root)
 *   tscCommand: string,     // e.g. 'npx tsc -p apps/foo/tsconfig.json --noEmit --incremental false'
 *   baselineFile: string,   // absolute path to this project's .tsc-baseline.json
 *   label: string,          // human label for console output, e.g. 'operator-core'
 *   argv: string[],         // process.argv.slice(2)
 *   countField?: string,    // baseline JSON field the derived total is written to on --update
 *                           // (default 'errorCount'; operator-core keeps its legacy
 *                           // 'operatorCoreErrorCount' name for back-compat with existing tooling).
 * }}
 */
export function runTscBaselineGate({ root, tscCommand, baselineFile, label, argv, countField = 'errorCount' }) {
  const updateFlag = argv.includes('--update');
  const mineFlag = argv.includes('--mine');

  let tscOutput = '';
  let tscThrew = false;
  try {
    tscOutput = execSync(`${tscCommand} 2>&1`, {
      cwd: root,
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
    return;
  }
  const baselineByFile = baseline.files ?? {};
  const changedFiles = mineFlag ? gitChangedFiles(root) : null;

  const result = decidePerFile({ currentByFile, baselineByFile, brokenFiles, updateFlag, changedFiles });
  console.log(
    `TSC ${label}: ${result.total} type errors across ${Object.keys(currentByFile).length} file(s) ` +
      `(baseline total ${result.baselineTotal})${mineFlag ? ' [--mine]' : ''}`,
  );

  const writeBaseline = (byFile, why) => {
    baseline.files = Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b)));
    baseline[countField] = sumValues(byFile); // derived total, kept for humans/back-compat
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
      console.log(`   (peer drift — not your regression. A bare npm run of this gate will still catch these for whoever owns them.)`);
      process.exit(0);
      break;
    case 'ok-ratchet':
      // Reached ONLY on an explicit `--update` with at least one improved file (decidePerFile gates it).
      writeBaseline(result.newBaselineByFile, 'Ratcheted improved file(s) down (--update)');
      for (const r of result.improvements) console.log(formatRow(r));
      process.exit(0);
      break;
    case 'ok-below':
      console.log(`✓ ${result.improvements.length} file(s) below baseline — NOT locked in. Re-run with --update on a quiet tree to lower them deliberately:`);
      for (const r of result.improvements) console.log(formatRow(r));
      process.exit(0);
      break;
    default:
      if (updateFlag) console.log('✓ --update: every file is at its baseline — nothing to lower.');
      console.log(`✓ Every ${label} file is at or under its type-error baseline.`);
      process.exit(0);
  }
}
