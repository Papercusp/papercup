/**
 * P-004 (git-pipeline-agent-state-2026-07-26) — "does the commit the gate is about
 * to judge actually contain MY change?"
 *
 * The green-checkpoint judges a COMMITTED candidate, checked out into an isolated
 * tree. It cannot see the working tree, and — because of the quiet-cut — the commit
 * it judges is routinely NOT the tip. Nothing in the fire path answered the one
 * question the caller actually has, so EI-18752644493166307 burned two gate runs
 * finding out by hand (`git show <candidate>:<path> | grep <marker>`, four times).
 *
 * The expensive part is not the wasted run: it is that a candidate WITHOUT your fix
 * reds on the pre-fix failure with the pre-fix count, which reads as **"your fix did
 * not work"** rather than **"your fix was not present"**. The natural next move is to
 * go re-debug code that was already correct. This module exists so that reading is
 * never available: a caller is told, in the reply, which of its files the candidate
 * does and does not carry.
 *
 * ## The one design constraint: an ABSENCE must never read as a POSITIVE
 *
 * Every primitive here is built from git reads that produce NON-EMPTY output on
 * success, and the verdict type is a THREE-valued `boolean | null` — never a bare
 * boolean. The naive implementation (`git diff --name-only <sha> -- <path>`, empty
 * ⇒ "same") silently converts *the git call failed* into *your change IS in the
 * candidate* — a false reassurance, which is the exact failure class this module was
 * written to kill. git-pipeline-position.ts's `refContains` takes the same care for
 * the same reason ("rev-list prints a count on success … unlike `merge-base
 * --is-ancestor`, whose 0/1 exit a stdout-only runner swallows").
 *
 * So the comparison is BLOB-IDENTITY, both sides read as a sha:
 *   - `git rev-parse --verify <sha>:<path>` → the blob the candidate carries
 *   - `git hash-object -- <path>`           → the blob the working tree holds
 * Equal ⇒ the candidate carries exactly what you have. Different ⇒ it does not.
 * Candidate-side absent + tree-side present ⇒ a NEW file, which no commit can carry
 * (the case a `git diff` against a commit cannot see at all). Tree-side unreadable
 * ⇒ `null`, "unknown", never "fine".
 */

/**
 * A git read scoped to one repo: trimmed stdout on success, `''` for a successful
 * command that printed nothing, and `null` when the command FAILED.
 *
 * The `''` vs `null` distinction is load-bearing — see the module doc. Adapters for
 * the two runner shapes already in the tree are at the bottom of this file.
 */
export type GitRead = (args: string[]) => Promise<string | null>;

const SHA_RE = /^[0-9a-f]{7,40}$/;

/** The blob `sha` stores at `relPath`, or null when the path is absent there / the read failed. */
export async function blobAtCommit(git: GitRead, sha: string, relPath: string): Promise<string | null> {
  const out = await git(['rev-parse', '--verify', `${sha}:${relPath}`]);
  return out && SHA_RE.test(out) ? out : null;
}

/**
 * The blob the WORKING TREE currently holds at `relPath` — the content a gate run
 * cannot see. Works for an untracked/new file, which is the whole point: a brand-new
 * test file is invisible to `git diff <commit>` and would otherwise read as "clean".
 */
export async function blobInWorkingTree(git: GitRead, relPath: string): Promise<string | null> {
  const out = await git(['hash-object', '--', relPath]);
  return out && SHA_RE.test(out) ? out : null;
}

/**
 * Why a path is not in the candidate. The reason picks the LEVER, which is the only
 * part the caller can act on:
 *  - `uncommitted`  → the edit never left the working tree. Commit it (git-sync:run).
 *  - `newer-commit` → it IS committed, but in a commit newer than the candidate
 *                     (quiet-cut, or the candidate simply lags). Re-fire once the
 *                     quiet window passes, or wait for the next run.
 *  - `absent`       → the candidate has no such path at all (a new file).
 */
export type MissingReason = 'uncommitted' | 'newer-commit' | 'absent';

export interface PathContainment {
  path: string;
  /** true = the candidate carries exactly this working-tree content. null = could not tell. */
  inCandidate: boolean | null;
  reason: MissingReason | null;
  /** Present when `inCandidate` is null: why the comparison could not be made. */
  unknownReason: string | null;
}

/**
 * Classify each path against `candidateSha` by blob identity against the WORKING TREE.
 *
 * `committedSha` (usually HEAD) separates the two missing-reasons: a path whose
 * working-tree blob differs from HEAD's is an UNCOMMITTED edit (the caller's own
 * lever); one that matches HEAD but not the candidate is committed-but-newer (the
 * quiet-cut case). Omit it and every miss is reported as `newer-commit`.
 */
