/**
 * tracked-files.mjs — the one tree enumerator every scripts/check-*.mjs guard
 * should use (WI-6730).
 *
 * THE BUG THIS EXISTS TO KILL: guards enumerated the tree with a bare
 * `git ls-files`, which does NOT recurse into submodules — it emits ONE gitlink
 * entry per submodule, not its contents. This repo has 39 submodules, including
 * libs/generic/sync (the sync transport + concurrency gate), libs/generic/sse,
 * libs/papercusp (harness / orchestrator / locks) and papercusp-desktop. So 26 of
 * 48 guards printed a confident ✓ for ~39 subtrees they had never opened.
 *
 * That failure mode is worse than a crash: a false ✓ actively suppresses the
 * question. `lint:no-raw-setinterval` — whose BASELINE is documented "MUST stay
 * empty ... that is the whole universal-visibility ratchet" — reported clean while
 * an unlisted host timer sat in libs/papercusp/packages/locks.
 *
 * WHY YOU CANNOT JUST EYEBALL THE PATH: `libs/generic/*` is MIXED. Some entries
 * are ordinary directories in the superproject (libs/generic/activity-bridge — IS
 * listed by plain `git ls-files`) and some are submodules (libs/generic/sync — is
 * NOT). Nothing about the path distinguishes them, which is why the blind spot
 * survived undetected.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `unscanned` IS PART OF THE CONTRACT, NOT AN ERROR CHANNEL.
 *
 * A submodule that is declared in .gitmodules but not initialized/checked out
 * contributes no files, and there is no honest way to assert anything about its
 * contents. Callers MUST NOT silently treat that as clean — that is the exact bug
 * above, one level up. Report it (see `describeUnscanned`) so a guard's output
 * says "checked N subtrees, could not check M" instead of a bare ✓.
 *
 * Today that set is normally just libs/zero-harness, which is retired and
 * deliberately not initialized — a legitimate skip, but still a stated one.
 */
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Repo root. NOTE the '../..': this module lives at scripts/lib/, one level
 * deeper than the scripts/check-*.mjs guards that copy the `new URL('..')`
 * idiom. Getting this wrong is silent and severe — a cwd of scripts/ makes
 * `git ls-files` return only the ~33 files under scripts/, and every caller
 * that relied on the default would report a confident ✓ having scanned almost
 * nothing. That is the same false-clean failure this module exists to remove,
 * so it is pinned by a test rather than left to inspection.
 */
const ROOT = new URL('../..', import.meta.url).pathname;

/** Run a git command and return trimmed stdout lines (empty array on failure). */
function gitLines(args, cwd) {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Submodule paths declared in .gitmodules, superproject-relative, sorted. */
export function declaredSubmodules(cwd = ROOT) {
  return gitLines('config -f .gitmodules --get-regexp path', cwd)
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean)
    .sort();
}

/**
 * Every tracked file in the superproject AND in each checked-out submodule, as
 * superproject-relative paths.
 *
 * Returns `{ files, declared, scanned, unscanned }` rather than a bare array
 * precisely so a caller cannot forget the coverage question — see the contract
 * note above.
 */
export function listTrackedFiles(cwd = ROOT) {
  // `--recurse-submodules` already emits submodule contents prefixed with the
  // submodule path, so no manual `git submodule foreach` + sed splicing is
  // needed (git >= 2.11; this repo is on 2.43). It exits 0 and simply omits an
  // uninitialized submodule, which is why coverage is computed separately below
  // rather than inferred from the exit code.
  const files = gitLines('ls-files --recurse-submodules', cwd);
  return { files, ...coverageOf(files, cwd) };
}

/**
 * Coverage partition for an ALREADY-COMPUTED file list — the seam that lets a
 * guard keep its own enumeration and still report honest coverage (WI-6776).
 *
 * Several guards cannot simply call `listTrackedFiles()`: check-no-nul-in-source
 * and check-no-control-bytes need `-z` (NUL-delimited) output because a guard
 * about byte-level corruption must not itself assume filenames are newline-free,
 * and check-env-feature-gates uses `git grep --recurse-submodules`. Forcing them
 * onto one enumerator would trade a real property for uniformity. What they
 * actually need to share is the COVERAGE CONTRACT, not the `git` invocation — so
 * that is what this exports.
 *
 * Returns `{ declared, scanned, unscanned }` where the partition is exact:
 * a declared submodule is `scanned` iff some emitted file sits under it.
 */
