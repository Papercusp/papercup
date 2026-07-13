/**
 * dev-deploy-state — the read-only release-gate snapshot behind the dev admin
 * rail's Deploy panel (plan dev-admin-sidebar-2026-06-05, P-006 / D-004).
 *
 * The #10 "my edit reverted" antidote: surfaces that the live operator's green
 * `:3070` runs from a SEPARATE release checkout (`papercup-release`) pinned to a
 * green ref, N commits / X hours behind `main`. A missing edit then reads as
 * *not-yet-deployed*, not *reverted*.
 *
 * Self-contained on purpose: it replicates the small slice of the release lib's
 * config + git primitives it needs (paths/refs + `git` shell-outs) rather than
 * importing `apps/operator/lib/release/*`. operator-core must not depend back on
 * apps/operator (wrong dependency direction), and the release lib also carries a
 * deploy/rollback surface this read panel must never reach. The refs/paths mirror
 * `release-config.ts` exactly (same env seams) so the two never drift.
 *
 * READ-ONLY (D-004): this computes + returns state. It never advances `ready`,
 * never deploys, never restarts — the deploy chokepoint stays the release-gate
 * agent's job.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';

const pexec = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', ['-C', repo, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/** A commit identity: sha + commit epoch-ms + subject line. */
export interface CommitRef {
  sha: string;
  shortSha: string;
  committedAtMs: number;
  subject: string;
}

/**
 * ⚠ NAMING (EI-11012 — read before you add a field here).
 *
 * The staging→main migration (staging-branch-pipeline-2026-06-06) made the GREEN PIN the
 * `main` BRANCH and the churning integration branch `staging` — see release-config.ts:126-129
 * ("the green pin is the `main` BRANCH (FF-advanced from green `staging`), not a separate
 * `ready` ref"). This module's fields were NOT renamed with it, so for ~5 weeks every field
 * here SAID "main"/"ready" and MEANT something else:
 *
 *     OLD (lying)          ACTUALLY MEASURED                       NOW
 *     mainHead             staging HEAD                            stagingHead
 *     ready                main HEAD (the green pin)               greenPin
 *     deployedBehindMain   deployed vs STAGING                     deployedBehindStaging
 *     readyBehindMain      main vs STAGING  ← the staging buffer   greenPinBehindStaging
 *     deployedBehindReady  deployed vs MAIN ← the real deploy gap  deployedBehindGreenPin
 *
 * That naming had a live cost: why-chain's deploy stage degraded on `readyBehindMain > 0`,
 * believing it meant "the tip hasn't been promoted". It actually means "staging is ahead of
 * main" — the NORMAL steady state of this fleet (git-sync commits staging continuously; the
 * green-checkpoint FFs main only hourly, only when green). So the deploy stage reported
 * `degraded` essentially ALWAYS, and because the why-chain stops at the first degraded stage,
 * it SHADOWED every real downstream cause. Keep these names honest.
 */
export interface DevDeployState {
  /** The churning integration tree git-sync commits to (resolves `staging` + `main`). */
  integrationRoot: string;
  /** The separate checkout the live `:3070` operator actually runs from. */
  releaseRoot: string;
  /** The green-pin ref name — the `main` BRANCH (`releaseRef`). */
  releaseRef: string;
  /** The integration branch name — `staging`, the agent firehose. */
  integrationBranch: string;

  /** `staging` HEAD — the churning integration branch (NOT main). */
  stagingHead: CommitRef | null;
  /** The green pin = `main` HEAD — the last commit the full-suite gate passed, i.e. what a
   *  deploy WOULD ship. null if unset. */
  greenPin: CommitRef | null;
  /** What the release checkout (the live `:3070`) is ACTUALLY running. */
  deployed: CommitRef | null;
  /** Best-effort wall-clock of the last deploy (release worktree HEAD mtime). */
  deployedAtMs: number | null;

  /** Commits `staging` has that the DEPLOYED ref doesn't (staging→live distance; spans the
   *  un-green-checkpointed buffer, so it is NOT by itself a deploy fault). */
  deployedBehindStaging: number | null;
  /** THE STAGING BUFFER: commits `staging` has that the green pin (`main`) doesn't — i.e. work
   *  committed but not yet green-checkpointed. NORMAL and almost always > 0 on this fleet.
   *  ⚠ NOT a deploy fault. Do NOT degrade the deploy stage on it (EI-11012). A buffer that stays
   *  large for a long time is a GATE/promotion concern (is the gate still advancing main?), and
   *  belongs to a time-thresholded gate signal — not to a `> 0` boolean here. */
  greenPinBehindStaging: number | null;
  /** THE REAL DEPLOY GAP: commits the green pin (`main`) has that the deployed ref doesn't —
   *  green, shippable, and NOT YET LIVE on :3070. This is the one field a deploy-stage health
   *  check should fire on. */
  deployedBehindGreenPin: number | null;
  /** True iff the green pin (`main`) is exactly at `staging` HEAD — the whole buffer is green. */
  greenPinAtStagingHead: boolean | null;

