/**
 * placement-watchdog.ts — the COMPLETION GUARANTEE for the Queen hive loop
 * (queen-autonomous-execution-2026-06-13 B-09: P-020 / P-021 / P-022 / P-023).
 *
 * The liveness watchdog (./watchdog.ts) guarantees the QUEEN stays awake; THIS
 * module guarantees every unit she PLACES reaches a terminal state — it closes
 * the G3 gap ("steer, don't dispatch" + reactive: a dead/stalled bee was only
 * rediscovered on the next idle wake). It rides the same 30s routinesTick and is
 * a BACKSTOP, not a cadence: every check is a deterministic SQL read; the wake /
 * escalation it MAY fire is the exception path.
 *
 * The reconciliation, per started hive:
 *   - P-020 — for each Queen-placed unit, derive its serving bee's liveness from
 *     `spawned_agents` (status / heartbeat / last_output) and the unit's own
 *     status + `taken_by`. A NON-terminal unit whose serving bee is dead/stalled
 *     and is NOT re-claimed by a live bee fires ONE targeted recovery wake to the
 *     Queen (debounced) so she re-places it WITHOUT waiting for the next idle
 *     wake. The Queen still DISPOSES (re-place / drain / drop) — the watchdog only
 *     surfaces (P-023: completion, not micromanagement).
 *   - P-021 — the cursed-item circuit breaker: after N failed placements (mirrors
 *     the orchestrator worker-chunk-loop `replanStrikes` exhaustion-flip, default
 *     3) the unit flips `cursed` and is escalated to the owner (the D-011 Queue
 *     precursor) instead of re-placed forever.
 *   - P-022 — stranded-work resolution: a `failing`/`failed` blocker that gates
 *     ≥1 non-terminal downstream unit is escalated ONCE so the owner can resolve /
 *     deprecate it and un-gate the downstream.
 *
 * Durable state is `harness_shared.hive_placements` (mig 263) — the per-(hive,
 * work-item) completion ledger holding ONLY the failed-placement counter, the
 * disposition, and the debounce timers. Liveness itself is never mirrored (it is
 * re-derived every sweep — storage policy).
 *
 * Pure deciders (`deriveBeeLiveness`, `evaluatePlacement`) are split from the PG
 * sweep (`reconcileHivePlacements`) so the behavioral contract unit-tests with no
 * database — the same split as wake-frontier-guard.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { RECLAIM_STALE_MS, WEDGE_SILENT_MS } from '../fleet/spawn-reclaim';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { listStartedHives } from './started';

// ── vocabulary (the canonical work-item terminal + stuck states) ──────────────

/** A placed unit is DONE when its status is one of these (work-items.ts: the set
 *  that fires `work-item:done:<id>`). Both kind-family dialects included. */
const TERMINAL_UNIT_STATES = new Set(['passed', 'deprecated', 'resolved', 'closed']);
/** A blocker is STUCK (P-022) when stalled in the feature-family failure band. */
const STUCK_BLOCKER_STATES = new Set(['failing', 'failed']);
/** A bee spawn row in one of these is GONE (its claim/work is no longer live). */
const TERMINAL_SPAWN_STATES = new Set(['done', 'failed', 'cancelled', 'reaped']);

export function isUnitTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL_UNIT_STATES.has(status);
}
export function isStuckBlockerState(status: string | null | undefined): boolean {
  return status != null && STUCK_BLOCKER_STATES.has(status);
}

/** The system actor that owns watchdog-fired escalations. */
const WATCHDOG_OWNER = 'system:hive-placement-watchdog';
const watchdogIdentity = { ownerId: WATCHDOG_OWNER } as unknown as AgentIdentity;

// ── tunables (env-overridable, like the liveness watchdog floor) ──────────────

