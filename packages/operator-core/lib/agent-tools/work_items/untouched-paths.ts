/**
 * P-005 (plan `design-to-code-coverage-seam-2026-09-02`), governed by D-016.
 *
 * Decide whether a completion's `filesChanged` names a path that is REAL BUT UNTOUCHED —
 * a file that genuinely exists in this tree and that this unit of work never changed.
 *
 * ## Why this exists beside P-001 rather than inside it
 *
 * D-016 ruled that `filesChanged` is graded on GIT HISTORY, not filesystem existence, and
 * built `fabricatedPathsInCompletion` on the one absence that is a defect: a path absent
 * from disk AND unknown to git has never existed here. That closes the fabrication hole
 * for INVENTED paths, and D-016 names this module as its "strictly stronger successor":
 * once a path must exist, the cheapest way to satisfy the check is to name a real file
 * you did not touch. That is the gaming surface P-001 moved rather than removed, and it
 * is what D-011 means by "A is a ladder, not one step".
 *
 * The two populations are DISJOINT BY CONSTRUCTION: P-001 judges only paths absent from
 * disk, this module only paths present on disk. A path is never reported by both, so the
 * grades cannot double-count one defect.
 *
 * ## Why the working-tree check is the load-bearing part
 *
 * The obvious predicate — "this path's last commit predates the work-item" — is already
 * implemented as `preExistingChangedPathsInCompletion` (complete.ts, EI-20288629053504794)
 * and is WARN-ONLY. It must stay warn-only, because on its own it is wrong in the one
 * direction that matters: this repo has ONE shared working tree and a git-sync routine
 * that commits it on a schedule, so at the moment an agent closes, its edit is usually
 * still UNCOMMITTED. Git history alone therefore reports an honest, in-flight change as
 * "not touched since the item was created" — a confident false accusation against exactly
 * the agent who did the work. That is tolerable in a nudge and disqualifying in a gate.
 *
 * So this module clears a path on EITHER of two independent proofs of work:
 *
 *   1. the working tree is DIRTY at that path (modified, staged, or untracked) — the edit
 *      exists and git-sync has simply not swept it yet; or
 *   2. a commit touched the path INSIDE the work window — git-sync already swept it.
 *
 * Only a path that fails both — present on disk, clean against HEAD, and last committed
 * before this work began — is reported. Those are the two ways real work can look, and a
 * path matching neither was not changed by this close.
 *
 * ## The window, and why it is widened
 *
 * The window opens at the work-item's own start (`since`, the caller passes the earliest
 * of created/claimed) and is widened by {@link UNTOUCHED_GRACE_SEC}, reusing the existing
 * `LANDING_RACE_WINDOW_SEC` — the constant this repo already uses for "a commit may have
 * landed either side of this boundary". The widening is deliberately one-directional: it
 * can only ever CLEAR a path, never accuse one, and it absorbs the honest case where an
 * agent edited a file shortly before the item existed and git-sync swept it in between.
 *
 * ## Biased toward generosity, deliberately
 *
 * Same asymmetry D-016 states: a false accusation lowers an honest agent's grade and
 * teaches the fleet the signal is noise, while a false clean verdict merely leaves today's
 * behaviour in place. Every ambiguity therefore resolves to "cannot judge":
 *
 *   - a path under a declared submodule prefix is NEVER judged. `lastCommitTimes` runs
 *     `git log` from the SUPERPROJECT, which reports NOTHING for a real file inside a
 *     submodule (EI-21138854971082896) — the one shape that would otherwise manufacture a
 *     confident false accusation against every submodule edit, migrations included;
 *   - an UNKNOWN last-commit time is never an exoneration and never an accusation. This is
 *     the rule `isUnchangedForAttribution` states for the same data: "`null` (unknown) is
 *     deliberately NOT unchanged ... treating unknown as unchanged would manufacture an
 *     exoneration out of an absence of evidence." Here the same absence must not
 *     manufacture an ACCUSATION either, so it is silence;
 *   - an unreadable working tree is silence: without proof-of-work route 1 the remaining
 *     evidence cannot distinguish an in-flight edit from an untouched file;
 *   - a glob, an absolute path, an escaping path, an unresolvable root, a missing window,
 *     or any throw is silence;
 *   - under multiple candidate roots, being cleared under ANY root clears the path.
 *
 * PURE via injected probes, so every branch above is unit-testable without a real tree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';

import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

/**
 * Bounds the git work, matching `MAX_FABRICATION_PROBES` on the sibling detector. A
 * completion naming more paths than this is not judged past the cap.
 */
