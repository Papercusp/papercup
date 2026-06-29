/**
 * schedule-inventory — the central, read-only union of every scheduled/recurring
 * thing in the operator host, regardless of cadence
 * (plan schedule-inventory-and-ephemeral-tier-2026-06-26, P-002).
 *
 * Today scheduling is split across siloed surfaces with no single view. This
 * collapses the currently-available ones into ONE row shape:
 *   - DBOS scheduled workflows (durable tier) — via dbos-schedule-introspect (P-001)
 *   - harness_shared.routines (durable tier; fired by the DBOS routinesTick)
 *   - in-process-periodic checks (ephemeral tier; the EI-1622 host health sweeps)
 * Later sources plug in here unchanged: the managedSetInterval registry (P-006,
 * source 'managed') and per-process registries (P-014). Per D-006, `tier` maps to
 * the TWO execution mechanisms: durable (DBOS) | ephemeral (in-process).
 *
 * Pure aggregation with injectable source seams — the MCP tool (schedule:inventory)
 * and the /admin/schedules data path (P-003) both call collectScheduleInventory().
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { listDbosScheduledWorkflows, type DbosScheduledEntry } from './dbos/dbos-schedule-introspect';
import { buildDefaultChecks, inProcessPeriodicChecksArmed } from './dbos/in-process-periodic';
import { listManaged, type ManagedEntry } from '@papercusp/scheduled-registry';

export type ScheduleSource = 'dbos' | 'routines' | 'in-process' | 'managed' | 'external-process';
export type ScheduleScope = 'operator' | 'harness';
/** Execution mechanism (D-006): durable = DBOS-backed; ephemeral = in-process setInterval. */
export type ScheduleTier = 'durable' | 'ephemeral';

export interface ScheduleInventoryRow {
  source: ScheduleSource;
  scope: ScheduleScope;
  tier: ScheduleTier;
  /** finer audit class: dbos-scheduled | routine | global-sweep | (later) lifecycle/watchdog/cache/ephemeral-harness */
  category: string;
  name: string;
  /** routines carry an install slug; null otherwise. */
  installSlug: string | null;
  /** crontab, or a human interval like "every 30s". */
  cadence: string;
  /** armed/active where known; null when not applicable. */
  armed: boolean | null;
  /** ISO last-fire, or null. */
  lastFire: string | null;
  /** ISO next-fire, or null. */
  nextFire: string | null;
  lastError: string | null;
  /** source-specific extras (mode, queue, targetRole, intervalMs, shed, …). */
  detail: Record<string, unknown>;
}

export interface RoutineRow {
  install_slug: string;
  name: string;
  trigger_kind: string;
  trigger_config: Record<string, unknown> | null;
  target_role: string;
  active: boolean;
  next_fire_at: Date | null;
  last_fired_at: Date | null;
  metadata: Record<string, unknown> | null;
}

export interface InProcessCheckLite {
  name: string;
  intervalMs: number;
  shed?: boolean;
  fireOnArm?: boolean;
}
export interface InProcessChecksResult {
  checks: InProcessCheckLite[];
  armed: boolean;
}

/**
 * A bespoke recurring timer in a SEPARATE process (NOT the operator host registry) — P-014.
 * Listed in the inventory for VISIBILITY; its live fire-state (armed/last-fire) requires
 * per-process federation (the follow-on, once each process exposes its managed-timer list over
 * its own admin/IPC), so until then armed/lastFire are null. Source of truth = each process's code.
 */
export interface ExternalProcessTimer {
  /** The owning process — the per-process sub-list grouping (D-007). */
  process: string;
  name: string;
  /** Human cadence where statically known, else '(external)'. */
  cadence: string;
  /** Repo source location the timer lives at. */
  source: string;
}

/**
 * STATIC manifest of the known external-process timers (mirrors P-009 / D-007). These run in the
 * inference gateway (:8788), its standalone systemd watchdog, and the psu-launcher — all
 * allow-listed from the host `check-no-raw-setinterval` guard. This static list is the plan's
 * OR-clause ("list each as category 'external-process'"); LIVE federation (real fire-state over
 * each process's admin/IPC) is the documented follow-on that replaces it.
 */
