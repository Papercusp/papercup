/**
 * append-heavy-invalidator — the DEBOUNCED live-invalidation producer for the append-heavy
 * activity-LOG tables (data-sync-push-completion P-005 / D-012).
 *
 * THE PROBLEM. The six APPEND_HEAVY_TABLES (audit_log, agent_runs_consolidated, user_actions,
 * harness_hook_logs, toast_log, feature_audit_consolidated) are MAPPED in TABLE_TO_QUERY_NAMES
 * but INTENTIONALLY carry NO per-row emit_change_notify trigger — a per-row pg_notify on a
 * high-write log is the notify-storm anti-pattern (mig 376 drops it; cache-tag-trigger-coverage's
 * COVERAGE_EXEMPT documents it). So their mapped sync queries (userActions.recent / byHarness /
 * byKind, auditLog.*, toastLog.recent, …) did NOT live-update on a write — the COVERAGE_EXEMPT
 * "Debounced invalidation TODO (P-005)". Consumers had to fall back to a client poll (the
 * AdvOverviewTab Activity tile) or go stale until the 180s drift-repair.
 *
 * THE FIX. ONE cheap detector instead of a per-row trigger OR per-client poll: poll `max(id)`
 * per table on a fixed cadence; when it advances, synthesize a single `harness_shared.<table>.changed`
 * invalidation — the SAME event the real trigger would emit — so the existing sync-sse bridge
 * fans it to every mapped query name + every connected client. ONE poll serves ALL clients, and
 * the synthesized fire is rate-limited to the poll cadence, so there is no per-row storm.
 *
 * Self-debounced ⇒ it passes a SHORT `dedupeWindowMs` so the bus's 90s default (built to collapse
 * a chatty per-row reconcile) does not WRONGLY collapse its legitimate per-tick fires to one/90s.
 *
 * Detection = `max(id)` (bigserial PK), which catches new rows — the dominant change for append
 * LOGS. A pure UPDATE that does not advance the PK (e.g. user_actions running→completed) is picked
 * up on the next INSERT or the 180s drift-repair; acceptable for an activity feed.
 *
 * Host-only (opens a PG connection, fires server invalidations). RLS: reads go through a
 * BYPASSRLS admin connection (mig 016) so `max(id)` sees every workspace; the synthesized
 * invalidation is name-only (full-bust), so each client refetches its own scope.
 */
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { notifySyncInvalidate } from '../sync-sse';
import { APPEND_HEAVY_TABLES } from './table-to-query-names';

const DEFAULT_POLL_MS = 8_000;
// < poll cadence, so consecutive per-tick fires are NOT collapsed; still long enough to
// collapse a same-tick burst if more than one host runs the detector.
const DEFAULT_DEDUPE_MS = 5_000;

/** Injectable seams so the loop is unit-testable without a real DB / bus / clock. */
export interface AppendHeavyInvalidatorDeps {
  /** Tables to watch. Default {@link APPEND_HEAVY_TABLES}. */
  tables?: readonly string[];
  /** Poll cadence (ms). Default 8000. */
  pollMs?: number;
  /** Per-fire dedupe window passed to the bus (ms). Default 5000. */
  dedupeWindowMs?: number;
  /** Read the table's current max(id). Returns null/undefined when empty. */
  maxId: (table: string) => Promise<bigint | number | null | undefined>;
  /** Emit the synthesized `harness_shared.<table>.changed` invalidation. */
  emitChanged: (eventName: string, dedupeWindowMs: number) => Promise<void>;
  /** setTimeout seam (default global). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  onError?: (where: string, err: unknown) => void;
  log?: (msg: string) => void;
}

/**
 * Run ONE detection sweep over `tables`, firing a synthesized `.changed` invalidation for each
 * table whose max(id) advanced since `lastSeen`. The FIRST observation of a table only records
 * its baseline (no fire) so boot doesn't spuriously full-bust every consumer. Mutates `lastSeen`.
 * Exported for the unit test.
 */
export async function sweepAppendHeavy(
  tables: readonly string[],
  lastSeen: Map<string, bigint>,
  maxId: AppendHeavyInvalidatorDeps['maxId'],
  emitChanged: AppendHeavyInvalidatorDeps['emitChanged'],
  dedupeWindowMs: number,
  onError?: AppendHeavyInvalidatorDeps['onError'],
): Promise<void> {
  for (const table of tables) {
    try {
      const raw = await maxId(table);
      if (raw == null) continue; // empty table — nothing to detect yet
      const cur = BigInt(raw);
      const prev = lastSeen.get(table);
      lastSeen.set(table, cur);
      if (prev === undefined) continue; // baseline only — no fire on first observation
      if (cur > prev) {
        await emitChanged(`harness_shared.${table}.changed`, dedupeWindowMs);
      }
    } catch (err) {
      onError?.(`append-heavy:${table}`, err);
    }
  }
}

/**
 * Start the detection loop. Returns a stop handle. Pure of I/O wiring — pass `maxId`/`emitChanged`
 * (the host wrapper {@link startAppendHeavyInvalidatorHost} supplies the real ones).
 */
export function startAppendHeavyInvalidator(deps: AppendHeavyInvalidatorDeps): () => void {
  const tables = deps.tables ?? APPEND_HEAVY_TABLES;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const dedupeWindowMs = deps.dedupeWindowMs ?? DEFAULT_DEDUPE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const lastSeen = new Map<string, bigint>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    await sweepAppendHeavy(tables, lastSeen, deps.maxId, deps.emitChanged, dedupeWindowMs, deps.onError);
    if (!stopped) timer = setTimer(() => void tick(), pollMs);
  };
  // Kick off; the first sweep records baselines (no fires).
  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
  };
}

/**
 * Host wrapper: wires the real BYPASSRLS admin connection + the sync-sse bridge. Call once at
 * operator-host boot (flag-gated). Returns a stop handle that also closes the connection.
 */
export function startAppendHeavyInvalidatorHost(opts?: {
  pollMs?: number;
  dedupeWindowMs?: number;
  log?: (msg: string) => void;
}): () => void {
  // Dedicated single connection on the BYPASSRLS admin URL (mig 016) so max(id) sees every
  // workspace's rows. max:1 — one long-lived poller connection, never per-call (perf-doc A-pattern).
  const sql = postgres(getHarnessAdminUrl(), { max: 1, idle_timeout: 0, connect_timeout: 30 });
  const stop = startAppendHeavyInvalidator({
    pollMs: opts?.pollMs,
    dedupeWindowMs: opts?.dedupeWindowMs,
    maxId: async (table) => {
      // table comes from the hardcoded APPEND_HEAVY_TABLES allow-list (never user input);
      // sql(table) escapes the identifier regardless.
      const rows = await sql<{ m: string | number | null }[]>`
        SELECT max(id) AS m FROM harness_shared.${sql(table)}`;
      return rows[0]?.m ?? null;
    },
    emitChanged: (eventName, dedupeWindowMs) =>
      notifySyncInvalidate(eventName, undefined, undefined, { dedupeWindowMs }),
    onError: (where, err) => (opts?.log ?? console.error)(`[append-heavy-invalidator] ${where}: ${String(err)}`),
    log: opts?.log,
  });
  return () => {
    stop();
    void sql.end({ timeout: 5 });
  };
}