export async function classifyPathsAgainstCandidate(
  git: GitRead,
  candidateSha: string | null,
  paths: string[],
  committedSha: string | null = 'HEAD',
): Promise<PathContainment[]> {
  if (!candidateSha) {
    return paths.map((path) => ({
      path,
      inCandidate: null,
      reason: null,
      unknownReason: 'No candidate commit could be resolved, so there is nothing to compare against.',
    }));
  }
  return Promise.all(
    paths.map(async (path): Promise<PathContainment> => {
      const [candidateBlob, treeBlob] = await Promise.all([
        blobAtCommit(git, candidateSha, path),
        blobInWorkingTree(git, path),
      ]);
      if (!treeBlob) {
        return {
          path,
          inCandidate: null,
          reason: null,
          unknownReason: `Could not read '${path}' from the working tree (deleted, or outside this repo) — containment is UNKNOWN, not confirmed.`,
        };
      }
      if (candidateBlob === treeBlob) return { path, inCandidate: true, reason: null, unknownReason: null };
      if (!candidateBlob) return { path, inCandidate: false, reason: 'absent', unknownReason: null };
      const headBlob = committedSha ? await blobAtCommit(git, committedSha, path) : null;
      return {
        path,
        inCandidate: false,
        reason: headBlob && headBlob !== treeBlob ? 'uncommitted' : 'newer-commit',
        unknownReason: null,
      };
    }),
  );
}

/** The caller-facing split P-004 asks `release:checkpoint-run` to report. */
export interface CallerEditsInCandidate {
  /** Paths the candidate carries byte-identically to the working tree. */
  included: string[];
  /** Paths it does NOT — a red on any of these is NOT evidence your fix failed. */
  missing: string[];
  /** Paths whose containment could not be determined (never counted as included). */
  unknown: string[];
  /** Per-path detail, in the order the paths were given. */
  paths: PathContainment[];
  /** The candidate these verdicts describe. */
  candidateSha: string | null;
}

export async function callerEditsInCandidate(
  git: GitRead,
  candidateSha: string | null,
  paths: string[],
  committedSha: string | null = 'HEAD',
): Promise<CallerEditsInCandidate> {
  const results = await classifyPathsAgainstCandidate(git, candidateSha, paths, committedSha);
  return {
    included: results.filter((r) => r.inCandidate === true).map((r) => r.path),
    missing: results.filter((r) => r.inCandidate === false).map((r) => r.path),
    unknown: results.filter((r) => r.inCandidate === null).map((r) => r.path),
    paths: results,
    candidateSha,
  };
}

/**
 * Paths with uncommitted working-tree changes, INCLUDING untracked files.
 *
 * An untracked file is the most dangerous input to a gate run — a brand-new test or
 * fixture the candidate provably cannot contain, and the one case a `git diff` against
 * a commit cannot see at all — so it must be in this set.
 *
 * Deliberately TWO bare-path reads rather than one `git status --porcelain`. Porcelain
 * v1 encodes the state in a fixed two-column PREFIX (`" M path"`), so its meaning
 * depends on leading whitespace — and every runner in this tree trims stdout, which
 * silently eats the first line's leading space and shifts the column parse by one. That
 * is a parse whose correctness depends on something no caller can see; these two
 * commands emit paths and nothing else, so there is no column to lose.
 */
export async function uncommittedPaths(git: GitRead): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(['diff', '--name-only', 'HEAD']),
    git(['ls-files', '--others', '--exclude-standard']),
  ]);
  const paths = [tracked, untracked]
    .filter((o): o is string => typeof o === 'string' && o.length > 0)
    .flatMap((o) => o.split('\n'))
    .map((l) => l.trim())
    .filter(Boolean);
  return [...new Set(paths)];
}

/**
 * `sha subject` for the commits in `(from, to]` that touch `relPath` — the concrete
 * resolution P-004 asks for.
 *
 * The old quiet-cut warning listed excluded SHAS and said "if your fix is among
 * them". That offloads the resolution onto the reader, and it is the wrong space to
 * offload it into: an agent knows exactly which FILES it edited and knows nothing
 * about which sha carries them. Answering in path-space turns a question the caller
 * cannot answer into one it never has to.
 */
export async function excludedCommitsTouchingPath(
  git: GitRead,
  from: string,
  to: string,
  relPath: string,
): Promise<string[]> {
  if (from === to) return [];
  const out = await git(['log', '--oneline', '--no-decorate', `${from}..${to}`, '--', relPath]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Every path touched by the commits in `(from, to]` — the excluded window's file footprint. */
export async function pathsTouchedByRange(git: GitRead, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const out = await git(['diff', '--name-only', from, to]);
  return out ? [...new Set(out.split('\n').filter(Boolean))] : [];
}

/* ------------------------------------------------------------------------- *
 * Adapters for the two git-runner shapes already in the tree.
 * ------------------------------------------------------------------------- */

/** Bind a `(repo, args)` runner (git-pipeline-position's `GitRunner`) to one repo. */
export function gitReadForRepo(
  runner: (repo: string, args: string[]) => Promise<string | null>,
  repo: string,
): GitRead {
  return (args) => runner(repo, args);
}

/** Bind a sync `(cmd, args) => { status, stdout }` runner (release-checkpoint-launch's `ExecSyncLike`). */
export function gitReadFromExecSync(
  execFn: (cmd: string, args: string[]) => { status: number | null; stdout: string },
  repo: string,
): GitRead {
  return async (args) => {
    const r = execFn('git', ['-C', repo, ...args]);
    // Preserve the '' vs null distinction the module doc depends on: a zero exit with
    // no output is a real EMPTY answer, not a failure.
    return r.status === 0 ? r.stdout.trim() : null;
  };
}
