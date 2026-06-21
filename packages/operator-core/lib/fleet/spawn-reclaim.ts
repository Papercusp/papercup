/**
 * fleet/spawn-reclaim — reclaim orphaned `spawned_agents` rows
 * (unify-agent-spawn-chokepoint-2026-06-06, P-011).
 *
 * A 'running'/'restarting' nursery row whose launching operator host died was
 * never reclaimed — it counted forever against the global concurrency ceiling
 * (the `operator-spawn.ts` "lease/timeout reclaims them" comment was aspirational;
 * no such mechanism existed). The live host now heartbeats `heartbeat_at` for its
 * own in-flight spawns (`heartbeatSpawns`); a row whose heartbeat goes stale
 * beyond `RECLAIM_STALE_MS` is presumed orphaned (host dead) and reclaimed to
 * 'failed' (`reclaimOrphanedSpawns`), freeing the ceiling.
 *
 * This is the deterministic SAFETY-floor half of the spawn chokepoint
 * (Phase 2 / durability-by-class): fail-loud + free. Re-running an autonomous
 * spawn idempotently on crash is the durable-spawn-wrapper's job (P-010); this
 * sweep only un-wedges the concurrency ceiling.
 *
 * Migration 174 adds `heartbeat_at` + the partial sweep index.
 * EI-108: When reclaiming a spawn with a parent, also wake the parent.
 */
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { wakeParentOnChildDeath } from './parent-wake';

/** A query handle — a pooled client or an open transaction. */
type Db = Sql | TransactionSql;

/** Cadence the live host bumps `heartbeat_at` for its in-flight spawns. */
export const SPAWN_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Per-process boot id (EI-2186) — a nonce minted ONCE when this operator process
 * starts. Stamped on every nursery row this process launches (`recordSpawnPid`).
 * Its job: tell a row launched by THIS live process apart from one left behind by
 * a DEAD prior incarnation on the same host, WITHOUT depending on a pid — which is
 * not stable across a host restart (the rebooted box reuses the same low pids for
 * unrelated processes, so a stale row's recorded pid can read as "alive" and wedge
 * the concurrency ceiling forever). A `running` row whose `launcher_host` is mine
 * but whose `launcher_boot_id` ≠ this is provably orphaned. Mutable only via
 * `__setLauncherBootIdForTests` so the integration tests can simulate "a row from
 * a prior boot".
 */
let LAUNCHER_BOOT_ID = randomUUID();

/** The current process's boot id (EI-2186). */
export function launcherBootId(): string {
  return LAUNCHER_BOOT_ID;
}

/** Test-only: override the boot id to simulate rows left by a prior incarnation. */
export function __setLauncherBootIdForTests(id: string): void {
  LAUNCHER_BOOT_ID = id;
}

/**
 * Record the child OS pid + this launcher host on a nursery row (EI-85). The
 * reclaim sweep uses these to /proc-liveness-check a stale-heartbeat row on the
 * SAME host before reclaiming it — so a child that is actually still alive (its
 * launching host was only briefly paused, not dead) is not reclaimed out from
 * under itself, and a dead one is reclaimed with an accurate reason. Best-effort.
 */
export async function recordSpawnPid(sql: Db, spawnId: string, pid: number): Promise<void> {
  await sql`
    UPDATE harness_shared.spawned_agents
       SET pid = ${pid}, launcher_host = ${hostname()}, launcher_boot_id = ${LAUNCHER_BOOT_ID}
     WHERE spawn_id = ${spawnId} AND status IN ('running', 'restarting')`;
}

