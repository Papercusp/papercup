/**
 * github-bridge-tick — ONE bridge pass for a bridged hive's managed repo
 * (github-bridge-hive-egress-2026-07-02 P-008, composing P-001/P-002/P-005/P-006).
 *
 * Rides the `system:git-sync` tick (D-003: no new scheduler): git-sync-action
 * calls this as a checkpointed step when the member's hive `hiveGit.mode` is
 * `bridged` AND FLAGS.GITHUB_BRIDGE is on. The pass:
 *
 *   1. INGRESS (P-002): fetch origin branch(es) into the synthetic
 *      github-origin namespace — FF-only; a rewrite surfaces as `nonFF`.
 *   2. ADMISSION (P-005): judge each newly-ingressed head against contribution
 *      revocation; the `lastAdmitted` watermark advances ONLY on admitted heads
 *      (persisted by the caller — git-sync-action keeps it in routine metadata).
 *   3. EGRESS (P-001): publish the hive canonical staging ref FF-only+CAS to
 *      the remote resolveForkPushTarget picks (fork wins — D-007b; no fork +
 *      no upstream write ⇒ egress skipped, commit-only semantics preserved).
 *   4. DIVERGENCE (P-006): fold the residues into the `github-bridge`
 *      escalation row — reported, never applied; origin is NEVER force-pushed.
 *
 * Push races between two members that both think they hold the bridge are SAFE
 * by construction (egress is FF-only + CAS: one wins, the other reports
 * rejectedNonFF/upToDate) — the integrator-lease affinity (D-002) is an
 * optimization seam (`isBridgeWriter`), not a correctness requirement.
 *
 * Every mechanism is an injectable seam; the default wiring is the real one.
 * Never throws — the tick reports, the routine records.
 */
import { hiveGitRepoPath, defaultRunGit, type RunGit } from './storage';
import { ingressOriginBranches, type IngressResult, type IngressInput } from './github-ingress';
import { admitGithubOriginHead, type AdmissionResult, type AdmissionInput } from './github-ingress-admission';
import { egressCanonicalRefs, type EgressResult, type EgressInput } from './github-egress';
import { collectDivergenceSignals, classifyDivergence, recordDivergenceVerdict, type DivergenceVerdict } from './github-divergence';
import { resolveForkPushTarget, type ForkPushTarget } from '../../harness/git-sync/fork-remote';

/** The canonical staging mirror the worktree bridge maintains in the bare repo. */
export const BRIDGE_CANONICAL_REF = 'refs/hive/staging';
/** Where the canonical staging egresses to on the GitHub remote. */
export const BRIDGE_REMOTE_STAGING_REF = 'refs/heads/staging';

export interface BridgeTickInput {
  potHomeSlug: string;
  workspaceId: string;
  /** The member repo key under the hive-git root (usually the member slug). */
  repoKey: string;
  /** Registry coords: the upstream GitHub remote (read + candidate push). */
  githubRemote?: string;
  /** Registry `fork_remote` — when set, egress pushes the fork, never upstream. */
  forkRemote?: string;
  /** Branches to ingress (WITHOUT refs/heads/); e.g. ['main']. */
  branches: string[];
  /** GitHub `permissions.push` on the upstream (null/undefined = unknown). */
  upstreamWrite?: boolean | null;
  /** The last ADMITTED github-origin head (caller-persisted watermark). */
  lastAdmitted: string | null;
  deps?: {
    runGit?: RunGit;
    repoPath?: string;
    ingress?: (i: IngressInput) => Promise<IngressResult>;
    admit?: (i: AdmissionInput) => Promise<AdmissionResult>;
    egress?: (i: EgressInput) => Promise<EgressResult>;
    record?: (hive: string, ws: string, v: DivergenceVerdict) => Promise<void>;
    /** D-002 affinity seam: only the bridge writer egresses (default: true —
     *  FF-only+CAS makes a stray second writer safe, just noisy). */
    isBridgeWriter?: () => Promise<boolean>;
  };
}

export interface BridgeTickOutcome {
  ran: boolean;
  /** Why the pass (or a leg) was skipped. */
  skipped?: 'no_github_remote' | 'not_bridge_writer';
  egressTarget: ForkPushTarget['target'] | 'skipped';
  ingressed: { updated: number; upToDate: number; nonFF: number; absent: number };
  admissions: Array<{ head: string; admit: boolean; basis: AdmissionResult['basis'] }>;
  /** The advanced watermark — caller persists it. Unchanged when nothing admitted. */
  lastAdmitted: string | null;
  egress: { pushed: number; upToDate: number; rejectedNonFF: number; blockedSecrets: number } | null;
  verdict: DivergenceVerdict;
  errors: string[];
}

