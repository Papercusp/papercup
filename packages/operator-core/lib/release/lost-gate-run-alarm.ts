/**
 * Lost gate-run alarm (gate-throughput-shift-left-2026-10-06 P-005 / R-5).
 *
 * A green-checkpoint run publishes a durable `gate_health.inFlightCandidate` marker naming its
 * pid. A hard loss (SIGKILL, OOM, host-generation replacement) cannot run the run's own
 * finalizer, so the marker stays set while nobody is judging anything. The existing handling of
 * that marker (`wakeAbandonedCheckpointAwaits` inside `checkGreenStall`) only resolves
 * `checkpoint:await` waiters, discards its own result, and runs on the 15-minute green-stall
 * pass. Nobody was PAGED: WI-10004928 measured a load-time death of the gate's tooling that sat
 * silent for 70+ minutes.
 *
 * This sweep closes that gap and nothing else:
 *  - it runs on its own short timer (LOST_RUN_SWEEP_INTERVAL_MS), so a death is alarmed within
 *    minutes rather than at the next 15-minute pass;
 *  - it alarms ONCE per dead run, deduped by a compare-and-set stamp
 *    (`gate_health.lostRunAlarm.key = candidate:pid:observedAtMs`), so a restart, an overlapping
 *    pass, or a marker that lingers because the wake failed never re-pages;
 *  - it pages the gate holder (the live claim on the gate's condition item) and a fleet leader
 *    (the holder's own fleet, else this host's PAPERCUSP_FLEET_SLUG), on top of the hive-wide
 *    severe-event broadcast;
 *  - it is silent while the pid is alive, when liveness cannot be determined, and once the marker
 *    is cleared.
 *
 * It deliberately does NOT clear the marker or wake waiters: that stays with the 15-minute pass,
 * so the two paths never run the record/emit/clear transaction on the same marker concurrently.
 */
import type { Sql } from 'postgres';
import type { SevereEventRoute } from '../severe-event-broadcast';
import {
  describeAbandonedInFlightCandidate,
  isPidAlive,
  judgeAbandonedInFlightCandidate,
  parseInFlightCandidate,
  type StoredInFlightCandidate,
} from './in-flight-candidate';

/** R-5 requires the alarm within 10 minutes of the death; a 2-minute sweep leaves wide margin. */
export const LOST_RUN_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

export function lostRunAlarmKey(marker: Pick<StoredInFlightCandidate, 'candidate' | 'pid' | 'observedAtMs'>): string {
  return `${marker.candidate}:${marker.pid}:${marker.observedAtMs}`;
}

export type LostRunAlarmDecision =
  | { action: 'silent'; reason: string }
  | {
      action: 'alarm';
      key: string;
      candidate: string;
      pid: number;
      /** How long ago the dead run published its marker (an upper bound on how long it ran). */
      markerAgeMs: number;
      summary: string;
    };

/**
 * Pure: should this marker raise a lost-run alarm right now?
 *
 * `alreadyAlarmedKey` is the stamp currently stored beside the marker. It is a cheap pre-filter
 * only; the authoritative dedup is the compare-and-set in {@link claimLostRunAlarm}.
 */
export function decideLostRunAlarm(input: {
  rawMarker: unknown;
  alreadyAlarmedKey: string | null;
  selfPid: number;
  pidAlive: (pid: number) => boolean | null;
  nowMs: number;
}): LostRunAlarmDecision {
  const marker = parseInFlightCandidate(input.rawMarker, input.nowMs);
  if (!marker) return { action: 'silent', reason: 'no-marker' };
  const verdict = judgeAbandonedInFlightCandidate(marker, {
    selfPid: input.selfPid,
    pidAlive: input.pidAlive(marker.pid),
    nowMs: input.nowMs,
  });
  if (!verdict.abandoned) return { action: 'silent', reason: verdict.reason };
  const key = lostRunAlarmKey(marker);
  if (input.alreadyAlarmedKey === key) return { action: 'silent', reason: 'already-alarmed' };
  return {
    action: 'alarm',
    key,
    candidate: marker.candidate,
    pid: marker.pid,
    markerAgeMs: Math.max(0, input.nowMs - marker.observedAtMs),
    summary:
      describeAbandonedInFlightCandidate(verdict) ??
      `Checkpoint run for ${marker.candidate.slice(0, 12)} disappeared without a verdict.`,
  };
}

/**
 * Pure: who gets paged directly. The holder is the agent holding a live claim on the gate's
 * condition item; the fleet leader is the leader of the holder's fleet, else of this host's
 * fleet. An empty list means nobody is directly reachable and the caller must fall back to the
 * owner-facing attention surface.
 */