/**
 * Is the recorded child process still alive on THIS host (EI-85)? Linux /proc
 * check, hardened against PID reuse: the pid must exist AND its cmdline must
 * name the invoke-once entrypoint (a reused pid running something else reads as
 * dead). Returns false on any non-Linux / unreadable case, so the caller falls
 * back to the heartbeat-stale reclaim — never a false "alive" that strands a
 * ceiling slot.
 *
 * IN-PROCESS LOOPBACK LAUNCHES (P-033, the real-Queen-reclaim fix). A
 * kind:'hive' Queen wake (and overwatch loops) is NOT a spawned `invoke-once`
 * child — it is an IN-PROCESS `/invoke` handler whose `defaultFire` row
 * (launch-blueprint.ts → `loopbackFetch`) is recorded by the firing process with
 * THAT process's pid (`recordSpawnPid(process.pid)`). The firing process is the
 * long-lived operator host (or, for the bench, the long-lived launcher that holds
 * the loopback connection open) — alive for the whole wake. So a launch row's
 * liveness is "the firing PROCESS still exists", NOT "an invoke-once child still
 * exists": this sweep proves it WITHOUT a fragile heartbeat `setInterval` (whose
 * 60s beat starves past RECLAIM_STALE_MS(300s) under multi-task load → a live
 * Queen reaped at ~310s, the 7-reclaim bench symptom). `launch` rows therefore use
 * a plain /proc-existence check (any live process), `spawn` (bee) rows keep the
 * strict invoke-once-cmdline PID-reuse hardening. A pid equal to THIS process is
 * alive by construction (we run this code in it) regardless of kind — covers the
 * reclaim running inside the very process that fired the launch.
 *
 * @param kind 'spawn' (default, an invoke-once bee child — strict cmdline check)
 *             or 'launch' (an in-process loopback launch — /proc-existence check).
 */
export function isSpawnProcessAlive(pid: number, kind: 'spawn' | 'launch' = 'spawn'): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  // The recorded pid IS this running process → alive by construction (this code
  // runs in it). Platform-agnostic, immune to PID reuse for the process lifetime.
  if (pid === process.pid) return true;
  if (process.platform !== 'linux') return false;
  try {
    // cmdline is NUL-separated. For a bee the entrypoint names invoke-once (the
    // reuse-hardening guard); for an in-process loopback launch the firing process
    // is the operator host / bench launcher — any live process counts as alive.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return kind === 'launch' ? cmdline.length > 0 : cmdline.includes('invoke-once');
  } catch {
    return false; // /proc/<pid> gone (dead) or unreadable → treat as dead
  }
}

/**
 * A running row un-heartbeated for longer than this is presumed orphaned
 * (launching host dead). Generously larger than the heartbeat interval so a
 * live spawn whose host was briefly paused (GC, restart-in-progress) is not
 * reclaimed out from under itself.
 */
export const RECLAIM_STALE_MS = 5 * 60_000;

/**
 * Bump `heartbeat_at` for the given live spawnIds (only while still active).
 *
 * `outputAtMs` (liveness-hardening P-008): epoch-ms of the latest stdout/
 * stderr chunk the supervising host observed per spawn — stamped onto
 * `last_output_at` in the SAME tick, so stream activity costs zero extra
 * write cadence. Monotonic guard (GREATEST) tolerates ticks racing.
 */
export async function heartbeatSpawns(
  sql: Db,
  spawnIds: string[],
  outputAtMs?: ReadonlyMap<string, number>,
): Promise<void> {
  if (spawnIds.length === 0) return;
  const withOutput = outputAtMs
    ? spawnIds.filter((id) => outputAtMs.has(id))
    : [];
  const plain = withOutput.length === 0
    ? spawnIds
    : spawnIds.filter((id) => !outputAtMs!.has(id));
  if (plain.length > 0) {
    await sql`
      UPDATE harness_shared.spawned_agents
         SET heartbeat_at = now()
       WHERE spawn_id = ANY(${plain}::text[])
         AND status IN ('running', 'restarting')`;
  }
  if (withOutput.length > 0) {
    const ids = withOutput;
    const stamps = withOutput.map((id) => new Date(outputAtMs!.get(id)!).toISOString());
    await sql`
      UPDATE harness_shared.spawned_agents AS a
         SET heartbeat_at = now(),
             last_output_at = GREATEST(coalesce(a.last_output_at, 'epoch'::timestamptz), u.output_at)
        FROM unnest(${ids}::text[], ${stamps}::timestamptz[]) AS u(spawn_id, output_at)
       WHERE a.spawn_id = u.spawn_id
         AND a.status IN ('running', 'restarting')`;
  }
}

