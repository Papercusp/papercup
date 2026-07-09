/**
 * throughput.ts — hive THROUGHPUT instrumentation
 * (queen-autonomous-execution-2026-06-13, B-11 / P-050).
 *
 * The Queen hive loop places ranked work onto bees; this module measures how
 * WELL it runs and records a durable per-tick snapshot in
 * `harness_shared.hive_throughput_ticks` (migration 261), surfaced on the
 * Learning tab's "Throughput" sub-view (resolver `learning.hiveThroughput`).
 *
 * Two layers, mirroring the scout tick-ledger split:
 *   - **pure math** (`computeHiveThroughput`, `detectThroughputBreaches`) — the
 *     metric derivation + the FB-21 audit-as-sensors breach predicate, both
 *     deterministic over a plain snapshot, unit-tested with zero PG. THESE are
 *     also the deterministic half of the B-11/P-051 loop-contract invariants.
 *   - **the production edge** (`recordHiveThroughputTick`, `readHiveThroughputTicks`)
 *     — the thin PG seam. Best-effort by contract: a tick must never break the
 *     30s routinesTick it rides (observability never fails the loop it watches).
 *
 * The six throughput signals (B-11): frontier depth, placements/wake,
 * bees-busy-vs-cap, stuck count, mean-time-to-complete, and the question-rung
 * distribution (how many bee questions self-resolved vs reached the owner). The
 * last is the surface for a signal the question-ladder (B-10/B-17) feeds later —
 * an empty map today, present so the chart lights up the moment rungs flow.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

// ── tunables ─────────────────────────────────────────────────────────────────

/** A running bee is "stuck" once its heartbeat is older than this (mirrors the
 *  nursery alias-liveness 10-min window, mig 225). Env-overridable. */
export function stuckThresholdMs(): number {
  const n = Number(process.env.PAPERCUSP_HIVE_STUCK_SEC ?? 600);
  return (Number.isFinite(n) && n >= 60 ? n : 600) * 1_000;
}

/** How far back the tick reads spawn rows to compute MTTC / placements (the
 *  per-tick window is then carved from this by `lastTickAtMs`). Default 6h. */
export function throughputReadWindowMs(): number {
  const n = Number(process.env.PAPERCUSP_HIVE_THROUGHPUT_WINDOW_SEC ?? 21_600);
  return (Number.isFinite(n) && n >= 300 ? n : 21_600) * 1_000;
}

// ── pure inputs / outputs ────────────────────────────────────────────────────

/** One bee spawn row, reduced to the fields the metrics need (epoch-ms). */
export interface HiveSpawnSnapshot {
  /** running | done | failed | cancelled | reaped (spawned_agents.status). */
  status: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  /** spawned_agents.duration_ms when recorded; else derive from started/finished. */
  durationMs: number | null;
  /** spawned_agents.heartbeat_at (mig 174); null when never stamped. */
  heartbeatAtMs: number | null;
}

/** The cheap snapshot the metrics derive from — all reads the tick already does. */
export interface HiveThroughputInput {
  nowMs: number;
  /** Ready work waiting for placement (todo feature-family items) — queue depth. */
  frontierDepth: number;
  /** Fleet ceiling (maxSimultaneousAgents / SAFETY_CEILING). */
  ceiling: number;
  /** Live running bee spawns right now. */
  running: number;
  /** Recent bee spawn rows within the read window. */
  spawns: HiveSpawnSnapshot[];
  /** Previous tick's timestamp, for placements-since / completed-since. null on first tick. */
  lastTickAtMs: number | null;
  /** A running bee is stuck when its heartbeat is older than this. */
  stuckThresholdMs: number;
  /** Question-rung counts {rung -> count}; empty until the ladder feeds it. */
  questionRungs?: Record<string, number>;
}

