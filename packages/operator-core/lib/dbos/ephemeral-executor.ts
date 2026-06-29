/**
 * Per-host EPHEMERAL executor (schedule-inventory-and-ephemeral-tier-2026-06-26 P-012 / D-006).
 *
 * The ephemeral tier is the FREQUENT, non-DBOS cadence class. Where the durable tier rides DBOS
 * `routinesTick` (cron, `listDueCronRoutines` — `tier='durable'` only), an ephemeral routine
 * (`tier='ephemeral'`) rides the SAME in-process scheduled-registry that drives the host sweeps
 * (D-006: ONE in-process mechanism, not three). On harness boot, under the single-owner gate
 * (`backgroundWorkers && !utilityHost`), this executor arms ONE `managedSetInterval` PER active
 * ephemeral routine — each a dynamic registration in `@papercusp/scheduled-registry`
 * (category `'ephemeral-harness'`) so every cadence is individually VISIBLE in `schedule:inventory`
 * with its own interval + last-fire (the plan's total-visibility thesis). Disarmed on teardown/pause.
 *
 * Each tick fires the routine's deterministic ACTION via the system-actions dispatch registry
 * (`getSystemAction` — `blueprint:validate` guarantees an ephemeral action is a concrete
 * `system:<x>`, never `system:blueprint-run`), then records DURABLE per-schedule liveness by
 * UPDATEing the ONE routine row (D-004: never an INSERT per fire — this is how the EI-1622
 * `workflow_status` bloat is avoided by construction). The registry supplies the unref'd timer,
 * the per-timer re-entrancy guard (a slow tick never piles up a second run), and the shed gate.
 *
 * Pure core over injected deps (the `EphemeralExecutorDeps` seam) so unit tests drive it with a
 * fake registry/clock and a stub fire/list; `productionEphemeralExecutorDeps()` wires the real
 * PG query + system-action dispatch.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getOrgPg, listActiveEphemeralRoutines, recordEphemeralFire } from '@papercusp/db-org';
import { getSystemAction, SYSTEM_TARGET_PREFIX } from '../harness/routines/system-actions';
import { backgroundWorkspaceIds } from '../workspace-registry';
import { runWithWorkspace } from '../workspace-als';

/** Min cadence floor (seconds) — mirrors blueprint:validate's EPHEMERAL_MIN_INTERVAL_SEC. */
export const EPHEMERAL_MIN_INTERVAL_SEC = 1;
/** Global-heartbeat cadence: a single inventory-visible managed timer proving the executor is alive. */
export const EPHEMERAL_HEARTBEAT_INTERVAL_MS = 30_000;

/** One ephemeral cadence to arm. */
export interface EphemeralRoutineSpec {
  id: string;
  workspaceId: string;
  installSlug: string;
  name: string;
  /** The deterministic action the cadence fires (a `system:<x>` target). */
  targetRole: string;
  /** Cadence in seconds (from `trigger_config.interval_sec`). */
  intervalSec: number;
  payloadTemplate: Record<string, unknown> | null;
  triggerConfig: Record<string, unknown>;
}

export interface EphemeralExecutorDeps {
  /** The ACTIVE ephemeral routines to arm. */
  list: () => Promise<EphemeralRoutineSpec[]>;
  /** Fire one routine's action (resolve + run). Throws on a missing/failed action. */
  fire: (r: EphemeralRoutineSpec) => Promise<void>;
  /** Durable per-schedule liveness — UPDATE the ONE routine row (D-004), never INSERT per fire. */
  recordFire: (r: EphemeralRoutineSpec, error: string | null) => Promise<void>;
  /** Optional durable global heartbeat (best-effort). The inventory-visible heartbeat timer is the
   *  process-liveness signal regardless; this is the durable backstop when supplied. */
  heartbeat?: () => Promise<void>;
  log?: (msg: string) => void;
}

interface ArmedEphemeral {
  spec: EphemeralRoutineSpec;
  handle: ManagedHandle;
}

// Module-singleton arm-set. One executor per host (single-owner gated at the boot call site).
let armed: Map<string, ArmedEphemeral> | null = null;
let heartbeatHandle: ManagedHandle | null = null;
let liveDeps: EphemeralExecutorDeps | null = null;

const logWith = (deps: EphemeralExecutorDeps, msg: string): void =>
  (deps.log ?? ((m: string) => console.log(`[ephemeral-executor] ${m}`)))(msg);

/** Arm ONE ephemeral routine as a managed timer (category 'ephemeral-harness'). */
function armOne(spec: EphemeralRoutineSpec, deps: EphemeralExecutorDeps): ArmedEphemeral {
  const intervalSec = Math.max(EPHEMERAL_MIN_INTERVAL_SEC, Math.floor(spec.intervalSec));
  const handle = managedSetInterval(
    `ephemeral:${spec.id}`,
    intervalSec * 1000,
    async () => {
      let err: string | null = null;
      try {
        await deps.fire(spec);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
        logWith(deps, `fire failed for ${spec.id} (${spec.targetRole}): ${err}`);
      }
      // D-004: per-schedule durable liveness — UPDATE one row, never INSERT per fire.
      try {
        await deps.recordFire(spec, err);
      } catch {
        /* best-effort: liveness must never crash the tick */
      }
    },
    // The registry's re-entrancy guard + shed gate; ephemeral fires are bounded sweeps → shed-eligible.
    { category: 'ephemeral-harness', shed: true },
  );
  return { spec, handle };
}