export const EXTERNAL_PROCESS_TIMERS: ExternalProcessTimer[] = [
  { process: 'inference-gateway', name: 'gateway-serviceable-admission-clamp', cadence: 'every ~2s', source: 'packages/operator-core/lib/inference-gateway/gateway.ts' },
  { process: 'inference-gateway', name: 'gateway-self-heal', cadence: 'every ~10s', source: 'packages/operator-core/lib/inference-gateway/gateway.ts' },
  { process: 'inference-gateway', name: 'gateway-readiness-probe', cadence: '(external)', source: 'packages/operator-core/lib/inference-gateway/launch.ts' },
  { process: 'inference-gateway', name: 'gateway-reload-check', cadence: '(external)', source: 'packages/operator-core/lib/inference-gateway/launch.ts' },
  { process: 'gateway-watchdog', name: 'gateway-watchdog-poll', cadence: 'every ~15s', source: 'packages/operator-core/lib/inference-gateway/watchdog.mjs' },
  { process: 'psu-launcher', name: 'psu-supervisor-heartbeat', cadence: 'every ~60s', source: 'apps/operator/scripts/psu-launcher.mjs' },
];

export interface ScheduleInventoryDeps {
  getDbosSchedules: () => Promise<DbosScheduledEntry[]>;
  getRoutines: () => Promise<RoutineRow[]>;
  /** LIVE managed timers from the scheduled-registry (source 'managed') — the actually-armed in-process timers with real fire times. */
  getManaged: () => ManagedEntry[];
  /** STATIC fallback: the known in-process sweeps as config (source 'in-process'), for checks not armed in THIS process. */
  getInProcessChecks: () => InProcessChecksResult;
  /** STATIC manifest of separate-process timers (source 'external-process', P-014); live fire-state requires federation (follow-on). */
  getExternalProcess: () => ExternalProcessTimer[];
}

const iso = (d: Date | null | undefined): string | null =>
  d && !Number.isNaN(new Date(d).getTime()) ? new Date(d).toISOString() : null;

const isoFromMs = (ms: number | null): string | null =>
  ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/** "every 30s" / "every 5m" — a readable cadence for an interval-driven check. */
