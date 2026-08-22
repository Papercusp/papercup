/**
 * provenance.ts — WHAT CODE PRODUCED THIS NUMBER
 * (harden-shared-hive-to-256-peers-2026-06-29 D-026, Lane B).
 *
 * THE HOLE THIS CLOSES. `PerfArtifact` recorded scenario, params, timings,
 * host shape and verdicts — and nothing whatsoever about the code that ran.
 * On a shared tree where peers hold uncommitted edits continuously and
 * git-sync sweeps on a schedule, that makes a number unattributable after the
 * fact: the tree has moved, so it cannot be re-derived, and no field on the
 * artifact records what it was. That is exactly why every historical
 * >32-peer figure in this repo is void (D-026), and why fixing the rig's
 * footprint without fixing this yields a good measurement nobody may cite.
 *
 * WHY THE CAPTURE LIVES HERE AND NOT IN `artifact.ts`. artifact.ts is the
 * schema module and is imported by `peer-child.ts` — i.e. by EVERY spawned
 * peer in a mesh run, which is the very import weight P-012 is measuring.
 * This module shells out to git and walks directories; it is imported ONLY by
 * `runner.ts` (the CLI parent), so no peer pays for it. The TYPE lives with
 * the rest of the schema in artifact.ts; the machinery lives here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS INSTRUMENT CANNOT TELL YOU — read before quoting a stamp.
 *
 * This lane has produced EIGHT instrument defects, each found only after a
 * conclusion had been drafted from the bad instrument (D-024 is the most
 * recent). So the limits are stated up front rather than discovered later:
 *
 *  1. A SUPERPROJECT SHA DOES NOT PIN SUBMODULE CODE. This repo has ~38
 *     submodules, edited in place, each committed by git-sync on its own
 *     schedule. The superproject's recorded gitlink can therefore lag a
 *     submodule's actually-checked-out HEAD, and `git rev-parse HEAD` at the
 *     top level says nothing about that lag. `submodulesDivergedFromGitlink`
 *     exists precisely to make the lie visible: a non-empty list means
 *     `lastCommitSha` DOES NOT describe all the code that ran. This was the
 *     defect on the leg of the claim that looked most obviously safe.
 *
 *  2. THE DIRTY DIGEST IS A FINGERPRINT, NOT A COMPARISON. On a box with
 *     ~90 concurrent agents the whole-tree porcelain is dominated by other
 *     lanes' churn and changes continuously, so `dirtyDigest` is effectively
 *     unique per run: it can prove "this run's tree differed from that run's"
 *     and it can never prove "the same code ran twice". Worse, a whole-tree
 *     dirty FLAG here would be permanently true, and a permanently-true
 *     signal carries no information (the same confound `computeHostHealth`
 *     documents for the swap-page fallback). `dirtyPathsInScope` is the field
 *     that carries information; the digest is only a fingerprint.
 *
 *  3. THE SCOPE IS A HAND-MAINTAINED APPROXIMATION AND THEREFORE
 *     UNDER-REPORTS. `scope` records exactly which prefixes were consulted so
 *     that under-reporting is visible in the artifact instead of implied by
 *     silence. A dirty file outside those prefixes that nevertheless affects
 *     the run will not appear. Read an empty `dirtyPathsInScope` as "nothing
 *     dirty UNDER THESE PREFIXES", never as "the tree was clean".
 *
 *  4. THE STAMP DESCRIBES RUN START, AND A LONG RUN OUTLIVES IT. Provenance
 *     is captured once, at run start, because the tree moves during a run and
 *     a per-artifact re-capture would record the state at emit rather than at
 *     execution. But peer children are spawned per SCENARIO and load their
 *     code then — so an artifact emitted 40 minutes in may have run code the
 *     start-of-run snapshot does not describe. `subjectDriftSinceCapture` is
 *     the falsifier for exactly that: it re-stats the subject trees at emit
 *     and names any that moved. A non-empty list means the snapshot is stale
 *     for that artifact and the run should not be quoted as one code state.
 *
 *  5. mtime IS NOT CONTENT. A file rewritten with identical bytes moves its
 *     mtime; a file whose content changed without a write does not exist.
 *     mtime drift is therefore a SUSPICION, not a diff — it over-reports.
 *     That direction is deliberate: an over-reporting falsifier costs a
 *     re-check, an under-reporting one costs a false attribution.
 *
 * Every leg fails SOFT. A git binary that is missing, slow, or refuses inside
 * a sandbox yields `null` plus a line in `unavailable` — never a thrown error
 * that kills a run which is otherwise producing good measurements. An
 * instrument that crashes the subject is worse than one that says "unknown".
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PerfArtifact, RunProvenance, SubjectTreeStamp } from './artifact';

/**
 * Repo-relative prefixes treated as "the code under test" for the dirty-path
 * and mtime legs. Hand-maintained, and therefore an approximation — see
 * limitation (3) in this file's header. It is recorded onto every stamp
 * (`worktree.scope`) so a reader sees what was actually consulted.
 */
