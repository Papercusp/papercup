/**
 * pot-git/integrator.ts — the staging integrator (Phase 7 G-5/G-5b/G-5d,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-029, P-034, P-038;
 * D-010/D-011).
 *
 * The lock-authority LEASE HOLDER (one machine at a time, per authority/
 * lock-authority.ts) computes the shared `staging` ref by INTEGRATING every
 * member device's work head into a single line, and publishes it in ITS OWN
 * namespace (`refs/namespaces/<integratorHex>/refs/heads/staging`). Receivers
 * mirror + FAST-FORWARD-ONLY accept it (G-7c) — staging never rewinds.
 *
 * INTEGRATION POLICY (the merge-queue model), deterministic by device-hex order:
 *   - a member head already contained in staging → skip (nothing new);
 *   - staging is an ancestor of the head → FAST-FORWARD staging to it;
 *   - the two diverged → a bare-repo 3-way merge via `git merge-tree
 *     --write-tree` (no worktree); clean → a real merge commit (2 parents),
 *     conflict → SKIP that head and report it (the member rebases onto the new
 *     staging and re-publishes). A conflict never blocks the other members.
 *
 * TWO-SPEED (G-5b): this computes the FAST, ungated `staging` — every admitted
 * member's work integrates immediately. The GREEN-GATED release ref (a distinct,
 * test-passing tag) is a separate, slower promotion (G-6 canonical-ref rules +
 * the distributed gate, Phase 8) and is NOT computed here.
 *
 * EPOCH FENCING (G-5d): `integrateMemberHeads` is pure over the repo; the
 * authority's monotonic (epoch, seq) is stamped by the ANNOUNCEMENT layer (G-3)
 * when it signs the staging-advance, so a stale ex-authority's late advance is
 * fenced by (epoch, seq) < the current one. This module returns the new staging
 * sha for that announcement to carry.
 *
 * Pure over storage.ts's RunGit seam, so it unit-tests against a real temp bare
 * repo with member namespaces and no network.
 */

import {
  type RunGit,
  defaultRunGit,
  deviceNamespaceKey,
  readNamespaceRef,
  readNamespaceRefForDevices,
  writeNamespaceRef,
} from './storage';

/** The within-namespace ref that holds a member device's work line. */
export const WORK_REF = 'refs/heads/work';
/** The within-namespace ref the integrator publishes the computed staging at. */
export const STAGING_REF = 'refs/heads/staging';

import { requireHiveEffectAuthority, type HiveEffectAuthority } from './hive-effect-authority';
import type { SignedProtocolScope } from './signed-context';

export interface MemberHead {
  /** The member device's namespace key (hex). */
  deviceHex: string;
  /** That device's work head sha (already verified via sigrefs by the caller). */
  sha: string;
}

export interface IntegrationResult {
  /** The new staging sha (unchanged from base when nothing integrated). */
  staging: string | null;
  /** Did staging move? */
  advanced: boolean;
  /** Device hexes whose work is now contained in staging (ff or merge). */
  integrated: string[];
  /** Heads left out because a 3-way merge conflicted — the member rebases. */
  skippedConflicts: { deviceHex: string; sha: string }[];
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string, runGit: RunGit): Promise<boolean> {
  const r = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], repoPath);
  return r.code === 0;
}

/** Bare-repo 3-way merge of two commits → {tree} on success, {conflict:true} on
 *  a content conflict. Uses merge-tree --write-tree (git ≥2.38): exit 0 = clean
 *  (stdout line 1 = merged tree oid), exit 1 = conflicts, else error. */
async function mergeTree(
  repoPath: string,
  a: string,
  b: string,
  runGit: RunGit,
): Promise<{ tree: string } | { conflict: true } | { error: string }> {
  const r = await runGit(['merge-tree', '--write-tree', a, b], repoPath);
  if (r.code === 0) {
    const tree = r.stdout.split('\n')[0]?.trim();
    return tree ? { tree } : { error: 'merge-tree produced no tree' };
  }
  if (r.code === 1) return { conflict: true };
  return { error: r.stderr.trim() || `merge-tree exited ${r.code}` };
}

/** commit-tree a merge (2 parents) with a fixed integrator identity. Re-running
 *  integration is idempotent (integrated heads become staging ancestors → the
 *  skip path), so a wall-clock commit date never causes churn. */
