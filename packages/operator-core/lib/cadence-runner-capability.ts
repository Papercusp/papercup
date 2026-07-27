/**
 * cadence-runner-capability — "does THIS node actually run the pot's autonomous
 * CADENCE loops for this harness?" (EI-18761517980514694).
 *
 * # Why this exists
 *
 * The per-Hive single-runner gate ({@link ../hive-single-runner}) elects ONE node
 * per pot to fire the cadence loops, by `argmin(device_pubkey)` over the live
 * `shared_presence` roster (lock-authority D-005). That election had NO notion of
 * whether the winner can run the loop it just won. Measured on the papercusp pot
 * (2026-07-27): a peer whose routine host never fires `gym-cycle` won every tick —
 * its device_pubkey sorts lowest and it heartbeats every ~10s — so the ONE node
 * with the gym stack, an enabled autoloop and $49 of budget stood down as
 * `remote-runner` on ~89% of fires and the gym was dark for hours. Nothing errored;
 * the election succeeded and simply elected a node that does not do the work.
 *
 * This module computes the capability bit that fixes it. The publisher stamps it on
 * every presence announce (`shared_presence.runs_routines`, mig 682) and the
 * election excludes non-capable PEERS from candidacy
 * (`LockAuthorityDeps.routineHostsOnly`).
 *
 * # Why THIS predicate and not a simpler one
 *
 * Both weaker candidates were measured and rejected against the real roster:
 *
 *  - `dbosLaunchesHere()` alone ("is this a routine host") — REJECTED on evidence.
 *    The wrongly-elected peer IS a routine host (`PAPERCUSP_DBOS_ENABLE=1`, no
 *    `PAPERCUSP_BACKGROUND_WORKERS` override ⇒ background workers on): it logged
 *    12,080 `[git-sync]` lines and ZERO `[gym-cycle]` lines. Marking it capable
 *    would have shipped a no-op.
 *  - "has any active routine" — REJECTED for the same reason: that peer's
 *    `git-sync` routine would satisfy it.
 *
 * What actually discriminates is WHICH cadence routines are armed on the node.
 * `harness_shared.routines` carries no `fed_ts`/`fed_hlc`, so it is node-LOCAL, and
 * its `(workspace_id, install_slug)` grain is exactly the presence row's grain
 * (install_slug IS the harness/pot slug). So "this harness has an active
 * cadence-runner routine HERE" is both locally knowable and genuinely
 * node-discriminating — which is the whole requirement.
 *
 * Deliberately NOT inferred from cycle EVIDENCE (`gym_autoloop_config.last_cycle_at`
 * and friends): those tables carry no device or federation columns, so they only
 * ever describe the local node — and while a node is standing down its own
 * `last_cycle_at` is always stale, which would turn the check into a no-op that
 * fails open on every tick. Capability must be published; it cannot be inferred.
 */
import { getOrgPg } from '@papercusp/db-org';
import { dbosLaunchesHere } from './background-workers';

/**
 * The routines whose ticks arbitrate through the per-Hive single-runner gate — the
 * complete set of `checkHiveSingleRunner` consumers (harness/routines/gym-actions.ts
 * → `isHiveRunner`, and scout/run.ts + blueprint-steps/ops/scout-cycle.ts).
 *
 * ⚠ Keep this in sync with those callers: a cadence loop that consults the gate but
 * is missing here makes its node look INCAPABLE to peers (safe — peers would each
 * run their own loop, a duplicate rather than a stall, per D-004 — but it defeats
 * the duplicate-prevention the gate exists for). A name listed here that no longer
 * gates is the opposite error: it can mark a node capable of a loop it does not run.
 */
export const CADENCE_RUNNER_ROUTINES = ['gym-cycle', 'scout-cycle'] as const;

/** How long a resolved capability answer is reused before it is re-read. */
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  value: boolean;
  atMs: number;
}
const cache = new Map<string, CacheEntry>();

/** Injectable seams (tests; production uses the live defaults). */
export interface CadenceRunnerCapabilityDeps {
  now?: () => number;
  /** Does THIS process launch the scheduled-routine host? Default: dbosLaunchesHere. */
  dbosLaunches?: () => boolean;
  /** Does this harness have an ACTIVE cadence-runner routine on this node? */
  hasActiveCadenceRoutine?: (workspaceId: string, harnessSlug: string) => Promise<boolean>;
  /** Cache window; 0 disables caching (tests). Default {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
}

async function defaultHasActiveCadenceRoutine(
  workspaceId: string,
  harnessSlug: string,
): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT 1
    FROM harness_shared.routines
    WHERE workspace_id = ${workspaceId}
      AND install_slug = ${harnessSlug}
      AND active = true
      AND name = ANY(${[...CADENCE_RUNNER_ROUTINES]}::text[])
    LIMIT 1
  `) as unknown as { length: number };
  return rows.length > 0;
}

/**
 * Whether this node runs the autonomous cadence loops for `harnessSlug` — the value
 * published as `shared_presence.runs_routines`.
 *
 * TRUE requires BOTH legs: the routine host actually launches here (an armed routine
 * on a request-only host never fires), and at least one cadence-runner routine is
 * ARMED here for this harness.
 *
 * Answers are cached for {@link DEFAULT_TTL_MS} because the presence announcer calls
 * this on every announce, per harness. The TTL is the point, not an optimisation:
 * resolving ONCE at wire time (the way `pot_slug` is) would let a node that later
 * DISARMS its cadence routine keep a stale `true` marker, keep winning the argmin,
 * and re-create exactly the bug this fixes. A 60s re-read self-heals well inside the
 * 90s authority staleness window.
 *
 * Never throws: any failure resolves to `false`, i.e. "not a runner". That is the
 * conservative direction — a node that under-reports itself is skipped by PEERS,
 * but every selector adds SELF unconditionally, so it still runs its own loop. The
 * cost of the safe default is at worst a duplicate cycle, never a dark one.
 */
export async function nodeRunsCadenceLoops(
  workspaceId: string,
  harnessSlug: string,
  deps: CadenceRunnerCapabilityDeps = {},
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const key = `${workspaceId}::${harnessSlug}`;
  const nowMs = now();
  if (ttlMs > 0) {
    const hit = cache.get(key);
    if (hit && nowMs - hit.atMs < ttlMs) return hit.value;
  }
  let value = false;
  try {
    const dbosLaunches = deps.dbosLaunches ?? dbosLaunchesHere;
    if (dbosLaunches()) {
      const hasRoutine = deps.hasActiveCadenceRoutine ?? defaultHasActiveCadenceRoutine;
      value = await hasRoutine(workspaceId, harnessSlug);
    }
  } catch {
    value = false; // see the doc above — under-reporting is the safe direction
  }
  if (ttlMs > 0) cache.set(key, { value, atMs: nowMs });
  return value;
}

/** Test seam: drop every cached answer. */
export function _resetCadenceRunnerCapabilityCache(): void {
  cache.clear();
}