/** The derived per-tick throughput metrics (the row, UI-shaped). */
export interface HiveThroughputMetrics {
  frontierDepth: number;
  beesBusy: number;
  beesCap: number;
  /** running / ceiling, clamped 0..1; 0 when ceiling is 0. */
  utilization: number;
  /** Bees newly placed since the previous tick (placements-per-wake proxy). */
  placements: number;
  /** Bees that finished (status='done') in the window. */
  completed: number;
  /** Mean duration (ms) over bees that finished in the window; null when none. */
  mttcMs: number | null;
  /** Running bees whose heartbeat is older than the stuck threshold. */
  stuckCount: number;
  /** {rung -> count}: bee questions resolved at each rung (empty until B-10/B-17). */
  questionRungs: Record<string, number>;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1 ? 1 : n;
}

/** Coerce a jsonb column to a plain object — tolerant of a client that hands
 *  jsonb back as a string (parse) or a legacy double-encoded scalar. */
function asJsonObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Is a spawn "in this tick's window" (started/finished after the previous tick)?
 *  On the first tick (lastTickAtMs null) the whole read window counts. */
function inWindow(at: number | null, lastTickAtMs: number | null): boolean {
  if (lastTickAtMs == null) return true;
  return at != null && at > lastTickAtMs;
}

/**
 * Derive the throughput metrics from a snapshot — PURE and deterministic (the
 * B-11/P-051 instrumentation contract). No PG, no clock; everything comes from
 * `input`. Robust to the messy real shapes: missing duration falls back to
 * finished−started, missing heartbeat falls back to started_at for staleness.
 */
export function computeHiveThroughput(input: HiveThroughputInput): HiveThroughputMetrics {
  const beesBusy = Math.max(0, Math.trunc(input.running));
  const beesCap = Math.max(0, Math.trunc(input.ceiling));
  const utilization = beesCap > 0 ? clamp01(beesBusy / beesCap) : 0;

  const placements = input.spawns.filter((s) => inWindow(s.startedAtMs, input.lastTickAtMs)).length;

  const completedSpawns = input.spawns.filter(
    (s) => s.status === 'done' && inWindow(s.finishedAtMs ?? s.startedAtMs, input.lastTickAtMs),
  );
  const durations = completedSpawns
    .map((s) => (s.durationMs != null ? s.durationMs : s.finishedAtMs != null ? s.finishedAtMs - s.startedAtMs : null))
    .filter((d): d is number => d != null && Number.isFinite(d) && d >= 0);
  const mttcMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  const stuckCount = input.spawns.filter((s) => {
    if (s.status !== 'running') return false;
    const ref = s.heartbeatAtMs ?? s.startedAtMs;
    return input.nowMs - ref > input.stuckThresholdMs;
  }).length;

  return {
    frontierDepth: Math.max(0, Math.trunc(input.frontierDepth)),
    beesBusy,
    beesCap,
    utilization,
    placements,
    completed: completedSpawns.length,
    mttcMs,
    stuckCount,
    questionRungs: input.questionRungs ?? {},
  };
}

// ── FB-21 audit-as-sensors: a breach files through capture ───────────────────

/** A throughput breach worth escalating — filed as an improvement (FB-21). */
export interface HiveThroughputBreach {
  kind: 'starvation' | 'stuck';
  title: string;
  body: string;
  severity: 'warn' | 'error';
  /** Stable cross-tick identity so a persistent breach files once, not per tick. */
  watchdogKey: string;
}

export interface HiveThroughputBreachContext {
  /** Owner steering maxBees knob for this hive. Null/undefined means no owner cap. */
  ownerMaxBees?: number | null;
  /** System-level spawn cap before owner maxBees lowers it. */
  systemCeiling?: number | null;
}

function positiveInt(n: number | null | undefined): number | null {
  return Number.isFinite(n) && n != null && n > 0 ? Math.trunc(n) : null;
}

function saturatedOnlyByOwnerCeiling(
  metrics: HiveThroughputMetrics,
  context: HiveThroughputBreachContext | undefined,
): boolean {
  const ownerMaxBees = positiveInt(context?.ownerMaxBees);
  const systemCeiling = positiveInt(context?.systemCeiling);
  return (
    ownerMaxBees != null &&
    systemCeiling != null &&
    ownerMaxBees < systemCeiling &&
    metrics.beesCap === ownerMaxBees &&
    metrics.beesBusy >= ownerMaxBees
  );
}

