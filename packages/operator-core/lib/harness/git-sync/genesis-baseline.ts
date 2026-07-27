/**
 * git-sync/genesis-baseline.ts — the G-10 genesis-publish baseline
 * (own-head-publish + ref-announce both consume it as `genesisBaselineSha`).
 *
 * Extracted from git-sync-action.ts by WI-6243 so it is testable over the
 * injected git seam like its pot-git siblings, instead of only behind the
 * action module's full mock harness.
 *
 * WHAT IT ANSWERS: on a FIRST publish there is no namespace ref to judge
 * against, so the G-10 guard would otherwise judge the repo's ENTIRE history.
 * Content a remote already serves is not NEW exposure, so genesis only needs to
 * guard the `(alreadyExposed, head]` delta. Without a baseline, a pre-existing
 * repo above the flood caps can never onboard onto the hive-git plane at all.
 *
 * ONLY LOCAL remote-tracking refs are consulted: no network, and a ref that
 * lags the real remote makes us judge MORE than needed, never less. Ancestry is
 * always verified so a diverged/rewound remote cannot smuggle a non-ancestor
 * baseline in, and every failure path falls back to `null` — the strict
 * full-history judge.
 *
 * WI-6243 (live-caught on the P-302 rig, 2026-07-27) — why this is no longer
 * `origin/<branch>`-or-nothing: the original form required BOTH a registry
 * `github_remote` AND a remote-tracking ref named exactly after the branch. A
 * pot created by the seed-snapshot clone path satisfies NEITHER — its registry
 * entry carries `github_remote: null`, and its only remote-tracking ref is
 * `refs/remotes/origin/papercusp-seed-snapshot-<uuid>` while the local branch
 * is `main`. So the mitigation was inert exactly where it was needed and
 * genesis judged the FULL history on EVERY tick: own-head-publish burned
 * 27.5 min per fire (vs ≤63s for every other git-sync step) holding the DBOS
 * dedup pin, the guard then refused, no namespace ref was ever written,
 * `priorSha` stayed null — and it repeated forever. Net effect: that device
 * never published its own head at all, i.e. a total non-participant in p2p
 * replication, with the whole git-sync cadence throttled 5min → ~30min behind
 * it.
 *
 * The registry field was only ever a PROXY for the real question. The git-level
 * facts are both stricter and more direct: a remote-tracking ref EXISTS (so a
 * fetch from that remote really happened) and the remote it tracks is NOT a
 * path on this machine. That is what is required now, and the baseline search
 * widens from one hard-coded ref name to the tightest already-exposed frontier
 * over ALL remote-tracking refs.
 */
import { type RunGit, defaultRunGit } from '../../sync/pot-git/storage';

/** The subset of a registry ProjectEntry this needs — kept structural so the
 *  helper does not drag the whole registry type into its test surface. */
export interface GenesisBaselineRepo {
  /** The worktree whose branch head is about to be published. */
  path: string;
  /** Normalized upstream clone URL from the registry, when known. A fast path
   *  for the external-remote gate — never required (WI-6243). */
  github_remote?: string;
}

/** A remote URL that is NOT a path on this machine. Matches http(s)://, ssh://,
 *  git://, and the scp-like `user@host:path` form; a bare/relative filesystem
 *  path (`/srv/mirror.git`, `../other`, `file://…`) deliberately does NOT count
 *  as exposure off this box. */
const EXTERNAL_REMOTE_URL_RE = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|[^\s/@]+@[^\s:/]+:)/;

/** Cost bound on the frontier walk. A branch with more unexposed commits than
 *  this still yields a SAFE (merely less tight) baseline: a truncated walk can
 *  only surface FEWER boundary commits, never a non-remote-reachable one. */
const MAX_FRONTIER_WALK_COMMITS = 50_000;

/** How many boundary commits to price before choosing. A merge can produce
 *  several and any ONE of them is safe (see deriveRemoteFrontierBaseline), so
 *  this only bounds how hard we try for the tightest. */
const MAX_FRONTIER_CANDIDATES = 16;

/**
 * Resolve the genesis-publish baseline for `branch` in `repo`, or null to fall
 * back to the strict full-history judge.
 */