/** Resolve the bare repo's canonical staging sha (null = not established yet). */
async function readCanonicalSha(repoPath: string, runGit: RunGit): Promise<string | null> {
  const r = await runGit(['rev-parse', '--verify', '--quiet', BRIDGE_CANONICAL_REF], repoPath);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export async function runGithubBridgeTick(input: BridgeTickInput): Promise<BridgeTickOutcome> {
  const errors: string[] = [];
  const runGit = input.deps?.runGit ?? defaultRunGit;
  const repoPath = input.deps?.repoPath ?? hiveGitRepoPath(input.potHomeSlug, input.repoKey);
  const record = input.deps?.record ?? ((h, w, v) => recordDivergenceVerdict(h, w, v));

  const empty: BridgeTickOutcome = {
    ran: false,
    egressTarget: 'skipped',
    ingressed: { updated: 0, upToDate: 0, nonFF: 0, absent: 0 },
    admissions: [],
    lastAdmitted: input.lastAdmitted,
    egress: null,
    verdict: classifyDivergence([]),
    errors,
  };

  // No GitHub remote at all → nothing to bridge (a p2p-only-shaped repo).
  if (!input.githubRemote) return { ...empty, skipped: 'no_github_remote' };

  if (input.deps?.isBridgeWriter) {
    try {
      if (!(await input.deps.isBridgeWriter())) return { ...empty, skipped: 'not_bridge_writer' };
    } catch (e) {
      errors.push(`isBridgeWriter seam failed (proceeding — FF-only egress is race-safe): ${e instanceof Error ? e.message : e}`);
    }
  }

  // 1. INGRESS — always from the UPSTREAM remote (the fork is a push target,
  //    never the read source: legacy humans/PR merges land upstream).
  const ingress = await (input.deps?.ingress ?? ingressOriginBranches)({
    repoPath,
    remoteUrl: input.githubRemote,
    branches: input.branches,
    runGit,
  });
  errors.push(...ingress.errors.map((e) => `ingress${e.branch ? ` ${e.branch}` : ''}: ${e.message}`));

  // 2. ADMISSION — judge each moved head; advance the watermark only on admits.
  const admissions: BridgeTickOutcome['admissions'] = [];
  const admissionResults: Array<{ head: string; result: AdmissionResult }> = [];
  let lastAdmitted = input.lastAdmitted;
  for (const u of ingress.updated) {
    const result = await (input.deps?.admit ?? admitGithubOriginHead)({
      repoPath,
      lastAdmitted,
      head: u.to,
      workspaceId: input.workspaceId,
      potHomeSlug: input.potHomeSlug,
      runGit,
    });
    admissionResults.push({ head: u.to, result });
    admissions.push({ head: u.to, admit: result.admit, basis: result.basis });
    if (result.admit) lastAdmitted = u.to;
    errors.push(...result.errors.map((e) => `admission ${u.to.slice(0, 12)}: ${e}`));
  }

  // 3. EGRESS — canonical staging, FF-only + CAS, to the D-007b-resolved target.
  const target = resolveForkPushTarget({
    forkRemote: input.forkRemote,
    upstreamRemote: input.githubRemote,
    upstreamWrite: input.upstreamWrite,
  });
  let egress: EgressResult | null = null;
  if (target.target !== 'none') {
    const canonicalSha = await readCanonicalSha(repoPath, runGit);
    if (canonicalSha) {
      egress = await (input.deps?.egress ?? egressCanonicalRefs)({
        repoPath,
        remoteUrl: target.remote,
        refs: [{ sha: canonicalSha, remoteRef: BRIDGE_REMOTE_STAGING_REF }],
        runGit,
      });
      errors.push(...egress.errors.map((e) => `egress: ${e}`));
    }
  }

  // 4. DIVERGENCE — fold residues, write/clear the escalation (best-effort).
  const verdict = classifyDivergence(
    collectDivergenceSignals({ egress, ingress, admissions: admissionResults }),
  );
  await record(input.potHomeSlug, input.workspaceId, verdict);

  return {
    ran: true,
    egressTarget: target.target === 'none' ? 'skipped' : target.target,
    ingressed: {
      updated: ingress.updated.length,
      upToDate: ingress.upToDate.length,
      nonFF: ingress.nonFF.length,
      absent: ingress.absent.length,
    },
    admissions,
    lastAdmitted,
    egress: egress
      ? {
          pushed: egress.pushed.length,
          upToDate: egress.upToDate.length,
          rejectedNonFF: egress.rejectedNonFF.length,
          blockedSecrets: egress.blockedSecrets.length,
        }
      : null,
    verdict,
    errors,
  };
}
