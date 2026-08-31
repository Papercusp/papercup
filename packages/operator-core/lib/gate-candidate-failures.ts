/**
 * gate-candidate-failures.ts — WI-1702869.
 *
 * THE ONE NUMBER GATE TRIAGE NEEDS: how many test files are failing ON THE FROZEN
 * CANDIDATE, and for each of them, whether its fix has ALREADY LANDED on `repairHead`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * Measured 2026-08-31, owner-escalated. Asked "how is the greening going", an agent
 * (me) hand-wrote SQL against `harness_shared.test_runs` and reported "45 → 29 failing
 * files" and "no full suite has run". Both were wrong, and wrong in the most expensive
 * direction: the real answer was ONE failing file, whose fix was ALREADY in repairHead.
 * Freeze-and-converge had worked and nobody could see it.
 *
 * The error was not carelessness. `test_runs` mixes THREE populations on any given
 * day, and only ONE of them answers "what are we promoting":
 *
 *   commit_sha='<candidate>', worktree_dirty=false  ← THE FROZEN CANDIDATE. The only
 *                                                     rows that judge what is being
 *                                                     promoted. (223 files that day.)
 *   commit_sha=NULL,          worktree_dirty=false  ← the FULL SUITE, attributed to NO
 *                                                     candidate (6,337 files). See
 *                                                     WI-1702898 — that NULL is a data
 *                                                     defect, not a category.
 *   worktree_dirty=true                             ← runs against a tree ~100 agents
 *                                                     are mutating. ZERO evidentiary
 *                                                     value about any sha, yet recorded
 *                                                     as source='ci'.
 *
 * Aggregating 2 and 3 reports FLEET CHURN as the gate's verdict. There was no cell,
 * tool or field that returned population 1, so the only way to ask the question was to
 * hand-write the join — which is exactly where the error entered. This module is that
 * missing instrument.
 *
 * ── THE FIELD THAT MATTERS ──────────────────────────────────────────────────────
 * `distinctFailingFiles[].fixInRepairHead`. A failing row on the frozen candidate does
 * NOT mean the file is still broken: the candidate is a FROZEN sha, fixes land ON TOP
 * of it (advancing `repairHead`), and the queue re-tests. So the population splits two
 * ways and only one of them is work:
 *
 *   fixInRepairHead: true   → "fixed, awaiting re-verification" — do NOT go fix it
 *   fixInRepairHead: false  → "still broken at repairHead" — THIS is the actual queue
 *   fixInRepairHead: null   → unmeasurable (blob unresolvable); says nothing either way
 *
 * On the measured incident that single field would have ended a five-hour hunt at
 * 06:00Z: 1 failing file, fix already contained, nothing to do but wait for the re-cut.
 *
 * ── THE SCOPE CAVEAT IS PART OF THE ANSWER, NOT A FOOTNOTE ──────────────────────
 * `filesJudged` is the AFFECTED RADIUS the gate selected for this candidate (~223 on
 * the measured day), NOT the ~6,700-file full suite. A reader who takes
 * `distinctFailingFiles: []` as "repairHead is green" has made the mirror-image of the
 * original error — over-claiming green off a narrow probe instead of over-claiming red
 * off a wide one. Every result therefore carries `scope` as a rendered sentence, and
 * `postSuiteMeasured` says whether the non-test legs (lint / perf / desktop / delta)
 * were measured at all. A passing affected-tests suite is NOT a green gate.
 */

import { execFile } from 'node:child_process';
import { getOrgPg } from '@papercusp/db-org';

/** Hard cap on rendered failing files — the result is read in-prompt. */
const MAX_FAILING_FILES = 60;
/** Blob comparison is one `git rev-parse` per file per ref; cap the fan-out. */
const MAX_BLOB_COMPARES = 40;
const GIT_TIMEOUT_MS = 5_000;

