/**
 * hive-git/github-egress.ts — the EGRESS half of the GitHub bridge
 * (github-bridge-hive-egress-2026-07-02 P-001; design S-1/S-2/S-4, D-001/D-002).
 *
 * Publishes the hive's COMPUTED CANONICAL refs (the integrator's staging, the
 * green-gated release ref, release tags) from the hive-git bare store OUT to the
 * GitHub remote — the D-009 "GitHub is the release channel, not the transport"
 * boundary made concrete. Device namespaces NEVER egress (S-2: noise + privacy);
 * only the refs the integrator/release layers computed.
 *
 * INVARIANTS (same class as G-5d/G-7c):
 *   - FF-ONLY, NEVER FORCE (S-4). Every push is un-forced, so the remote itself
 *     rejects a non-fast-forward — GitHub's atomic old-sha check is the CAS.
 *     Before pushing we ALSO verify locally that the remote's current head is an
 *     ancestor of what we publish, so a diverged origin (a human push, a legacy
 *     member's git-sync merge) is REPORTED as `rejectedNonFF` — the P-006
 *     divergence policy (ingress-merge via the integrator; escalation) owns what
 *     happens next. This module never overwrites GitHub-side history, full stop.
 *   - SINGLE WRITER (S-1/D-002): the CALLER gates on the integrator
 *     lock-authority lease — only the lease holder egresses. This module is pure
 *     mechanism and does not consult the lease (it has no PG/authority dep), by
 *     the same layering as integrator.ts.
 *   - SECRETS GATE: the DELTA being published (changed files between the remote's
 *     current head and the egress target) runs through secrets-guard
 *     (`scanTextForSecrets`) before any bytes leave. Findings BLOCK that ref —
 *     fail-closed, like release-promotion's posture: an outward publish must
 *     never leak a credential. (This is the first live wiring of secrets-guard —
 *     it was built for exactly this boundary.)
 *   - TAGS are create-only (an existing remote tag never moves — un-forced tag
 *     pushes to an existing tag are rejected by the remote, reported per-tag).
 *
 * WHERE THE PUSH TARGET COMES FROM: the caller resolves it with the EXISTING
 * `resolveForkPushTarget` seam (harness/git-sync/fork-remote.ts — D-007b: a
 * configured fork ALWAYS wins; upstream only with write; else none) and passes
 * the resolved remote URL in. This module takes a URL, not a policy — legacy
 * contribution semantics stay in the one module that already owns them.
 *
 * Fail-soft: never throws; every failure folds into the per-ref result. Pure
 * over storage.ts's RunGit seam — integration tests run against local bare
 * "origin" repos, no network.
 */

import { type RunGit, defaultRunGit } from './storage';
import { type SecretFinding, scanTextForSecrets } from './secrets-guard';

/** Upper bound on delta files scanned for secrets per egressed ref. Exceeding
 *  it BLOCKS the ref (`secret_scan_overflow`) rather than silently skipping the
 *  tail — fail-closed; callers with a legitimately huge first publish raise it. */
export const DEFAULT_MAX_SCAN_FILES = 5_000;

/** Blobs larger than this are skipped by the secret scan (binary/asset noise;
 *  entropy scans on megabytes are slow) — counted, never silently dropped. */
export const MAX_SCAN_BLOB_BYTES = 1_048_576;

/** One canonical ref to publish: a local sha → a fully-qualified remote ref. */
export interface EgressRef {
  /** The local sha to publish (e.g. the integrator's staging head). */
  sha: string;
  /** Fully-qualified destination, e.g. `refs/heads/staging`. */
  remoteRef: string;
}

/** One release tag to publish (create-only). */
export interface EgressTag {
  /** Tag name WITHOUT the refs/tags/ prefix, e.g. `release-2026-07-02`. */
  name: string;
  /** The sha the tag points at. */
  sha: string;
}

export interface EgressInput {
  /** The hive-git bare repo (storage.ts hiveGitRepoPath). */
  repoPath: string;
  /**
   * The push destination URL — resolved by the CALLER via resolveForkPushTarget
   * (fork wins / upstream-with-write / none). A local path works (tests).
   */
  remoteUrl: string;
  /** Canonical refs to publish. */
  refs: EgressRef[];
  /** Release tags to publish (create-only). */
  tags?: EgressTag[];
  runGit?: RunGit;
  /** Secret-scan the published delta (default true — S-2). */
  scanSecrets?: boolean;
  /** Cap on delta files scanned per ref (default DEFAULT_MAX_SCAN_FILES). */
  maxScanFiles?: number;
}

export interface EgressPushed {
  remoteRef: string;
  /** The remote's sha before our push (null = the ref did not exist). */
  from: string | null;
  to: string;
}

export interface EgressNonFF {
  remoteRef: string;
  /** What the remote currently holds (null = unknown / unfetchable). */
  remoteSha: string | null;
  localSha: string;
  reason: string;
}

export interface EgressSecretBlock {
  remoteRef: string;
  findings: SecretFinding[];
  /** True when the delta exceeded maxScanFiles — blocked as overflow, not leak. */
  overflow: boolean;
  /** Oversized blobs skipped by the scan (informational). */
  skippedLargeBlobs: number;
}