export interface PlacementConfig {
  /** Failed placements before the cursed-item breaker trips (P-021). Mirrors the
   *  orchestrator `replanStrikes` default (3): two recovery wakes, then escalate. */
  breakerThreshold: number;
  /** Minimum gap between recovery wakes for the same stalled unit (debounce) — so
   *  a unit that stays stalled across many 30s ticks wakes the Queen at most once
   *  per window, not every tick. */
  recoveryDebounceMs: number;
}

export function placementConfig(): PlacementConfig {
  const threshold = Number(process.env.PAPERCUSP_HIVE_PLACEMENT_BREAKER ?? 3);
  const debounce = Number(process.env.PAPERCUSP_HIVE_PLACEMENT_DEBOUNCE_MS ?? 5 * 60_000);
  return {
    breakerThreshold: Number.isFinite(threshold) && threshold >= 1 ? threshold : 3,
    recoveryDebounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 5 * 60_000,
  };
}

// ── P-020 pure decider 1: bee liveness from the durable spawn row ─────────────

export type BeeLiveness = 'live' | 'wedged' | 'dead';

export interface BeeLivenessInput {
  status: string;
  heartbeatAtMs: number | null;
  lastOutputAtMs: number | null;
  now: number;
}

/**
 * Derive a bee's liveness from its spawn row, reusing the fleet-reclaim
 * thresholds so the watchdog agrees with orphan-reclaim / wedge-reap:
 *   - terminal spawn status (done/failed/cancelled/reaped) → `dead`;
 *   - running but heartbeat stale beyond RECLAIM_STALE_MS → `dead` (orphaned host);
 *   - running, heartbeat fresh, but output silent beyond WEDGE_SILENT_MS → `wedged`;
 *   - otherwise → `live`.
 * A null heartbeat on a running bee is treated as `live` (freshly spawned, no
 * heartbeat tick yet — reclaim owns the true-orphan case).
 */
export function deriveBeeLiveness(input: BeeLivenessInput): BeeLiveness {
  if (TERMINAL_SPAWN_STATES.has(input.status)) return 'dead';
  const { heartbeatAtMs, lastOutputAtMs, now } = input;
  if (heartbeatAtMs != null && now - heartbeatAtMs > RECLAIM_STALE_MS) return 'dead';
  if (lastOutputAtMs != null && now - lastOutputAtMs > WEDGE_SILENT_MS) return 'wedged';
  return 'live';
}

// ── P-020/P-021 pure decider 2: what to do about one placement ────────────────

export interface PlacementObservation {
  workItemId: string;
  /** The unit row still exists. */
  unitExists: boolean;
  /** The unit reached a terminal state. */
  unitTerminal: boolean;
  /** A LIVE bee currently holds/serves this non-terminal unit (re-placement took,
   *  or the original is still working). */
  hasLiveHolder: boolean;
  /** Failed placements already recorded for this unit (0 if never placed). */
  failCount: number;
  /** The existing placement row's status, or null if this is a new placement. */
  placementStatus: string | null;
  /** When the last recovery wake fired (debounce), ms epoch, or null. */
  lastRecoveryAtMs: number | null;
  now: number;
}

export type PlacementDecision =
  | { kind: 'healthy' }
  | { kind: 'completed' }
  | { kind: 'recover'; nextFailCount: number; reason: string }
  | { kind: 'debounced' }
  | { kind: 'breaker'; nextFailCount: number; reason: string }
  | { kind: 'abandon'; reason: string };

/**
 * The completion-guarantee contract for ONE placement (P-020 + P-021), pure:
 *   unit gone        → abandon
 *   unit terminal    → completed              (the placement succeeded)
 *   live holder      → healthy                (working / re-placement took)
 *   else (failed)    → breaker | debounced | recover
 * `breaker` fires once the count AFTER this failure reaches the threshold, so the
 * unit is escalated rather than re-placed a (threshold+1)-th time.
 */