  /** Non-fatal problems gathering the snapshot (a ref didn't resolve, etc.). */
  errors: string[];
}

/** Resolve the release paths/refs the same way release-config.ts does (env seams). */
/**
 * Memoized `git rev-parse --show-toplevel`. Resolved AT MOST ONCE per process:
 * the repo root cannot change under a running operator, and this probe sits
 * behind a UI-POLLED sync query (dev-glances), so re-forking git on every poll
 * bought nothing. In a PACKAGED install there is no repo at all, so each poll
 * forked a doomed git AND let its `fatal: not a git repository` reach the
 * operator's stderr — 3,247 of them in one 0.0.8 mac install's serve.log,
 * burying real errors (WI-4368). `stderr: 'ignore'` keeps a repo-less install
 * silent; the memo keeps it from re-asking.
 */
let cachedToplevel: string | null = null;
function gitToplevel(): string {
  if (cachedToplevel != null) return cachedToplevel;
  try {
    cachedToplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    cachedToplevel = process.cwd();
  }
  return cachedToplevel;
}

function resolveConfig(): Pick<
  DevDeployState,
  'integrationRoot' | 'releaseRoot' | 'releaseRef' | 'integrationBranch'
> {
  // PAPERCUSP_INTEGRATION_ROOT is exported into the :3070 operator's unit env
  // (the release-gate cutover). Off that env, derive from cwd's git toplevel.
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT || gitToplevel();
  const parent = path.dirname(integrationRoot);
  const releaseRoot = process.env.PAPERCUSP_RELEASE_ROOT ?? path.join(parent, 'papercup-release');
  // staging→main model (staging-branch-pipeline-2026-06-06): the integration
  // branch (agent firehose) is `staging`; the green pin is the `main` BRANCH.
  // Field names below predate the rename and read generically: `stagingHead` = the
  // integration branch (staging) HEAD; `ready` = the green pin (main); the
  // behind-counts are measured against those. Mirrors release-config.ts.
  return {
    integrationRoot,
    releaseRoot,
    releaseRef: process.env.PAPERCUSP_RELEASE_REF ?? 'main',
    integrationBranch: process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging',
  };
}

/** sha + commit date + subject for a ref in `repo`, or null on any failure. */
async function commitRef(repo: string, ref: string): Promise<CommitRef | null> {
  try {
    // ONE `git log -1` fork/exec resolves+peels the ref AND formats sha + committer
    // epoch + subject, replacing the former 3-exec fan-out (rev-parse --verify ^{commit}
    // + show -s %ct + show -s %s). `log -1 <ref>^{commit}` peels a branch/tag to its
    // commit and exits non-zero (→ caught → null) on an unresolvable ref — the exact
    // same contract as the old rev-parse --verify. %s is git's single-LINE subject, so
    // the two %n separators split cleanly (sha \n ct \n subject); an empty subject
    // yields a trailing empty field, handled by `rest.join`. Cutting commitRef 3→1 exec
    // drops the whole snapshot fan-out from ~12 to ~6 git fork/execs — the #1
    // application-attributable event-loop cost under the poll storm (P-009 cpuprofile
    // attribution, mcp-reliability-hardening-2026-07-11: git spawn from THIS file was
    // ≈59% of real on-loop work during the Jul-10 4–6s-lag saturation).
    const out = await git(repo, ['log', '-1', '--format=%H%n%ct%n%s', ref + '^{commit}']);
    const [sha, ct, ...rest] = out.split('\n');
    return {
      sha,
      shortSha: sha.slice(0, 8),
      committedAtMs: Number(ct) * 1000,
      subject: rest.join('\n'),
    };
  } catch {
    return null;
  }
}

/** Count of commits in `from..to` within `repo`, or null on failure. */
async function aheadCount(repo: string, from: string, to: string): Promise<number | null> {
  try {
    const out = await git(repo, ['rev-list', '--count', from + '..' + to]);
    return Number(out);
  } catch {
    return null;
  }
}

