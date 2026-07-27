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
 * EI-18731016038876755 — parse an EXPLICIT `--files=a.ts,b.ts` CLI flag naming exactly the
 * files the caller changed THIS session, as an alternative to `--mine`'s implicit
 * git-status-derived scoping.
 *
 * WHY: `gitChangedFiles` (above) attributes "mine" from working-tree dirt (`git status`), which
 * on this concurrently-edited shared checkout includes every PEER's uncommitted edits too — not
 * just the caller's own. Observed live: `--mine` reported a regression in a file the calling
 * agent had never opened, because a peer had it mid-edit at that exact moment; re-running the
 * gate a minute later (once the peer's edit settled) gave the opposite verdict on the identical
 * command against the identical tree. `git status` cannot distinguish WHICH agent dirtied a
 * file on a shared checkout — there is no session-scoped signal to read there.
 *
 * `--files=` sidesteps the ambiguity entirely: the caller states which files are theirs
 * (e.g. from their own edit history / Edit-tool log this turn), and that explicit set is used
 * VERBATIM instead of the git-status guess — no heuristic, no false attribution. Passing
 * `--files=` also implies `--mine`-style scoping (a caller naming exact files obviously wants
 * the check scoped to them), so `--mine` need not be passed alongside it.
 *
 * Returns `null` when the flag is absent (falls through to the existing `--mine`/bare behavior
 * unchanged) — never an empty Set for "flag absent", so callers can tell "not scoped" apart from
 * "scoped to zero files" (a malformed `--files=` with no content, which is now the caller's own
 * bug to fix, not a silent no-op).
 */
export function parseExplicitFiles(argv) {
  const flag = argv.find((a) => a.startsWith('--files='));
  if (flag === undefined) return null;
  const list = flag
    .slice('--files='.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(list);
}

/**
 * Resolve the EFFECTIVE per-file baseline, inheriting cross-package files from their OWNING
 * package's baseline (EI-18649014117371738).
 *
 * ## Why this exists
 *
 * `decidePerFile` treats a file ABSENT from the baseline as an implicit 0 — correct for a file this
 * gate OWNS (a fresh file that arrives with errors IS a named regression). It is WRONG for a file in
 * ANOTHER package that has its own baseline gate: this gate's baseline was captured at some other
 * moment, under a DIFFERENT tsconfig, so "absent" there means "this gate never recorded it", NOT
 * "it was clean". Absent ⇒ 0 turns that gap into a phantom regression.
 *
 * That is not hypothetical: operator-core's baseline records e.g.
 * `packages/operator-core/lib/agent-tools/memory/search.ts: 1` (a KNOWN, TOLERATED error), while
 * apps/operator-vite's baseline — seeded four days later — never listed it. So `lint:tsc` PASSED and
 * `lint:tsc:operator-vite` FAILED on the SAME source file, and 12 operator-core files read as
 * regressions to an agent who had opened none of them. Two gates over one tree giving opposite
 * verdicts makes neither number trustworthy — exactly the false-signal problem the per-file gate was
 * built to kill (EI-847), reintroduced at the cross-package seam.
 *
 * ## The rule
 *
 * For a file this gate MEASURED but did not record, that lives under a `prefix` owned by a package
 * with its own baseline, inherit that package's recorded count instead of defaulting to 0.
 *
 *   - Own baseline ALWAYS wins when present — an explicit entry is this gate's own measured truth
 *     under its own tsconfig, and ratchet-only-down must never be loosened by a foreign number.
 *   - Inheritance is scoped to files actually in `currentByFile`, so a foreign baseline can never
 *     inject files this gate does not measure (that would fabricate phantom "improvements" and
 *     inflate the reported total).
 *   - Absent from BOTH is still an implicit 0 — a genuinely NEW error in a foreign file still gates.
 *
 * @param {{
 *   baselineByFile: Record<string, number>,
 *   currentByFile: Record<string, number>,
 *   foreignBaselines?: {prefix:string, files:Record<string,number>, label?:string}[],
 * }} args
 * @returns {{ effective: Record<string, number>, inherited: {file:string,baseline:number,from:string}[] }}
 */
export function effectiveBaselineByFile({ baselineByFile, currentByFile, foreignBaselines = [] }) {
  if (!foreignBaselines.length) return { effective: baselineByFile, inherited: [] };

  const effective = { ...baselineByFile };
  const inherited = [];
  for (const file of Object.keys(currentByFile)) {
    if (effective[file] !== undefined) continue; // this gate's OWN recorded count wins, always
    for (const source of foreignBaselines) {
      if (!file.startsWith(source.prefix)) continue;
      const count = source.files?.[file];
      if (typeof count === 'number' && count > 0) {
        effective[file] = count;
        inherited.push({ file, baseline: count, from: source.label ?? source.prefix });
      }
      break; // first matching prefix OWNS the file — a second source never overrides it
    }
  }
  inherited.sort((a, b) => a.file.localeCompare(b.file));
  return { effective, inherited };
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
      const unattributed = regressions.filter((r) => !changedFiles.has(r.file));
      // EI-18766822535373909 — a regression in a file with NO baseline entry is a BRAND-NEW file,
      // and it must never be dismissed as peer drift. Two independent reasons:
      //
      //  1. It is not "drift" in the only sense the peer-drift affordance is safe for. That
      //     affordance (EI-1984) exists to let pre-existing shared-tree debt flap without redding
      //     an unrelated agent — debt the baseline already KNOWS about. A file absent from the
      //     baseline has no known-good state to drift from; every error in it is NEW, which is
      //     precisely what this ratchet exists to catch. Bare mode already fails it
      //     ('fail-regressed'); only --mine was letting it through, so this closes an
      //     inconsistency between the two modes rather than adding a new policy.
      //  2. `changedFiles` CANNOT prove the file is not yours on this checkout. It is derived from
      //     `git status`, and git-sync auto-commits the whole tree every few minutes — so your own
      //     brand-new file stops being dirty, drops out of the "mine" set, and lands here. That is
      //     exactly how this was found: a new file's real TS2352 was reported under a leading ✓ as
      //     "peer drift — not your regression", and it would have red the green-checkpoint for the
      //     whole fleet hours later.
      //
      // '(unattributed)' (errors tsc did not pin to a file) is deliberately LEFT in peerDrift: it
      // is not a new file, and it is genuinely unattributable, so gating on it would red callers
      // for something they cannot act on.
      const newFiles = unattributed.filter((r) => r.file !== '(unattributed)' && !(r.file in baselineByFile));
      const peerDrift = unattributed.filter((r) => r.file === '(unattributed)' || r.file in baselineByFile);
      // Under --mine the gate fails when a regression lands in a file you changed, OR in a file so
      // new the baseline has never seen it. Drift in KNOWN files you did not touch stays reported
      // but not gated — that is the "verify MY change is clean" affordance (EI-1984), and it is why
      // --mine is opt-in and never the CI default.
      if (attributed.length > 0) return { verdict: 'fail-attributed', ...base, attributed, peerDrift, newFiles };
      if (newFiles.length > 0) return { verdict: 'fail-new-file', ...base, attributed: [], peerDrift, newFiles };
      return { verdict: 'ok-peer-drift', ...base, attributed: [], peerDrift, newFiles: [] };
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
 * The headline for an ATTRIBUTED failure, worded per how the changed-set was derived.
 *
 * This is a pure function purely so the wording is TESTABLE, because the wording is where
 * the bug was. `--files` means the caller NAMED the files, so "you changed" is a fact.
 * `--mine` infers them from `git status` — and this repo has ONE working tree shared by the
 * whole fleet, with every agent's edits unstaged until the next git-sync tick, so that set is
 * "dirty right now": yours AND every peer's. Claiming "YOU changed" over it is false, and it
 * is expensively false in BOTH directions — you chase a peer's error believing it is yours,
 * or your own genuine regression arrives amid peer noise under the same label and you dismiss
 * the lot as fleet drift. Filed four separate times before the wording was fixed
 * (EI-18731016038876755, which added `--files`, plus three later duplicates).
 *
 * @param {{count: number, explicit: boolean}} opts
 * @returns {string}
 */
export function formatAttributionHeadline({ count, explicit }) {
  if (explicit) {
    return `❌ ${count} file(s) YOU NAMED added type errors above their baseline:`;
  }
  return (
    `❌ ${count} file(s) DIRTY IN THE WORKING TREE added type errors above their baseline — ` +
    `on this shared checkout that set is yours AND every peer's, so a file here may not be yours ` +
    `(re-run with --files=<the files you edited> to scope it to your own):`
  );
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
 *   foreignBaselines?: {prefix: string, baselineFile: string, label?: string}[],
 *                           // Cross-package files this gate MEASURES but does not OWN: a file under
 *                           // `prefix` that is absent from this gate's baseline inherits the owning
 *                           // package's recorded count instead of an implicit 0. See
 *                           // effectiveBaselineByFile (EI-18649014117371738).
 * }}
 */
export function runTscBaselineGate({
  root,
  tscCommand,
  baselineFile,
  label,
  argv,
  countField = 'errorCount',
  foreignBaselines = [],
}) {
  const updateFlag = argv.includes('--update');
  const explicitFiles = parseExplicitFiles(argv);
  const mineFlag = argv.includes('--mine') || explicitFiles !== null;

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
  const ownBaselineByFile = baseline.files ?? {};

  // Load each owning package's baseline for the cross-package files this gate measures but does not
  // own. Fail-SOFT per source: an unreadable foreign baseline degrades to the old absent⇒0 behaviour
  // (a possible false red we WARN about) rather than crashing the gate or silently passing.
  const loadedForeign = [];
  for (const source of foreignBaselines) {
    try {
      const parsed = JSON.parse(readFileSync(source.baselineFile, 'utf-8'));
      loadedForeign.push({ ...source, files: parsed.files ?? {} });
    } catch {
      console.warn(
        `⚠ Could not read the baseline owning ${source.prefix} (${source.baselineFile}) — ` +
          `files under it fall back to an implicit 0 baseline and may report as false regressions.`,
      );
    }
  }

  const { effective: baselineByFile, inherited } = effectiveBaselineByFile({
    baselineByFile: ownBaselineByFile,
    currentByFile,
    foreignBaselines: loadedForeign,
  });
  // EI-18731016038876755: an explicit --files= list is authoritative — the caller SAID which
  // files are theirs, so never fall back to the git-status guess for the same run.
  const changedFiles = explicitFiles ?? (mineFlag ? gitChangedFiles(root) : null);

  const result = decidePerFile({ currentByFile, baselineByFile, brokenFiles, updateFlag, changedFiles });
  console.log(
    `TSC ${label}: ${result.total} type errors across ${Object.keys(currentByFile).length} file(s) ` +
      `(baseline total ${result.baselineTotal})${explicitFiles ? ' [--files]' : mineFlag ? ' [--mine]' : ''}`,
  );
  if (inherited.length > 0) {
    console.log(
      `   (${inherited.length} cross-package file(s) inherited their baseline from the package that OWNS them — ` +
        `already-known errors there, not regressions to this gate.)`,
    );
  }

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
      console.error(
        formatAttributionHeadline({ count: result.attributed.length, explicit: explicitFiles !== null }),
      );
      for (const r of result.attributed) console.error(formatRow(r));
      if (result.newFiles.length > 0) {
        console.error(`   (also ${result.newFiles.length} NEW file(s) with errors — see below)`);
        for (const r of result.newFiles) console.error(formatRow(r));
      }
      if (result.peerDrift.length > 0) {
        console.error(`   (also ${result.peerDrift.length} regressed file(s) not in your changed set — not gated under --mine)`);
      }
      process.exit(1);
      break;
    case 'fail-new-file':
      // EI-18766822535373909: these are files the baseline has NEVER seen. Absence from the
      // changed set does not clear you — git-sync commits the tree every few minutes, so your own
      // new file is dirty for only a short window. Never greenwash this one.
      console.error(`❌ ${result.newFiles.length} NEW file(s) (not in the baseline) have type errors:`);
      for (const r of result.newFiles) console.error(formatRow(r));
      console.error(`   These files are new, so every error in them is new — the baseline has no known-good state to drift from.`);
      console.error(`   They are not in your git-status changed set, but that does NOT establish they aren't yours: git-sync`);
      console.error(`   auto-commits this shared tree every few minutes, which silently drops your own recent work out of that set.`);
      console.error(`   If a file here really isn't yours, its author needs to know — a bare run of this gate reds the fleet on it.`);
      console.error(`   To scope this check to exactly the files you touched, re-run with --files=<comma-separated paths>.`);
      process.exit(1);
      break;
    case 'ok-peer-drift':
      console.log(`✓ Your changed files are tsc-clean. ${result.peerDrift.length} file(s) already in the baseline regressed but are not in your changed set:`);
      for (const r of result.peerDrift) console.log(formatRow(r));
      console.log(`   (Not gated under --mine. Note the changed set comes from git status, and git-sync auto-commits this tree`);
      console.log(`    every few minutes — so a file you edited a while ago can appear here. Use --files= to scope precisely.`);
      console.log(`    A bare npm run of this gate will still catch these for whoever owns them.)`);
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
