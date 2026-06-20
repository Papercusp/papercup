/**
 * in-process-periodic.ts — lightweight in-process periodic checks (EI-1622).
 *
 * The SOURCE fix for the recurring routine-engine freeze: the high-frequency
 * ephemeral health-checks / sweeps below used to be modeled as DURABLE DBOS
 * scheduled workflows (periodic-workflows.ts), each persisting a permanent
 * `dbos.workflow_status` row every 30–60s. At ~200k rows/day the table grew to
 * 328k rows / 253MB, the DBOS executor starved (every dequeue scans it), and
 * `routinesTick` stalled → the hive-wake never fired → the Queen froze.
 *
 * These checks are EPHEMERAL + IDEMPOTENT — a missed fire is caught by the next
 * fire — so they do NOT need DBOS durability/recovery/a permanent execution
 * record. Modeling them as durable workflows was an over-generalization of
 * "everything is a DBOS workflow". Here they run as plain `setInterval` ticks:
 * zero workflow_status writes, so the table stays small and the daily GC (R4-5)
 * becomes a true backstop, not load-bearing. DBOS workflows are reserved for the
 * genuinely-recoverable units (the feature pipeline, durable-spawn, provision,
 * backup snapshot, plan render) and the low-frequency maintenance that is not the
 * bloat source (telemetryFlush, attentionReconcile, embedBackfill, the daily GCs).
 *
 * The scheduler is modeled on the out-of-band Red Queen engine-death sentinel
 * (red-queen/engine-death.ts): a plain unref'd interval, idempotent arm, an
 * injectable-deps seam so tests run without timers/PG. Armed ONCE from
 * host-bootstrap, gated on `backgroundWorkers` — exactly like the sentinel — so a
 * naive setInterval never runs N× across :3070 cluster request workers (the #1
 * gotcha: DBOS dedup'd by workflow-id; in-process does not).
 */
import { shouldShedHeavyTick } from './tick-load-shed';

/** One in-process periodic check. The tick must be idempotent — a throw is
 *  caught + logged and the next interval retries (no durable recovery). */
export interface PeriodicCheck {
  name: string;
  intervalMs: number;
  /** Heavy ticks (system-health, harness-status-sweep) shed a cycle under event-loop
   *  saturation / power-save. Light single-query probes do NOT shed — we want their
   *  signal precisely under load (parity with the DBOS version's shouldShedHeavyTick). */
  shed?: boolean;
  tick: () => Promise<void> | void;
}

export interface RunCheckDeps {
  shouldShed?: (name: string) => boolean;
  log?: (msg: string) => void;
}

/**
 * One check pass: shed-gate (heavy ticks only), then the tick, NEVER throwing.
 * Returns whether the tick ran (false when shed or when it threw — the next
 * interval retries either way).
 */
export async function runPeriodicCheck(
  check: PeriodicCheck,
  deps: RunCheckDeps = {},
): Promise<{ ran: boolean; shed?: boolean }> {
  const log = deps.log ?? ((m: string) => console.warn(`[in-process-periodic] ${m}`));
  try {
    if (check.shed) {
      const shed = deps.shouldShed ?? shouldShedHeavyTick;
      if (shed(check.name)) return { ran: false, shed: true };
    }
    await check.tick();
    return { ran: true };
  } catch (e) {
    log(`${check.name} tick failed (next interval retries): ${e instanceof Error ? e.message : e}`);
    return { ran: false };
  }
}

// ── The default checks (the converted ex-DBOS-workflow set) ──────────────────
// Each tick body is the EXACT logic from its former DBOS scheduled workflow in
// periodic-workflows.ts (same flag gates, same side effects, same log strings);
// only the scheduler driving it changed (setInterval, no DBOS.runStep / no
// registerWorkflow → no persisted workflow_status row). Lazy imports inside the
// ticks keep boot light and defer the heavy module loads to first fire.

// Every 30s: whole-system Health snapshot (system-health-tab P-003/D-001).
// Recompute per-workspace SystemHealth + fire notifySyncInvalidate('health.snapshot')
// (inside runSystemHealthTick) so an open Health tab stays SSE-live. Flag-gated
// (SYSTEM_HEALTH_TAB); the resolver's on-demand recompute is the correctness floor,
// so this tick is the liveness bonus. HEAVY → sheds under saturation.
const systemHealthCheck: PeriodicCheck = {
  name: 'system-health',
  intervalMs: 30_000,
  shed: true,
  tick: async () => {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    if (!(await getFlag(FLAGS.SYSTEM_HEALTH_TAB, 'system'))) return;
    const { readRegistry } = await import('../workspace-registry');
    const { runSystemHealthTick } = await import('../system-health');
    for (const ws of readRegistry().workspaces.map((w) => w.id)) {
      await runSystemHealthTick(ws).catch((e) => {
        console.warn(`[system-health] tick failed for ${ws}: ${e instanceof Error ? e.message : e}`);
      });
    }
  },
};