/**
 * A bee alive-but-silent past this long is a "possibly wedged" candidate
 * (liveness-hardening P-009): the supervisor still beats for it (process
 * alive) but its stream hasn't moved — hung network call, stuck rate-limit
 * loop. DISPLAY/TRIAGE ONLY (plan P-010 owns any auto-action policy).
 */
export const WEDGE_SILENT_MS = 10 * 60_000;

/**
 * Classify a spawn row as possibly wedged: actively supervised (running, fresh
 * heartbeat) yet stream-silent past the threshold. A row with NO last_output_at
 * (pre-233, or no output observed yet) is never flagged — absence of signal is
 * not evidence of a wedge. Pure; exported for tests + fleet:tree.
 */
export function isPossiblyWedged(
  // heartbeatAt/lastOutputAt accept string too: raw PG reads return ISO strings,
  // and getMs() below normalizes Date|string|number (EI-482/EI-492). The type now
  // matches that tested contract (was Date|null — too narrow for the string path).
  row: { status: string; heartbeatAt?: Date | string | null; lastOutputAt?: Date | string | null },
  opts: { now?: number; silentMs?: number; staleMs?: number } = {},
): boolean {
  const now = opts.now ?? Date.now();
  const silentMs = opts.silentMs ?? WEDGE_SILENT_MS;
  const staleMs = opts.staleMs ?? RECLAIM_STALE_MS;
  if (row.status !== 'running' && row.status !== 'restarting') return false;
  if (!row.heartbeatAt) return false;
  const getMs = (v: unknown): number => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') return new Date(v).getTime();
    if (typeof v === 'number') return v;
    return NaN;
  };
  const heartbeatMs = getMs(row.heartbeatAt);
  if (isNaN(heartbeatMs) || now - heartbeatMs > staleMs) return false; // not supervised-live → the reclaim path owns it
  if (!row.lastOutputAt) return false;
  const lastOutputMs = getMs(row.lastOutputAt);
  return !isNaN(lastOutputMs) && now - lastOutputMs > silentMs;
}

export interface ReclaimResult {
  reclaimed: number;
  spawnIds: string[];
  /** Distinct workspaces whose ceiling the reclaim freed slots in — callers
   *  announce `spawn-slot:freed:<ws>` per entry so over-ceiling waiters wake
   *  (D-004 queue+await; the announce lives at the call sites, this module
   *  stays a pure sql unit). */
  workspaces: string[];
}

/**
 * Reclaim active rows whose heartbeat went stale (host presumed dead): flip to
 * 'failed' with a clear reason + a terminal `finished_at`/`duration_ms`, freeing
 * the concurrency ceiling. Workspace-agnostic — one sweep covers every workspace
 * on the org PG. Idempotent (a row already terminal is skipped). Best-effort:
 * callers swallow errors (a missed sweep just defers the reclaim to the next one
 * or to the opportunistic reclaim on the next spawn).
 */