export async function deriveGenesisBaselineSha(
  repo: GenesisBaselineRepo,
  branch: string | undefined,
  runGit: RunGit = defaultRunGit,
): Promise<string | null> {
  try {
    // Resolve the branch EXACTLY as the publish ticks do (explicit cfg wins,
    // else the worktree's checked-out branch) so baseline and publish agree.
    let wtBranch = branch ?? null;
    if (!wtBranch) {
      const sym = await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], repo.path);
      wtBranch = sym.code === 0 ? sym.stdout.trim() : null;
    }
    if (!wtBranch) return null;

    // "Already exposed off-box" gate. The registry's github_remote is a fast
    // path; absent it (every seed-snapshot pot), fall back to the git-level
    // truth — at least one configured remote with a non-local URL.
    if (!repo.github_remote && !(await hasExternalRemote(repo.path, runGit))) return null;

    const branchRef = `refs/heads/${wtBranch}`;
    // 1. The exact upstream for this branch — cheapest, and the intended case.
    const tip = await runGit(['rev-parse', '--verify', '-q', `refs/remotes/origin/${wtBranch}^{commit}`], repo.path);
    const tipSha = tip.code === 0 ? tip.stdout.trim() : '';
    if (tipSha) {
      const anc = await runGit(['merge-base', '--is-ancestor', tipSha, branchRef], repo.path);
      if (anc.code === 0) return tipSha;
    }
    // 2. WI-6243: no branch-named upstream (or it diverged) — use the tightest
    //    already-exposed frontier across every remote-tracking ref instead.
    return await deriveRemoteFrontierBaseline(repo.path, branchRef, runGit);
  } catch {
    return null; // strict fallback
  }
}

/** True when the repo has at least one configured remote whose URL is external
 *  (WI-6243) — proof that content fetched from it left this machine. */
async function hasExternalRemote(repoPath: string, runGit: RunGit): Promise<boolean> {
  const res = await runGit(['remote', '-v'], repoPath);
  if (res.code !== 0) return false;
  return res.stdout.split('\n').some((line) => {
    const url = line.trim().split(/\s+/)[1];
    return !!url && EXTERNAL_REMOTE_URL_RE.test(url);
  });
}

/**
 * WI-6243: the tightest baseline that is provably already exposed off-box.
 *
 * `git rev-list --boundary <branch> --not --remotes` walks the commits on
 * `<branch>` that NO remote-tracking ref reaches, and prints — prefixed with
 * '-' — exactly the commits it stopped at: remote-reachable parents of those
 * commits. That set IS the already-exposed frontier, found in one walk.
 *
 * Safety argument for picking a SINGLE boundary B: every commit U unreachable
 * from any remote ref is also unreachable from B (B is remote-reachable, so
 * everything reachable from B is too), and U is reachable from head. Hence
 * U ∈ (B, head] for ANY boundary B — the judged range is always a SUPERSET of
 * the genuinely-unexposed set. Picking one of several boundaries only ever
 * judges MORE, never less, so this can never under-guard.
 */
async function deriveRemoteFrontierBaseline(
  repoPath: string,
  branchRef: string,
  runGit: RunGit,
): Promise<string | null> {
  const anyRemoteRef = await runGit(['for-each-ref', '--count=1', '--format=%(objectname)', 'refs/remotes/'], repoPath);
  if (anyRemoteRef.code !== 0 || !anyRemoteRef.stdout.trim()) return null;

  const walk = await runGit(
    ['rev-list', '--boundary', `--max-count=${MAX_FRONTIER_WALK_COMMITS}`, branchRef, '--not', '--remotes'],
    repoPath,
  );
  if (walk.code !== 0) return null;
  const lines = walk.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    // Nothing on this branch is unexposed — a remote already serves the whole
    // branch. The head itself is the baseline: an empty range to judge.
    const head = await runGit(['rev-parse', '--verify', '-q', `${branchRef}^{commit}`], repoPath);
    return head.code === 0 ? head.stdout.trim() || null : null;
  }

  const boundary = lines
    .filter((l) => l.startsWith('-'))
    .map((l) => l.slice(1))
    .filter(Boolean);
  // No boundary at all ⇒ the unexposed history reaches a root: there is no
  // already-exposed content to lean on. Fall back to the strict full judge.
  if (boundary.length === 0) return null;

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of boundary.slice(0, MAX_FRONTIER_CANDIDATES)) {
    // Belt-and-braces, mirroring the fast path: never accept a non-ancestor.
    const anc = await runGit(['merge-base', '--is-ancestor', candidate, branchRef], repoPath);
    if (anc.code !== 0) continue;
    if (boundary.length === 1) return candidate;
    const count = await runGit(['rev-list', '--count', `${candidate}..${branchRef}`], repoPath);
    const distance = count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN;
    if (!Number.isFinite(distance)) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
