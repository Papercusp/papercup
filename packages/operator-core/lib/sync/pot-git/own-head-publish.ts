/**
 * pot-git/own-head-publish.ts — G-2a: the FIRST link of the replication chain,
 * the Radicle `git push rad` analogue (p2p-git-live-activation-2026-07-09,
 * WI-5146). Publishes THIS device's local worktree branch head into its own
 * namespace in the (hive, repo) bare store.
 *
 * Every other wired leg is a DOWNSTREAM consumer of namespace refs — bootstrap
 * (G-8) seeds them FROM a peer, ref-announce (P-202) announces a namespace
 * that already advanced, the integrator (G-5) merges member heads, the
 * worktree-bridge (P-204) follows staging the integrator computed. Until this
 * module landed, NOTHING in production wrote a device's own commits into its
 * own namespace: a bridged/p2p-only hive produced no bare store, announced
 * nothing, and left a cold joiner with nothing to bootstrap from — the design
 * doc's G-1..G-8 list simply never specced this link (live-caught on the
 * tower↔VM rig, 2026-07-17).
 *
 * Ordering contract (the git-sync caller): runs AFTER the bootstrap leg and
 * BEFORE ref-announce. After bootstrap because a genuinely cold joiner must
 * seed peers' namespaces first — own-head-first would warm the store
 * (`listNamespaces` non-empty) and permanently skip G-8's one-shot cold-join.
 * Before ref-announce so the same tick that ingests a new head also signs +
 * announces it.
 *
 * Exposure discipline: objects are transferred REF-LESSLY first (a plain
 * `git fetch <worktree> <ref>` writes the ODB + FETCH_HEAD but creates no
 * ref, so nothing new is advertised by upload-pack), then the G-10 publish
 * guard judges the (prior, head] range, and only an allowed range gets the
 * namespace ref CAS-written. A refused head is therefore never servable to
 * peers — same layering as ref-announce's own guard, one hop earlier.
 *
 * Single-writer-per-namespace makes the CAS a belt-and-braces guard, not a
 * contention mechanism; a forced move (rebase/reset in the worktree) is a
 * legitimate own-namespace rewrite (Radicle semantics — receivers judge
 * rollback via sigrefs versioning, not this ref).
 *
 * Pure over the injected RunGit seam like its siblings; no swarm, no signing,
 * no policy — storage + guard + one ref write.
 */
import {
  type RunGit,
  NETWORK_RUN_GIT_TIMEOUT_MS,
  defaultRunGit,
  ensurePotGitRepo,
  readNamespaceRef,
  writeNamespaceRef,
} from './storage';
import { WORK_REF } from './integrator';
import {
  type IncrementalPublishResolution,
  type PublishGuardCaps,
  type PublishGuardResult,
  resolveIncrementalPublishSha,
} from './publish-guard';
import type { SecretFinding } from './secrets-guard';
import { listTempPackFiles, pruneFailedFetchTempPacks } from '../../harness/git-sync/run-git-sync';

export interface OwnHeadPublishTickInput {
  /** Hive home slug — the bare-store directory key (storage.ts G-1). */
  potHomeSlug: string;
  /** Managed-repo key within the hive (G-1b) — the git-sync caller passes the
   *  member harness slug, matching hiveGitRepoPath(potHomeSlug, slug)
   *  everywhere else in the tick chain. */
  repoKey: string;
  /** The local worktree (ProjectEntry.path) whose branch head is published. */
  worktreePath: string;
  /** Branch to publish (the git-sync routine's cfg.branch). Absent ⇒ resolved
   *  from the worktree's checked-out branch; a detached HEAD is a no-op. */
  branch?: string;
  /** This device's raw-32 Ed25519 pubkey, base64 (the namespace key). */
  devicePubkeyBase64: string;
  publishGuardCaps?: PublishGuardCaps;
  /**
   * WI-5395 follow-on (genesis-publish baseline): the sha of content ALREADY
   * EXPOSED outside this machine (e.g. the GitHub origin's branch tip), used as
   * the G-10 guard baseline ONLY on a FIRST-EVER publish (priorSha null).
   *
   * Without it, genesis judges `(null, head]` — the repo's ENTIRE history — so
   * any pre-existing repo above the flood caps (papercusp: 200k+ objects vs the
   * 50k cap) is refused forever and can never onboard onto the hive-git plane.
   * Content the GitHub remote already serves to every hive member is not NEW
   * exposure; only `(alreadyExposed, head]` is. The caller must VERIFY the
   * baseline is an ancestor of head before passing it (git-sync-action does:
   * remote-tracking ref + merge-base --is-ancestor). Ignored after genesis —
   * incremental publishes keep the strict namespace-prior baseline.
   */
  genesisBaselineSha?: string | null;
  runGit?: RunGit;
  /** WI-5591: workspace whose runtime secrets-guard path exemptions to
   *  consult (see publish-guard.ts's PublishGuardInput.workspaceId). Omitted
   *  ⇒ no runtime exemptions consulted (only static FIXTURE_FILES applies). */
  workspaceId?: string;
}

