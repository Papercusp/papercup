/**
 * release-deploy-staleness-watchdog.ts — the release-pipeline stall/staleness
 * RECURRENCE GUARD (WI-1623).
 *
 * WI-1623 root cause (documented in full on the work-item + queen-notify.ts's
 * sibling fix WI-963): the deploy pipeline itself was found to be healthy — the
 * green-checkpoint/release-trigger routines were correctly advancing the green
 * pin and re-deploying `papercup-release` — but the `deployedAtMs` field
 * `release:deploy op:status` / the Deploy panel surface to an agent/operator can
 * get PERSISTENTLY STUCK on a stale value (confirmed live: frozen at the
 * worktree-pointer file's one-time creation mtime instead of the real, per-deploy
 * `HEAD` mtime) with NOTHING catching it — so "the deploy pipeline looks dead"
 * went unnoticed for ~a month even though nothing in the pipeline's OWN state
 * (gate/pin/routine health) was actually red. That silence is the gap this
 * watchdog closes: a deterministic, zero-cost-when-healthy sweep that raises a
 * loud, debounced alert whenever the green pin has been deployable-but-not-live
 * for an unreasonable amount of wall-clock time — REGARDLESS of whether the
 * true cause is a genuinely wedged deploy or (as it turned out here) a lying
 * status field. Either way, an operator should see it, not discover it a month
 * later while chasing something else.
 *
 * Deliberately reuses the EXISTING pure pipeline-status computation
 * (`release-deploy-launch.ts`'s `computeDeployStatus`) rather than re-deriving
 * "is a deploy pending" logic — this watchdog only adds the staleness CLOCK +
 * the alerting/debounce shell around it (same split as the other hive watchdogs:
 * a pure decider unit-tested with no DB, a thin PG sweep wired into the shared
 * 30s `routinesTick`, fail-soft throughout, a `<=0` kill switch).
 */
import { gitPipelineSnapshot } from './git-pipeline-stats';
import { computeDeployStatus, type DeployStateKind } from './release-deploy-launch';
import { recentWatchdogFires, recordFire } from './pot/watchdog';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';

// ── tunable (env-overridable, like the other watchdog floors) ─────────────────

/** How long the green pin may sit deployable-but-not-live before this watchdog
 *  alerts. Default 3h (well past the documented ≤15-min auto-deploy cadence —
 *  wide enough to absorb a slow/retrying checkpoint without false-alarming).
 *  `<=0` DISABLES the whole sweep (kill switch). */
export function deployStalenessThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC ?? 10_800);
  return Number.isFinite(n) ? n : 10_800;
}

// ── pure decider (unit-tested with no DB) ──────────────────────────────────────

export interface DeployStalenessInput {
  /** The pipeline state computed by `computeDeployStatus` — only 'green-deployable'
   *  (green code ahead of live, deployable right now) is a staleness candidate;
   *  every other state (up-to-date, gate-red, gate-wedged, staging-buffered,
   *  unknown) means either nothing is pending or something ELSE already explains
   *  the delay, so this watchdog stays out of their way. */
  state: DeployStateKind;
  /** Epoch ms the live :3070 was last deployed, or null if unresolvable (treated
   *  as maximally stale — an unknown deploy time is never assumed fresh). */
  deployedAtMs: number | null;
  /** epoch ms "now" — injected so the decider is deterministic in tests. */
  now: number;
  thresholdMs: number;
}

export interface DeployStalenessVerdict {
  stale: boolean;
  /** Human-readable reason — becomes the alert body / the "why not" for a healthy read. */
  reason: string;
  /** Age of `deployedAtMs` in ms, when resolvable (null when deployedAtMs itself is null). */
  ageMs: number | null;
}

/**
 * PURE: is the green pin deployable-but-not-live for longer than the threshold?
 * `thresholdMs <= 0` is the kill switch (never stale). A null `deployedAtMs`
 * while green code is waiting is ALSO flagged — "unknown how long" is itself a
 * signal worth surfacing (an unresolvable deploy timestamp on a pipeline that
 * SHOULD be shipping is not a healthy silence).
 */