export interface GateCandidateFailingFile {
  path: string;
  /** How many rows this file has on the candidate (a gate retry writes more than one). */
  attempts: number;
  /** The LATEST attempt's status — a retried-and-passed file is not a failure. */
  status: string;
  /**
   * Whether this file's content DIFFERS between the candidate and repairHead — i.e.
   * whether a fix landed after the cut. `null` when it could not be measured.
   * See the module header: this is the field that separates work from noise.
   */
  fixInRepairHead: boolean | null;
  /** What was actually compared, so a reader can re-run it by hand. */
  comparison: string;
  candidateBlob: string | null;
  repairHeadBlob: string | null;
  /** Plain-language reading of the row, so the tri-state cannot be mis-skimmed. */
  reading: string;
}

export interface GateCandidateFailures {
  candidateSha: string | null;
  repairHeadSha: string | null;
  /**
   * DISTINCT test files the gate judged on this candidate — the AFFECTED RADIUS,
   * not the full suite. Read `scope` before quoting this anywhere.
   */
  filesJudged: number;
  /** Files whose LATEST attempt on the candidate is fail/error. */
  distinctFailingFiles: GateCandidateFailingFile[];
  failingFileCount: number;
  /** Of the failing files, how many already have their fix in repairHead. */
  alreadyFixedCount: number;
  /** Of the failing files, how many are still broken at repairHead — the real queue. */
  stillBrokenCount: number;
  /**
   * Whether the gate's non-test legs (lint / perf / desktop / delta) were measured.
   * `null` = not recorded in the readable gate-health snapshot, which is NOT the same
   * as `false`. A passing affected-tests suite is never by itself a green gate.
   */
  postSuiteMeasured: boolean | null;
  /** The scope sentence. Rendered, not derived by the reader. */
  scope: string;
  /** Set when the answer could not be computed; the other fields are then not evidence. */
  unavailable: string | null;
  /** Truncation marker — a capped list is a bounded measurement, never a total. */
  truncated: boolean;
}

type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

/** Fail-soft git: a non-zero exit or a missing ref is UNKNOWN (`null`), never a throw. */
const realGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      // `git rev-parse <ref>:<missing>` PRINTS the ref string to stdout before exiting
      // non-zero, so stdout alone is NOT a success signal here (the documented
      // `--verify --quiet` trap). Gate on the error first.
      resolve(err ? null : stdout.trim() || null);
    });
  });

export interface ReadGateCandidateFailuresOpts {
  candidateSha: string | null;
  repairHeadSha: string | null;
  /** Repo root the blob comparisons resolve against. */
  root: string;
  /** Submodule prefixes (from `submodulePaths()`), so a gitlink move is not misread. */
  submodulePaths?: readonly string[];
  postSuiteMeasured?: boolean | null;
  git?: GitRunner;
  sql?: ReturnType<typeof getOrgPg>['sql'];
}

const SCOPE_SENTENCE =
  'filesJudged is the AFFECTED RADIUS the gate selected for this candidate — NOT the full suite ' +
  '(~6,700 files). An empty failing list means "nothing failed in the judged radius", NOT ' +
  '"repairHead is green"; the post-suite legs (lint/perf/desktop/delta) and the main fast-forward ' +
  'are separate and are reported by postSuiteMeasured.';

function unavailable(reason: string, candidateSha: string | null, repairHeadSha: string | null): GateCandidateFailures {
  return {
    candidateSha,
    repairHeadSha,
    filesJudged: 0,
    distinctFailingFiles: [],
    failingFileCount: 0,
    alreadyFixedCount: 0,
    stillBrokenCount: 0,
    postSuiteMeasured: null,
    scope: SCOPE_SENTENCE,
    unavailable: reason,
    truncated: false,
  };
}