export interface EgressResult {
  ok: boolean;
  pushed: EgressPushed[];
  /** Remote already at the target sha. */
  upToDate: string[];
  /** Diverged origin — NEVER forced; P-006 divergence policy owns the follow-up. */
  rejectedNonFF: EgressNonFF[];
  /** Refs blocked by the secrets gate — nothing left the machine for these. */
  blockedSecrets: EgressSecretBlock[];
  tagsPushed: string[];
  tagsRejected: { name: string; reason: string }[];
  errors: string[];
}

/** `git ls-remote <url> <ref>` → sha, or null when the ref doesn't exist there.
 *  A transport failure returns { error } so callers can distinguish "absent"
 *  from "unreachable" (pushing at an unreachable remote is pointless noise). */
async function lsRemote(
  repoPath: string,
  remoteUrl: string,
  ref: string,
  runGit: RunGit,
): Promise<{ sha: string | null } | { error: string }> {
  const r = await runGit(['ls-remote', remoteUrl, ref], repoPath);
  if (r.code !== 0) return { error: r.stderr.trim() || `ls-remote exited ${r.code}` };
  const line = r.stdout.split('\n').find((l) => l.trim());
  if (!line) return { sha: null };
  const sha = line.trim().split(/\s+/)[0];
  return { sha: sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null };
}

async function haveObject(repoPath: string, sha: string, runGit: RunGit): Promise<boolean> {
  const r = await runGit(['cat-file', '-e', `${sha}^{commit}`], repoPath);
  return r.code === 0;
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string, runGit: RunGit): Promise<boolean> {
  const r = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], repoPath);
  return r.code === 0;
}

/**
 * Every blob INTRODUCED by the pushed range (base..target; base=null → all of
 * target's history) as { path, content } for the secrets scan.
 *
 * Why per-commit and not endpoint-diff: a push publishes HISTORY — a secret
 * committed then deleted inside the range rides out in the pack even though an
 * endpoint diff never shows it. So we walk `rev-list base..target` and collect
 * each commit's introduced blobs (diff-tree vs its parents), deduped by blob
 * sha. Blobs already reachable from `base` are excluded by rev-list itself.
 *
 * Bounds: unique blobs beyond `maxFiles` → overflow (the caller fails CLOSED);
 * blobs over MAX_SCAN_BLOB_BYTES or containing NUL (binary) are skipped and
 * counted, not scanned.
 */
async function collectScanFiles(
  repoPath: string,
  base: string | null,
  target: string,
  maxFiles: number,
  runGit: RunGit,
): Promise<{ files: { path: string; content: string }[]; overflow: boolean; skippedLarge: number } | { error: string }> {
  const range = base ? [`${base}..${target}`] : [target];
  const revs = await runGit(['rev-list', ...range], repoPath);
  if (revs.code !== 0) return { error: revs.stderr.trim() || `rev-list exited ${revs.code}` };
  const commits = revs.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  // blob sha → a path it appears at (for the finding report).
  const blobs = new Map<string, string>();
  let overflow = false;
  outer: for (const c of commits) {
    // -m: diff merges against EACH parent (a merge can introduce blobs too);
    // --root: a parentless commit diffs against the empty tree.
    const raw = await runGit(['diff-tree', '-r', '-m', '--root', '--no-commit-id', c], repoPath);
    if (raw.code !== 0) return { error: raw.stderr.trim() || `diff-tree ${c} exited ${raw.code}` };
    for (const line of raw.stdout.split('\n')) {
      const m = line.match(/^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) ([A-Z])\d*\t(.+?)(?:\t.*)?$/);
      if (!m) continue;
      const [, dstSha, status, path] = m;
      if (status === 'D' || /^0+$/.test(dstSha)) continue; // deletion — no new blob
      if (blobs.has(dstSha)) continue;
      if (blobs.size >= maxFiles) {
        overflow = true;
        break outer;
      }
      blobs.set(dstSha, path);
    }
  }

  let skippedLarge = 0;
  const files: { path: string; content: string }[] = [];
  for (const [sha, path] of blobs) {
    const size = await runGit(['cat-file', '-s', sha], repoPath);
    if (size.code !== 0) continue; // a submodule gitlink / non-blob entry
    if (Number(size.stdout.trim()) > MAX_SCAN_BLOB_BYTES) {
      skippedLarge += 1;
      continue;
    }
    const show = await runGit(['cat-file', '-p', sha], repoPath);
    if (show.code !== 0) continue;
    if (show.stdout.includes('\0')) continue; // binary — no line-oriented secrets
    files.push({ path, content: show.stdout });
  }
  return { files, overflow, skippedLarge };
}

/**
 * Publish canonical refs (+ release tags) to the GitHub remote. FF-only, never
 * forced, secrets-gated. Per-ref best-effort: one blocked/rejected ref never
 * stops the others. `ok` = no transport errors (rejections/blocks are POLICY
 * outcomes, reported in their own buckets, and do not clear `ok`).
 */