export async function reclaimOrphanedSpawns(
  sql: Db,
  opts: { staleMs?: number; isAlive?: (pid: number, kind?: 'spawn' | 'launch') => boolean } = {},
): Promise<ReclaimResult> {
  const staleSec = Math.max(1, Math.round((opts.staleMs ?? RECLAIM_STALE_MS) / 1000));
  const isAlive = opts.isAlive ?? isSpawnProcessAlive; // injectable for tests

  // EI-85: a stale heartbeat no longer blindly reclaims. First gather the
  // candidates with their recorded pid + launcher host; a candidate that is
  // SAME-HOST and whose process is still alive (/proc) is NOT reclaimed — its host
  // was only briefly paused, the process survived (e.g. spawned into its own
  // systemd scope, or — P-033 — an in-process loopback launch whose firing
  // operator/launcher process is still up). Such rows get their heartbeat bumped so
  // this host keeps them fresh. Everything else (process confirmed dead, no pid, or
  // a different host we can't liveness-check) is reclaimed — with a reason saying which.
  //
  // `run_id` distinguishes the row CLASS for the liveness check (P-033): a
  // `launch-%` run_id is a `defaultFire` in-process loopback launch (Queen wake /
  // overwatch) → liveness = the firing process exists; otherwise it is an
  // invoke-once bee spawn → liveness = the strict invoke-once-cmdline check.
  const candidates = await sql<
    {
      spawn_id: string;
      workspace_id: string;
      pid: number | null;
      launcher_host: string | null;
      run_id: string | null;
      launcher_boot_id: string | null;
    }[]
  >`
    SELECT spawn_id, workspace_id, pid, launcher_host, run_id, launcher_boot_id
      FROM harness_shared.spawned_agents
     WHERE status IN ('running', 'restarting')
       AND heartbeat_at < now() - ${staleSec}::int * interval '1 second'`;
  if (candidates.length === 0) {
    return { reclaimed: 0, spawnIds: [], workspaces: [] };
  }

  const me = hostname();
  const alive: string[] = [];
  const deadChild: string[] = [];
  const hostGone: string[] = [];
  const priorBoot: string[] = [];
  for (const c of candidates) {
    const sameHost = c.launcher_host != null && c.launcher_host === me;
    // EI-2186: a same-host row stamped with a DIFFERENT (non-null) boot id was
    // launched by a dead prior incarnation of this operator — provably orphaned,
    // immune to pid reuse (a rebooted host reassigns the same pids, which is how a
    // stale `launch`-kind row's recorded pid read as "alive" and wedged the ceiling
    // forever). This must short-circuit the pid liveness check below — otherwise the
    // false-alive path bumps its heartbeat and it never becomes a candidate again.
    if (sameHost && c.launcher_boot_id != null && c.launcher_boot_id !== LAUNCHER_BOOT_ID) {
      priorBoot.push(c.spawn_id);
      continue;
    }
    const kind: 'spawn' | 'launch' = (c.run_id ?? '').startsWith('launch-') ? 'launch' : 'spawn';
    if (sameHost && c.pid != null) {
      if (isAlive(c.pid, kind)) alive.push(c.spawn_id);
      else deadChild.push(c.spawn_id);
    } else {
      // Different host (can't liveness-check), or a row predating pid recording.
      hostGone.push(c.spawn_id);
    }
  }

  // Keep the live-but-host-paused children: bump their heartbeat so neither this
  // sweep nor the next reclaims them (their own host will resume heartbeating).
  if (alive.length > 0) await heartbeatSpawns(sql, alive);

  const reclaimable = [...deadChild, ...hostGone, ...priorBoot];
  if (reclaimable.length === 0) {
    return { reclaimed: 0, spawnIds: [], workspaces: [] };
  }

  // Reclaim the confirmed-dead + unverifiable rows. The status guard keeps it
  // idempotent + race-safe against a concurrent sweep on another host. The
  // reason distinguishes a child we PROVED dead from a host we merely presume
  // dead — accurate diagnosis (EI-85's mislabel was exactly this).
  const rows = await sql<{ spawn_id: string; workspace_id: string }[]>`
    UPDATE harness_shared.spawned_agents
       SET status = 'failed',
           finished_at = now(),
           duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint,
           error_message = COALESCE(
             error_message,
             CASE
               WHEN spawn_id = ANY(${priorBoot}::text[])
                 THEN 'reclaimed: launched by a prior operator incarnation (boot-id mismatch on '
                      || COALESCE(launcher_host, '?')
                      || ') — host restarted, concurrency ceiling freed by the reclaim sweep (EI-2186)'
               WHEN spawn_id = ANY(${deadChild}::text[])
                 THEN 'reclaimed: child process (pid ' || COALESCE(pid::text, '?')
                      || ') confirmed dead on ' || COALESCE(launcher_host, '?')
                      || ' — concurrency ceiling freed by the P-011 reclaim sweep (EI-85)'
               ELSE 'reclaimed: spawn heartbeat stale > ' || ${staleSec}::text
                      || 's (launching operator host presumed dead) — concurrency ceiling freed by the P-011 reclaim sweep'
             END
           )
     WHERE status IN ('running', 'restarting')
       AND spawn_id = ANY(${reclaimable}::text[])
    RETURNING spawn_id, workspace_id`;

  // EI-108: Wake parents of reclaimed spawns (best-effort, concurrent, no await)
  for (const row of rows) {
    void wakeParentOnChildDeath(sql as Sql, row.spawn_id, row.workspace_id, 'failed').catch(
      () => { /* best-effort — logged inside wakeParentOnChildDeath */ },
    );
  }

  return {
    reclaimed: rows.length,
    spawnIds: rows.map((r) => r.spawn_id),
    workspaces: [...new Set(rows.map((r) => r.workspace_id).filter(Boolean))],
  };
}

