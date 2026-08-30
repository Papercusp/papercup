/**
 * P-002 (frozen-candidate-compliance-enforcement-2026-08-30): the ONE sanctioned route
 * for getting a gate-red fix onto the frozen candidate's judged lineage.
 *
 * The mechanism itself is P-001's `shouldConvergeRepairHead` — this module does NOT
 * re-derive that rule, it wraps it in the single verb `release:repair-queue{op:'converge'}`
 * so compliance is one call instead of a worktree recipe. D-001 forbids answering this
 * class with prose, and D-002 fixes what each outcome means:
 *
 *   1. repairHead still an ancestor of staging  -> fast-forward it (nothing else needed)
 *   2. repairHead diverged (a fixer committed)  -> merge staging INTO the repair worktree
 *   3. provably unreachable-green               -> op:'retire', then let the next run re-freeze
 *
 * Every verdict here is one of those, plus the two honest "no answer" cases: there is no
 * frozen queue at all, or the ancestry probe itself failed. Both fail closed.
 */
import { spawnSync } from 'node:child_process';
import { integrationRoot } from '../release-deploy-launch';
import {
  shouldConvergeRepairHead,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

export type ConvergeVerdict =
  /** Nothing is frozen. An ordinary staging commit is already the judged lineage. */
  | 'no-frozen-queue'
  /** repairHead already equals the staging tip; the fix is on the judged sha. */
  | 'already-converged'
  /** repairHead is an ancestor of staging and would move (dry run). */
  | 'would-converge'
  /** repairHead was moved to the staging tip. */
  | 'converged'
  /** D-002 case 2 — a fixer commit has diverged; fast-forward would discard it. */
  | 'diverged-merge-required'
  /** The ancestry probe failed. Fails closed: today's behaviour, never a guess. */
  | 'ancestry-unverifiable';

export interface ConvergePlan {
  verdict: ConvergeVerdict;
  /** The sha repairHead should move to, or null when it must not move. */
  newRepairHead: string | null;
  /** The sha the gate is judging once this plan is applied. */
  judgedSha: string | null;
  /** What the caller must do next, when the verb alone cannot finish the job. */
  nextAction: string | null;
}

/**
 * Pure: classify the queue against staging. Split out from the git work so the ruling is
 * testable without a repository, and so the one mechanism (`shouldConvergeRepairHead`)
 * stays the only place the fast-forward rule is written down.
 */
export function planConvergeRepairHead(input: {
  queue: Pick<FrozenCandidateRepairQueue, 'repairHead' | 'worktreePath'> | null;
  stagingTip: string | null;
  repairHeadIsAncestorOfStaging: boolean | null;
}): ConvergePlan {
  const { queue, stagingTip, repairHeadIsAncestorOfStaging } = input;
  if (!queue) {
    return {
      verdict: 'no-frozen-queue',
      newRepairHead: null,
      judgedSha: stagingTip,
      nextAction:
        'No frozen repair queue. Fix on staging as normal — git-sync commits it and the ' +
        'next candidate is cut from that tip. Do not fire release:checkpoint-run.',
    };
  }
  if (!stagingTip || repairHeadIsAncestorOfStaging === null) {
    return {
      verdict: 'ancestry-unverifiable',
      newRepairHead: null,
      judgedSha: queue.repairHead,
      nextAction:
        'The ancestry probe failed, so no convergence is attempted (fail-closed — this is ' +
        'exactly today\'s behaviour). Re-run once git is reachable; do not retire on this.',
    };
  }

  const decision = shouldConvergeRepairHead({
    repairHead: queue.repairHead,
    stagingTip,
    repairHeadIsAncestorOfStaging,
  });

  if (decision.converge && decision.newRepairHead) {
    return {
      verdict: 'would-converge',
      newRepairHead: decision.newRepairHead,
      judgedSha: decision.newRepairHead,
      nextAction: null,
    };
  }
  if (repairHeadIsAncestorOfStaging && stagingTip === queue.repairHead) {
    return {
      verdict: 'already-converged',
      newRepairHead: null,
      judgedSha: queue.repairHead,
      nextAction: null,
    };
  }
  // Not an ancestor: a repair fixer has committed unique, unpushed content. Fast-forward
  // would discard it, so D-002 case 2 applies.
  return {
    verdict: 'diverged-merge-required',
    newRepairHead: null,
    judgedSha: queue.repairHead,
    nextAction:
      `A repair fixer has already committed on this queue, so repairHead is no longer an ` +
      `ancestor of staging and MUST NOT be fast-forwarded (that would discard the fixer's ` +
      `work). Carry the staging fix in by merging staging into the repair worktree at ` +
      `${queue.worktreePath}. Do NOT re-cut a fresh candidate (D-002) and do NOT retire ` +
      `unless the queue is provably unreachable-green.`,
  };
}

export function integrationBranch(): string {
  return process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging';
}

export interface GitProbe {
  /** Resolve a ref to a sha, or null when it does not resolve. */
  revParse(root: string, ref: string): string | null;
  /** true / false, or null when the probe itself failed (never a guess). */
  isAncestor(root: string, ancestor: string, descendant: string): boolean | null;
  /** Blob sha of `path` at `ref`, or null when absent. */
  blobAt(root: string, ref: string, path: string): string | null;
}

const run = (argv: string[], root: string) =>
  spawnSync('git', ['-C', root, ...argv], { encoding: 'utf8' });

export const realGitProbe: GitProbe = {
  revParse(root, ref) {
    // `--verify --quiet` matters: a bare `git rev-parse <ref>` PRINTS the ref string to
    // stdout before exiting 128, which a naive capture stores as though it were a sha.
    const r = run(['rev-parse', '--verify', '--quiet', ref], root);
    const out = (r.stdout ?? '').trim();
    return r.status === 0 && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  },
  isAncestor(root, ancestor, descendant) {
    const r = run(['merge-base', '--is-ancestor', ancestor, descendant], root);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    // Any other status (bad object, git failure) is UNKNOWN, not "false".
    return null;
  },
  blobAt(root, ref, path) {
    const r = run(['rev-parse', '--verify', '--quiet', `${ref}:${path}`], root);
    const out = (r.stdout ?? '').trim();
    return r.status === 0 && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  },
};

export interface PathContainment {
  path: string;
  /** true = the judged sha carries this path's current staging content. */
  containedInJudgedSha: boolean;
  judgedBlob: string | null;
  stagingBlob: string | null;
}

/**
 * Per-path containment against the sha the gate is actually judging. This is the
 * completion evidence P-006 requires: "I fixed N reds" is only true if the judged sha
 * carries them. Equal blobs mean the judged sha already has that path's staging content.
 *
 * NOTE the documented limit: equal blobs prove that PATH is current, not that the
 * candidate is. A submodule-backed subject moves underneath an identical test blob, so a
 * gitlink diff is still required to rule out pure submodule staleness.
 */
export function containmentForPaths(
  paths: string[],
  judgedSha: string,
  root: string,
  git: GitProbe = realGitProbe,
  branch: string = integrationBranch(),
): PathContainment[] {
  return paths.map((path) => {
    const judgedBlob = git.blobAt(root, judgedSha, path);
    const stagingBlob = git.blobAt(root, branch, path);
    return {
      path,
      containedInJudgedSha: judgedBlob !== null && judgedBlob === stagingBlob,
      judgedBlob,
      stagingBlob,
    };
  });
}

/** Resolve staging + ancestry, then classify. Git failures degrade to fail-closed. */
export function assessConvergeRepairHead(
  queue: FrozenCandidateRepairQueue | null,
  root: string = integrationRoot(),
  git: GitProbe = realGitProbe,
  branch: string = integrationBranch(),
): ConvergePlan & { stagingTip: string | null; root: string; branch: string } {
  const stagingTip = git.revParse(root, branch);
  const repairHeadIsAncestorOfStaging =
    queue && stagingTip ? git.isAncestor(root, queue.repairHead, stagingTip) : null;
  return {
    ...planConvergeRepairHead({ queue, stagingTip, repairHeadIsAncestorOfStaging }),
    stagingTip,
    root,
    branch,
  };
}