export function coverageOf(files, cwd = ROOT) {
  const declared = declaredSubmodules(cwd);
  const scanned = [];
  const unscanned = [];
  for (const path of declared) {
    if (files.some((f) => f.startsWith(`${path}/`))) scanned.push(path);
    else unscanned.push(path);
  }
  // The two gaps are NOT equally serious, and a caller that needs to ACT (rather than
  // just report) has to tell them apart:
  //
  //   unscannedPresent — content is on disk but git could not enumerate it. The scan
  //                      is missing real, existing files. THIS is the one that makes a
  //                      ✓ a lie and an absence-proof unsound.
  //   unscannedAbsent  — nothing is checked out. Contributes no files anywhere, so it
  //                      does not shrink the scan relative to what actually exists.
  //
  // Conflating them makes any "coverage is incomplete" alarm cry wolf: this repo
  // permanently carries one absent submodule (libs/zero-harness, retired and
  // deliberately uninitialized), so an alarm keyed on `unscanned` fires on every run
  // in a perfectly healthy tree and is trained away. Key alarms on unscannedPresent.
  const unscannedPresent = unscanned.filter((p) => hasContentOnDisk(p, cwd));
  const unscannedAbsent = unscanned.filter((p) => !unscannedPresent.includes(p));
  return { declared, scanned, unscanned, unscannedPresent, unscannedAbsent };
}

/** Does this submodule directory hold content on disk, whatever git can see? */
function hasContentOnDisk(path, cwd) {
  try {
    return readdirSync(join(cwd, path)).length > 0;
  } catch {
    return false;
  }
}

/**
 * One-line coverage suffix for a guard's success message, so a ✓ always states
 * what it did NOT look at. Returns '' when every declared submodule was scanned.
 *
 * Accepts either the bare `unscanned` array or a whole `listTrackedFiles()`
 * result (preferred — it already knows `declared`, so no re-read of .gitmodules).
 *
 * ── WHY THIS REPORTS A CAUSE, NOT JUST A LIST (WI-6776) ─────────────────────
 * The first version said "NOT scanned — not initialized", which is the right
 * FACT with the wrong DIAGNOSIS, and the wrong diagnosis is expensive. Measured
 * 2026-08-02 in papercusp-checkpoint (the GREEN GATE's own tree): 0/39
 * submodules enumerated, yet 38 of them are checked out with content on disk.
 * They are `git archive`-extracted by setup-release-checkout.sh — deliberately,
 * because many pins are never pushed to origin — and an archive-extracted tree
 * has no `.git`, so `git ls-files --recurse-submodules` cannot descend. Nothing
 * is "uninitialized"; the enumerator simply cannot see a perfectly present tree.
 * (A linked worktree with unregistered submodules degrades identically.)
 *
 * Telling an agent "not initialized" in that tree sends it to `git submodule
 * update --init` chasing a fault that does not exist. That wasted-diagnostic-time
 * cost is precisely what EI-19301033966613245 was filed about, so the suffix
 * names the shape it actually found:
 *
 *   present-on-disk-but-not-enumerable → archive-extracted / worktree (BY DESIGN)
 *   absent-from-disk                   → genuinely not initialized
 *
 * Reporting the RATIO is the load-bearing part: `0/39` cannot be misread as
 * clean, whereas a bare ✓ over an empty scan reads exactly like a pass.
 */
export function describeUnscanned(unscannedOrScan, cwd = ROOT) {
  const isScan = unscannedOrScan && !Array.isArray(unscannedOrScan);
  const unscanned = isScan ? unscannedOrScan.unscanned : unscannedOrScan;
  if (!unscanned || unscanned.length === 0) return '';
  const declared = isScan ? unscannedOrScan.declared : declaredSubmodules(cwd);
  const total = declared?.length ?? unscanned.length;

  const present = isScan && unscannedOrScan.unscannedPresent
    ? unscannedOrScan.unscannedPresent
    : unscanned.filter((p) => hasContentOnDisk(p, cwd));
  const absent = unscanned.filter((p) => !present.includes(p));

  // Cap the name list: in a release-shaped tree EVERY submodule lands in one
  // bucket for one by-design reason, and printing 39 paths every run buries the
  // ratio that actually matters.
  const names = (list) => (list.length <= 4 ? list.join(', ') : `${list.slice(0, 4).join(', ')} +${list.length - 4} more`);

  const parts = [];
  if (present.length > 0) {
    parts.push(
      `${present.length} present on disk but NOT git-enumerable — archive-extracted release checkout ` +
        `or linked worktree (no .git, so --recurse-submodules cannot descend), BY DESIGN: ${names(present)}`,
    );
  }
  if (absent.length > 0) parts.push(`${absent.length} not initialized: ${names(absent)}`);

  return (
    ` (⚠ coverage ${total - unscanned.length}/${total} declared submodule(s) enumerated; ` +
    `${parts.join('; ')}. This result says nothing about them.)`
  );
}