export function evaluatePlacement(obs: PlacementObservation, cfg: PlacementConfig): PlacementDecision {
  if (!obs.unitExists) return { kind: 'abandon', reason: 'unit no longer exists' };
  if (obs.unitTerminal) return { kind: 'completed' };
  if (obs.hasLiveHolder) return { kind: 'healthy' };

  // Non-terminal unit with no live holder → this placement failed.
  // Debounce repeated wakes only while we are ALREADY mid-recovery for it.
  if (
    obs.placementStatus === 'recovering' &&
    obs.lastRecoveryAtMs != null &&
    obs.now - obs.lastRecoveryAtMs < cfg.recoveryDebounceMs
  ) {
    return { kind: 'debounced' };
  }
  const nextFailCount = obs.failCount + 1;
  if (nextFailCount >= cfg.breakerThreshold) {
    return {
      kind: 'breaker',
      nextFailCount,
      reason: `${nextFailCount} failed placements (>= breaker threshold ${cfg.breakerThreshold})`,
    };
  }
  return {
    kind: 'recover',
    nextFailCount,
    reason: 'serving bee dead/stalled and the unit is not terminal',
  };
}

// ── PG: the sweep ─────────────────────────────────────────────────────────────

export interface PlacementSweepResult {
  workspaceId: string;
  installSlug: string;
  workItemId: string;
  decision: PlacementDecision['kind'] | 'stranded' | 'unblocked';
  detail?: string;
}

interface BeeLite {
  spawnId: string;
  ownerId: string; // coord owner == work-item taken_by
  featureId: string | null;
  liveness: BeeLiveness;
}

interface UnitRow {
  feature_id: string;
  harness_slug: string | null;
  status: string;
  taken_by: string | null;
}