export interface OwnHeadPublishTickOutcome {
  /** False only when the input could not even be evaluated (no worktree /
   *  unborn branch / detached HEAD with no branch given) — all legit no-ops. */
  ran: boolean;
  /** True iff the namespace ref moved this tick. */
  changed: boolean;
  /** The branch actually used (input or resolved), null when unresolvable. */
  branch: string | null;
  /** The worktree head judged this tick (null when `ran` is false). */
  headSha: string | null;
  /** The namespace ref's prior sha (null on first-ever publish). */
  priorSha: string | null;
  /** Set when the G-10 guard REFUSED a commit for a HARD reason (oversized
   *  blob / secret). WI-5738: this no longer implies nothing was published —
   *  the range is drained up to the offending commit first, so check
   *  `publishedSha`/`changed` for what DID become servable. Deliberate
   *  refusal, not an error. */
  refused: PublishGuardResult | null;
  /** WI-5738: the exact commit a hard refusal stopped at (null when none).
   *  Attribution is now one commit, not "somewhere in this range". */
  blockedAtCommit?: string | null;
  /** WI-5738: true when the publish advanced but did NOT reach the worktree
   *  head — a volume cap split the range and the remainder drains on
   *  following ticks. Not an error; a healthy partial publish.
   *
   *  EI-19341709637436070: named `backlogRemains` (not `drained`) DELIBERATELY —
   *  the prior name `drained` read as "has been drained" (healthy) while this is
   *  assigned `!resolution.complete`, i.e. it means the OPPOSITE: backlog still
   *  remains. Two separate agents had to leave "read the value, never the name"
   *  warning comments at the consumers before the field itself got renamed. */
  backlogRemains?: boolean;
  /** WI-5738: a single commit that alone exceeds the volume caps and so cannot
   *  be split. It IS published (refusing it forever is the outage this
   *  replaces); named here so the health layer can raise it. */
  oversizedCommit?: string | null;
  /** WI-5738: the sha actually written to the namespace ref this tick. */
  publishedSha?: string | null;
  /** Secret findings suppressed by a runtime path exemption this tick (WI-5591)
   *  — populated whether the publish ultimately admitted or was refused for a
   *  DIFFERENT reason, so an exemption's use is always visible for audit. */
  exemptedFindings: SecretFinding[];
  errors: string[];
}

/**
 * ONE own-head publish pass: ensure the bare store, transfer the worktree
 * branch head's objects ref-lessly, guard the new range, CAS the namespace
 * branch ref. Safe to call on every git-sync tick — an unmoved head is a free
 * no-op (one rev-parse + one ref read).
 */