export function humanInterval(intervalMs: number): string {
  if (intervalMs % 3_600_000 === 0) return `every ${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `every ${intervalMs / 60_000}m`;
  return `every ${Math.round(intervalMs / 1000)}s`;
}

async function defaultGetRoutines(): Promise<RoutineRow[]> {
  try {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    return await sql<RoutineRow[]>`
      SELECT install_slug, name, trigger_kind, trigger_config, target_role,
             active, next_fire_at, last_fired_at, metadata
        FROM harness_shared.routines
       WHERE workspace_id = ${ws}
       ORDER BY install_slug, name`;
  } catch {
    return [];
  }
}

function defaultGetInProcessChecks(): InProcessChecksResult {
  let armed = false;
  try {
    armed = inProcessPeriodicChecksArmed();
  } catch {
    /* not loaded in this process */
  }
  let checks: InProcessCheckLite[] = [];
  try {
    checks = buildDefaultChecks().map((c) => ({
      name: c.name,
      intervalMs: c.intervalMs,
      shed: c.shed,
      fireOnArm: c.fireOnArm,
    }));
  } catch {
    /* ignore */
  }
  return { checks, armed };
}

/**
 * Collect the unified schedule inventory across all currently-available sources.
 * Each source seam is independently fail-soft — one source erroring yields its
 * empty slice, never a thrown inventory.
 */
export async function collectScheduleInventory(
  deps: Partial<ScheduleInventoryDeps> = {},
): Promise<ScheduleInventoryRow[]> {
  const getDbos = deps.getDbosSchedules ?? (() => listDbosScheduledWorkflows());
  const getRoutines = deps.getRoutines ?? defaultGetRoutines;
  const getChecks = deps.getInProcessChecks ?? defaultGetInProcessChecks;
  const getManaged = deps.getManaged ?? (() => listManaged());
  const getExternal = deps.getExternalProcess ?? (() => EXTERNAL_PROCESS_TIMERS);

  const [dbos, routines] = await Promise.all([
    getDbos().catch(() => [] as DbosScheduledEntry[]),
    getRoutines().catch(() => [] as RoutineRow[]),
  ]);
  let inproc: InProcessChecksResult;
  try {
    inproc = getChecks();
  } catch {
    inproc = { checks: [], armed: false };
  }
  let managed: ManagedEntry[];
  try {
    managed = getManaged();
  } catch {
    managed = [];
  }
  let external: ExternalProcessTimer[];
  try {
    external = getExternal();
  } catch {
    external = [];
  }

  const rows: ScheduleInventoryRow[] = [];

  for (const d of dbos) {
    rows.push({
      source: 'dbos',
      scope: 'operator',
      tier: 'durable',
      category: 'dbos-scheduled',
      name: d.name,
      installSlug: null,
      cadence: d.crontab,
      armed: true, // a registered schedule is live in this process
      lastFire: isoFromMs(d.lastFireMs),
      nextFire: null,
      lastError: null,
      detail: { mode: d.mode, queueName: d.queueName, lastStatus: d.lastStatus },
    });
  }

  for (const r of routines) {
    const cron = (r.trigger_config as { cron?: string } | null)?.cron ?? null;
    const lastError =
      (r.metadata as { last_error?: unknown } | null)?.last_error != null
        ? String((r.metadata as { last_error?: unknown }).last_error)
        : null;
    rows.push({
      source: 'routines',
      scope: 'operator',
      tier: 'durable', // routines are fired by the DBOS routinesTick
      category: 'routine',
      name: r.name,
      installSlug: r.install_slug,
      cadence: cron ?? r.trigger_kind,
      armed: r.active,
      lastFire: iso(r.last_fired_at),
      nextFire: iso(r.next_fire_at),
      lastError,
      detail: { triggerKind: r.trigger_kind, targetRole: r.target_role },
    });
  }

  // source 'managed' — the LIVE scheduled-registry (P-006): actually-armed in-process
  // timers (the re-homed host sweeps + any codemod'd bespoke timers) with real fire
  // times. All managed timers are the in-process (ephemeral) mechanism per D-006.
  const managedNames = new Set(managed.map((m) => m.name));
  for (const m of managed) {
    rows.push({
      source: 'managed',
      scope: 'operator',
      tier: 'ephemeral',
      category: m.category,
      name: m.name,
      installSlug: null,
      cadence: humanInterval(m.intervalMs),
      armed: true, // present in the registry == armed in this process
      lastFire: isoFromMs(m.lastFireAt),
      nextFire: null,
      lastError: m.lastError,
      detail: {
        intervalMs: m.intervalMs,
        shed: m.shed,
        fires: m.fires,
        armedAt: m.armedAt,
        running: m.running,
        instances: m.instances ?? 1,
        instanced: m.instanced ?? false,
      },
    });
  }

  // source 'in-process' — STATIC fallback: known sweeps NOT currently armed as managed
  // timers in THIS process (e.g. a :3070 request worker), so they're still listed
  // (armed=false) instead of vanishing. Deduped against the live managed set above.
  for (const c of inproc.checks) {
    if (managedNames.has(c.name)) continue;
    rows.push({
      source: 'in-process',
      scope: 'operator',
      tier: 'ephemeral',
      category: 'global-sweep',
      name: c.name,
      installSlug: null,
      cadence: humanInterval(c.intervalMs),
      armed: inproc.armed,
      lastFire: null,
      nextFire: null,
      lastError: null,
      detail: { intervalMs: c.intervalMs, shed: c.shed ?? false, fireOnArm: c.fireOnArm ?? false },
    });
  }

  // source 'external-process' — bespoke timers in SEPARATE processes (P-014): the inference
  // gateway, its standalone watchdog, the psu-launcher. Listed for VISIBILITY (the per-process
  // sub-list is detail.process); armed/lastFire are null because live fire-state requires the
  // per-process federation follow-on.
  for (const e of external) {
    rows.push({
      source: 'external-process',
      scope: 'operator',
      tier: 'ephemeral',
      category: 'external-process',
      name: e.name,
      installSlug: null,
      cadence: e.cadence,
      armed: null,
      lastFire: null,
      nextFire: null,
      lastError: null,
      detail: { process: e.process, source: e.source, note: 'static manifest — live fire-state requires P-014 federation' },
    });
  }

  return rows.sort(
    (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );
}

/** Small rollup for headers/badges. */
export function summarizeInventory(rows: ScheduleInventoryRow[]): {
  total: number;
  bySource: Record<string, number>;
  byTier: Record<string, number>;
} {
  const bySource: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
  }
  return { total: rows.length, bySource, byTier };
}