interface PlacementRow {
  work_item_id: string;
  status: string;
  fail_count: number;
  last_recovery_ms: number | null;
  escalation_msg_id: string | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Resolve the hive's Queen coord-owner from its most-recent hive session — the
 *  recipient of recovery wakes, and the key bee spawns carry as parent_spawn_id. */
async function resolveQueenOwner(sql: Sql, workspaceId: string, installSlug: string): Promise<string | null> {
  const rows = await sql<{ coord_owner_id: string }[]>`
    SELECT coord_owner_id
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND label LIKE ${'hive · ' + installSlug + '/%'}
       AND coord_owner_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`;
  return rows[0]?.coord_owner_id ?? null;
}

/** Upsert one placement row (the per-unit completion ledger). */
async function upsertPlacement(
  sql: Sql,
  p: {
    workspaceId: string;
    installSlug: string;
    workItemId: string;
    harnessSlug: string | null;
    queenOwnerId: string | null;
    beeSpawnId: string | null;
    beeOwnerId: string | null;
    status: string;
    failCount: number;
    disposition: string;
    escalationMsgId?: string | null;
    bumpRecovery?: boolean;
    now: number;
  },
): Promise<void> {
  const recoveryAt = p.bumpRecovery ? new Date(p.now) : null;
  await sql`
    INSERT INTO harness_shared.hive_placements
      (workspace_id, install_slug, work_item_id, harness_slug, queen_owner_id,
       bee_spawn_id, bee_owner_id, status, fail_count, last_disposition,
       escalation_msg_id, last_recovery_at, last_seen_at, updated_at)
    VALUES (
      ${p.workspaceId}, ${p.installSlug}, ${p.workItemId}, ${p.harnessSlug}, ${p.queenOwnerId},
      ${p.beeSpawnId}, ${p.beeOwnerId}, ${p.status}, ${p.failCount}, ${p.disposition},
      ${p.escalationMsgId ?? null}, ${recoveryAt}, ${new Date(p.now)}, ${new Date(p.now)}
    )
    ON CONFLICT (workspace_id, install_slug, work_item_id) DO UPDATE SET
      harness_slug      = COALESCE(EXCLUDED.harness_slug, harness_shared.hive_placements.harness_slug),
      queen_owner_id    = COALESCE(EXCLUDED.queen_owner_id, harness_shared.hive_placements.queen_owner_id),
      bee_spawn_id      = COALESCE(EXCLUDED.bee_spawn_id, harness_shared.hive_placements.bee_spawn_id),
      bee_owner_id      = COALESCE(EXCLUDED.bee_owner_id, harness_shared.hive_placements.bee_owner_id),
      status            = EXCLUDED.status,
      fail_count        = EXCLUDED.fail_count,
      last_disposition  = EXCLUDED.last_disposition,
      escalation_msg_id = COALESCE(EXCLUDED.escalation_msg_id, harness_shared.hive_placements.escalation_msg_id),
      last_recovery_at  = COALESCE(EXCLUDED.last_recovery_at, harness_shared.hive_placements.last_recovery_at),
      last_seen_at      = EXCLUDED.last_seen_at,
      updated_at        = EXCLUDED.updated_at`;
}

/**
 * The sweep's external effects, as an injectable seam (defaults to the real
 * impls — the routine caller passes none). Lets the orchestration (flag gate,
 * started-hive iteration, per-hive isolation, aggregation) be unit-tested
 * without PG; reconcileOneHive's own SQL stays integration-tested separately.
 */
export interface ReconcileSweepDeps {
  getFlag: typeof getFlag;
  listStartedHives: typeof listStartedHives;
  getOrgPg: typeof getOrgPg;
  reconcileOneHive: typeof reconcileOneHive;
}

/** Reconcile EVERY started hive's placements. Fail-soft; never throws. */
export async function reconcileHivePlacements(
  opts: { now?: number; deps?: Partial<ReconcileSweepDeps> } = {},
): Promise<PlacementSweepResult[]> {
  const results: PlacementSweepResult[] = [];
  const getFlagFn = opts.deps?.getFlag ?? getFlag;
  const listStartedHivesFn = opts.deps?.listStartedHives ?? listStartedHives;
  const getOrgPgFn = opts.deps?.getOrgPg ?? getOrgPg;
  const reconcileOneHiveFn = opts.deps?.reconcileOneHive ?? reconcileOneHive;
  try {
    if (!(await getFlagFn(FLAGS.HIVE_PLACEMENT_WATCHDOG, 'system'))) return results;
    const started = await listStartedHivesFn();
    if (started.length === 0) return results;
    const { sql } = getOrgPgFn();
    const now = opts.now ?? Date.now();
    const cfg = placementConfig();
    for (const { workspaceId, installSlug } of started) {
      try {
        results.push(...(await reconcileOneHiveFn(sql, workspaceId, installSlug, cfg, now)));
      } catch (e) {
        console.warn(
          `[hive-placement-watchdog] hive ${installSlug} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  } catch (e) {
    console.warn(`[hive-placement-watchdog] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}

/** Reconcile ONE hive's placements against `sql` (injected so it integration-tests
 *  with a test DB). Resolves the Queen owner, derives each placed unit's holder
 *  liveness, and applies the P-020/P-021/P-022 decisions. Exported for the
 *  integration test + the P-051 invariant test. */
export async function reconcileOneHive(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  cfg: PlacementConfig,
  now: number,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  const queenOwner = await resolveQueenOwner(sql, workspaceId, installSlug);
  // Without a resolvable Queen owner we can neither attribute bees to this hive
  // nor target a recovery wake — leave it to the next sweep (the hive may not
  // have run yet). The liveness watchdog still keeps the Queen armed.
  if (!queenOwner) return out;

  // 1. This hive's bees (placement targets carry the Queen as parent).
  const beeRows = await sql<
    {
      spawn_id: string;
      session_owner: string | null;
      feature_id: string | null;
      status: string;
      heartbeat_ms: number | null;
      last_output_ms: number | null;
    }[]
  >`
    SELECT spawn_id, session_owner, feature_id, status,
           extract(epoch from heartbeat_at) * 1000 AS heartbeat_ms,
           extract(epoch from last_output_at) * 1000 AS last_output_ms
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND child_role = 'bee'
       AND parent_spawn_id = ${queenOwner}`;

  const beeByOwner = new Map<string, BeeLite>();
  for (const b of beeRows) {
    const ownerId = b.session_owner || b.spawn_id;
    const bee: BeeLite = {
      spawnId: b.spawn_id,
      ownerId,
      featureId: b.feature_id,
      liveness: deriveBeeLiveness({
        status: b.status,
        heartbeatAtMs: num(b.heartbeat_ms),
        lastOutputAtMs: num(b.last_output_ms),
        now,
      }),
    };
    // Index by both owner and spawn id so a unit's taken_by resolves either way.
    beeByOwner.set(ownerId, bee);
    beeByOwner.set(b.spawn_id, bee);
  }
  const beeOwners = [...new Set(beeRows.map((b) => b.session_owner || b.spawn_id))];

  // 2. Candidate placed units: each bee's spawn-anchored unit ∪ units a bee holds
  //    (warm-inject). One fetch resolves every candidate's current row.
  const candidateIds = new Set<string>();
  for (const b of beeRows) if (b.feature_id) candidateIds.add(b.feature_id);
  if (beeOwners.length > 0) {
    const claimed = await sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId} AND taken_by = ANY(${beeOwners})`;
    for (const r of claimed) candidateIds.add(r.feature_id);
  }

  // Existing placement ledger rows for this hive (the durable counters).
  const placeRows = await sql<PlacementRow[]>`
    SELECT work_item_id, status, fail_count,
           extract(epoch from last_recovery_at) * 1000 AS last_recovery_ms,
           escalation_msg_id
      FROM harness_shared.hive_placements
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}`;
  const placeById = new Map<string, PlacementRow>(placeRows.map((p) => [p.work_item_id, p]));

  if (candidateIds.size > 0) {
    const ids = [...candidateIds];
    const unitRows = await sql<UnitRow[]>`
      SELECT feature_id, harness_slug, status, taken_by
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids})`;
    const unitById = new Map<string, UnitRow>(unitRows.map((u) => [u.feature_id, u]));

    for (const unitId of ids) {
      const unit = unitById.get(unitId);
      const existing = placeById.get(unitId);

      // Serving bee = the unit's current holder, or the bee whose spawn placed it.
      const holder = unit?.taken_by ? beeByOwner.get(unit.taken_by) : undefined;
      const anchor = beeRows.find((b) => b.feature_id === unitId);
      const anchorBee = anchor ? beeByOwner.get(anchor.session_owner || anchor.spawn_id) : undefined;
      const servingBee = holder ?? anchorBee;
      const hasLiveHolder = holder?.liveness === 'live' || anchorBee?.liveness === 'live';

      const obs: PlacementObservation = {
        workItemId: unitId,
        unitExists: Boolean(unit),
        unitTerminal: isUnitTerminal(unit?.status),
        hasLiveHolder,
        failCount: existing?.fail_count ?? 0,
        placementStatus: existing?.status ?? null,
        lastRecoveryAtMs: existing?.last_recovery_ms ?? null,
        now,
      };
      const decision = evaluatePlacement(obs, cfg);

      const base = {
        workspaceId,
        installSlug,
        workItemId: unitId,
        harnessSlug: unit?.harness_slug ?? null,
        queenOwnerId: queenOwner,
        beeSpawnId: servingBee?.spawnId ?? null,
        beeOwnerId: servingBee?.ownerId ?? null,
        now,
      };

      switch (decision.kind) {
        case 'healthy':
          await upsertPlacement(sql, {
            ...base,
            status: 'working',
            failCount: obs.failCount,
            disposition: 'working',
          });
          break;
        case 'completed':
          if (existing?.status !== 'completed') {
            await upsertPlacement(sql, {
              ...base,
              status: 'completed',
              failCount: obs.failCount,
              disposition: 'completed',
            });
            out.push({ workspaceId, installSlug, workItemId: unitId, decision: 'completed' });
            // P-032 — EDGE RESOLUTION: a completed lane that gated downstream work
            // has just un-gated it (its `blocks` edges resolve). Fire ONE Queen wake
            // so she surveys + places the now-ready next-wave batch — the wave
            // ordering executing through edge resolution, replacing the hand-rolled
            // pair-emit `:done` events (queen-wave-dispatch D-006). The survey applies
            // the precise readiness gate; we only wake when there IS non-terminal
            // downstream this lane blocks. Fires once (guarded by the status transition).
            if (base.harnessSlug) {
              const downstream = await countNonTerminalDownstream(sql, workspaceId, base.harnessSlug, unitId);
              if (downstream > 0) {
                await fireUnblockWake(workspaceId, queenOwner, unitId, base.harnessSlug, downstream);
                out.push({ workspaceId, installSlug, workItemId: unitId, decision: 'unblocked', detail: `${downstream} downstream` });
              }
            }
          }
          break;
        case 'recover':
          await upsertPlacement(sql, {
            ...base,
            status: 'recovering',
            failCount: decision.nextFailCount,
            disposition: 'recover',
            bumpRecovery: true,
          });
          await fireRecoveryWake(workspaceId, queenOwner, unitId, base.harnessSlug, decision.nextFailCount);
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'recover',
            detail: `attempt ${decision.nextFailCount}`,
          });
          break;
        case 'breaker': {
          const msgId = await escalateCursedPlacement(unitId, base.harnessSlug, decision.nextFailCount);
          await upsertPlacement(sql, {
            ...base,
            status: 'cursed',
            failCount: decision.nextFailCount,
            disposition: 'breaker',
            escalationMsgId: msgId,
          });
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'breaker',
            detail: decision.reason,
          });
          break;
        }
        case 'debounced':
          await upsertPlacement(sql, {
            ...base,
            status: 'recovering',
            failCount: obs.failCount,
            disposition: 'recover',
          });
          break;
        case 'abandon':
          if (existing && existing.status !== 'abandoned' && existing.status !== 'completed') {
            await upsertPlacement(sql, {
              ...base,
              status: 'abandoned',
              failCount: obs.failCount,
              disposition: 'abandoned',
            });
          }
          break;
      }
    }
  }

  // 3. P-022 — stranded-work resolution: stuck blockers gating downstream work.
  out.push(...(await reconcileStrandedWork(sql, workspaceId, installSlug, queenOwner, placeById, now)));
  return out;
}

/** P-020 — fire ONE targeted recovery wake to the Queen so she re-places the
 *  stalled unit without waiting for the next idle wake. Best-effort: a woken:0
 *  (Queen has no armed wake) degrades to "she sees the recovering row in
 *  hive:status on her next natural turn"; the liveness watchdog keeps her armed. */
async function fireRecoveryWake(
  workspaceId: string,
  queenOwner: string,
  unitId: string,
  harness: string | null,
  attempt: number,
): Promise<void> {
  try {
    await wakeRecipients([queenOwner], {
      summary:
        `Placement watchdog: work-item ${unitId}${harness ? ` (${harness})` : ''} is not terminal but its ` +
        `bee is dead/stalled (placement attempt ${attempt}) — re-place or recover it.`,
      payload: { kind: 'placement-recovery', workItemId: unitId, harness, attempt },
      source: 'hive-placement-watchdog',
      workspaceId,
    });
  } catch (e) {
    console.warn(`[hive-placement-watchdog] recovery wake failed for ${unitId}: ${e instanceof Error ? e.message : e}`);
  }
}

/** P-032 — count the NON-TERMINAL downstream features that `blockerId` (in `harness`)
 *  gates via a `blocks` edge: the lanes a completion may have just un-gated. Mirrors
 *  reconcileStrandedWork's edge query (the single `coord_links rel='blocks'` source of
 *  truth, D-007), with the blocker as edge SOURCE and live downstream as the target. */
async function countNonTerminalDownstream(
  sql: Sql,
  workspaceId: string,
  harness: string,
  blockerId: string,
): Promise<number> {
  const rows = await sql<{ downstream: number }[]>`
    SELECT count(*)::int AS downstream
      FROM harness_shared.coord_links l
      JOIN harness_shared.harness_features_consolidated d
        ON d.workspace_id = ${workspaceId}
       AND d.harness_slug = split_part(l.dst_ref, '#', 1)
       AND d.feature_id   = split_part(l.dst_ref, '#', 2)
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.rel = 'blocks'
       AND l.src_kind = 'feature'
       AND l.dst_kind = 'feature'
       AND l.src_ref = ${`${harness}#${blockerId}`}
       AND d.status <> ALL(${[...TERMINAL_UNIT_STATES]})`;
  return rows[0]?.downstream ?? 0;
}

/** P-032 — a completed lane that gated downstream work fires ONE Queen wake so she
 *  surveys + places the now-unblocked next-wave batch. The wave ordering executing
 *  through edge resolution — replacing the hand-rolled pair-emit `:done` events
 *  (queen-wave-dispatch D-006). Best-effort: a woken:0 (no armed wake) degrades to
 *  the Queen seeing the freed lanes in her next natural hive:survey. */
async function fireUnblockWake(
  workspaceId: string,
  queenOwner: string,
  completedId: string,
  harness: string | null,
  downstream: number,
): Promise<void> {
  try {
    await wakeRecipients([queenOwner], {
      summary:
        `Placement watchdog: ${completedId}${harness ? ` (${harness})` : ''} completed and un-gated ` +
        `${downstream} downstream lane(s) — survey + place the next wave batch.`,
      payload: { kind: 'placement-unblocked', workItemId: completedId, harness, downstream },
      source: 'hive-placement-watchdog',
      workspaceId,
    });
  } catch (e) {
    console.warn(`[hive-placement-watchdog] unblock wake failed for ${completedId}: ${e instanceof Error ? e.message : e}`);
  }
}

/** P-021 — route a cursed unit to the owner escalation queue (the D-011 Queue
 *  precursor). Returns the escalation msg_id (or null on failure). */
async function escalateCursedPlacement(unitId: string, harness: string | null, fails: number): Promise<string | null> {
  try {
    const rec = await openEscalation(watchdogIdentity, {
      severity: 'blocker',
      summary: `Cursed placement: ${unitId} failed ${fails}× — stopped auto-re-placing`,
      body:
        `Work-item ${unitId}${harness ? ` (${harness})` : ''} has been placed and lost ${fails} times without ` +
        `reaching a terminal state. Per the cursed-item circuit breaker (queen-autonomous-execution B-09 / P-021) ` +
        `the Queen has STOPPED auto-re-placing it. Investigate it (ill-specified? wedging bees?) then re-place, ` +
        `deprecate, or split it. Re-placing clears the breaker when it next completes.`,
    });
    return rec.msg_id;
  } catch (e) {
    console.warn(`[hive-placement-watchdog] cursed escalation failed for ${unitId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * P-022 — a `failing`/`failed` feature blocker that gates ≥1 non-terminal
 * downstream feature is escalated ONCE so the owner can resolve/deprecate it and
 * un-gate the downstream. Dedupe: a hive_placements row for the blocker in
 * `stranded`/`cursed` with an escalation already recorded suppresses re-escalation
 * (the breaker escalation also covers a stuck blocker that is itself cursed).
 * v1 covers feature→feature block edges (the primary case); issue-blocker
 * stranding is a follow-on.
 */
async function reconcileStrandedWork(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  queenOwner: string,
  placeById: Map<string, PlacementRow>,
  now: number,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  const blockers = await sql<
    { blocker_id: string; blocker_harness: string; blocker_status: string; downstream: number }[]
  >`
    SELECT b.feature_id AS blocker_id, b.harness_slug AS blocker_harness, b.status AS blocker_status,
           count(*)::int AS downstream
      FROM harness_shared.coord_links l
      JOIN harness_shared.harness_features_consolidated b
        ON b.workspace_id = ${workspaceId}
       AND b.harness_slug = split_part(l.src_ref, '#', 1)
       AND b.feature_id   = split_part(l.src_ref, '#', 2)
      JOIN harness_shared.harness_features_consolidated d
        ON d.workspace_id = ${workspaceId}
       AND d.harness_slug = split_part(l.dst_ref, '#', 1)
       AND d.feature_id   = split_part(l.dst_ref, '#', 2)
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.rel = 'blocks'
       AND l.src_kind = 'feature'
       AND l.dst_kind = 'feature'
       AND b.status = ANY(${[...STUCK_BLOCKER_STATES]})
       AND d.status <> ALL(${[...TERMINAL_UNIT_STATES]})
     GROUP BY b.feature_id, b.harness_slug, b.status`;

  for (const blk of blockers) {
    const existing = placeById.get(blk.blocker_id);
    // Already escalated (stranded earlier, or cursed by the breaker) → skip.
    if (existing && existing.escalation_msg_id && (existing.status === 'stranded' || existing.status === 'cursed')) {
      continue;
    }
    let msgId: string | null = null;
    try {
      const rec = await openEscalation(watchdogIdentity, {
        severity: 'blocker',
        summary: `Stuck blocker ${blk.blocker_id} is stranding ${blk.downstream} downstream work-item(s)`,
        body:
          `Blocker ${blk.blocker_id} (${blk.blocker_harness}) is ${blk.blocker_status} and gating ` +
          `${blk.downstream} non-terminal downstream work-item(s) — they cannot proceed until it resolves. ` +
          `Resolve, deprecate, or re-place the blocker to un-gate the downstream work. ` +
          `(queen-autonomous-execution B-09 / P-022)`,
      });
      msgId = rec.msg_id;
    } catch (e) {
      console.warn(`[hive-placement-watchdog] stranded escalation failed for ${blk.blocker_id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    await upsertPlacement(sql, {
      workspaceId,
      installSlug,
      workItemId: blk.blocker_id,
      harnessSlug: blk.blocker_harness,
      queenOwnerId: queenOwner,
      beeSpawnId: null,
      beeOwnerId: null,
      status: 'stranded',
      failCount: existing?.fail_count ?? 0,
      disposition: 'stranded',
      escalationMsgId: msgId,
      now,
    });
    out.push({ workspaceId, installSlug, workItemId: blk.blocker_id, decision: 'stranded', detail: `${blk.downstream} downstream` });
  }
  return out;
}

/** Open placements needing the Queen's attention — surfaced in hive:status so she
 *  acts on recoveries/cursed/stranded each wake (P-020/P-023: completion). */
export interface OpenPlacementSummary {
  recovering: number;
  cursed: number;
  stranded: number;
  workingTracked: number;
  items: Array<{ workItemId: string; status: string; failCount: number; harness: string | null }>;
}

export async function summarizeOpenPlacements(
  workspaceId: string,
  installSlug: string,
  limit = 20,
): Promise<OpenPlacementSummary> {
  const empty: OpenPlacementSummary = { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] };
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ work_item_id: string; status: string; fail_count: number; harness_slug: string | null }[]>`
      SELECT work_item_id, status, fail_count, harness_slug
        FROM harness_shared.hive_placements
       WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}
         AND status IN ('recovering', 'cursed', 'stranded', 'working')
       ORDER BY (status = 'cursed') DESC, (status = 'stranded') DESC, (status = 'recovering') DESC, updated_at DESC
       LIMIT ${limit}`;
    const summary = { ...empty, items: [] as OpenPlacementSummary['items'] };
    for (const r of rows) {
      if (r.status === 'recovering') summary.recovering++;
      else if (r.status === 'cursed') summary.cursed++;
      else if (r.status === 'stranded') summary.stranded++;
      else if (r.status === 'working') summary.workingTracked++;
      if (r.status !== 'working') {
        summary.items.push({ workItemId: r.work_item_id, status: r.status, failCount: r.fail_count, harness: r.harness_slug });
      }
    }
    return summary;
  } catch {
    return empty;
  }
}