/**
 * Best-effort last-deploy wall-clock: mtime of the release checkout's real HEAD
 * ref file.
 *
 * The release checkout is a LINKED WORKTREE (`git worktree add`), so
 * `<releaseRoot>/.git` is not a directory — it's a static `gitdir: <path>`
 * pointer FILE written once at worktree-creation time and never rewritten
 * afterwards. A `git checkout` / `git reset --hard` inside the worktree
 * updates the ref file at `<pointer-target>/HEAD` (under the MAIN repo's
 * `.git/worktrees/<name>/`), not the pointer file itself. Statting the
 * pointer file (as this used to) therefore returns the worktree's CREATION
 * time forever, silently making every past + future deploy look like it
 * happened on day one — the exact symptom behind WI-1623 ("deployedAt
 * ~month-stale" when deploys were in fact landing).
 *
 * So: resolve the real per-worktree admin dir by parsing the pointer file
 * (same `gitdir:\s*(.+)` shape `classify-tree.ts` already parses for worktree
 * detection) and stat ITS `HEAD`, which git does touch on every checkout.
 * Falls back to the plain non-worktree case (`.git` is a real directory) and,
 * failing everything, to the old best-effort stats so this never regresses to
 * throwing or silently returning null on a shape we haven't seen.
 */
function lastDeployMtime(releaseRoot: string): number | null {
  const gitPath = path.join(releaseRoot, '.git');
  try {
    const st = fs.statSync(gitPath);
    if (st.isDirectory()) {
      // Not a worktree (a plain/standalone checkout) — HEAD lives right here.
      return Math.round(fs.statSync(path.join(gitPath, 'HEAD')).mtimeMs);
    }
    if (st.isFile()) {
      const raw = fs.readFileSync(gitPath, 'utf-8');
      const match = raw.match(/^gitdir:\s*(.+?)\s*$/m);
      const target = match?.[1];
      if (target) {
        // Resolve relative-to-worktree-root pointer targets too (git usually
        // writes an absolute path, but tolerate a relative one defensively).
        const realGitDir = path.isAbsolute(target) ? target : path.join(releaseRoot, target);
        return Math.round(fs.statSync(path.join(realGitDir, 'HEAD')).mtimeMs);
      }
    }
  } catch {
    /* fall through to the best-effort candidates below */
  }
  // Last resort: the pre-fix behavior. Wrong for a worktree, but better than
  // null when the shape above didn't match (e.g. .git missing entirely).
  const candidates = [path.join(releaseRoot, '.git', 'HEAD'), path.join(releaseRoot, '.git')];
  for (const c of candidates) {
    try {
      return Math.round(fs.statSync(c).mtimeMs);
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Compute the current release-gate snapshot. Pure read — shells `git` against the
 * integration + release checkouts; mutates nothing. Resolves a partial snapshot
 * with `errors[]` populated rather than throwing, so the panel always renders.
 *
 * NOT exported — every caller goes through the cached `devDeployState()` wrapper
 * below. One call here fans out ~6 `git` subprocess fork/execs (3×commitRef, each
 * a single `git log -1`, + 3×aheadCount `rev-list`). git spawning on the request-
 * worker loop has been pinned by cpuprofile attribution as the single largest
 * application-attributable event-loop cost TWICE — round-4 P-015
 * (infra-perf-reliability-audit-round4, ~26% of real on-CPU work) and again
 * P-009 (mcp-reliability-hardening-2026-07-11, ≈59% of on-loop work in the Jul-10
 * 4–6s-lag storm) — amplified by the poll storm hitting system-health +
 * sync-resolver `dev.deployState`. Two levers keep it off the hot path: this
 * fan-out was halved 12→6 execs (commitRef 3→1, P-009) and the cache below
 * collapses concurrent/rapid callers to one fan-out per TTL.
 */
async function computeDevDeployState(): Promise<DevDeployState> {
  const cfg = resolveConfig();
  const errors: string[] = [];

  // cfg.integrationBranch === 'staging' (the churning firehose); cfg.releaseRef === 'main'
  // (the green pin). The bindings are named for what they HOLD — see the naming note above.
  const [stagingHead, greenPin, deployed] = await Promise.all([
    commitRef(cfg.integrationRoot, cfg.integrationBranch),
    commitRef(cfg.integrationRoot, cfg.releaseRef),
    commitRef(cfg.releaseRoot, 'HEAD'),
  ]);

  if (!stagingHead) errors.push('could not resolve ' + cfg.integrationBranch + ' in ' + cfg.integrationRoot);
  if (!greenPin) errors.push('ref ' + cfg.releaseRef + ' not found in ' + cfg.integrationRoot);
  if (!deployed) errors.push('could not resolve HEAD of release checkout ' + cfg.releaseRoot);

  // All counts are measured in the integration tree (it has every object — the
  // release worktree shares its object store). deployed must be reachable there.
  // aheadCount(from, to) = `rev-list --count from..to` = commits `to` has that `from` lacks.
  const [deployedBehindStaging, greenPinBehindStaging, deployedBehindGreenPin] = await Promise.all([
    // live :3070 → staging tip (spans the un-checkpointed buffer; not a fault on its own)
    deployed && stagingHead ? aheadCount(cfg.integrationRoot, deployed.sha, stagingHead.sha) : Promise.resolve(null),
    // green pin (main) → staging tip = THE STAGING BUFFER (normal; not a deploy fault)
    greenPin && stagingHead ? aheadCount(cfg.integrationRoot, greenPin.sha, stagingHead.sha) : Promise.resolve(null),
    // live :3070 → green pin (main) = THE REAL DEPLOY GAP (green but not shipped)
    deployed && greenPin ? aheadCount(cfg.integrationRoot, deployed.sha, greenPin.sha) : Promise.resolve(null),
  ]);

  return {
    ...cfg,
    stagingHead,
    greenPin,
    deployed,
    deployedAtMs: lastDeployMtime(cfg.releaseRoot),
    deployedBehindStaging,
    greenPinBehindStaging,
    deployedBehindGreenPin,
    greenPinAtStagingHead: greenPinBehindStaging == null ? null : greenPinBehindStaging === 0,
    errors,
  };
}

// ─── Short-TTL single-flight cache ────────────────────────────────────────────
// The release-gate snapshot is a display read whose underlying git refs only move
// on a commit / deploy (seconds-to-minutes granularity), yet `devDeployState()`
// is called from poll-storm-amplified hot paths — system-health/compute,
// sync-resolver `dev.deployState`, and the pipeline-stats/position tools — each
// firing ~10 `git` fork/execs on the request-worker event loop with no reuse.
// Under the ~70-agent reconnect/poll storm that pegged a single core, this was
// the #1 application-attributable on-loop cost (P-015 cpuprofile attribution).
//
// The cache does two things: (1) memoises the resolved snapshot for a short TTL
// so rapid repeat reads skip git entirely, and (2) shares the in-flight promise
// (single-flight) so a BURST of concurrent callers collapses to ONE git fan-out
// instead of N. TTL is read per-call so it's runtime-tunable and test-overridable
// (set PAPERCUSP_DEPLOY_STATE_TTL_MS=0 to disable, e.g. when a test mutates refs
// then re-reads). Default 10s (raised from 3s in P-009): the underlying refs only
// move on the git-sync commit (minutes) / deploy (≤15min, ~46s of :3070 downtime)
// cadence, so a read-only display panel is fully live at 10s resolution while the
// steady per-TTL git drip that survives single-flight during an 8-minute poll storm
// drops ~3× (480/3s→480/10s fan-outs). Combined with the 12→6 exec halving above,
// git fork/exec load on the loop falls ~6–7× under the storm.

interface DeployStateCacheEntry {
  at: number;
  value: Promise<DevDeployState>;
}
let deployStateCache: DeployStateCacheEntry | null = null;

function deployStateTtlMs(): number {
  const raw = process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS;
  if (raw == null || raw === '') return 10_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
}

/**
 * Cached, single-flight release-gate snapshot. Identical signature + return
 * contract to the underlying compute (READ-ONLY; resolves a partial snapshot with
 * `errors[]` rather than throwing). Concurrent + rapid callers within the TTL
 * window share one `git` fan-out; see the cache note above.
 */
export async function devDeployState(): Promise<DevDeployState> {
  const ttl = deployStateTtlMs();
  const now = Date.now();
  if (ttl > 0 && deployStateCache && now - deployStateCache.at < ttl) {
    return deployStateCache.value;
  }
  const value = computeDevDeployState();
  if (ttl > 0) {
    const entry: DeployStateCacheEntry = { at: now, value };
    deployStateCache = entry;
    // computeDevDeployState resolves-with-errors rather than throwing, but if it
    // ever rejects, drop the entry so the next call retries instead of caching it.
    value.catch(() => {
      if (deployStateCache === entry) deployStateCache = null;
    });
  }
  return value;
}

/** Clear the snapshot cache — for tests that mutate refs/env then re-read. */
export function resetDevDeployStateCache(): void {
  deployStateCache = null;
}