/**
 * Arm the per-host ephemeral executor. IDEMPOTENT (a second call is a no-op). Call ONCE from
 * host-bootstrap under the single-owner gate (`backgroundWorkers && !utilityHost`).
 */
export async function armEphemeralExecutor(deps: EphemeralExecutorDeps): Promise<{ stop: () => void }> {
  if (armed) return { stop: disarmEphemeralExecutor };
  armed = new Map();
  liveDeps = deps;
  const specs = await deps.list();
  for (const spec of specs) armed.set(spec.id, armOne(spec, deps));
  if (deps.heartbeat) {
    heartbeatHandle = managedSetInterval(
      'ephemeral-executor-heartbeat',
      EPHEMERAL_HEARTBEAT_INTERVAL_MS,
      async () => {
        try {
          await deps.heartbeat!();
        } catch {
          /* best-effort */
        }
      },
      { category: 'ephemeral-harness' },
    );
  }
  logWith(deps, `armed ${specs.length} ephemeral cadence(s): ${specs.map((s) => s.name).join(', ') || '(none)'}`);
  return { stop: disarmEphemeralExecutor };
}

/**
 * Re-sync ONE routine in place (event-driven, D-006 — NOT a polling rescan): re-arm on an
 * add/edit (the cadence may have changed), idempotent. No-op when the executor is not armed on
 * this host. Pair with `unarmEphemeralRoutine` on delete/pause.
 */
export function syncEphemeralRoutine(spec: EphemeralRoutineSpec): void {
  if (!armed || !liveDeps) return;
  armed.get(spec.id)?.handle.stop();
  armed.set(spec.id, armOne(spec, liveDeps));
}

/** Stop + drop ONE ephemeral routine's timer (event-driven disarm on delete/pause). */
export function unarmEphemeralRoutine(routineId: string): void {
  if (!armed) return;
  const a = armed.get(routineId);
  if (a) {
    a.handle.stop();
    armed.delete(routineId);
  }
}

/** Disarm the whole executor (teardown / pause / test cleanup). Deregisters every timer from the inventory. */
export function disarmEphemeralExecutor(): void {
  if (armed) {
    for (const a of armed.values()) a.handle.stop();
    armed = null;
  }
  if (heartbeatHandle) {
    heartbeatHandle.stop();
    heartbeatHandle = null;
  }
  liveDeps = null;
}

/** Whether the executor is currently armed on this host (tests / introspection). */
export function ephemeralExecutorArmed(): boolean {
  return armed !== null;
}

/** The routine ids currently armed (tests / introspection). */
export function armedEphemeralIds(): string[] {
  return armed ? [...armed.keys()] : [];
}

/**
 * Production deps: the real PG arm-set + the system-action dispatch. `list` enumerates every
 * background workspace's active ephemeral routines (per-window-workspace-context P-020 — a
 * background reader has no request to scope it); `fire` resolves `getSystemAction` inside the
 * routine's workspace ALS scope; `recordFire` stamps the durable per-schedule liveness.
 */
export function productionEphemeralExecutorDeps(): EphemeralExecutorDeps {
  return {
    list: async () => {
      const out: EphemeralRoutineSpec[] = [];
      for (const ws of backgroundWorkspaceIds()) {
        const rows = await runWithWorkspace(ws, () => {
          const { sql } = getOrgPg();
          return listActiveEphemeralRoutines(sql);
        });
        for (const r of rows) {
          const intervalSec = Number(r.triggerConfig?.interval_sec);
          if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
            console.warn(`[ephemeral-executor] skipping ${r.id}: missing/invalid interval_sec`);
            continue;
          }
          out.push({
            id: r.id,
            workspaceId: r.workspaceId,
            installSlug: r.installSlug,
            name: r.name,
            targetRole: r.targetRole,
            intervalSec,
            payloadTemplate: r.payloadTemplate,
            triggerConfig: r.triggerConfig,
          });
        }
      }
      return out;
    },
    fire: async (r) => {
      // Deterministic-action-only: blueprint:validate guarantees an ephemeral action is a concrete
      // system:<x>. A non-system role is out of contract for this bounded in-process fire path.
      if (!r.targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {
        throw new Error(`ephemeral routine ${r.id} targetRole "${r.targetRole}" is not a ${SYSTEM_TARGET_PREFIX}action`);
      }
      const name = r.targetRole.slice(SYSTEM_TARGET_PREFIX.length);
      const action = getSystemAction(name);
      if (!action) throw new Error(`no system action "${name}" registered (ephemeral routine ${r.id})`);
      await runWithWorkspace(r.workspaceId, () =>
        action({
          installSlug: r.installSlug,
          workspaceId: r.workspaceId,
          triggerConfig: r.triggerConfig,
          payloadTemplate: r.payloadTemplate,
        }),
      );
    },
    recordFire: async (r, error) => {
      await runWithWorkspace(r.workspaceId, () => {
        const { sql } = getOrgPg();
        return recordEphemeralFire(sql, r.id, error);
      });
    },
  };
}