export const DEFAULT_SUBJECT_SCOPE = [
  'packages/operator-core/lib/sync/hyperbee',
  'libs/generic/sync',
] as const;

/** Cap on `dirtyPathsInScope`, so a pathological run cannot bloat every artifact. */
const MAX_SCOPED_DIRTY_PATHS = 50;

/** Extensions walked by the subject-mtime leg. */
const SUBJECT_EXTENSIONS = ['.ts', '.mjs', '.js', '.json'];

// ───────────────────────────── pure parsing ─────────────────────────────
// Separated from the shelling-out so they are unit-testable WITHOUT running
// git, walking a tree, or firing anything (D-026 item 2: Lane B is NON-FIRING).

export interface SubmoduleStatusRow {
  path: string;
  sha: string;
  /**
   * True when the checked-out HEAD differs from the gitlink the superproject
   * records ('+'), the submodule is uninitialised ('-'), or it has merge
   * conflicts ('U'). Any of those means the superproject sha does not
   * describe this submodule's code.
   */
  diverged: boolean;
  /** The raw status character, so a reader can tell '+' from '-' from 'U'. */
  status: string;
}

/**
 * Parse `git submodule status` output.
 *
 * Format is a one-character status, then the sha, then the path, then an
 * optional `(describe)`: `" 1a2b… libs/generic/sync (heads/main)"`. A leading
 * SPACE means in-sync; '+', '-' and 'U' each mean the superproject sha does
 * not describe that submodule's checked-out code.
 */
export function parseSubmoduleStatus(text: string): SubmoduleStatusRow[] {
  const rows: SubmoduleStatusRow[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const status = raw[0] ?? ' ';
    // The status char is column 0 even when it is a space; the sha follows.
    const rest = raw.slice(1);
    const m = /^([0-9a-f]{7,64})\s+(\S+)/.exec(rest);
    if (!m) continue;
    rows.push({
      status,
      sha: m[1],
      path: m[2],
      diverged: status !== ' ',
    });
  }
  return rows;
}

export interface PorcelainSummary {
  /** sha256 of the raw porcelain text — a fingerprint, NOT a comparison key. */
  digest: string;
  /** Number of entries git reported dirty (tracked + non-ignored untracked). */
  fileCount: number;
  /** Every repo-relative path git named, in git's order. */
  paths: string[];
}

/**
 * Parse `git status --porcelain` (v1) into a digest + the paths it named.
 *
 * Rename entries are `XY orig -> new`; the NEW path is the one that describes
 * the current tree, so that is the one kept. Quoted paths (git quotes when a
 * name contains unusual bytes) are kept verbatim rather than unquoted — this
 * leg exists to say WHICH FILES moved, and an approximate name is strictly
 * better than dropping the entry.
 */
export function parsePorcelainStatus(text: string): PorcelainSummary {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const paths: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw.length < 4) continue;
    const body = raw.slice(3);
    const arrow = body.indexOf(' -> ');
    paths.push(arrow >= 0 ? body.slice(arrow + 4) : body);
  }
  return { digest, fileCount: paths.length, paths };
}

/** Keep the paths that sit under one of `scope`'s repo-relative prefixes. */
export function selectPathsInScope(paths: string[], scope: readonly string[]): string[] {
  return paths.filter((p) => scope.some((s) => p === s || p.startsWith(`${s}/`)));
}