/**
 * The sensor predicate (FB-21): which metrics constitute a breach to escalate.
 * PURE — the orchestrator files whatever this returns. Two breaches, each with
 * its own stable key (cross-tick dedup keeps a standing breach from flooding):
 *   - **starvation**: the fleet is pegged at cap (utilization=1) with ready work
 *     still queued — adding bees is impossible, the backlog can only grow.
 *   - **stuck**: one or more placed bees have a stale heartbeat — placements that
 *     stopped advancing, which the Queen's next idle wake would otherwise miss.
 */
export function detectThroughputBreaches(
  metrics: HiveThroughputMetrics,
  potSlug: string,
  context?: HiveThroughputBreachContext,
): HiveThroughputBreach[] {
  const breaches: HiveThroughputBreach[] = [];
  if (
    metrics.beesCap > 0 &&
    metrics.utilization >= 1 &&
    metrics.frontierDepth > 0 &&
    !saturatedOnlyByOwnerCeiling(metrics, context)
  ) {
    breaches.push({
      kind: 'starvation',
      severity: 'warn',
      watchdogKey: `governor-starvation:${potSlug}`,
      title: `Hive ${potSlug}: fleet saturated with work still queued`,
      body:
        `All ${metrics.beesCap} bee slot(s) are busy while ${metrics.frontierDepth} ready ` +
        `item(s) wait for placement. The frontier can only grow until a bee frees a slot — ` +
        `raise the fleet ceiling (rate-limit config) or widen the credential pool (D-006).`,
    });
  }
  if (metrics.stuckCount > 0) {
    breaches.push({
      kind: 'stuck',
      severity: 'error',
      watchdogKey: `orphaned-spawn:${potSlug}:throughput`,
      title: `Hive ${potSlug}: ${metrics.stuckCount} placed bee(s) stuck`,
      body:
        `${metrics.stuckCount} running bee(s) have a stale heartbeat (no progress past the ` +
        `stuck threshold). A stalled placement holds its slot without advancing — it needs a ` +
        `recovery wake or reclaim (the placement watchdog, P-020).`,
    });
  }
  return breaches;
}

// ── the "operating well" yardstick (P-050/P-051) ─────────────────────────────

/**
 * The placement yardstick: how many bees an ideal Queen wake SHOULD place given
 * the ready frontier (N) and free slots (M) — `min(N, M)`. Pure and total. This
 * is the TARGET the behavioral contract (B-07 batch placement) is measured
 * against; today the prompt-driven Queen is scored against it, and the B-11/
 * P-051 contract test asserts a real wake achieves it once B-07 lands.
 */
export function idealPlacements(frontierDepth: number, headroom: number): number {
  return Math.max(0, Math.min(Math.trunc(frontierDepth), Math.trunc(headroom)));
}

/**
 * Is the loop "operating well" this tick? A pure yardstick over the metrics:
 * no stuck placements, and not starved (the fleet has slack OR the frontier is
 * empty). The single boolean the Throughput view's health tone keys off.
 */
export function isOperatingWell(m: HiveThroughputMetrics): boolean {
  const starved = m.beesCap > 0 && m.utilization >= 1 && m.frontierDepth > 0;
  return m.stuckCount === 0 && !starved;
}

// ── the production edge (best-effort PG seam) ────────────────────────────────

/** What the tick wrote (returned for tests / callers; not persisted as-is). */
export interface HiveThroughputTickResult {
  recorded: boolean;
  metrics: HiveThroughputMetrics;
  breaches: HiveThroughputBreach[];
}

interface SpawnRow {
  status: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  duration_ms: string | number | null;
  heartbeat_at: string | Date | null;
}

function ms(v: string | Date | null | undefined): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * Take + persist one throughput tick for a started hive. Best-effort: every PG
 * read/write is guarded, and a failure degrades to `recorded:false` (never
 * throws — the 30s routinesTick must survive a transient DB blip). Files FB-21
 * breach signals through captureImprovement and pushes the Learning tab.
 */