export function evaluateDeployStaleness(input: DeployStalenessInput): DeployStalenessVerdict {
  if (input.thresholdMs <= 0) return { stale: false, reason: 'kill switch (thresholdMs <= 0)', ageMs: null };
  if (input.state !== 'green-deployable') {
    return { stale: false, reason: `pipeline state is '${input.state}', not green-deployable`, ageMs: null };
  }
  if (input.deployedAtMs == null || !Number.isFinite(input.deployedAtMs)) {
    return {
      stale: true,
      reason:
        'green pin is deployable but the live deploy timestamp is unresolvable (null) — cannot confirm ' +
        'the pipeline is actually shipping; treating an unknown deploy time as stale rather than assuming health.',
      ageMs: null,
    };
  }
  const ageMs = input.now - input.deployedAtMs;
  if (ageMs < input.thresholdMs) {
    return { stale: false, reason: `deployedAt age ${Math.round(ageMs / 3_600_000)}h is under the threshold`, ageMs };
  }
  const ageHours = Math.round(ageMs / 3_600_000);
  const thresholdHours = Math.max(1, Math.round(input.thresholdMs / 3_600_000));
  return {
    stale: true,
    reason:
      `green pin has been deployable-but-not-live for ${ageHours}h (>= the ${thresholdHours}h threshold) — ` +
      `the release-trigger routine (documented ≤15-min cadence) should have shipped it long ago. Either the ` +
      `pipeline is genuinely wedged (check routines:list for release-trigger/green-checkpoint health) or the ` +
      `deployedAt field itself is stale/lying (compare against the release checkout's actual git state ` +
      `on disk before assuming a real stall).`,
    ageMs,
  };
}

// ── the PG sweep ────────────────────────────────────────────────────────────────

export interface DeployStalenessSweepResult {
  outcome: 'alerted' | 'skipped' | 'healthy' | 'error';
  verdict?: DeployStalenessVerdict;
  reason: string;
}

/**
 * The release-deploy staleness sweep. Reuses `gitPipelineSnapshot` +
 * `computeDeployStatus` (no re-derived pipeline logic), evaluates staleness, and
 * — debounced per the existing `hive_watchdog_fires` ledger (source
 * 'release-deploy-staleness') — durably records + logs a loud alert. Never
 * throws (a watchdog that crashes its host guards nothing); default-safe (a
 * healthy pipeline is a complete no-op). Kill switch:
 * PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC <= 0.
 */
export async function releaseDeployStalenessSweep(opts: {
  now?: number;
  workspaceId?: string;
  installSlug?: string;
}): Promise<DeployStalenessSweepResult> {
  const thresholdSec = deployStalenessThresholdSec();
  if (thresholdSec <= 0) return { outcome: 'skipped', reason: 'kill switch' };
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? (process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug());
  try {
    const snap = await gitPipelineSnapshot(installSlug);
    const status = computeDeployStatus(snap);
    const verdict = evaluateDeployStaleness({
      state: status.state,
      deployedAtMs: status.deploy.deployedAtMs,
      now: opts.now ?? Date.now(),
      thresholdMs: thresholdSec * 1_000,
    });
    if (!verdict.stale) return { outcome: 'healthy', verdict, reason: verdict.reason };

    const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
    const alreadyFiredRecently =
      (await recentWatchdogFires(workspaceId, installSlug, windowHours, 'release-deploy-staleness')) > 0;
    if (alreadyFiredRecently) {
      return { outcome: 'skipped', verdict, reason: 'debounced' };
    }

    const reason = `deploy staleness: ${verdict.reason}`;
    console.warn(`[release-deploy-staleness] ALERT: ${reason}`);
    await recordFire({ workspaceId, installSlug, source: 'release-deploy-staleness', reason, wakeAt: null });
    return { outcome: 'alerted', verdict, reason };
  } catch (e) {
    return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
