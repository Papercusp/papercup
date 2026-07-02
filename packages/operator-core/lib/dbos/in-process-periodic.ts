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
import { createConnectionPressureGovernor } from '../connection-pressure-governor';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

/** One in-process periodic check. The tick must be idempotent — a throw is
 *  caught + logged and the next interval retries (no durable recovery). */
export interface PeriodicCheck {
  name: string;
  intervalMs: number;
  /** Heavy ticks (system-health, harness-status-sweep) shed a cycle under event-loop
   *  saturation / power-save. Light single-query probes do NOT shed — we want their
   *  signal precisely under load (parity with the DBOS version's shouldShedHeavyTick). */
  shed?: boolean;
  /** Also run ONCE immediately when armed (heal-on-startup), not only after the first
   *  interval. For self-heal sweeps that should converge on boot (e.g. epoch-key reconcile)
   *  rather than wait a full interval. Still subject to the shed-gate. */
  fireOnArm?: boolean;
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

// One per process (this tick runs only on the background-worker host, so the AIMD
// penalty fires once — not N× across the :3070 cluster). Closure-held debounce state.
const connectionPressureGovernor = createConnectionPressureGovernor();

// Every 30s: connection-pressure watch (backend-connection-scaling C5-1). pgHealth()
// reports server-wide saturation; warn LOUDLY past 85% with the top holders. LIGHT
// probe — NOT shed-on-loop-pressure (we want the signal precisely under load), but
// it DOES feed the connection-pressure governor (C5-1) which sheds agent concurrency
// via AIMD at critical saturation — the admission half that closes the loop.
const connectionPressureCheck: PeriodicCheck = {
  name: 'connection-pressure',
  intervalMs: 30_000,
  tick: async () => {
    const { pgHealth } = await import('../dev-data');
    const h = await pgHealth().catch(() => null);
    if (!h || h.maxConnections <= 0) return;

    // C5-1: close the loop — feed saturation into the AIMD concurrency governor so
    // critical PG saturation sheds agent concurrency (recovering as it falls).
    // Gated by CONNECTION_PRESSURE_GOVERNOR (default ON); fail-OPEN to the default-on
    // behavior so a flag-read error can't silently disable the backpressure. OFF ⇒
    // signal-only (just the warn below) — the operator's escape hatch.
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    const governorOn = await getFlag(
      FLAGS.CONNECTION_PRESSURE_GOVERNOR,
      'connection-pressure',
    ).catch(() => true);
    if (governorOn) connectionPressureGovernor.observe(h.saturationPct);

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
    const { reclaimOrphanedSpawns, reclaimWedgedSpawns, WEDGE_REAP_SILENT_MS } = await import(
      '../fleet/spawn-reclaim'
    );
    const sql = getOrgPg().sql;
    const { emitAwaitedEvent } = await import('../events/await/engine');
    const { spawnSlotEventKey } = await import('../fleet/operator-spawn');
    const announceFreed = async (workspaces: string[], summary: string) => {
      for (const ws of workspaces) {
        await emitAwaitedEvent({
          key: spawnSlotEventKey(ws),
          summary,
          source: 'spawn-reclaim-sweep',
          workspaceId: ws,
        }).catch(() => undefined);
      }
    };

    const r = await reclaimOrphanedSpawns(sql);
    if (r.reclaimed > 0) {
      console.warn(`[spawn-reclaim] freed ${r.reclaimed} orphaned spawn(s): ${r.spawnIds.join(', ')}`);
      try {
        await announceFreed(r.workspaces, `${r.reclaimed} orphaned spawn slot(s) reclaimed by the periodic sweep`);
      } catch {
        /* best-effort — waiters fall back to their await timeout */
      }
    }

    // RECLAIM_STALLED: the "stalled, not just dead" half — durably reclaim WEDGED
    // spawns (supervised-LIVE but stream-silent past the action threshold) that the
    // orphan sweep above (stale-heartbeat only) can't see. Flag-gated OFF: killing a
    // live agent + freeing its slot is a hot-path placement change (D-003 attended).
    // The reap engine + threshold are the SAME as the in-memory `reapWedgedLocalSpawns`
    // fast path — this is the durable, DB-truth, restart-safe floor over it.
    try {
      const [{ getFlag }, { FLAGS }] = await Promise.all([
        import('@papercusp/flags/server'),
        import('@papercusp/flags'),
      ]);
      if (await getFlag(FLAGS.RECLAIM_STALLED, 'system')) {
        const { cancelSubtree } = await import('../fleet/nursery');
        const { abortLocalSpawn } = await import('../fleet/operator-spawn');
        const wr = await reclaimWedgedSpawns(sql, async (c) => {
          const silentMin = Math.round(c.silentMs / 60_000);
          // Durable cancel FIRST (releases claims/locks + flips the row with a
          // `reclaimed:`-prefixed reason → the placement watchdog reads it as an
          // infra reclaim, not item-pathology, WI-233), THEN SIGTERM the live child.
          // Idempotent: a row that just settled is `alreadyTerminal`, the abort no-ops.
          await cancelSubtree(sql, {
            workspaceId: c.workspaceId,
            rootSpawnId: c.spawnId,
            reason: `reclaimed: wedged — alive but stream-silent ${silentMin}min (> ${Math.round(
              WEDGE_REAP_SILENT_MS / 60_000,
            )}min, RECLAIM_STALLED durable reaper)`,
            actor: {
              ownerId: 'wedge-reclaim-sweep',
              ownerLabel: 'system · wedge-reclaim-sweep',
              source: 'signed-spawn',
              workspaceId: c.workspaceId,
              userId: null,
            },
          });
          abortLocalSpawn(c.spawnId);
          return true;
        });
        if (wr.reclaimed > 0) {
          console.warn(
            `[wedge-reclaim] durably reaped ${wr.reclaimed} wedged spawn(s): ${wr.spawnIds.join(', ')}`,
          );
          await announceFreed(
            wr.workspaces,
            `${wr.reclaimed} wedged spawn slot(s) reclaimed (RECLAIM_STALLED durable reaper)`,
          );
        }
      }
    } catch (err) {
      console.warn('[wedge-reclaim] sweep failed (non-fatal — retries next tick):', err);
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
    // live-configurability-audit P-014: apply the stale-claim reclaim overrides (undefined ⇒ baked default).
    const { readCoordLivenessConfig } = await import('../coord-liveness-config');
    const livenessCfg = await readCoordLivenessConfig();
    // agent-activity-liveness-truth P-003 (D-003): the STALLED leg (free a LIVE but
    // non-progressing holder) is flag-gated OFF by default — a live-placement change
    // on a hot path. The DEAD + confirmed-terminal-spawn legs always run.
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    const includeStalled = await getFlag(FLAGS.RECLAIM_STALLED, 'system');
    const r = await reclaimStaleWorkItemClaims(sql, {
      graceMs: livenessCfg.reclaimGraceMs,
      requeueCap: livenessCfg.reclaimRequeueCap,
      includeStalled,
    });
    if (r.released.length > 0) {
      const byAction = r.released.reduce<Record<string, number>>((acc, c) => {
        acc[c.action] = (acc[c.action] ?? 0) + 1;
        return acc;
      }, {});
      const byReason = r.released.reduce<Record<string, number>>((acc, c) => {
        acc[c.reason] = (acc[c.reason] ?? 0) + 1;
        return acc;
      }, {});
      console.warn(
        `[stale-claims] released ${r.released.length} work-item claim(s) ` +
          `(reasons: ${Object.entries(byReason).map(([a, n]) => `${a}:${n}`).join(', ')}; ` +
          `${Object.entries(byAction).map(([a, n]) => `${a}:${n}`).join(', ')}): ` +
          r.released.map((c) => `${c.harness_slug}/${c.feature_id}<-${c.former_taken_by} [${c.former_status}->${c.new_status} ${c.reason}]`).join(', '),
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

    // ── P-017 (cross-machine-coord-parity-and-trust-2026-07-01): the LEASE-table
    // backstops the WORKITEM_CLAIM_LEASE flag (DEFAULT ON since WI-597) shipped
    // without. (a) GC: sweep lapsed harness_shared.work_item_claims rows — until
    // now nothing ever deleted them (steal-on-acquire was the only consumer).
    // (b) DIVERGENCE DETECTION: a live lease whose holder disagrees with the
    // work item's denorm `taken_by` is the post-failover double-claim signature —
    // ANNOTATE loudly, don't auto-mutate (the liveness model's own rule; full
    // cross-machine reconcile rides the federated claims read model, later).
    try {
      const { sweepLapsedClaims } = await import('../work-item-claims');
      const wsRows = await sql<{ workspace_id: string }[]>`
        SELECT DISTINCT workspace_id FROM harness_shared.work_item_claims
        WHERE expires_ts <= clock_timestamp()`;
      let swept = 0;
      for (const w of wsRows) swept += await sweepLapsedClaims(w.workspace_id);
      if (swept > 0) console.warn(`[claim-lease] swept ${swept} lapsed lease row(s) (P-017 GC)`);
      const diverged = await sql<
        { workspace_id: string; harness_slug: string; work_item_id: string; owner: string; taken_by: string | null }[]
      >`
        SELECT c.workspace_id, c.harness_slug, c.work_item_id, c.owner, f.taken_by
        FROM harness_shared.work_item_claims c
        JOIN harness_shared.harness_features_consolidated f
          ON f.workspace_id = c.workspace_id
         AND f.harness_slug = c.harness_slug
         AND f.feature_id = c.work_item_id
        WHERE c.expires_ts > clock_timestamp()
          AND COALESCE(f.taken_by, '') <> c.owner
        LIMIT 20`;
      if (diverged.length > 0) {
        console.warn(
          `[claim-lease] ${diverged.length} lease/denorm DIVERGENCE(s) — post-failover double-claim ` +
            `signature; lease is the authority-arbitrated fact (annotate-only, P-017): ` +
            diverged
              .map((d) => `${d.harness_slug}/${d.work_item_id} lease=${d.owner} taken_by=${d.taken_by ?? '∅'}`)
              .join(', '),
        );
      }
    } catch (e) {
      console.warn(
        `[claim-lease] P-017 backstop tick failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
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

    // The PLAN-ITEM analog (EI-179): delete claims whose lease lapsed past grace AND
    // whose holder is gone. The durable ASSIGNMENT (mig 140) is untouched HERE — the
    // assignment reaper below handles it.
    const {
      reclaimExpiredPlanItemClaims,
      reclaimStaleDeadHolderPlanItemAssignments,
      reclaimStalledLivePlanItemAssignments,
    } = await import('../plan-items/stale-claims');
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

    // The dead-holder ASSIGNMENT reaper (EI-2535): soft-release durable plan-item
    // RESERVATIONS whose name-aware holder is dead past grace (a one-shot session-id
    // assignee never re-adopts, so its reservation strands forever — the leases above
    // never touched it). Returns the item to the unassigned pool.
    const ar = await reclaimStaleDeadHolderPlanItemAssignments(sql, {
      graceMs: livenessCfg.assignmentReclaimGraceMs,
    });
    if (ar.released.length > 0) {
      console.warn(
        `[stale-claims] soft-released ${ar.released.length} dead-holder plan-item assignment(s) ` +
          `(reserved past grace, no live presence): ` +
          ar.released
            .map((c) => `${c.harness_slug}/${c.plan_slug}#${c.item_id}<-${c.former_assignee}`)
            .join(', '),
      );
    }

    // The STALLED-but-ALIVE assignment leg (stale-ownership-activity-truth): release a
    // durable assignment whose holder is process-ALIVE (heartbeating) but has done no
    // GENUINE activity (last_active_at) within the window — the "agent wandered off but
    // its process lingers, so the item still reads as assigned/handled" gap. Gated by
    // RECLAIM_STALLED (same switch as the work-item stalled leg) — a live-placement
    // change D-003 ships behind that flag.
    let sar = { released: [] as typeof ar.released };
    if (includeStalled) {
      sar = await reclaimStalledLivePlanItemAssignments(sql);
      if (sar.released.length > 0) {
        console.warn(
          `[stale-claims] soft-released ${sar.released.length} STALLED-but-alive plan-item assignment(s) ` +
            `(holder heartbeating but genuinely idle past the activity window): ` +
            sar.released
              .map((c) => `${c.harness_slug}/${c.plan_slug}#${c.item_id}<-${c.former_assignee}`)
              .join(', '),
        );
      }
    }

    // P-009 heartbeat — record this run (always, even when nothing was freed) so the
    // system-health reader can detect a WEDGED scheduler (last-run aged out).
    try {
      const { recordSweepRun, STALE_CLAIM_SWEEP_NAME } = await import('../work-queue-health');
      await recordSweepRun(
        sql,
        STALE_CLAIM_SWEEP_NAME,
        r.released.length + ir.released.length + pr.released.length + ar.released.length + sar.released.length,
      );
    } catch {
      /* best-effort heartbeat */
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

// WI-887 self-heal: owner-side epoch-key reconcile. A shared-hive member that went stuck without the
// CURRENT epoch key (it federated in around an epoch advance, or was missed while papercusp-hive-rekey
// was dark) cannot decrypt current content, so its plans/work_items silently never materialize (the
// live federation gap, plan shared-hive-member-content-federation D-018; the owner's Mac join hits
// this). The onMemberApplied hook heals the moment a membership op applies; this sweep heals a hive
// whose members are ALREADY applied (no fresh op coming) — e.g. on app restart / on the flag flip.
// GAP-AWARE: it does NO crypto on an intact hive (only reconciles a hive with a member missing the
// current key), owner-gated (reconcile no-ops where this box lacks the hive key), and flag-gated.
const hiveEpochKeyReconcileCheck: PeriodicCheck = {
  name: 'hive-epoch-key-reconcile',
  intervalMs: 600_000,
  // NOT shed: gap-aware (does no crypto on an intact hive), so it stays cheap under load and the
  // fireOnArm heal-on-startup runs even during the busy boot window (a shed tick would skip it).
  shed: false,
  fireOnArm: true, // heal stuck members on app startup, not only after the first 10m interval
  tick: async () => {
    const { isHiveRekeyEnabled, reconcileOwnedHiveEpochKeys } = await import(
      '../sync/hyperbee/hive-epoch-boundary-wiring'
    );
    const enabled = await isHiveRekeyEnabled();
    if (!enabled) return; // re-key dark ⇒ no epoch-key distribution to reconcile
    await reconcileOwnedHiveEpochKeys({ enabled });
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
    hiveEpochKeyReconcileCheck,
  ];
}

// ── The scheduler (idempotent, unref'd, never keeps the process alive) ────────

interface ArmedCheck {
  name: string;
  handle: ManagedHandle;
}

let armed: ArmedCheck[] | null = null;

/**
 * Arm the in-process periodic checks. Idempotent (a second call is a no-op).
 * Call ONCE from host-bootstrap gated on `backgroundWorkers` — never per cluster
 * request worker.
 *
 * P-005 (schedule-inventory-and-ephemeral-tier-2026-06-26): each check now rides
 * `managedSetInterval` from @papercusp/scheduled-registry — the ONE in-process
 * scheduling mechanism (D-006), shared with the ephemeral blueprint cadence tier.
 * The registry supplies the unref'd timer, the per-check re-entrancy guard (a slow
 * tick never piles up a second concurrent run — parity with DBOS's workflow-id
 * dedup), the fireOnArm heal-on-startup setTimeout(0), AND per-check
 * armed/last-fire/last-error tracking so every sweep is VISIBLE in schedule:inventory
 * (category 'global-sweep'). The tick body is still `runPeriodicCheck`, so the
 * shed-gate (shouldShedHeavyTick) + never-throw behavior is byte-identical; the
 * registry's own shed-gate stays disabled (default shouldShed = false) to avoid
 * double-shedding — the `shed` flag is carried only so the inventory can show which
 * checks are shed-eligible.
 */
export function armInProcessPeriodicChecks(
  opts: { checks?: PeriodicCheck[]; deps?: RunCheckDeps } = {},
): { stop: () => void } {
  if (armed) return { stop: disarmInProcessPeriodicChecks };
  const checks = opts.checks ?? buildDefaultChecks();
  armed = checks.map((check) => ({
    name: check.name,
    handle: managedSetInterval(check.name, check.intervalMs, () => runPeriodicCheck(check, opts.deps), {
      category: 'global-sweep',
      shed: check.shed,
      fireOnArm: check.fireOnArm,
    }),
  }));
  console.log(
    `[in-process-periodic] armed ${checks.length} in-process check(s): ${checks.map((c) => c.name).join(', ')}`,
  );
  return { stop: disarmInProcessPeriodicChecks };
}

/** Disarm all in-process checks (tests; graceful shutdown). Deregisters them from the inventory. */
export function disarmInProcessPeriodicChecks(): void {
  if (!armed) return;
  for (const a of armed) a.handle.stop();
  armed = null;
}

/** Whether the in-process checks are currently armed (tests). */
export function inProcessPeriodicChecksArmed(): boolean {
  return armed !== null;
}