export async function recordHiveThroughputTick(opts: {
  potSlug: string;
  workspaceId?: string;
  now?: number;
}): Promise<HiveThroughputTickResult> {
  const nowMs = opts.now ?? Date.now();
  const empty: HiveThroughputMetrics = {
    frontierDepth: 0,
    beesBusy: 0,
    beesCap: 0,
    utilization: 0,
    placements: 0,
    completed: 0,
    mttcMs: null,
    stuckCount: 0,
    questionRungs: {},
  };
  try {
    const { sql } = getOrgPg();
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const windowStart = new Date(nowMs - throughputReadWindowMs());

    // Frontier + headroom + spawns + last-tick, all cheap workspace-scoped reads.
    const { hiveDemandCheck } = await import('./watchdog');
    const { getSpawnHeadroom } = await import('../fleet/operator-spawn');
    const { hivePlaceableFrontierDepth } = await import('./survey');
    const [demand, headroom, spawnRows, lastRows, placeableFrontier] = await Promise.all([
      hiveDemandCheck(ws).catch(() => ({ demand: false, todoItems: 0, startedPlans: 0 })),
      getSpawnHeadroom(ws).catch(() => ({ ceiling: 0, running: 0, headroom: 0 })),
      sql<SpawnRow[]>`
        SELECT status, started_at, finished_at, duration_ms, heartbeat_at
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${ws} AND child_role IN ('bee', 'cup')
           AND started_at > ${windowStart}`.catch(() => [] as SpawnRow[]),
      sql<Array<{ tick_at: string | Date }>>`
        SELECT tick_at FROM harness_shared.hive_throughput_ticks
         WHERE workspace_id = ${ws} AND pot_slug = ${opts.potSlug}
         ORDER BY tick_at DESC LIMIT 1`.catch(() => [] as Array<{ tick_at: string | Date }>),
      // WI-267: the hive's REAL placeable-frontier depth (member-scoped; feature-kind,
      // todo, unassigned, not-cursed) — NOT the workspace-wide demand.todoItems — so the
      // starvation breach gates on what THIS Queen can actually place. Fail-soft ⇒ 0 (a
      // flaky read must never manufacture a false 'saturated with work queued' alarm).
      hivePlaceableFrontierDepth(ws, opts.potSlug).catch(() => 0),
    ]);

    const spawns: HiveSpawnSnapshot[] = spawnRows.map((r) => ({
      status: String(r.status ?? ''),
      startedAtMs: ms(r.started_at) ?? nowMs,
      finishedAtMs: ms(r.finished_at),
      durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
      heartbeatAtMs: ms(r.heartbeat_at),
    }));

    const metrics = computeHiveThroughput({
      nowMs,
      // WI-267: real placeable frontier (member-scoped) — was demand.todoItems (workspace-wide).
      frontierDepth: placeableFrontier,
      ceiling: headroom.ceiling,
      running: headroom.running,
      spawns,
      lastTickAtMs: ms(lastRows[0]?.tick_at),
      stuckThresholdMs: stuckThresholdMs(),
    });
    let ownerMaxBees: number | null = null;
    let systemCeiling: number | null = null;
    try {
      const [{ getOwnerSteering }, { spawnConcurrencyCeiling }] = await Promise.all([
        import('../owner-steering'),
        import('../fleet/operator-spawn'),
      ]);
      const steering = await getOwnerSteering(ws, opts.potSlug);
      ownerMaxBees = steering.maxBees ?? null;
      systemCeiling = spawnConcurrencyCeiling();
    } catch {
      // Fail open: a steering read fault must not hide a genuine starvation breach.
    }
    const breaches = detectThroughputBreaches(metrics, opts.potSlug, { ownerMaxBees, systemCeiling });

    await sql`
      INSERT INTO harness_shared.hive_throughput_ticks
        (workspace_id, pot_slug, frontier_depth, placements, bees_busy, bees_cap,
         stuck_count, completed, mttc_ms, question_rungs, detail)
      VALUES
        (${ws}, ${opts.potSlug}, ${metrics.frontierDepth}, ${metrics.placements},
         ${metrics.beesBusy}, ${metrics.beesCap}, ${metrics.stuckCount}, ${metrics.completed},
         ${metrics.mttcMs}, ${JSON.stringify(metrics.questionRungs)}::text::jsonb,
         ${JSON.stringify({
           utilization: metrics.utilization,
           stuckThresholdMs: stuckThresholdMs(),
           startedPlans: demand.startedPlans,
           breaches: breaches.map((b) => b.kind),
         })}::text::jsonb)`;

    // FB-21 audit-as-sensors: a breach files through capture (best-effort, deduped
    // by watchdogKey so a standing breach files once, not every 30s tick).
    if (breaches.length) {
      const { captureImprovement } = await import('../harness/improvements/capture-core');
      for (const b of breaches) {
        await captureImprovement({
          title: b.title,
          body: b.body,
          kind: 'bug',
          severity: b.severity === 'error' ? 'major' : 'minor',
          scope: `harness:${opts.potSlug}`,
          sourceRole: 'system',
          source: 'su',
          watchdogKey: b.watchdogKey,
          dedupScope: 'open',
          evidenceAt: new Date(nowMs).toISOString(),
          findingClass: `hive-throughput:${b.kind}`,
          foundDuring: 'hive-throughput-tick',
        }).catch((e) => {
          console.warn(`[hive-throughput] breach capture failed (${b.kind}): ${e instanceof Error ? e.message : e}`);
        });
      }
    }

    // Push the Learning tab's Throughput view. Fire-and-forget via lazy import so
    // the PG seam (+ tests) never statically depends on the SSE layer.
    void import('../sync-sse')
      .then((m) => m.notifySyncInvalidate('learning.hiveThroughput'))
      .catch(() => {});

    return { recorded: true, metrics, breaches };
  } catch (e) {
    console.warn(`[hive-throughput] tick failed (${opts.potSlug}): ${e instanceof Error ? e.message : e}`);
    return { recorded: false, metrics: empty, breaches: [] };
  }
}

