/**
 * hive-git/github-ingress.ts — the INGRESS half of the GitHub bridge
 * (github-bridge-hive-egress-2026-07-02 P-002; design S-3/S-4, D-001).
 *
 * GITHUB-AS-A-MEMBER (S-3): fetches the GitHub origin branch(es) into a
 * dedicated SYNTHETIC device namespace — a "github-origin" device — so
 * GitHub-side commits (a human merging a PR, a legacy member's git-sync push,
 * an external contributor landing on the default branch) become ONE MORE
 * single-writer input the integrator merges. Origin divergence is thereby
 * "not merged yet" (visible, mergeable), never split-brain.
 *
 * THE SYNTHETIC DEVICE KEY: namespaces are keyed by hex-of-raw-32-pubkey
 * (storage.ts deviceNamespaceKey). The github-origin "device" has no keypair —
 * its 32 bytes are a domain-separated SHA-256 of the NORMALIZED remote identity
 * (`github.com/<owner>/<repo>`, lowercased, .git-stripped), so:
 *   - every peer derives the SAME namespace for the same origin (stores
 *     converge with no coordination);
 *   - it is 64-hex and flows through every existing namespace helper
 *     (listNamespaces, gc, bootstrap) unchanged;
 *   - it cannot collide with a real device (that would require inverting
 *     SHA-256 into an Ed25519 keypair).
 * There are NO SIGREFS for this namespace — GitHub can't sign. The bridge layer
 * feeds this head to the integrator EXPLICITLY, gated by the P-005 ingress
 * admission (author→hive identity, contribution-admission revocation), never
 * via the sigrefs-verified member reconcile.
 *
 * REWIND SAFETY (the G-4b/G-8 posture): the fetch lands in a PRIVATE quarantine
 * ref (`refs/ingress-quarantine/…`, ours to clobber — bootstrap.ts idiom), and
 * the namespace head only ADVANCES fast-forward, CAS-guarded (writeNamespaceRef
 * expectedOld) so a concurrent local writer can't be clobbered. A NON-FF origin
 * move (force-push / history rewrite on GitHub) does NOT move the namespace —
 * it is REPORTED in `nonFF` for the P-006 divergence policy to act on (S-4:
 * visible, not destructive). `allowNonFF: true` (owner-authorized, P-006's
 * lever) accepts the rewrite explicitly.
 *
 * Fail-soft: never throws; per-branch best-effort — one broken branch never
 * stops the others. Pure over storage.ts's RunGit seam — integration tests run
 * against local bare "origin" repos, no network.
 */

import { createHash } from 'node:crypto';
import {
  type RunGit,
  defaultRunGit,
  deviceNamespaceKey,
  readNamespaceRef,
  writeNamespaceRef,
} from './storage';

/** Domain-separation tag for the synthetic device derivation (hive-git idiom). */
export const GITHUB_ORIGIN_DEVICE_DOMAIN = 'papercusp-hive-git-github-origin-v1';

/** The private landing area for ingress fetches — never read by anything else,
 *  always safe to clobber (the bootstrap-quarantine posture). */
export const INGRESS_QUARANTINE_PREFIX = 'refs/ingress-quarantine';

/** update-ref's "the ref must NOT exist" old-value (create-only CAS). */
const ZERO_SHA = '0'.repeat(40);

/**
 * Normalize a GitHub remote to its stable identity: `github.com/<owner>/<repo>`
 * (lowercased, `.git` stripped) for https/ssh/scp-style URLs. A non-GitHub or
 * unparseable remote falls back to the trimmed URL itself — still deterministic,
 * just not cross-form-canonical (a file-path test remote lands here).
 */
