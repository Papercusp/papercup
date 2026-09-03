/**
 * Per-path containment against the sha the gate is judging — the completion evidence a
 * gate-red claim needs ("I fixed N reds" is only true if the judged sha carries them).
 *
 * This module used to be `converge-repair-head.ts` and carried the fast-forward plan that
 * moved a frozen queue's `repairHead` to the staging tip. That plan is gone (plan
 * frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, P-002 / D-004): a fix enters the
 * judged lineage ONLY through `admitPathsOntoRepairHead` (repair-head-admission.ts), which
 * replaces exactly the named paths on top of repairHead and never reads the tip as a whole.
 * What remains here is the read side — where the integration branch is, and whether a given
 * path's content on the judged sha equals its content on that branch.
 */
import { spawnSync } from 'node:child_process';

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
 * Per-path containment against the sha the gate is actually judging. Equal blobs mean the
 * judged sha already has that path's staging content.
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