// Every 30s: harness_status / harness_lanes PID-liveness sweep (consolidation
// P-001). HEAVY → sheds under saturation. NB: the legacy ensureHarnessStatusSweep
// now stands down on backgroundWorkersEnabled() (not dbosTimersActive), so this
// in-process check is the single owner wherever background workers run.
const harnessStatusSweepCheck: PeriodicCheck = {
  name: 'harness-status-sweep',
  intervalMs: 30_000,
  shed: true,
  tick: async () => {
    const { runHarnessStatusSweepOnce } = await import('../harness-status-sweep');
    await runHarnessStatusSweepOnce();
  },
};

// Every 30s: connection-pressure watch (backend-connection-scaling C5-1). pgHealth()
// reports server-wide saturation; warn LOUDLY past 85% with the top holders. LIGHT
// probe — NOT shed (we want the signal precisely under load).
const connectionPressureCheck: PeriodicCheck = {
  name: 'connection-pressure',
  intervalMs: 30_000,
  tick: async () => {
    const { pgHealth } = await import('../dev-data');
    const h = await pgHealth().catch(() => null);
    if (!h || h.maxConnections <= 0) return;
    if (h.saturationPct >= 85) {
      const top = h.byApplication
        .slice(0, 6)
        .map((a) => `${a.name}=${a.count}`)
        .join(' ');
      console.warn(
        `[pg-pressure] DANGER ${h.serverWideConnections}/${h.maxConnections} conns ` +
          `(${h.saturationPct}%). Top holders: ${top}. ` +
          `Remedy: raise the ceiling (npx tsx scripts/pg-autotune.ts --apply), lower ` +
          `PAPERCUSP_DB_POOL_MAX, or enable PgBouncer (PAPERCUSP_PGBOUNCER=1).`,
      );
    }
  },
};

// Every 60s: probe the dev endpoints + broadcast on each up/down TRANSITION
// (fleet-coordination-painpoints Phase 3b). External liveness has no event source,
// so this is the one irreducible poll; transition-only, never a per-tick firehose.
const serviceHealthCheck: PeriodicCheck = {
  name: 'service-health',
  intervalMs: 60_000,
  tick: async () => {
    const { runServiceHealthTick } = await import('../service-health');
    await runServiceHealthTick();
  },
};

// Every 60s: poll completion_refs against the remote (git ls-remote), stamping
// verified/divergent. Per-feature backoff stays in the worker; a verifier is
// idempotent and a missed run catches up next tick.
const completionRefVerifyCheck: PeriodicCheck = {
  name: 'completion-ref-verify',
  intervalMs: 60_000,
  tick: async () => {
    const { runCompletionRefVerifierOnce } = await import('../harness/completion-ref-verifier');
    await runCompletionRefVerifierOnce();
  },
};

// Every 60s: reclaim orphaned spawn rows whose launching host died, so they stop
// counting forever against the global concurrency ceiling (unify-agent-spawn-
// chokepoint P-011). Freed slots → wake over-ceiling waiters (D-004).
const spawnReclaimSweepCheck: PeriodicCheck = {
  name: 'spawn-reclaim-sweep',
  intervalMs: 60_000,
  tick: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { reclaimOrphanedSpawns } = await import('../fleet/spawn-reclaim');
    const r = await reclaimOrphanedSpawns(getOrgPg().sql);
    if (r.reclaimed > 0) {
      console.warn(`[spawn-reclaim] freed ${r.reclaimed} orphaned spawn(s): ${r.spawnIds.join(', ')}`);
      try {
        const { emitAwaitedEvent } = await import('../events/await/engine');
        const { spawnSlotEventKey } = await import('../fleet/operator-spawn');
        for (const ws of r.workspaces) {
          await emitAwaitedEvent({
            key: spawnSlotEventKey(ws),
            summary: `${r.reclaimed} orphaned spawn slot(s) reclaimed by the periodic sweep`,
            source: 'spawn-reclaim-sweep',
            workspaceId: ws,
          }).catch(() => undefined);
        }
      } catch {
        /* best-effort — waiters fall back to their await timeout */
      }
    }
  },
};