export async function egressCanonicalRefs(input: EgressInput): Promise<EgressResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const scan = input.scanSecrets !== false;
  const maxScanFiles = input.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
  const res: EgressResult = {
    ok: true,
    pushed: [],
    upToDate: [],
    rejectedNonFF: [],
    blockedSecrets: [],
    tagsPushed: [],
    tagsRejected: [],
    errors: [],
  };

  for (const spec of input.refs) {
    // 1. Where is the remote now?
    const remote = await lsRemote(input.repoPath, input.remoteUrl, spec.remoteRef, runGit);
    if ('error' in remote) {
      res.ok = false;
      res.errors.push(`ls-remote ${spec.remoteRef}: ${remote.error}`);
      continue;
    }
    const remoteSha = remote.sha;
    if (remoteSha === spec.sha) {
      res.upToDate.push(spec.remoteRef);
      continue;
    }

    // 2. FF check against the remote's current head. If we don't hold the
    //    remote's objects (a GitHub-side commit we never ingressed), fetch just
    //    that head into a private landing ref (ours to clobber, like the
    //    bootstrap quarantine) so ancestry + delta-scan can run.
    if (remoteSha !== null) {
      if (!(await haveObject(input.repoPath, remoteSha, runGit))) {
        const f = await runGit(
          ['fetch', input.remoteUrl, `+${remoteSha}:refs/egress-remote/head`],
          input.repoPath,
        );
        if (f.code !== 0 || !(await haveObject(input.repoPath, remoteSha, runGit))) {
          // Can't establish ancestry → fail CLOSED as a non-FF (never push blind).
          res.rejectedNonFF.push({
            remoteRef: spec.remoteRef,
            remoteSha,
            localSha: spec.sha,
            reason: 'remote head unfetchable — ancestry unverifiable, refusing blind push',
          });
          continue;
        }
      }
      if (!(await isAncestor(input.repoPath, remoteSha, spec.sha, runGit))) {
        res.rejectedNonFF.push({
          remoteRef: spec.remoteRef,
          remoteSha,
          localSha: spec.sha,
          reason: 'origin diverged from canonical — ingress-merge via the integrator (S-4), never force',
        });
        continue;
      }
    }

    // 3. Secrets gate over the published delta (fail-closed).
    if (scan) {
      const collected = await collectScanFiles(input.repoPath, remoteSha, spec.sha, maxScanFiles, runGit);
      if ('error' in collected) {
        res.ok = false;
        res.errors.push(`secret-scan collect ${spec.remoteRef}: ${collected.error}`);
        continue;
      }
      const findings = collected.files.flatMap((f) => scanTextForSecrets(f.path, f.content));
      if (findings.length > 0 || collected.overflow) {
        res.blockedSecrets.push({
          remoteRef: spec.remoteRef,
          findings,
          overflow: collected.overflow,
          skippedLargeBlobs: collected.skippedLarge,
        });
        continue;
      }
    }

    // 4. The push — UN-FORCED, so the remote's own atomic old-sha check is the
    //    CAS: a race (someone pushed between our ls-remote and now) rejects
    //    non-FF and lands in rejectedNonFF for the next tick to reconcile.
    const push = await runGit(['push', input.remoteUrl, `${spec.sha}:${spec.remoteRef}`], input.repoPath);
    if (push.code === 0) {
      res.pushed.push({ remoteRef: spec.remoteRef, from: remoteSha, to: spec.sha });
    } else if (/non-fast-forward|fetch first|failed to push some refs/i.test(push.stderr)) {
      res.rejectedNonFF.push({
        remoteRef: spec.remoteRef,
        remoteSha: null,
        localSha: spec.sha,
        reason: `push rejected: ${push.stderr.trim().split('\n')[0] ?? 'non-fast-forward'}`,
      });
    } else {
      res.ok = false;
      res.errors.push(`push ${spec.remoteRef}: ${push.stderr.trim() || `exited ${push.code}`}`);
    }
  }

  // 5. Release tags — create-only. An un-forced push to an EXISTING tag is
  //    rejected by the remote; we pre-check to report it as policy, not error.
  for (const tag of input.tags ?? []) {
    const tagRef = `refs/tags/${tag.name}`;
    const remote = await lsRemote(input.repoPath, input.remoteUrl, tagRef, runGit);
    if ('error' in remote) {
      res.ok = false;
      res.errors.push(`ls-remote ${tagRef}: ${remote.error}`);
      continue;
    }
    if (remote.sha === tag.sha) {
      res.upToDate.push(tagRef);
      continue;
    }
    if (remote.sha !== null) {
      res.tagsRejected.push({ name: tag.name, reason: 'tag exists on remote with a different sha — tags never move' });
      continue;
    }
    const push = await runGit(['push', input.remoteUrl, `${tag.sha}:${tagRef}`], input.repoPath);
    if (push.code === 0) res.tagsPushed.push(tag.name);
    else res.tagsRejected.push({ name: tag.name, reason: push.stderr.trim().split('\n')[0] ?? `exited ${push.code}` });
  }

  return res;
}