/**
 * Is `p` inside one of the submodule prefixes?
 *
 * ⚠ THE SUBMODULE TRAP, hit twice on 2026-08-31 before it was named: for a path inside
 * a submodule, `git rev-parse <candidate>:<path>` compares content that is IDENTICAL in
 * both refs while the GITLINK moved underneath it. That answers "unchanged" confidently
 * and wrongly — the false-negative direction, which sends an agent to re-fix a file that
 * was already fixed. Submodule-backed paths are therefore compared by GITLINK, not blob.
 */
function submoduleFor(p: string, subs: readonly string[]): string | null {
  return subs.find((s) => p === s || p.startsWith(s + '/')) ?? null;
}

async function compareOne(
  git: GitRunner,
  root: string,
  path: string,
  candidateSha: string,
  repairHeadSha: string,
  subs: readonly string[],
): Promise<Pick<GateCandidateFailingFile, 'fixInRepairHead' | 'comparison' | 'candidateBlob' | 'repairHeadBlob' | 'reading'>> {
  const sub = submoduleFor(path, subs);
  if (sub) {
    // Compare the GITLINK, not the file. `git diff --raw` emits mode 160000 rows for
    // submodule pointers; a non-empty result means the submodule moved between the two
    // refs, which is the only thing the superproject can honestly say about this path.
    const raw = await git(root, ['diff', '--raw', candidateSha, repairHeadSha, '--', sub]);
    const moved = raw === null ? null : /^:160000/m.test(raw);
    return {
      fixInRepairHead: moved,
      comparison: `gitlink ${sub} between ${candidateSha.slice(0, 12)} and ${repairHeadSha.slice(0, 12)} (submodule-backed path — blob compare would answer about the wrong object)`,
      candidateBlob: null,
      repairHeadBlob: null,
      reading:
        moved === null
          ? 'UNMEASURABLE — the gitlink diff could not be read; this says nothing either way.'
          : moved
            ? `The ${sub} submodule pointer MOVED between the candidate and repairHead, so this red may already be repaired — verify in the submodule before fixing it again.`
            : `The ${sub} submodule pointer is UNCHANGED at repairHead, so nothing has landed for this path yet.`,
    };
  }

  const [a, b] = await Promise.all([
    git(root, ['rev-parse', '--verify', '--quiet', `${candidateSha}:${path}`]),
    git(root, ['rev-parse', '--verify', '--quiet', `${repairHeadSha}:${path}`]),
  ]);
  // Either blob unresolvable ⇒ UNKNOWN. An absent path and an unresolvable ref look
  // identical here, and neither is evidence about whether a fix landed.
  const fixInRepairHead = a === null || b === null ? null : a !== b;
  return {
    fixInRepairHead,
    comparison: `git rev-parse ${candidateSha.slice(0, 12)}:${path} vs ${repairHeadSha.slice(0, 12)}:${path}`,
    candidateBlob: a,
    repairHeadBlob: b,
    reading:
      fixInRepairHead === null
        ? 'UNMEASURABLE — one of the two blobs did not resolve; this says nothing either way.'
        : fixInRepairHead
          ? 'FIXED AT repairHead, awaiting re-verification — the file changed after the candidate was cut. Do NOT re-fix it.'
          : 'STILL BROKEN — the file is byte-identical at repairHead, so no fix has landed. This one is real work.',
  };
}

/**
 * Read the failing-files-on-the-frozen-candidate answer.
 *
 * Fail-soft in every direction: an unreachable database, an unresolvable ref, or a
 * missing candidate all return `unavailable` with the reason stated. A cell must always
 * render, and "I could not measure this" is a correct answer — a fabricated zero is not.
 */