// Every 60s: release work-item / issue / plan-item claims held by DEAD agents
// (alias-aware liveness). Companion to spawn-reclaim: that frees the dead spawn's
// CONCURRENCY slot, this frees its CLAIMS. Also stamps a liveness heartbeat
// (recordSweepRun) so the system-health reader can detect a WEDGED scheduler.
const staleClaimSweepCheck: PeriodicCheck = {
  name: 'stale-claim-sweep',
  intervalMs: 60_000,
  tick: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;

    const { reclaimStaleWorkItemClaims, reclaimStaleIssueClaims } = await import('../work-items-stale-claims');
    const r = await reclaimStaleWorkItemClaims(sql);
    if (r.released.length > 0) {
      const byAction = r.released.reduce<Record<string, number>>((acc, c) => {
        acc[c.action] = (acc[c.action] ?? 0) + 1;
        return acc;
      }, {});
      console.warn(
        `[stale-claims] released ${r.released.length} work-item claim(s) from dead holders ` +
          `(${Object.entries(byAction).map(([a, n]) => `${a}:${n}`).join(', ')}): ` +
          r.released.map((c) => `${c.harness_slug}/${c.feature_id}<-${c.former_taken_by} [${c.former_status}->${c.new_status}]`).join(', '),
      );
      // Broadcast ONLY dead-letters: poison items that exhausted the requeue cap and
      // parked in `blocked`, which DO need human/Queen attention (D-006).
      const deadLettered = r.released.filter((c) => c.action === 'dead-lettered');
      if (deadLettered.length > 0) {
        try {
          const { sendMessage } = await import('../agent-tools/coordination/messages');
          await sendMessage(
            {
              ownerId: 'stale-claim-sweep',
              ownerLabel: 'system · stale-claim-sweep',
              source: 'signed-spawn',
              workspaceId: null,
              userId: null,
            },
            {
              to: ['*'],
              summary:
                `stale-claim sweep: ${deadLettered.length} work item(s) dead-lettered to [blocked] ` +
                `(stale-reclaim-exhausted — requeued past the cap by repeatedly-dying holders, needs attention): ` +
                deadLettered.map((c) => `${c.harness_slug}/${c.feature_id} (requeued ${c.requeue_count}x)`).join(', '),
            },
          );
        } catch {
          /* best-effort — the console.warn above is the floor */
        }
      }
    }

    // The issue-family reaper — clear dead holders off OPEN bug/change issues
    // (same alias-aware liveness), returning them to the open pool (P-005 / D-009).
    const ir = await reclaimStaleIssueClaims(sql);
    if (ir.released.length > 0) {
      console.warn(
        `[stale-claims] reaped ${ir.released.length} issue-family claim(s) from dead holders ` +
          `(returned to the open pool): ` +
          ir.released.map((c) => `${c.issue_id}[${c.kind}]<-${c.former_assignee}`).join(', '),
      );
    }

    // P-009 heartbeat — record this run (always, even when nothing was freed) so the
    // system-health reader can detect a WEDGED scheduler (last-run aged out).
    try {
      const { recordSweepRun, STALE_CLAIM_SWEEP_NAME } = await import('../work-queue-health');
      await recordSweepRun(sql, STALE_CLAIM_SWEEP_NAME, r.released.length + ir.released.length);
    } catch {
      /* best-effort heartbeat */
    }

    // The PLAN-ITEM analog (EI-179): delete claims whose lease lapsed past grace AND
    // whose holder is gone. The durable ASSIGNMENT (mig 140) is untouched, so the
    // item returns to its assignee/pool.
    const { reclaimExpiredPlanItemClaims } = await import('../plan-items/stale-claims');
    const pr = await reclaimExpiredPlanItemClaims(sql);
    if (pr.released.length > 0) {
      console.warn(
        `[stale-claims] released ${pr.released.length} EXPIRED plan-item claim(s) from dead holders ` +
          `(lease lapsed past grace, no live presence): ` +
          pr.released
            .map((c) => `${c.harness_slug}/${c.plan_slug}#${c.item_id}<-${c.former_owner}`)
            .join(', '),
      );
    }
  },
};

// Every 2min: composite learning-infra health tick (consume-edges P-003/D-002) —
// LLM-spine + runner spawn + gym circuit → ONE status; owner notification on the
// transition to offline. Flag-gated (LEARNING_INFRA_HEALTH); transition-only.
const learningInfraHealthCheck: PeriodicCheck = {
  name: 'learning-infra-health',
  intervalMs: 120_000,
  tick: async () => {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    if (!(await getFlag(FLAGS.LEARNING_INFRA_HEALTH, 'learning-infra-health'))) return;
    const { runLearningInfraHealthTick } = await import('../harness/improvements/learning-infra-health');
    const { health, transition } = await runLearningInfraHealthTick();
    if (transition) {
      console.warn(`[learning-infra-health] ${transition === 'offline' ? 'OFFLINE' : 'recovered'} — ${health.reason}`);
    }
  },
};