export const MAX_UNTOUCHED_PROBES = 12;

/**
 * How far before the work window opens a commit still counts as this work.
 *
 * Reuses the value `LANDING_RACE_WINDOW_SEC` carries in `scripts/lib/tsc-baseline-gate.mjs`
 * — this repo's existing name for the interval in which a git-sync sweep may land either
 * side of a boundary. It is duplicated as a number rather than imported because that
 * module is an `.mjs` build-script helper whose import pulls a gate toolchain into a pure
 * resolver; the constant is asserted equal to it by this module's test, so the two cannot
 * drift silently.
 */
export const UNTOUCHED_GRACE_SEC = 20 * 60;

/**
 * Epoch SECONDS of the path's last commit · `null` = git answered but knows nothing ·
 * `undefined` = COULD NOT ASK. All three are distinct: only a real timestamp is ever
 * grounds for a finding, and neither of the other two may become one.
 */
export type GitLastCommitProbe = (repoRoot: string, relPath: string) => number | null | undefined;

/**
 * `true` = the working tree differs from HEAD at this path (modified/staged/untracked) ·
 * `false` = it is clean · `undefined` = COULD NOT ASK, which is silence rather than
 * "clean", because a clean reading is half of what produces a finding.
 */
export type GitDirtyProbe = (repoRoot: string, relPath: string) => boolean | undefined;

export interface UntouchedPathProbe {
  /** Candidate checkout roots. An explicit empty list means "cannot judge", never "guess". */
  repoRoots?: readonly string[];
  /** Does this absolute path exist on disk? */
  exists?: (abs: string) => boolean;
  /** Is the working tree dirty at this repo-relative path? */
  isDirty?: GitDirtyProbe;
  /** When was this repo-relative path last committed? */
  lastCommitAt?: GitLastCommitProbe;
  /** Repo-relative submodule directory prefixes; paths under one are never judged. */
  submodulePrefixes?: (repoRoot: string) => readonly string[];
}

export interface UntouchedPathHit {
  path: string;
  /** ISO-8601 of the path's last commit — what makes the verdict checkable by hand. */
  lastCommitAt: string;
}

/** `git status --porcelain -- <path>`: any output means the tree differs from HEAD here. */
const defaultIsDirty: GitDirtyProbe = (repoRoot, relPath) => {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', relPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return out.trim().length > 0;
  } catch {
    return undefined; // not a repo, git missing, timeout → cannot judge
  }
};

/** `git log -1 --format=%ct -- <path>`, mirroring the existing `lastCommitTimes` read. */
const defaultLastCommitAt: GitLastCommitProbe = (repoRoot, relPath) => {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%ct', '--', relPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const parsed = Number.parseInt(out.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return undefined;
  }
};

