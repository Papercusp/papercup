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
 * Candidate-side absent + tree-side present ⇒ a NEW file (the case a `git diff`
 * against a commit cannot see at all) — but NOT necessarily an uncommitted one: a new
 * file committed after the candidate is absent there and committed here, so HEAD, not
 * the candidate, decides which lever the caller needs. Tree-side unreadable
 * ⇒ `null`, "unknown", never "fine".
 *
 * That rule is now contract-level for every state cell, not a local discipline:
 * unified-agent-state-plane-2026-07-27 #D-038 axis 2. Its corollary is why
 * `unknownReason` below is an ENUMERATED code rather than the prose it started
 * as — see `cell-contract.ts`.
 */

import { cellUnknown, type CellUnknown } from './cell-contract';

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
 *  - `absent`       → the candidate has no such path AND no HEAD was supplied to ask
 *                     whether a newer commit carries it, so committed-ness is genuinely
 *                     unknown. With a HEAD (the default) this collapses into one of the
 *                     two above, because those name a lever and this does not.
 */
export type MissingReason = 'uncommitted' | 'newer-commit' | 'absent';

export interface PathContainment {
  path: string;
  /** true = the candidate carries exactly this working-tree content. null = could not tell. */
  inCandidate: boolean | null;
  reason: MissingReason | null;
  /**
   * Present when `inCandidate` is null: why the comparison could not be made —
   * ENUMERATED, never prose (D-038 axis 2 corollary). A caller branches on
   * `code` (`not-applicable` is final; `resolver-failed` is retry-or-escalate);
   * `detail` carries the sentence this field used to hold on its own.
   */
  unknownReason: CellUnknown | null;
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
      // No candidate was supplied at all, so containment is not a question that
      // applies yet — a retry with the same inputs cannot change it.
      unknownReason: cellUnknown(
        'not-applicable',
        'No candidate commit could be resolved, so there is nothing to compare against.',
      ),
    }));
  }
  // The candidate COMMIT must resolve before any per-path verdict is meaningful. Without
  // this, an unresolvable sha makes every `<sha>:<path>` read fail, and a failed read on
  // the candidate side is indistinguishable from "the commit genuinely lacks this path" —
  // so every file comes back `absent`, a DEFINITIVE miss, and the caller is hard-warned
  // that none of its work is in the run. Caught live: a garbage sha reported
  // `inCandidate: false, reason: 'absent'` for a file that was plainly committed.
  // `judgingSha` is parsed from a log line / a foreign checkout's HEAD, so a stale or
  // bogus value is a real input, not a hypothetical — and a detector that cries wolf is
  // one agents learn to ignore.
  const resolved = await git(['rev-parse', '--verify', `${candidateSha}^{commit}`]);
  if (!resolved || !SHA_RE.test(resolved)) {
    return paths.map((path) => ({
      path,
      inCandidate: null,
      reason: null,
      // A sha WAS supplied and this repo could not resolve it — a fetch, or a
      // read against the right checkout, may still answer. Not `not-applicable`.
      unknownReason: cellUnknown(
        'resolver-failed',
        `Candidate commit '${candidateSha.slice(0, 12)}' does not resolve in this repo — containment is UNKNOWN, not missing.`,
      ),
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
          unknownReason: cellUnknown(
            'resolver-failed',
            `Could not read '${path}' from the working tree (deleted, or outside this repo) — containment is UNKNOWN, not confirmed.`,
          ),
        };
      }
      if (candidateBlob === treeBlob) return { path, inCandidate: true, reason: null, unknownReason: null };
      // A path ABSENT from the candidate is NOT self-evidently uncommitted. A brand-new
      // file committed AFTER the candidate is absent there and fully committed here — the
      // single commonest case on this tree, because the quiet-cut deliberately steps the
      // judged commit back ~4 min behind the tip. Answering `absent` without consulting
      // HEAD therefore sent callers to `git-sync:run`, a NO-OP for an already-committed
      // file, while the real lever (wait out the quiet window / let the next run pick it
      // up) went unnamed. So HEAD decides this case exactly as it decides the modified
      // one below; `absent` now survives only when there is no HEAD to ask.
      const headBlob = committedSha ? await blobAtCommit(git, committedSha, path) : null;
      if (!candidateBlob) {
        if (!committedSha) return { path, inCandidate: false, reason: 'absent', unknownReason: null };
        return {
          path,
          inCandidate: false,
          // HEAD carries exactly this content ⇒ committed, merely newer than the candidate.
          // HEAD lacks it or differs ⇒ the edit really has not left the working tree.
          reason: headBlob === treeBlob ? 'newer-commit' : 'uncommitted',
          unknownReason: null,
        };
      }
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

/* NOTE: the "every path touched by (from, to]" read deliberately does NOT live here.
 * Its only consumer is `willJudge.excludedPaths` in release-checkpoint-launch.ts, which
 * must stay SYNCHRONOUS — that function's steps from the active-run check to `spawnFn`
 * have to run in one tick (see its cancelStaleAwaits comment), so an async helper could
 * not be used there. It is `pathsBetweenSync` in that module. An async twin here would be
 * dead code that only its own test exercised. */

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