/**
 * Compare a fresh subject-tree walk against the stamped one and name the
 * directories whose newest mtime ADVANCED.
 *
 * Only forward movement counts. A tree whose newest file was deleted reports
 * an OLDER newest-mtime, which is a change but not evidence that the code
 * under test was rewritten mid-run — and treating it as drift would make this
 * falsifier fire on ordinary cleanup. Both `null`s (unreadable either time)
 * are reported as no-drift for the same reason: an unreadable directory is an
 * absent observation, and `unavailable` is where absence is recorded.
 */
export function diffSubjectDrift(
  captured: SubjectTreeStamp[] | null,
  now: SubjectTreeStamp[] | null,
): string[] {
  if (!captured || !now) return [];
  const byDir = new Map(captured.map((s) => [s.dir, s]));
  const drifted: string[] = [];
  for (const cur of now) {
    const before = byDir.get(cur.dir);
    if (!before) continue;
    if (before.newestMtimeMs === null || cur.newestMtimeMs === null) continue;
    if (cur.newestMtimeMs > before.newestMtimeMs) drifted.push(cur.dir);
  }
  return drifted;
}

// ─────────────────────────── impure capture ────────────────────────────

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
      // `--date=iso-strict-local` renders in TZ, so pin it to UTC — git
      // otherwise renders %cd in the COMMIT's own recorded offset, which is
      // a silent multi-hour skew against every other timestamp on the
      // artifact (all UTC).
      env: { ...process.env, TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Walk one repo-relative directory and summarise its newest write.
 *
 * An AGGREGATE (count + newest) rather than a per-file mtime list on purpose:
 * a per-file list of a few hundred entries on every artifact would dwarf the
 * measurements it annotates, while "did anything under here move, and what"
 * is the whole question the mtime leg is asked.
 */
export function stampSubjectTree(repoRoot: string, dir: string): SubjectTreeStamp {
  let fileCount = 0;
  let newestMtimeMs: number | null = null;
  let newestPath: string | null = null;

  const walk = (relDir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(repoRoot, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        walk(rel, depth + 1);
        continue;
      }
      if (!SUBJECT_EXTENSIONS.some((x) => e.name.endsWith(x))) continue;
      fileCount += 1;
      try {
        const ms = statSync(join(repoRoot, rel)).mtimeMs;
        if (newestMtimeMs === null || ms > newestMtimeMs) {
          newestMtimeMs = ms;
          newestPath = rel;
        }
      } catch {
        // A file that vanished between readdir and stat is a racing peer, not
        // an error worth failing a run over.
      }
    }
  };

  walk(dir, 0);
  return { dir, fileCount, newestMtimeMs, newestPath };
}

export function stampSubjectTrees(
  repoRoot: string,
  scope: readonly string[] = DEFAULT_SUBJECT_SCOPE,
): SubjectTreeStamp[] {
  return scope.map((d) => stampSubjectTree(repoRoot, d));
}