async function commitMerge(
  repoPath: string,
  tree: string,
  parents: string[],
  message: string,
  runGit: RunGit,
): Promise<string> {
  const args = ['-c', 'user.name=hive-integrator', '-c', 'user.email=integrator@hive', 'commit-tree', tree];
  for (const p of parents) args.push('-p', p);
  args.push('-m', message);
  const r = await runGit(args, repoPath);
  if (r.code !== 0) throw new Error(`pot-git: commit-tree (merge) failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * Integrate every member head into staging for the integrator device, publishing
 * the result at `refs/namespaces/<integratorHex>/refs/heads/staging`. Returns the
 * new staging sha + which heads integrated / conflicted. Best-effort per head: a
 * merge ERROR (not a clean conflict) skips that head as a conflict rather than
 * aborting the whole pass, so one bad head can't wedge integration.
 */
export async function integrateMemberHeads(
  repoPath: string,
  integratorDevicePubkeyBase64: string,
  memberHeads: MemberHead[],
  opts: { runGit?: RunGit; scope?: SignedProtocolScope; authority?: HiveEffectAuthority | null } = {},
): Promise<IntegrationResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  const base = await readNamespaceRef(repoPath, integratorDevicePubkeyBase64, STAGING_REF, runGit);
  let staging = base;
  const integrated: string[] = [];
  const skippedConflicts: { deviceHex: string; sha: string }[] = [];

  // Deterministic order so every observer of the same head-set gets the same
  // staging lineage (device-hex is peer-stable).
  const heads = [...memberHeads].sort((a, b) => a.deviceHex.localeCompare(b.deviceHex));

  for (const mh of heads) {
    if (!mh.sha) continue;
    if (staging === null) {
      staging = mh.sha;
      integrated.push(mh.deviceHex);
      continue;
    }
    if (mh.sha === staging) continue; // identical head
    // Already contained → nothing to do.
    if (await isAncestor(repoPath, mh.sha, staging, runGit)) continue;
    // Fast-forward: staging is strictly behind this head.
    if (await isAncestor(repoPath, staging, mh.sha, runGit)) {
      staging = mh.sha;
      integrated.push(mh.deviceHex);
      continue;
    }
    // Diverged → 3-way merge in the ODB (no worktree).
    const merged = await mergeTree(repoPath, staging, mh.sha, runGit);
    if ('tree' in merged) {
      staging = await commitMerge(
        repoPath,
        merged.tree,
        [staging, mh.sha],
        `integrate ${mh.deviceHex.slice(0, 12)} @ ${mh.sha.slice(0, 8)}`,
        runGit,
      );
      integrated.push(mh.deviceHex);
    } else {
      // conflict OR merge error → leave for the member to rebase.
      skippedConflicts.push({ deviceHex: mh.deviceHex, sha: mh.sha });
    }
  }

  const advanced = staging !== base && staging !== null;
  if (advanced) {
    await requireHiveEffectAuthority(opts.authority, opts.scope ?? { hive_id: '', repo_key: '' },
      ['integrate-staging', repoPath, integratorDevicePubkeyBase64, staging!]);
    await writeNamespaceRef(
      repoPath,
      integratorDevicePubkeyBase64,
      STAGING_REF,
      staging as string,
      runGit,
      base ?? '0'.repeat(40),
    );
  }
  return { staging, advanced, integrated, skippedConflicts };
}

/** Read the integrator's currently-published staging sha (null if none). */
export function readStaging(
  repoPath: string,
  integratorDevicePubkeyBase64: string,
  runGit: RunGit = defaultRunGit,
): Promise<string | null> {
  return readNamespaceRef(repoPath, integratorDevicePubkeyBase64, STAGING_REF, runGit);
}

/** Collect member work heads from the local mirror for a set of member devices
 *  (skips devices with no work head). The caller passes the CURRENT verified
 *  member set; a device whose sigrefs did not verify must be excluded upstream. */
export async function collectMemberHeads(
  repoPath: string,
  memberDevicePubkeysBase64: string[],
  runGit: RunGit = defaultRunGit,
): Promise<MemberHead[]> {
  const out: MemberHead[] = [];
  // ONE `for-each-ref` for every member, not one `git` spawn per member —
  // see readNamespaceRefForDevices (EI-18808838427010743).
  const shas = await readNamespaceRefForDevices(repoPath, memberDevicePubkeysBase64, WORK_REF, runGit);
  for (const dev of memberDevicePubkeysBase64) {
    const sha = shas.get(dev);
    if (sha) out.push({ deviceHex: deviceNamespaceKey(dev), sha });
  }
  return out;
}