export async function readGateCandidateFailures(
  opts: ReadGateCandidateFailuresOpts,
): Promise<GateCandidateFailures> {
  const candidateSha = opts.candidateSha?.trim() || null;
  const repairHeadSha = opts.repairHeadSha?.trim() || null;
  if (!candidateSha) {
    return unavailable(
      'no frozen candidate — there is no sha to judge, so there is no failing-files answer. This is not "zero failures".',
      null,
      repairHeadSha,
    );
  }

  const git = opts.git ?? realGit;
  const subs = opts.submodulePaths ?? [];

  let judged: Array<{ files_judged: string | number }>;
  let failing: Array<{ file_path: string; status: string; attempts: string | number }>;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    // ONE population, stated explicitly: rows the CI gate recorded FOR THIS SHA against a
    // CLEAN tree. `worktree_dirty=false` is not defensive noise — a dirty-tree run is a
    // measurement of a tree ~100 agents are mutating and proves nothing about any sha.
    [judged, failing] = await Promise.all([
      sql<Array<{ files_judged: string | number }>>`
        SELECT count(DISTINCT file_path) AS files_judged
          FROM harness_shared.test_runs
         WHERE source = 'ci'
           AND worktree_dirty = false
           AND commit_sha = ${candidateSha}`,
      // DISTINCT ON keeps only each file's LATEST attempt: a gate retry writes a second
      // row, and counting the superseded attempt forever is how a fixed file keeps
      // reading as red.
      sql<Array<{ file_path: string; status: string; attempts: string | number }>>`
        WITH candidate_runs AS (
          SELECT file_path, status, finished_at, id
            FROM harness_shared.test_runs
           WHERE source = 'ci'
             AND worktree_dirty = false
             AND commit_sha = ${candidateSha}
        ), latest AS (
          SELECT DISTINCT ON (file_path) file_path, status
            FROM candidate_runs
           ORDER BY file_path, finished_at DESC NULLS LAST, id DESC
        )
        SELECT l.file_path,
               l.status,
               (SELECT count(*) FROM candidate_runs c WHERE c.file_path = l.file_path) AS attempts
          FROM latest l
         WHERE l.status IN ('fail', 'error')
         ORDER BY l.file_path`,
    ]);
  } catch (err) {
    return unavailable(
      `test_runs unreadable: ${err instanceof Error ? err.message : String(err)}`,
      candidateSha,
      repairHeadSha,
    );
  }

  const filesJudged = Number(judged[0]?.files_judged ?? 0);
  const truncated = failing.length > MAX_FAILING_FILES;
  const rows = failing.slice(0, MAX_FAILING_FILES);

  const files: GateCandidateFailingFile[] = [];
  for (const [i, r] of rows.entries()) {
    const base = {
      path: r.file_path,
      attempts: Number(r.attempts ?? 1),
      status: r.status,
    };
    if (!repairHeadSha) {
      files.push({
        ...base,
        fixInRepairHead: null,
        comparison: 'not compared — no repairHead sha is open for this candidate',
        candidateBlob: null,
        repairHeadBlob: null,
        reading: 'UNMEASURABLE — without a repairHead there is nothing to compare the candidate against.',
      });
      continue;
    }
    if (i >= MAX_BLOB_COMPARES) {
      files.push({
        ...base,
        fixInRepairHead: null,
        comparison: `not compared — past the ${MAX_BLOB_COMPARES}-file blob-compare cap`,
        candidateBlob: null,
        repairHeadBlob: null,
        reading: 'UNMEASURABLE — comparison capped; re-run the comparison by hand for this path.',
      });
      continue;
    }
    files.push({ ...base, ...(await compareOne(git, opts.root, r.file_path, candidateSha, repairHeadSha, subs)) });
  }

  const alreadyFixedCount = files.filter((f) => f.fixInRepairHead === true).length;
  const stillBrokenCount = files.filter((f) => f.fixInRepairHead === false).length;

  return {
    candidateSha,
    repairHeadSha,
    filesJudged,
    distinctFailingFiles: files,
    failingFileCount: failing.length,
    alreadyFixedCount,
    stillBrokenCount,
    postSuiteMeasured: opts.postSuiteMeasured ?? null,
    scope: SCOPE_SENTENCE,
    unavailable: null,
    truncated,
  };
}