/**
 * Boot-time spawn-admission reconcile (EI-2186) — the release-on-host-restart
 * half of the spawn chokepoint.
 *
 * THE BUG IT FIXES. A host restart (or operator-process restart) kills every
 * in-flight spawn/launch BEFORE its normal admission-release runs, leaving
 * `running`/`restarting` nursery rows that count forever against the global
 * concurrency ceiling (`maxSimultaneousAgents`). The periodic
 * `reclaimOrphanedSpawns` could not clear them: it only considers rows whose
 * heartbeat is STALE, but a stale `launch`-kind row's recorded pid gets REUSED by
 * an unrelated process on the rebooted box, so the permissive launch liveness
 * check read it as "alive" and BUMPED its heartbeat each sweep — keeping it
 * permanently fresh and never a reclaim candidate. The ceiling read N/N with ~0
 * live bees and NO bee could be placed fleet-wide (the "idle Queen / no bees"
 * storm was actually a hard-jammed ceiling).
 *
 * THE RECONCILE. A fresh operator process has launched NOTHING yet, so any
 * `running` row attributed to THIS host that does not carry THIS process's boot id
 * is owned by a dead prior incarnation — reclaim it, regardless of heartbeat
 * freshness (that is the crucial difference from the periodic sweep: it does NOT
 * gate on staleness, so it clears rows the false-alive bug kept fresh). The
 * boot-id discriminator is immune to pid reuse. Rows predating the boot-id column
 * (`launcher_boot_id IS NULL`) fall back to the stale-heartbeat rule so a
 * mid-insert current-process row (not yet pid/boot-id-stamped) is never reclaimed
 * out from under itself. Different-host rows are left alone (a federated peer's
 * live operator owns them).
 *
 * Call ONCE at host bootstrap, before arming the spawn paths. Idempotent + safe to
 * re-run. The caller announces `spawn-slot:freed:<ws>` per freed workspace so any
 * over-ceiling waiter wakes (the same contract as the periodic sweep).
 */
export async function reconcileSpawnAdmissionOnBoot(
  sql: Db,
  opts: { staleMs?: number } = {},
): Promise<ReclaimResult> {
  const staleSec = Math.max(1, Math.round((opts.staleMs ?? RECLAIM_STALE_MS) / 1000));
  const me = hostname();

  const rows = await sql<{ spawn_id: string; workspace_id: string }[]>`
    UPDATE harness_shared.spawned_agents
       SET status = 'failed',
           finished_at = now(),
           duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint,
           error_message = COALESCE(
             error_message,
             'reclaimed at operator boot: launched by a prior incarnation on '
               || COALESCE(launcher_host, '?')
               || ' (host/process restarted before its admission-release ran) — '
               || 'stale spawn-ceiling debit freed by the boot reconcile (EI-2186)'
           )
     WHERE status IN ('running', 'restarting')
       AND launcher_host = ${me}
       AND (
             (launcher_boot_id IS NOT NULL AND launcher_boot_id <> ${LAUNCHER_BOOT_ID})
          OR (launcher_boot_id IS NULL AND heartbeat_at < now() - ${staleSec}::int * interval '1 second')
       )
    RETURNING spawn_id, workspace_id`;

  // Wake parents of the reclaimed spawns (best-effort, concurrent — same as the
  // periodic sweep; a parent awaiting a now-dead child should not hang).
  for (const row of rows) {
    void wakeParentOnChildDeath(sql as Sql, row.spawn_id, row.workspace_id, 'failed').catch(
      () => { /* best-effort — logged inside wakeParentOnChildDeath */ },
    );
  }

  return {
    reclaimed: rows.length,
    spawnIds: rows.map((r) => r.spawn_id),
    workspaces: [...new Set(rows.map((r) => r.workspace_id).filter(Boolean))],
  };
}