export function resolveLostRunRoutes(input: {
  installSlug: string;
  holderOwnerId: string | null;
  holderFleetSlug: string | null;
  hostFleetSlug: string | null;
}): SevereEventRoute[] {
  const routes: SevereEventRoute[] = [];
  if (input.holderOwnerId) {
    routes.push({
      ownerSelector: input.holderOwnerId,
      reason: `you hold the ${input.installSlug} gate and its in-flight run died`,
    });
  }
  const fleetSlug = (input.holderFleetSlug ?? input.hostFleetSlug ?? '').trim();
  if (fleetSlug) {
    routes.push({
      ownerSelector: `@fleet-leader:${fleetSlug}`,
      reason: `the ${input.installSlug} gate's in-flight run died; fleet ${fleetSlug} leads it`,
    });
  }
  return routes;
}

/** Pure: the alarm text. Names the dead pid and the one thing to do next. */
export function lostRunAlarmBody(opts: {
  installSlug: string;
  decision: Extract<LostRunAlarmDecision, { action: 'alarm' }>;
  paged: readonly string[];
}): { summary: string; body: string } {
  const { decision } = opts;
  const minutes = Math.round(decision.markerAgeMs / 60_000);
  return {
    summary: `green-checkpoint run LOST on ${opts.installSlug}: pid ${decision.pid} is gone, no verdict for ${decision.candidate.slice(0, 12)}`,
    body:
      `${decision.summary} The run's in-flight marker was published ${minutes} min ago and its pid ` +
      `${decision.pid} no longer exists, so no verdict will arrive for this candidate. ` +
      `Next step: read gate.greenCheckpoint.ownership and the checkpoint unit log for the death window, ` +
      `then re-run the verdict (release:checkpoint-run) once the cause is understood. ` +
      (opts.paged.length > 0
        ? `Paged directly: ${opts.paged.join(', ')}.`
        : `No gate holder or fleet leader was resolvable, so this was raised to the owner.`),
  };
}

/**
 * Compare-and-set the dedup stamp. Returns true only for the caller that moved the stored key to
 * `key`; every later caller (another pass, a restarted process) gets false and stays silent.
 */
export async function claimLostRunAlarm(
  sql: Sql,
  target: { installSlug: string; workspaceId: string },
  key: string,
  nowMs: number,
): Promise<boolean> {
  const result = await sql`
    UPDATE harness_shared.routines
       SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{gate_health}',
             COALESCE(metadata->'gate_health', '{}'::jsonb)
               || jsonb_build_object('lostRunAlarm', jsonb_build_object('key', ${key}::text, 'alarmedAtMs', ${nowMs}::bigint)),
             true
           )
     WHERE install_slug = ${target.installSlug}
       AND workspace_id = ${target.workspaceId}
       AND target_role = 'system:green-checkpoint'
       AND (metadata->'gate_health'->'lostRunAlarm'->>'key') IS DISTINCT FROM ${key}::text`;
  return result.count === 1;
}

async function readHolder(installSlug: string): Promise<string | null> {
  const { readGateOwnership } = await import('../coord/gate-ownership');
  const own = await readGateOwnership({ harness: installSlug });
  return own.claimState === 'held' && own.takenBy ? own.takenBy : null;
}

async function readOwnerFleetSlug(sql: Sql, workspaceId: string, ownerId: string): Promise<string | null> {
  const rows = await sql<{ fleet_slug: string | null }[]>`
    SELECT fleet_slug FROM harness_shared.coord_presence
     WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
     LIMIT 1`;
  const slug = rows[0]?.fleet_slug?.trim();
  return slug ? slug : null;
}

export interface LostRunSweepDeps {
  nowMs?: number;
  selfPid?: number;
  pidAlive?: (pid: number) => boolean | null;
  hostFleetSlug?: string | null;
  claim?: typeof claimLostRunAlarm;
  readHolder?: (installSlug: string) => Promise<string | null>;
  readOwnerFleetSlug?: (sql: Sql, workspaceId: string, ownerId: string) => Promise<string | null>;
  broadcast?: (ev: import('../severe-event-broadcast').SevereEventBroadcast) => Promise<boolean>;
  notifyOwner?: (opts: { workspaceId: string; title: string; body: string; data: Record<string, unknown> }) => Promise<void>;
}

export interface LostRunSweepResult {
  /** install slugs paged this pass (exactly once per dead run). */
  alarmed: string[];
  /** install slugs with a dead run whose alarm another pass already claimed. */
  deduped: string[];
  /** install slugs whose alarm could not be delivered this pass (retried next pass). */
  failed: string[];
}