// ── read seam (the resolver reads through normalizeThroughputRow) ────────────

/** One throughput tick row, camelCase mirror of the migration-261 columns. */
export interface HiveThroughputTickRow extends HiveThroughputMetrics {
  potSlug: string;
  tickAt: string;
}

/** The raw migration-261 row shape (snake_case, postgres-typed). */
export interface RawThroughputTickRow {
  pot_slug: string;
  tick_at: string | Date;
  frontier_depth: number | null;
  placements: number | null;
  bees_busy: number | null;
  bees_cap: number | null;
  stuck_count: number | null;
  completed: number | null;
  mttc_ms: string | number | null;
  question_rungs: Record<string, number> | null;
  detail: Record<string, unknown> | null;
}

/**
 * Map one raw tick row into the UI-shaped {@link HiveThroughputTickRow}. PURE —
 * shared by the resolver read (learning-hive-throughput-read.ts) so the row
 * contract lives in one place. Utilization prefers the persisted detail value,
 * else re-derives from busy/cap (resilient to a detail-less row).
 */
export function normalizeThroughputRow(r: RawThroughputTickRow): HiveThroughputTickRow {
  const beesBusy = Number(r.bees_busy ?? 0);
  const beesCap = Number(r.bees_cap ?? 0);
  const mttc = r.mttc_ms == null ? null : Number(r.mttc_ms);
  const detailUtil = asJsonObject(r.detail)?.utilization;
  const rungs = asJsonObject(r.question_rungs);
  return {
    potSlug: String(r.pot_slug ?? ''),
    tickAt: r.tick_at instanceof Date ? r.tick_at.toISOString() : new Date(r.tick_at).toISOString(),
    frontierDepth: Number(r.frontier_depth ?? 0),
    beesBusy,
    beesCap,
    utilization:
      typeof detailUtil === 'number' && Number.isFinite(detailUtil)
        ? clamp01(detailUtil)
        : beesCap > 0
          ? clamp01(beesBusy / beesCap)
          : 0,
    placements: Number(r.placements ?? 0),
    completed: Number(r.completed ?? 0),
    mttcMs: mttc != null && Number.isFinite(mttc) ? mttc : null,
    stuckCount: Number(r.stuck_count ?? 0),
    questionRungs: (rungs as Record<string, number> | null) ?? {},
  };
}
