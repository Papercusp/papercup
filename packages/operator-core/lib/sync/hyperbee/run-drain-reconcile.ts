/**
 * run-drain-reconcile — WI-254 (EI-1618 item 2): the periodic federation-drain
 * reconcile pass (single run).
 *
 * EI-1618's on-READ surface (federation-status route + the desktop) flips a
 * harness off "healthy" when its substrate_outbox is undrained past threshold —
 * but only when something READS it. This is the proactive half: one pass over the
 * LIVE booted harnesses that flags any whose outbox is stalled (captured but not
 * federating — the EI-681 class) and files a DEDUPED improvement, so a silent
 * stall is caught without a reader, and surfaced long before the
 * substrate-outbox-backstop-GC drops the undrained-orphaned rows (it GCs at 48h;
 * this alerts at 60s — a huge no-race margin).
 *
 * HOME (design, WI-254): this is an EPHEMERAL, idempotent health check, so per
 * EI-1622 it must NOT be a DBOS scheduled workflow (those wrote ~200k
 * workflow_status rows/day = the routine-engine-freeze source) NOR a routine-engine
 * action (wedge-prone). It is armed as a lightweight in-process-periodic check (a
 * plain setInterval, resilient to the routine-engine / bg-host cycling). This module
 * is the single-run body (parity with runStorageGrowthAlarmOnce); the in-process
 * tick lazy-imports + calls it.
 *
 * Over-reaction guard (aligned with the transient-signal-over-reaction runbook):
 * a healthy drain marks a row within seconds, so the 60s threshold is solidly past
 * any transient capture→drain gap; the per-(workspace,harness) watchdog dedup means
 * one improvement per stall, never one per tick.
 */
import type { SubstrateDrainStat } from './load-drain-stats';
import type { InProcessSubstrateStatus } from './in-process-status';
import {
  planDrainReconcile,
  drainStallWatchdogKey,
  type DrainStallFlag,
  type DrainReconcileInput,
} from './plan-drain-reconcile';

const ZERO_DRAIN: SubstrateDrainStat = { undrainedCount: 0, oldestUndrainedAgeMs: null };

/** Result of a capture attempt (the subset of captureImprovement's return we use). */
export interface CaptureResult {
  created: boolean;
  reason?: string;
  issue?: { id: string } | null;
}

export interface RunDrainReconcileDeps {
  /** Prefetch the per-(ws,harness) undrained drain stats. Default: loadSubstrateDrainStats over getOrgPg. */
  loadDrainStats?: () => Promise<Map<string, SubstrateDrainStat>>;
  /** The in-process substrate status, given a sync drain resolver. Default: getInProcessSubstrateStatus. */
  getStatus?: (opts: {
    resolveDrainStats: (ws: string, slug: string) => SubstrateDrainStat;
  }) => InProcessSubstrateStatus;
  /** File a deduped improvement for one stall. Default: captureImprovement. */
  capture?: (input: {
    title: string;
    kind: 'bug';
    severity: 'major' | 'minor';
    body: string;
    foundDuring: string;
    dedupScope: 'open';
    watchdogKey: string;
  }) => Promise<CaptureResult>;
  log?: (msg: string) => void;
  stalledMs?: number;
  unhealthyMs?: number;
}

export interface RunDrainReconcileResult {
  flagged: DrainStallFlag[];
  captured: number;
}

function bodyFor(f: DrainStallFlag): string {
  const ageS = Math.round(f.oldestUndrainedAgeMs / 1000);
  return (
    `Harness ${f.harnessSlug} (workspace ${f.workspaceId}) is BOOTED but its ` +
    `substrate_outbox has ${f.undrainedCount} row(s) undrained for ${ageS}s — content is ` +
    `captured but NOT federating (the EI-681 silent-stall class). A healthy drain marks a ` +
    `row within seconds, so this is a real stall, not a transient.\n\n` +
    `Likely causes: the per-harness outbox drain is wedged / the harness never joined its ` +
    `topic / a workspace mis-route (see substrate-outbox-backstop-gc). This was caught by ` +
    `the federation-drain reconcile (WI-254) BEFORE the 48h backstop-GC would drop the rows. ` +
    `Verdict: ${f.severity}.`
  );
}

/**
 * Run one drain-reconcile pass. Reads the undrained stats, maps them over the LIVE
 * booted harnesses, and files a deduped improvement per stalled one. Best-effort:
 * a single capture failure is logged + skipped (the others still fire); a fatal
 * read error propagates to the in-process tick wrapper (which logs + retries next
 * interval). Pure-core (planDrainReconcile) does the stall classification.
 */
export async function runDrainReconcileOnce(
  deps: RunDrainReconcileDeps = {},
): Promise<RunDrainReconcileResult> {
  const log = deps.log ?? ((m: string) => console.warn(`[federation-drain-reconcile] ${m}`));

  const loadDrainStats =
    deps.loadDrainStats ??
    (async () => {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { loadSubstrateDrainStats } = await import('./load-drain-stats');
      const { sql } = getOrgPg();
      const runQuery = async <T,>(q: string, p: unknown[]): Promise<T[]> =>
        (await sql.unsafe(q, p as never)) as unknown as T[];
      return loadSubstrateDrainStats({ runQuery });
    });

  // getInProcessSubstrateStatus is sync; resolve it via await-import (ESM — no
  // require) so an injected getStatus keeps the test path PG/boot-free.
  let getStatus = deps.getStatus;
  if (!getStatus) {
    const mod = await import('./in-process-status');
    getStatus = mod.getInProcessSubstrateStatus;
  }

  const capture =
    deps.capture ??
    (async (input) => {
      const { captureImprovement } = await import('../../harness/improvements/capture-core');
      return (await captureImprovement(input)) as CaptureResult;
    });

  const drainByKey = await loadDrainStats();
  const status = getStatus({
    resolveDrainStats: (ws, slug) => drainByKey.get(`${ws}::${slug}`) ?? ZERO_DRAIN,
  });

  const inputs: DrainReconcileInput[] = status.harnesses.map((h) => ({
    workspaceId: h.workspaceId,
    harnessSlug: h.harnessSlug,
    drain: h.drain,
  }));
  const flagged = planDrainReconcile(inputs, {
    stalledMs: deps.stalledMs,
    unhealthyMs: deps.unhealthyMs,
  });

  let captured = 0;
  for (const f of flagged) {
    try {
      const res = await capture({
        title: `Federation stall: ${f.harnessSlug} outbox undrained ${Math.round(
          f.oldestUndrainedAgeMs / 1000,
        )}s (${f.undrainedCount} row(s))`,
        kind: 'bug',
        severity: f.severity === 'unhealthy' ? 'major' : 'minor',
        body: bodyFor(f),
        foundDuring: 'federation-drain-reconcile',
        dedupScope: 'open',
        watchdogKey: drainStallWatchdogKey(f.workspaceId, f.harnessSlug),
      });
      if (res.created) captured += 1;
    } catch (e) {
      log(`capture failed for ${f.workspaceId}/${f.harnessSlug} (skipped): ${e instanceof Error ? e.message : e}`);
    }
  }

  if (flagged.length > 0) {
    log(
      `${flagged.length} stalled harness(es): ` +
        flagged.map((f) => `${f.harnessSlug}=${f.undrainedCount}u/${Math.round(f.oldestUndrainedAgeMs / 1000)}s[${f.severity}]`).join(', ') +
        ` (${captured} newly filed, rest deduped)`,
    );
  }
  return { flagged, captured };
}