/** Scan every green-checkpoint row and page once for each run whose pid is gone. Never throws. */
export async function sweepLostGateRuns(sql: Sql, deps: LostRunSweepDeps = {}): Promise<LostRunSweepResult> {
  const out: LostRunSweepResult = { alarmed: [], deduped: [], failed: [] };
  const nowMs = deps.nowMs ?? Date.now();
  let rows: { install_slug: string; workspace_id: string; marker: unknown; alarmed_key: string | null }[];
  try {
    rows = await sql<typeof rows>`
      SELECT install_slug, workspace_id,
             metadata->'gate_health'->'inFlightCandidate' AS marker,
             metadata->'gate_health'->'lostRunAlarm'->>'key' AS alarmed_key
        FROM harness_shared.routines
       WHERE target_role = 'system:green-checkpoint'
         AND jsonb_typeof(metadata->'gate_health'->'inFlightCandidate') = 'object'`;
  } catch (e) {
    console.warn(`[lost-gate-run-alarm] row scan failed (will retry): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }

  for (const row of rows) {
    const decision = decideLostRunAlarm({
      rawMarker: row.marker,
      alreadyAlarmedKey: row.alarmed_key,
      selfPid: deps.selfPid ?? process.pid,
      pidAlive: deps.pidAlive ?? isPidAlive,
      nowMs,
    });
    if (decision.action === 'silent') {
      if (decision.reason === 'already-alarmed') out.deduped.push(row.install_slug);
      continue;
    }
    const target = { installSlug: row.install_slug, workspaceId: row.workspace_id };
    try {
      const won = await (deps.claim ?? claimLostRunAlarm)(sql, target, decision.key, nowMs);
      if (!won) {
        out.deduped.push(row.install_slug);
        continue;
      }
    } catch (e) {
      console.warn(`[lost-gate-run-alarm] dedup claim failed for ${row.install_slug} (will retry): ${e instanceof Error ? e.message : String(e)}`);
      out.failed.push(row.install_slug);
      continue;
    }

    // Routing is best-effort: an unreadable holder or fleet must never suppress the alarm itself.
    const holder = await (deps.readHolder ?? readHolder)(row.install_slug).catch(() => null);
    const holderFleetSlug = holder
      ? await (deps.readOwnerFleetSlug ?? readOwnerFleetSlug)(sql, row.workspace_id, holder).catch(() => null)
      : null;
    const routes = resolveLostRunRoutes({
      installSlug: row.install_slug,
      holderOwnerId: holder,
      holderFleetSlug,
      hostFleetSlug: deps.hostFleetSlug !== undefined ? deps.hostFleetSlug : (process.env.PAPERCUSP_FLEET_SLUG ?? null),
    });
    const { summary, body } = lostRunAlarmBody({
      installSlug: row.install_slug,
      decision,
      paged: routes.map((r) => r.ownerSelector),
    });
    const broadcast = deps.broadcast ?? (await import('../severe-event-broadcast')).broadcastSevereEvent;
    const delivered = await broadcast({
      summary,
      body,
      category: 'severe-event',
      conditionKey: `green-checkpoint-lost-run:${row.install_slug}`,
      oneShot: true,
      ...(routes[0] ? { route: routes[0] } : {}),
      ...(routes.length > 1 ? { extraRoutes: routes.slice(1) } : {}),
    });
    if (routes.length === 0) {
      const notifyOwner = deps.notifyOwner ?? defaultNotifyOwner;
      await notifyOwner({
        workspaceId: row.workspace_id,
        title: summary,
        body,
        data: { installSlug: row.install_slug, candidate: decision.candidate.slice(0, 12), pid: decision.pid },
      }).catch((e) => {
        console.warn(`[lost-gate-run-alarm] owner notify failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    if (delivered) {
      out.alarmed.push(row.install_slug);
    } else {
      // The stamp is already claimed, so release it: the next pass must retry an undelivered page.
      await releaseLostRunAlarmClaim(sql, target, decision.key).catch(() => {});
      out.failed.push(row.install_slug);
    }
  }
  return out;
}

async function releaseLostRunAlarmClaim(
  sql: Sql,
  target: { installSlug: string; workspaceId: string },
  key: string,
): Promise<void> {
  await sql`
    UPDATE harness_shared.routines
       SET metadata = jsonb_set(metadata, '{gate_health}', (metadata->'gate_health') - 'lostRunAlarm', true)
     WHERE install_slug = ${target.installSlug}
       AND workspace_id = ${target.workspaceId}
       AND target_role = 'system:green-checkpoint'
       AND metadata->'gate_health'->'lostRunAlarm'->>'key' = ${key}::text`;
}

async function defaultNotifyOwner(opts: {
  workspaceId: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const { notifyAttention } = await import('../attention-notify');
  await notifyAttention({
    kind: 'intervention',
    title: opts.title,
    body: opts.body,
    importance: 'urgent',
    workspaceId: opts.workspaceId,
    data: opts.data,
  });
}
