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

  const declared = declaredSubmodules(cwd);
  const scanned = [];
  const unscanned = [];
  for (const path of declared) {
    // A submodule contributed content iff some emitted file sits under it.
    if (files.some((f) => f.startsWith(`${path}/`))) scanned.push(path);
    else unscanned.push(path);
  }

  return { files, declared, scanned, unscanned };
}

/**
 * One-line coverage suffix for a guard's success message, so a ✓ always states
 * what it did NOT look at. Returns '' when every declared submodule was scanned.
 */
export function describeUnscanned(unscanned) {
  if (unscanned.length === 0) return '';
  return (
    ` (⚠ ${unscanned.length} declared submodule(s) NOT scanned — not initialized: ` +
    `${unscanned.join(', ')}; this result says nothing about them)`
  );
}