export async function runOwnHeadPublishTick(
  input: OwnHeadPublishTickInput,
): Promise<OwnHeadPublishTickOutcome> {
  const runGit = input.runGit ?? defaultRunGit;
  const errors: string[] = [];
  const noop = (branch: string | null): OwnHeadPublishTickOutcome => ({
    ran: false,
    changed: false,
    branch,
    headSha: null,
    priorSha: null,
    refused: null,
    exemptedFindings: [],
    errors,
  });

  // Resolve the branch: explicit config wins; otherwise the worktree's
  // checked-out branch (detached HEAD ⇒ nothing to publish under).
  let branch = input.branch ?? null;
  if (!branch) {
    const r = await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], input.worktreePath);
    branch = r.code === 0 ? r.stdout.trim() : null;
    if (!branch) return noop(null);
  }
  const branchRef = `refs/heads/${branch}`;

  // Worktree head. An unborn branch (fresh clone of an empty repo) is a no-op.
  const head = await runGit(['rev-parse', '--verify', '-q', `${branchRef}^{commit}`], input.worktreePath);
  const headSha = head.code === 0 ? head.stdout.trim() : '';
  if (!headSha) return noop(branch);

  const repoPath = await ensurePotGitRepo(input.potHomeSlug, input.repoKey, runGit);

  let priorSha: string | null;
  try {
    priorSha = await readNamespaceRef(repoPath, input.devicePubkeyBase64, branchRef, runGit);
  } catch (e) {
    errors.push(`reading own namespace ref failed: ${e instanceof Error ? e.message : e}`);
    return { ...noop(branch), ran: true, headSha };
  }
  if (priorSha === headSha) {
    return { ran: true, changed: false, branch, headSha, priorSha, refused: null, exemptedFindings: [], errors };
  }

  // WI-5163: a SHALLOW source worktree (from-repo's `shallow:true` smoke
  // default) transfers ONLY the graft-truncated history via the ref-less
  // fetch below — the bare store gets no `.git/shallow` marker of its own, so
  // checkPublishGuard's `rev-list --objects` walk hits a commit whose parent
  // was never transferred and fail-closes (correct guard behavior, but the
  // net effect is this device can NEVER publish its own head — every tick
  // refuses forever, silently). Detect + unshallow the SOURCE worktree first
  // so the objects transferred are always full, walkable history. On failure,
  // reclaim this attempt's partial packs and stop before transferring incomplete
  // history. Reuse the normal git-sync cleanup for this separate fetch path.
  const shallowCheck = await runGit(['rev-parse', '--is-shallow-repository'], input.worktreePath);
  if (shallowCheck.code === 0 && shallowCheck.stdout.trim() === 'true') {
    const remotesRes = await runGit(['remote'], input.worktreePath);
    const remoteName =
      (remotesRes.code === 0
        ? remotesRes.stdout
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean)
        : undefined) ?? 'origin';
    // Generous network timeout — a real remote (e.g. GitHub) unshallow can
    // legitimately transfer a lot of history, not a local-op-speed transfer
    // (github-bridge-ingress-timeout-too-short-2026-07-20, EI-18189246091367226).
    const beforeUnshallow = await listTempPackFiles(runGit, input.worktreePath);
    let unshallow: Awaited<ReturnType<RunGit>> | undefined;
    try {
      unshallow = await runGit(['fetch', '--quiet', '--unshallow', remoteName], input.worktreePath, {
        timeoutMs: NETWORK_RUN_GIT_TIMEOUT_MS,
      });
    } finally {
      if (unshallow?.code !== 0) {
        await pruneFailedFetchTempPacks(runGit, input.worktreePath, beforeUnshallow, (message) => errors.push(message));
      }
    }
    if (unshallow.code !== 0) {
      errors.push(
        `source worktree is shallow and could not be unshallowed (remote '${remoteName}'): ${unshallow.stderr.trim().slice(0, 500)}`,
      );
      return { ...noop(branch), ran: true, headSha, priorSha };
    }
  }

  // Ref-less object transfer: ODB + FETCH_HEAD only — no ref is created, so
  // upload-pack advertises nothing new until the guard below allows the write.
  const beforeTransfer = await listTempPackFiles(runGit, repoPath);
  let fetch: Awaited<ReturnType<RunGit>> | undefined;
  try {
    fetch = await runGit(['fetch', '--quiet', input.worktreePath, branchRef], repoPath);
  } finally {
    if (fetch?.code !== 0) {
      await pruneFailedFetchTempPacks(runGit, repoPath, beforeTransfer, (message) => errors.push(message));
    }
  }
  if (fetch.code !== 0) {
    errors.push(`object transfer from worktree failed: ${fetch.stderr.trim().slice(0, 500)}`);
    return { ran: true, changed: false, branch, headSha, priorSha, refused: null, exemptedFindings: [], errors };
  }

  // G-10: judge the (prior, head] range BEFORE the ref makes it servable. On a
  // rewound/rebased head this judges the new-side commits, same as announce.
  // Genesis (priorSha null): use the caller-verified already-exposed baseline
  // when given, so onboarding a pre-existing GitHub-backed repo judges only the
  // genuinely unexposed delta instead of refusing the whole history (see
  // genesisBaselineSha).
  const guardBaseline = priorSha ?? input.genesisBaselineSha ?? null;
  // WI-5738: resolve the furthest PUBLISHABLE sha instead of taking an
  // all-or-nothing verdict on the whole range. A volume refusal
  // (total-over-cap / object-flood) used to be TERMINAL here: the baseline
  // below advances ONLY via writeNamespaceRef, which runs ONLY after guard.ok
  // — so the baseline could only move through the publish it was blocking,
  // while every new commit enlarged the refused range (2261MB → 2415MB over
  // five days of total p2p outage, 2026-07-20). Now the range drains
  // incrementally, and a HARD refusal (oversized blob / secret) stops at the
  // exact offending commit with everything before it published.
  let resolution: IncrementalPublishResolution;
  try {
    resolution = await resolveIncrementalPublishSha({
      repoPath,
      fromOid: guardBaseline,
      toOid: headSha,
      caps: input.publishGuardCaps,
      runGit,
      workspaceId: input.workspaceId,
    });
  } catch (e) {
    errors.push(`publish guard threw (refusing, fail-closed): ${e instanceof Error ? e.message : e}`);
    return { ran: true, changed: false, branch, headSha, priorSha, refused: null, exemptedFindings: [], errors };
  }
  errors.push(...resolution.errors);
  const guard = resolution.blocked?.result ?? null;
  const exemptedFindings = guard?.exemptedFindings ?? [];
  const publishSha = resolution.safeSha;
  const base = {
    ran: true as const,
    branch,
    headSha,
    priorSha,
    blockedAtCommit: resolution.blocked?.commit ?? null,
    oversizedCommit: resolution.oversizedCommit,
    exemptedFindings,
    errors,
  };
  // No forward progress at all — a hard refusal, reported exactly as before.
  if (!publishSha || publishSha === priorSha) {
    return { ...base, changed: false, backlogRemains: false, publishedSha: null, refused: guard };
  }

  try {
    await writeNamespaceRef(
      repoPath,
      input.devicePubkeyBase64,
      branchRef,
      publishSha,
      runGit,
      priorSha ?? undefined,
    );
  } catch (e) {
    errors.push(`namespace ref CAS write failed: ${e instanceof Error ? e.message : e}`);
    return { ...base, changed: false, backlogRemains: false, publishedSha: null, refused: null };
  }

  // The integrator gates member heads at the canonical WORK_REF, not the
  // branch-named ref — publish the alias too, over the same guarded range.
  // Best-effort: the branch ref is already servable, and the integrator's
  // default-branch fallback covers an alias miss.
  if (branchRef !== WORK_REF) {
    try {
      const workPrior = await readNamespaceRef(repoPath, input.devicePubkeyBase64, WORK_REF, runGit);
      // WI-5738: the alias tracks what was ACTUALLY published (publishSha),
      // never the unjudged head — on a partial drain those differ.
      if (workPrior !== publishSha) {
        await writeNamespaceRef(
          repoPath,
          input.devicePubkeyBase64,
          WORK_REF,
          publishSha,
          runGit,
          workPrior ?? undefined,
        );
      }
    } catch (e) {
      errors.push(`WORK_REF alias write failed (branch ref published): ${e instanceof Error ? e.message : e}`);
    }
  }
  return {
    ...base,
    changed: true,
    backlogRemains: !resolution.complete,
    publishedSha: publishSha,
    refused: guard,
  };
}