export function normalizeGithubRemote(remoteUrl: string): string {
  const u = remoteUrl.trim();
  const m =
    /^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return `github.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
  return u;
}

/**
 * The synthetic "github-origin" device pubkey (raw-32 base64) for a remote —
 * a domain-separated SHA-256 of the normalized remote identity. Feed it to any
 * storage.ts helper exactly like a real device pubkey.
 */
export function githubOriginDevicePubkey(remoteUrl: string): string {
  return createHash('sha256')
    .update(`${GITHUB_ORIGIN_DEVICE_DOMAIN}:${normalizeGithubRemote(remoteUrl)}`)
    .digest('base64');
}

/** The synthetic device's namespace key (64-hex) for a remote. */
export function githubOriginNamespaceKey(remoteUrl: string): string {
  return deviceNamespaceKey(githubOriginDevicePubkey(remoteUrl));
}

export interface IngressInput {
  /** The hive-git bare repo (storage.ts hiveGitRepoPath). */
  repoPath: string;
  /** The GitHub remote to ingress from (a local path works — tests). */
  remoteUrl: string;
  /** Branch names to ingress (WITHOUT refs/heads/), e.g. ['main']. */
  branches: string[];
  runGit?: RunGit;
  /**
   * Accept a NON-FF origin move (history rewrite) — default false. This is the
   * P-006 divergence-policy lever, owner-authorized; the default posture only
   * ever fast-forwards the synthetic namespace.
   */
  allowNonFF?: boolean;
}

export interface IngressUpdated {
  branch: string;
  /** The synthetic namespace head before (null = first ingress of this branch). */
  from: string | null;
  to: string;
  /** True when this update accepted a non-FF rewrite (allowNonFF only). */
  forced: boolean;
}

export interface IngressNonFF {
  branch: string;
  /** Where the synthetic namespace currently points. */
  local: string;
  /** Where origin now points (not an ancestor-descendant of local). */
  remote: string;
}

export interface IngressResult {
  ok: boolean;
  /** The synthetic device's namespace key (hex) — what the integrator keys on. */
  namespaceKey: string;
  updated: IngressUpdated[];
  upToDate: string[];
  /** Origin rewrote history — namespace NOT moved (unless allowNonFF). P-006 owns follow-up. */
  nonFF: IngressNonFF[];
  /** Branches absent on the remote (deleted / never existed). */
  absent: string[];
  errors: { branch?: string; message: string }[];
}

/**
 * Ingress origin branches into the synthetic github-origin namespace.
 * FF-only + CAS by default; per-branch best-effort; never throws.
 */
export async function ingressOriginBranches(input: IngressInput): Promise<IngressResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const devPubkey = githubOriginDevicePubkey(input.remoteUrl);
  const nsKey = deviceNamespaceKey(devPubkey);
  const res: IngressResult = {
    ok: true,
    namespaceKey: nsKey,
    updated: [],
    upToDate: [],
    nonFF: [],
    absent: [],
    errors: [],
  };

  for (const branch of input.branches) {
    if (!branch || branch.includes('..') || branch.startsWith('/') || branch.includes('\0')) {
      res.errors.push({ branch, message: 'unsafe branch name' });
      continue;
    }
    const quarantineRef = `${INGRESS_QUARANTINE_PREFIX}/${nsKey}/${branch}`;

    // 1. Fetch origin's head into the quarantine (forced — ours to clobber).
    //    A missing remote branch is "absent", not an error.
    const fetch = await runGit(
      ['fetch', input.remoteUrl, `+refs/heads/${branch}:${quarantineRef}`],
      input.repoPath,
    );
    if (fetch.code !== 0) {
      if (/couldn't find remote ref|no such ref/i.test(fetch.stderr)) {
        res.absent.push(branch);
      } else {
        res.ok = false;
        res.errors.push({ branch, message: fetch.stderr.trim() || `fetch exited ${fetch.code}` });
      }
      continue;
    }
    const rev = await runGit(['rev-parse', '--verify', '-q', `${quarantineRef}^{commit}`], input.repoPath);
    const remoteSha = rev.stdout.trim();
    if (rev.code !== 0 || !remoteSha) {
      res.ok = false;
      res.errors.push({ branch, message: 'fetched quarantine ref unreadable' });
      continue;
    }

    // 2. Compare with the synthetic namespace's current head.
    const ref = `refs/heads/${branch}`;
    const current = await readNamespaceRef(input.repoPath, devPubkey, ref, runGit);
    if (current === remoteSha) {
      res.upToDate.push(branch);
      continue;
    }

    try {
      if (current === null) {
        // First ingress — create-only CAS (must not exist).
        await writeNamespaceRef(input.repoPath, devPubkey, ref, remoteSha, runGit, ZERO_SHA);
        res.updated.push({ branch, from: null, to: remoteSha, forced: false });
        continue;
      }
      const ff = await runGit(['merge-base', '--is-ancestor', current, remoteSha], input.repoPath);
      if (ff.code === 0) {
        // Fast-forward — CAS on the head we just read.
        await writeNamespaceRef(input.repoPath, devPubkey, ref, remoteSha, runGit, current);
        res.updated.push({ branch, from: current, to: remoteSha, forced: false });
      } else if (input.allowNonFF) {
        // Owner-authorized rewrite acceptance (P-006's lever) — still CAS-guarded.
        await writeNamespaceRef(input.repoPath, devPubkey, ref, remoteSha, runGit, current);
        res.updated.push({ branch, from: current, to: remoteSha, forced: true });
      } else {
        res.nonFF.push({ branch, local: current, remote: remoteSha });
      }
    } catch (e) {
      // A lost CAS (concurrent local writer) or update-ref failure — report,
      // never wedge the other branches; the next tick reconciles.
      res.ok = false;
      res.errors.push({ branch, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return res;
}