/** Submodule prefixes parsed from `.gitmodules`. Failure yields [] — see the caller. */
const defaultSubmodulePrefixes = (repoRoot: string): readonly string[] => {
  try {
    const raw = readFileSync(nodePath.join(repoRoot, '.gitmodules'), 'utf8');
    return [...raw.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((m) => m[1].trim()).filter((p) => p.length > 0);
  } catch {
    return [];
  }
};

/**
 * Seconds since the epoch for a Date, an epoch number (s or ms), or a parseable string.
 * `undefined` for anything unparseable — which makes the whole check silent rather than
 * letting a malformed timestamp define a window.
 */
function epochSeconds(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms / 1000 : undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value > 1_000_000_000_000 ? value / 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

/**
 * Paths in `filesChanged` that exist in this tree but that this work never touched.
 *
 * `since` is the moment the work began — the caller passes the EARLIEST of the item's
 * created/claimed timestamps, because a wider window can only clear paths.
 *
 * Returns `undefined` when there is nothing confident to say — no declared paths, no
 * usable root, no usable window, or every path was cleared or unjudgeable. A caller may
 * treat a returned finding as grade-bearing; `undefined` must always mean "grade as
 * before".
 */
export function untouchedPathsInCompletion(
  evidence: CompletionVerificationEvidence | null | undefined,
  since: unknown,
  probe: UntouchedPathProbe = {},
): { untouched: UntouchedPathHit[]; since: string } | undefined {
  const declared = evidence?.filesChanged;
  if (!declared?.length) return undefined;

  // No window means no question to ask. Never fall back to "assume the work started now",
  // which would report every path as untouched.
  const sinceSec = epochSeconds(since);
  if (sinceSec === undefined) return undefined;
  const cutoffSec = sinceSec - UNTOUCHED_GRACE_SEC;

  // `in` rather than `??`, matching the sibling detector: an EXPLICIT empty roots list
  // means "I could not resolve a root, do not guess", which differs from omitting it.
  const rawRoots = 'repoRoots' in probe ? probe.repoRoots : undefined;
  const repoRoots = [
    ...new Set(
      (rawRoots ?? [])
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        .map((r) => nodePath.resolve(r)),
    ),
  ];
  if (repoRoots.length === 0) return undefined;

  const exists = probe.exists ?? ((abs: string) => existsSync(abs));
  const isDirty = probe.isDirty ?? defaultIsDirty;
  const lastCommitAt = probe.lastCommitAt ?? defaultLastCommitAt;
  const submodulePrefixes = probe.submodulePrefixes ?? defaultSubmodulePrefixes;

  const submodulesByRoot = new Map<string, readonly string[]>();
  const submodulesFor = (root: string): readonly string[] => {
    if (!submodulesByRoot.has(root)) {
      let prefixes: readonly string[] = [];
      try {
        prefixes = submodulePrefixes(root) ?? [];
      } catch {
        prefixes = [];
      }
      submodulesByRoot.set(root, prefixes);
    }
    return submodulesByRoot.get(root) ?? [];
  };

  const untouched: UntouchedPathHit[] = [];

  for (const raw of declared.slice(0, MAX_UNTOUCHED_PROBES)) {
    const declaredPath = (raw ?? '').trim();
    // A glob describes many files; it is not a claim that one path was changed.
    if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) continue;
    // An absolute path names another tree we have no standing to judge.
    if (nodePath.isAbsolute(declaredPath)) continue;

    let verdictSec: number | undefined;
    let clearedByAnyRoot = false;

    for (const repoRoot of repoRoots) {
      let abs: string;
      try {
        abs = nodePath.resolve(repoRoot, declaredPath);
      } catch {
        continue;
      }
      // Escapes the root (`../`) → outside our standing to judge.
      if (abs !== repoRoot && !abs.startsWith(repoRoot + nodePath.sep)) continue;

      // Under a submodule the superproject tracks only the gitlink, so `git log` there is
      // empty for a REAL file and `git status` reports the gitlink rather than the file.
      // Judging here would manufacture a confident false accusation (EI-21138854971082896).
      const norm = declaredPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (submodulesFor(repoRoot).some((p) => norm === p || norm.startsWith(p.replace(/\/$/, '') + '/'))) {
        clearedByAnyRoot = true;
        break;
      }

      let onDisk: boolean;
      try {
        onDisk = exists(abs);
      } catch {
        continue; // fs error → cannot judge under this root
      }
      // Absent from disk is P-001's population, never this one. Clearing here is what keeps
      // the two findings disjoint, so one defect can never be graded twice.
      if (!onDisk) {
        clearedByAnyRoot = true;
        break;
      }

      // Proof-of-work route 1: the edit is present but not yet swept by git-sync.
      let dirty: boolean | undefined;
      try {
        dirty = isDirty(repoRoot, declaredPath);
      } catch {
        dirty = undefined;
      }
      if (dirty === undefined) continue; // cannot judge under this root
      if (dirty) {
        clearedByAnyRoot = true;
        break;
      }

      // Proof-of-work route 2: git-sync already swept the edit into a commit.
      let commitSec: number | null | undefined;
      try {
        commitSec = lastCommitAt(repoRoot, declaredPath);
      } catch {
        commitSec = undefined;
      }
      // Unknown is neither an exoneration nor an accusation — it is silence.
      if (commitSec === undefined || commitSec === null || !Number.isFinite(commitSec)) continue;
      if (commitSec >= cutoffSec) {
        clearedByAnyRoot = true;
        break;
      }
      // Judged under this root: on disk, clean, and last committed before the work began.
      verdictSec = commitSec;
    }

    if (!clearedByAnyRoot && verdictSec !== undefined) {
      untouched.push({ path: declaredPath, lastCommitAt: new Date(verdictSec * 1000).toISOString() });
    }
  }

  return untouched.length > 0
    ? { untouched, since: new Date(sinceSec * 1000).toISOString() }
    : undefined;
}