/** Resolve the repo root from a directory inside it; null when git cannot. */
export function resolveRepoRoot(from: string): string | null {
  const out = git(from, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() || null : null;
}

export interface CaptureProvenanceInput {
  /** Any directory inside the checkout being measured. */
  from: string;
  /** Host figures the runner ALREADY sampled at start — not re-sampled here. */
  hostAtStart: RunProvenance['hostAtStart'];
  scope?: readonly string[];
}

/**
 * Capture the run-level provenance snapshot. Call ONCE, at run start.
 *
 * Every leg is independently fail-soft: a null field plus a line in
 * `unavailable` naming which probe could not answer. A caller must never read
 * a null as a negative finding — `lastCommitSha: null` means "git did not
 * answer", not "there is no commit".
 */
export function captureRunProvenance(input: CaptureProvenanceInput): RunProvenance {
  const scope = input.scope ?? DEFAULT_SUBJECT_SCOPE;
  const unavailable: string[] = [];
  const repoRoot = resolveRepoRoot(input.from);

  if (!repoRoot) {
    return {
      capturedAt: new Date().toISOString(),
      lastCommitSha: null,
      lastCommitAt: null,
      subjectLastCommitSha: null,
      subjectLastCommitAt: null,
      submodulesDivergedFromGitlink: null,
      worktree: null,
      subjects: null,
      subjectDriftSinceCapture: null,
      hostAtStart: input.hostAtStart,
      unavailable: ['repo-root: git rev-parse --show-toplevel did not answer'],
    };
  }

  // The checkout's last commit. Deliberately NOT named `treeSha`/`headSha`:
  // it describes the last COMMIT, and the working tree can differ from it by
  // an arbitrary amount (that is what `worktree` is for).
  const headLine = git(repoRoot, ['log', '-1', '--date=iso-strict-local', '--format=%H%x09%cd']);
  let lastCommitSha: string | null = null;
  let lastCommitAt: string | null = null;
  if (headLine) {
    const [sha, at] = headLine.trim().split('\t');
    lastCommitSha = sha || null;
    lastCommitAt = at || null;
  } else {
    unavailable.push('last-commit: git log -1 did not answer');
  }

  // The last commit touching the code under test — a strictly more precise
  // answer than the checkout tip, which on this tree is routinely a different
  // agent's sweep that touched nothing here.
  const subjLine = git(repoRoot, [
    'log',
    '-1',
    '--date=iso-strict-local',
    '--format=%H%x09%cd',
    '--',
    ...scope,
  ]);
  let subjectLastCommitSha: string | null = null;
  let subjectLastCommitAt: string | null = null;
  if (subjLine) {
    const [sha, at] = subjLine.trim().split('\t');
    subjectLastCommitSha = sha || null;
    subjectLastCommitAt = at || null;
  } else {
    unavailable.push('subject-last-commit: git log -1 -- <scope> did not answer');
  }

  // Limitation (1): the leg that makes `lastCommitSha` honest.
  const subOut = git(repoRoot, ['submodule', 'status']);
  let submodulesDivergedFromGitlink: string[] | null = null;
  if (subOut === null) {
    unavailable.push('submodules: git submodule status did not answer');
  } else {
    submodulesDivergedFromGitlink = parseSubmoduleStatus(subOut)
      .filter((r) => r.diverged)
      .map((r) => `${r.status}${r.path}`);
  }

  const porcelain = git(repoRoot, ['status', '--porcelain']);
  let worktree: RunProvenance['worktree'] = null;
  if (porcelain === null) {
    unavailable.push('worktree: git status --porcelain did not answer');
  } else {
    const parsed = parsePorcelainStatus(porcelain);
    const inScope = selectPathsInScope(parsed.paths, scope);
    worktree = {
      dirtyDigest: parsed.digest,
      dirtyFileCount: parsed.fileCount,
      dirtyPathsInScope: inScope.slice(0, MAX_SCOPED_DIRTY_PATHS),
      scopedTruncated: inScope.length > MAX_SCOPED_DIRTY_PATHS,
      scope: [...scope],
    };
  }

  return {
    capturedAt: new Date().toISOString(),
    lastCommitSha,
    lastCommitAt,
    subjectLastCommitSha,
    subjectLastCommitAt,
    submodulesDivergedFromGitlink,
    worktree,
    subjects: stampSubjectTrees(repoRoot, scope),
    // Meaningless on the run-level snapshot — it is filled per ARTIFACT, at
    // emit, by stampArtifactProvenance below.
    subjectDriftSinceCapture: null,
    hostAtStart: input.hostAtStart,
    unavailable,
  };
}

/**
 * Attach the run's provenance to ONE artifact at emit time, re-checking the
 * subject trees so limitation (4) is falsifiable per artifact rather than
 * assumed away for the whole run.
 *
 * Returns a NEW artifact — the caller's object is not mutated, so a scenario
 * that keeps a reference to what it emitted cannot observe a stamp appearing
 * on it later.
 */
export function stampArtifactProvenance(
  artifact: PerfArtifact,
  runProvenance: RunProvenance,
  repoRoot: string | null,
): PerfArtifact {
  const nowStamps = repoRoot ? stampSubjectTrees(repoRoot, runProvenance.worktree?.scope ?? DEFAULT_SUBJECT_SCOPE) : null;
  return {
    ...artifact,
    provenance: {
      ...runProvenance,
      subjectDriftSinceCapture: nowStamps ? diffSubjectDrift(runProvenance.subjects, nowStamps) : null,
    },
  };
}