// Every 5min: the multi-Queen steering-churn tripwire sweep (hive-network-surface
// P-010 / D-004). Find backlog items re-steered by >= 2 distinct writers in the
// window and raise a debounced owner escalate above the flip threshold.
const steeringChurnSweepCheck: PeriodicCheck = {
  name: 'steering-churn-sweep',
  intervalMs: 300_000,
  tick: async () => {
    const { sweepSteeringChurn, pruneSteeringChurnEvents } = await import('../steering-churn');
    const r = await sweepSteeringChurn();
    if (r.escalated > 0) {
      console.warn(`[steering-churn] swept ${r.checked} churned item(s); escalated ${r.escalated} to the owner`);
    }
    await pruneSteeringChurnEvents();
  },
};

// Every 5min: federation-drain reconcile (WI-254 / EI-1618 item 2). Flags a LIVE
// booted harness whose substrate_outbox is undrained past 60s (content captured but
// NOT federating — the EI-681 silent-stall class) and files a DEDUPED improvement —
// the proactive half of EI-1618's on-read drain-health surface, so a silent stall is
// caught without a reader. Composes with substrate-outbox-backstop-gc (alert@60s vs
// its GC@48h — a huge no-race margin). Lives here (NOT a DBOS workflow) per EI-1622:
// an ephemeral health check on a durable workflow is the workflow_status-bloat that
// froze the routine engine. Default OFF (opt-in PAPERCUSP_FEDERATION_DRAIN_RECONCILE=1)
// pending fleet-alert review — the code ships ready + tested, enablement is a human
// decision. HEAVY (substrate_outbox group-scan) → sheds under saturation; a stall
// persists, so a shed tick is caught next interval.
const federationDrainReconcileCheck: PeriodicCheck = {
  name: 'federation-drain-reconcile',
  intervalMs: 300_000,
  shed: true,
  tick: async () => {
    if (process.env.PAPERCUSP_FEDERATION_DRAIN_RECONCILE !== '1') return;
    const { runDrainReconcileOnce } = await import('../sync/hyperbee/run-drain-reconcile');
    await runDrainReconcileOnce();
  },
};

/** The converted ex-DBOS-workflow set. */
export function buildDefaultChecks(): PeriodicCheck[] {
  return [
    systemHealthCheck,
    harnessStatusSweepCheck,
    connectionPressureCheck,
    serviceHealthCheck,
    completionRefVerifyCheck,
    spawnReclaimSweepCheck,
    staleClaimSweepCheck,
    learningInfraHealthCheck,
    steeringChurnSweepCheck,
    federationDrainReconcileCheck,
  ];
}

// ── The scheduler (idempotent, unref'd, never keeps the process alive) ────────

interface ArmedCheck {
  timer: ReturnType<typeof setInterval>;
}

let armed: ArmedCheck[] | null = null;

/**
 * Arm the in-process periodic checks. Idempotent (a second call is a no-op).
 * Call ONCE from host-bootstrap gated on `backgroundWorkers` — never per cluster
 * request worker. Each check runs on its own unref'd interval with a per-check
 * re-entrancy guard (a slow tick never piles up a second concurrent run — parity
 * with DBOS's workflow-id dedup).
 */
export function armInProcessPeriodicChecks(
  opts: { checks?: PeriodicCheck[]; deps?: RunCheckDeps } = {},
): { stop: () => void } {
  if (armed) return { stop: disarmInProcessPeriodicChecks };
  const checks = opts.checks ?? buildDefaultChecks();
  armed = [];
  for (const check of checks) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return; // previous tick still in flight — skip, no pile-up
      running = true;
      void runPeriodicCheck(check, opts.deps).finally(() => {
        running = false;
      });
    }, check.intervalMs);
    timer.unref?.();
    armed.push({ timer });
  }
  console.log(
    `[in-process-periodic] armed ${checks.length} in-process check(s): ${checks.map((c) => c.name).join(', ')}`,
  );
  return { stop: disarmInProcessPeriodicChecks };
}

/** Disarm all in-process checks (tests; graceful shutdown). */
export function disarmInProcessPeriodicChecks(): void {
  if (!armed) return;
  for (const a of armed) clearInterval(a.timer);
  armed = null;
}

/** Whether the in-process checks are currently armed (tests). */
export function inProcessPeriodicChecksArmed(): boolean {
  return armed !== null;
}
