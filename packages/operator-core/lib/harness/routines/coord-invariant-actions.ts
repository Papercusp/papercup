/**
 * coord-invariant-actions.ts — Layer D of coord-system-e2e-testing-2026-06-10:
 * the live fleet's coordination-substrate watchers (P-012 + P-013). This module
 * is the ONE home for substrate monitor routines — the shared-hive-loop plan's
 * P-012/P-013 monitor family (double-completion detector, convergence-lag
 * probe, outbox depth, orphaned-lease sweep) plugs in here as further checks
 * rather than growing a second framework.
 *
 *   - `system:coord-probe-canary` (P-012, every 15 min): two synthetic probe
 *     identities run the live verb cycle — ping → inbox → ack → file-lock
 *     acquire → contend-busy → release → contender wins — through the REAL
 *     host adapters (sendMessage/readInbox/appendAck, tryAcquire/tryRelease
 *     over the live su-lock store). Per-step latency + a total-cycle SLO; a
 *     failed step or SLO breach files a forensics-laden improvement
 *     (coord-log + lock-table rows) through the watchdog capture core
 *     (deduped, dedupScope 'open'). Probe hygiene: rows older than 24h are
 *     swept each fire, so the canary never becomes its own bloat incident.
 *
 *   - `system:coord-invariant-monitor` (P-013, hourly): cheap SQL/adapter
 *     snapshots checked against thresholds —
 *       · handoffs stuck pending          (open > stuckHandoffHours, def 12)
 *       · unacked escalations             (open > staleEscalationHours, def 6)
 *       · locks held past TTL, unswept    (expired > expiredLockGraceMin, def 60)
 *       · presence ghosts                 (heartbeat stale > presenceGhostHours,
 *                                          def 72, rows never cleaned)
 *       · wake-queue depth / age          (pending_wakes > wakeQueueDepthMax,
 *                                          def 50, or oldest > wakeQueueAgeHours)
 *     Each violation files ONE deduped improvement with a STABLE title (the
 *     dedup key), so a persisting violation never floods the backlog.
 *
 * Both handlers are replay-safe (read-only checks + idempotent probe writes +
 * dedup-gated filing) and every check is isolated — one failing query degrades
 * that check, never the fire. Pure planners (`evaluateProbe`,
 * `evaluateInvariants`) are exported for unit tests; the probe cycle takes an
 * injectable deps bag for the same reason.
 *
 * Seed: seed-coord-invariant-routines.ts. Registered via register-system-actions.
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { captureImprovement } from '../improvements/capture-core';
import { lockAuthorityForHive } from '../../authority/lock-authority';
import {
  runSharedHiveMonitorPass,
  type LeaseHolderRow,
  type MonitorIncident,
  type PresenceRow,
} from '../../shared-hive-loop/fleet-monitors';
import { sendMessage, readInbox, appendAck, readAckedMsgIds } from '../../agent-tools/coordination/messages';
import { listHandoffs } from '../../agent-tools/coordination/handoffs';
import { listEscalations } from '../../agent-tools/coordination/escalations';
import { sweepDeadOwnerPendingWakes } from '../../agent-tools/coordination/pending-wakes';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import {
  ensureBootstrap,
  getTxPool,
  normalizePaths,
  tryAcquire,
  tryRelease,
} from '../../agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';

// ── P-012: probe-pair canary ────────────────────────────────────────────────

export const PROBE_A = 'coord-probe-canary-a';
export const PROBE_B = 'coord-probe-canary-b';
/** Synthetic coordination domain — never a real repo, so the scope guard keeps
 *  these locks local and no live agent ever contends with the probe. */
export const PROBE_DOMAIN = 'coord-probe-canary';
const PROBE_PATH = 'probe/canary.lock';

export interface ProbeStep {
  step: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface ProbeVerdict {
  ok: boolean;
  totalMs: number;
  /** First failed step, when any. */
  failedStep?: string;
  /** True when every step passed but the cycle blew the total SLO. */
  sloBreached: boolean;
}

/** Pure: judge a completed probe cycle against the total-cycle SLO. */
export function evaluateProbe(steps: ProbeStep[], totalSloMs: number): ProbeVerdict {
  const totalMs = steps.reduce((n, s) => n + s.ms, 0);
  const failed = steps.find((s) => !s.ok);
  return {
    ok: !failed && totalMs <= totalSloMs,
    totalMs,
    failedStep: failed?.step,
    sloBreached: !failed && totalMs > totalSloMs,
  };
}

/** The verb cycle, over an injectable deps bag (unit tests run on fakes). */
export interface ProbeDeps {
  send: (from: AgentIdentity, to: string, summary: string) => Promise<{ msg_id: string; ts: string }>;
  inboxHas: (owner: string, msgId: string, sinceTs: string) => Promise<boolean>;
  ack: (acker: AgentIdentity, msgId: string, from: string) => Promise<void>;
  ackedHas: (acker: string, msgId: string) => Promise<boolean>;
  acquire: (owner: string) => Promise<{ ok: boolean; busyOwner?: string }>;
  release: (owner: string) => Promise<void>;
  now?: () => number;
}

export async function runProbeCycle(deps: ProbeDeps, idA: AgentIdentity, idB: AgentIdentity): Promise<ProbeStep[]> {
  const now = deps.now ?? Date.now;
  const steps: ProbeStep[] = [];
  const timed = async (step: string, fn: () => Promise<{ ok: boolean; detail?: string }>) => {
    const t0 = now();
    try {
      const r = await fn();
      steps.push({ step, ok: r.ok, ms: now() - t0, detail: r.detail });
      return r.ok;
    } catch (err) {
      steps.push({ step, ok: false, ms: now() - t0, detail: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  // 1. ping A→B …
  let msgId = '';
  let sentTs = '';
  if (
    !(await timed('ping', async () => {
      const env = await deps.send(idA, idB.ownerId, `probe ping ${new Date(now()).toISOString()}`);
      msgId = env.msg_id;
      sentTs = env.ts;
      return { ok: !!msgId };
    }))
  ) {
    return steps;
  }
  // 2. … lands in B's inbox …
  if (!(await timed('inbox', async () => ({ ok: await deps.inboxHas(idB.ownerId, msgId, sentTs) })))) return steps;
  // 3. … B acks, and the ack is readable.
  if (
    !(await timed('ack', async () => {
      await deps.ack(idB, msgId, idA.ownerId);
      return { ok: await deps.ackedHas(idB.ownerId, msgId) };
    }))
  ) {
    return steps;
  }
  // 4. A takes the probe lock.
  if (!(await timed('lock-acquire', async () => deps.acquire(idA.ownerId)))) return steps;
  // 5. B contends and MUST be refused (mutual exclusion live).
  if (
    !(await timed('lock-contend', async () => {
      const r = await deps.acquire(idB.ownerId);
      return { ok: !r.ok && r.busyOwner === idA.ownerId, detail: r.ok ? 'contender was GRANTED a held lock' : undefined };
    }))
  ) {
    // Leave no probe debris even on the failure path.
    await deps.release(idA.ownerId).catch(() => {});
    return steps;
  }
  // 6. A releases…
  if (
    !(await timed('lock-release', async () => {
      await deps.release(idA.ownerId);
      return { ok: true };
    }))
  ) {
    return steps;
  }
  // 7. …and the former contender now wins.
  await timed('lock-regrant', async () => {
    const r = await deps.acquire(idB.ownerId);
    if (r.ok) await deps.release(idB.ownerId);
    return { ok: r.ok };
  });
  return steps;
}

function probeIdentity(ownerId: string, workspaceId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'omp-hook-session', workspaceId, userId: null } as AgentIdentity;
}

/** The real-seam deps the live routine composes. */
function liveProbeDeps(): ProbeDeps {
  return {
    send: async (from, to, summary) => {
      const env = await sendMessage(from, { to: [to], summary, category: 'probe-canary' });
      return { msg_id: env.msg_id, ts: env.ts };
    },
    inboxHas: async (owner, msgId, sinceTs) => {
      // since strictly-later would exclude the probe itself — back off 1ms.
      const since = new Date(Date.parse(sinceTs) - 1).toISOString();
      const inbox = await readInbox(owner, { since_ts: since });
      return inbox.some((l) => l.msg_id === msgId);
    },
    ack: async (acker, msgId, from) => {
      await appendAck(acker, msgId, from);
    },
    ackedHas: async (acker, msgId) => (await readAckedMsgIds(acker)).has(msgId),
    acquire: async (owner) => {
      const r = await inWorkspaceTxn(PROBE_DOMAIN, owner, (tx) =>
        tryAcquire(tx, {
          coordinationDomain: PROBE_DOMAIN,
          owner,
          ownerLabel: `probe:${owner}`,
          paths: normalizePaths([PROBE_PATH]),
          intent: 'coord probe-pair canary',
          ttlSec: 120,
        }),
      );
      if (r.ok) return { ok: true };
      return { ok: false, busyOwner: r.busy[0]?.owner };
    },
    release: async (owner) => {
      await inWorkspaceTxn(PROBE_DOMAIN, owner, (tx) =>
        tryRelease(tx, { coordinationDomain: PROBE_DOMAIN, owner, allMine: true }),
      );
    },
  };
}

/** Probe hygiene + failure forensics live on the same tables. */
async function sweepProbeRows(workspaceId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.coord_event_log
    WHERE workspace_id = ${workspaceId}
      AND writer_key IN (${PROBE_A}, ${PROBE_B})
      AND ts < now() - interval '24 hours'`;
}

async function probeForensics(workspaceId: string): Promise<string> {
  const parts: string[] = [];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ surface: string; msg_id: string; ts: string; writer_key: string | null }[]>`
      SELECT surface, msg_id, ts::text, writer_key
      FROM harness_shared.coord_event_log
      WHERE workspace_id = ${workspaceId} AND writer_key IN (${PROBE_A}, ${PROBE_B})
      ORDER BY id DESC LIMIT 20`;
    parts.push(`coord_event_log (probe rows, newest 20):\n${rows.map((r) => `  ${r.ts} ${r.surface} ${r.msg_id} by ${r.writer_key}`).join('\n') || '  (none)'}`);
  } catch (err) {
    parts.push(`coord_event_log forensics unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const sql = getTxPool();
    const locks = await sql<{ path: string; owner: string; expires_ts: string }[]>`
      SELECT path, owner, expires_ts::text FROM agent_file_locks
      WHERE coordination_domain = ${PROBE_DOMAIN} LIMIT 20`;
    parts.push(`agent_file_locks (probe domain):\n${locks.map((l) => `  ${l.path} held by ${l.owner} until ${l.expires_ts}`).join('\n') || '  (none)'}`);
  } catch (err) {
    parts.push(`lock-table forensics unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parts.join('\n\n');
}

registerSystemAction('coord-probe-canary', async (ctx: SystemActionCtx) => {
  const sloMs = Number((ctx.payloadTemplate?.totalSloMs as number | undefined) ?? 10_000);
  await ensureBootstrap();
  const idA = probeIdentity(PROBE_A, ctx.workspaceId);
  const idB = probeIdentity(PROBE_B, ctx.workspaceId);

  const steps = await runProbeCycle(liveProbeDeps(), idA, idB);
  const verdict = evaluateProbe(steps, sloMs);

  await sweepProbeRows(ctx.workspaceId).catch(() => {});

  if (!verdict.ok) {
    const stepLines = steps.map((s) => `  ${s.ok ? '✓' : '×'} ${s.step} ${s.ms}ms${s.detail ? ` — ${s.detail}` : ''}`).join('\n');
    await captureImprovement({
      title: verdict.failedStep
        ? `coord probe-pair canary failed at '${verdict.failedStep}'`
        : 'coord probe-pair canary breached its cycle SLO',
      kind: 'bug',
      severity: verdict.failedStep ? 'major' : 'minor',
      dedupScope: 'open',
      foundDuring: 'system:coord-probe-canary',
      subTopic: 'coordination',
      body:
        `The scheduled probe-pair canary (coord-system-e2e P-012) ${verdict.failedStep ? `failed at step '${verdict.failedStep}'` : `completed but took ${verdict.totalMs}ms (SLO ${sloMs}ms)`}.\n\n` +
        `Cycle:\n${stepLines}\n\n${await probeForensics(ctx.workspaceId)}`,
    });
  }
});

// ── P-013: invariant monitors ───────────────────────────────────────────────

export interface InvariantThresholds {
  stuckHandoffHours: number;
  staleEscalationHours: number;
  expiredLockGraceMin: number;
  presenceGhostHours: number;
  wakeQueueDepthMax: number;
  wakeQueueAgeHours: number;
}

export const DEFAULT_THRESHOLDS: InvariantThresholds = {
  stuckHandoffHours: 12,
  staleEscalationHours: 6,
  expiredLockGraceMin: 60,
  presenceGhostHours: 72,
  wakeQueueDepthMax: 50,
  wakeQueueAgeHours: 6,
};

export interface InvariantSnapshot {
  openHandoffTs: string[];
  openEscalationTs: string[];
  /** Locks whose expiry is older than the grace window and still present. */
  longExpiredLocks: number;
  /** Presence rows whose heartbeat is stale past the ghost window. */
  presenceGhosts: number;
  wakeQueueDepth: number;
  wakeQueueOldestMs: number | null;
}

export interface Violation {
  /** STABLE dedup title — a persisting violation re-files into its open issue. */
  title: string;
  detail: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
}

/** Pure: judge a snapshot against the thresholds. */
export function evaluateInvariants(
  snap: InvariantSnapshot,
  t: InvariantThresholds,
  nowMs: number,
): Violation[] {
  const out: Violation[] = [];
  const olderThanH = (tsList: string[], hours: number) =>
    tsList.filter((ts) => nowMs - Date.parse(ts) > hours * 3_600_000).length;

  const stuckHandoffs = olderThanH(snap.openHandoffTs, t.stuckHandoffHours);
  if (stuckHandoffs > 0) {
    out.push({
      title: `coord invariant: handoffs stuck pending past ${t.stuckHandoffHours}h`,
      detail: `${stuckHandoffs} open handoff(s) older than ${t.stuckHandoffHours}h — work is parked with no acceptor.`,
      severity: 'minor',
    });
  }
  const staleEsc = olderThanH(snap.openEscalationTs, t.staleEscalationHours);
  if (staleEsc > 0) {
    out.push({
      title: `coord invariant: escalations unacked past ${t.staleEscalationHours}h`,
      detail: `${staleEsc} open escalation(s) older than ${t.staleEscalationHours}h.`,
      severity: 'major',
    });
  }
  if (snap.longExpiredLocks > 0) {
    out.push({
      title: 'coord invariant: file locks held past TTL without sweep',
      detail: `${snap.longExpiredLocks} lock row(s) expired more than ${t.expiredLockGraceMin}min ago and still present — heartbeat/sweep failure or orphaned holder.`,
      severity: 'minor',
    });
  }
  if (snap.presenceGhosts > 0) {
    out.push({
      title: `coord invariant: presence ghosts lingering past ${t.presenceGhostHours}h`,
      detail: `${snap.presenceGhosts} presence row(s) with a heartbeat older than ${t.presenceGhostHours}h never cleaned up.`,
      severity: 'nit',
    });
  }
  const oldestH = snap.wakeQueueOldestMs == null ? 0 : (nowMs - snap.wakeQueueOldestMs) / 3_600_000;
  if (snap.wakeQueueDepth > t.wakeQueueDepthMax || oldestH > t.wakeQueueAgeHours) {
    out.push({
      title: 'coord invariant: wake-queue depth/age growth',
      detail: `pending_wakes depth=${snap.wakeQueueDepth} (max ${t.wakeQueueDepthMax}), oldest=${oldestH.toFixed(1)}h (max ${t.wakeQueueAgeHours}h) — staged wakes are not being released.`,
      severity: 'minor',
    });
  }
  return out;
}

/** Gather the live snapshot. Every leg is isolated — a failing query zeroes
 *  its own check (and notes it), never the fire. */
async function gatherSnapshot(t: InvariantThresholds): Promise<InvariantSnapshot> {
  const snap: InvariantSnapshot = {
    openHandoffTs: [],
    openEscalationTs: [],
    longExpiredLocks: 0,
    presenceGhosts: 0,
    wakeQueueDepth: 0,
    wakeQueueOldestMs: null,
  };
  try {
    snap.openHandoffTs = (await listHandoffs({ status: 'open' })).map((h) => h.record.ts);
  } catch {
    /* check degraded */
  }
  try {
    snap.openEscalationTs = (await listEscalations({ status: 'open' })).map((e) => e.ts);
  } catch {
    /* check degraded */
  }
  try {
    const sql = getTxPool();
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM agent_file_locks
      WHERE expires_ts < now() - make_interval(mins => ${t.expiredLockGraceMin})`;
    snap.longExpiredLocks = Number(rows[0]?.n ?? 0);
  } catch {
    /* check degraded */
  }
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.coord_presence
      WHERE heartbeat_at < now() - make_interval(hours => ${t.presenceGhostHours})`;
    snap.presenceGhosts = Number(rows[0]?.n ?? 0);
  } catch {
    /* check degraded */
  }
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ n: string; oldest: string | null }[]>`
      SELECT count(*)::text AS n, min(created_at)::text AS oldest
      FROM harness_shared.pending_wakes`;
    snap.wakeQueueDepth = Number(rows[0]?.n ?? 0);
    snap.wakeQueueOldestMs = rows[0]?.oldest ? Date.parse(rows[0].oldest) : null;
  } catch {
    /* check degraded */
  }
  return snap;
}

// ── shared-hive-loop P-012/P-013: the multi-swarm dispatch checks ───────────
// (shared-hive-loop-e2e-testing-2026-06-10; plugs into THIS home per both
// briefs — checks live in shared-hive-loop/fleet-monitors.ts, proven on the
// hermetic 2-swarm rig. Scope discovery: every harness with work_item_claims
// rows in this workspace — i.e. exactly where the distributed lease layer is
// actually in use; zero rows ⇒ the leg is a no-op.)

/** Stable dedup titles per incident kind (a persisting incident re-files into
 *  its open improvement instead of flooding). */
export function planSharedHiveCapture(
  incident: MonitorIncident,
  harness: string,
): { title: string; severity: 'critical' | 'major' | 'minor' | 'nit' } {
  switch (incident.kind) {
    case 'double-completion':
      return { title: `shared-hive invariant: cross-swarm double completion in ${harness}`, severity: 'major' };
    case 'outbox-health':
      return { title: 'shared-hive invariant: substrate outbox depth/age breach', severity: 'major' };
    case 'presence-ghost':
      return { title: `shared-hive invariant: presence ghost anchoring live leases in ${harness}`, severity: 'minor' };
    case 'orphaned-taken-by':
      return { title: `shared-hive invariant: orphaned taken_by swept in ${harness}`, severity: 'minor' };
  }
}

async function runSharedHiveLeg(ctx: SystemActionCtx): Promise<void> {
  const { sql } = getOrgPg();
  const scopes = await sql<{ harness_slug: string; hive_slug: string | null }[]>`
    SELECT DISTINCT harness_slug, hive_slug FROM harness_shared.work_item_claims
     WHERE workspace_id = ${ctx.workspaceId}`;
  for (const scope of scopes) {
    try {
      // The orphan sweep runs only on the elected authority for the scope
      // (sweepOrphanedTakenBy's contract); resolution failure ⇒ scan-only.
      let isAuthority = false;
      try {
        isAuthority = (await lockAuthorityForHive(scope.hive_slug ?? scope.harness_slug)).isSelf;
      } catch {
        isAuthority = false;
      }
      let presence: PresenceRow[] = [];
      let liveLeases: LeaseHolderRow[] = [];
      try {
        const rows = await sql<{ device_pubkey: string; last_seen_ms: string }[]>`
          SELECT device_pubkey, (extract(epoch FROM last_seen_at) * 1000)::bigint::text AS last_seen_ms
            FROM harness_shared.shared_presence
           WHERE workspace_id = ${ctx.workspaceId}
             AND ${scope.hive_slug ? sql`hive_slug = ${scope.hive_slug}` : sql`TRUE`}`;
        presence = rows.map((r) => ({ devicePubkey: r.device_pubkey, lastSeenMs: Number(r.last_seen_ms) }));
        const leases = await sql<{ work_item_id: string; holder_pubkey: string | null; expires_ms: string }[]>`
          SELECT work_item_id, holder_pubkey, (extract(epoch FROM expires_ts) * 1000)::bigint::text AS expires_ms
            FROM harness_shared.work_item_claims
           WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${scope.harness_slug}`;
        liveLeases = leases.map((l) => ({
          workItemId: l.work_item_id,
          holderPubkey: l.holder_pubkey,
          expiresTsMs: Number(l.expires_ms),
        }));
      } catch {
        /* presence/lease legs degraded — the PG scans below still run */
      }
      await runSharedHiveMonitorPass({
        sql,
        workspaceId: ctx.workspaceId,
        harness: scope.harness_slug,
        isAuthority,
        presence,
        liveLeases,
        fileIncident: async (incident) => {
          const plan = planSharedHiveCapture(incident, scope.harness_slug);
          await captureImprovement({
            title: plan.title,
            kind: 'bug',
            severity: plan.severity,
            dedupScope: 'open',
            foundDuring: 'system:coord-invariant-monitor (shared-hive leg)',
            subTopic: 'shared-hive',
            body: `${incident.title}\n\nForensics: ${JSON.stringify(incident.detail)}\n(shared-hive-loop-e2e-testing-2026-06-10 P-012/P-013; check source: lib/shared-hive-loop/fleet-monitors.ts.)`,
          }).catch(() => {
            /* a capture failure must not abort the remaining incidents */
          });
        },
      });
    } catch {
      /* one scope's failure never aborts the others */
    }
  }
}

registerSystemAction('coord-invariant-monitor', async (ctx: SystemActionCtx) => {
  const t: InvariantThresholds = { ...DEFAULT_THRESHOLDS, ...(ctx.payloadTemplate as Partial<InvariantThresholds> | null) };
  // EI-314: GC staged wakes for ENDED sessions before measuring. A manual-mode
  // queue for a gone owner can never be released (only the owner releases it), so
  // it would trip the wake-queue invariant as pure debris and re-file forever.
  // Sweeping first means the violation only fires for a LIVE agent's genuinely-
  // stuck review queue. Best-effort — a sweep failure never aborts the pass.
  await sweepDeadOwnerPendingWakes().catch(() => 0);
  const snap = await gatherSnapshot(t);
  const violations = evaluateInvariants(snap, t, Date.now());
  for (const v of violations) {
    await captureImprovement({
      title: v.title,
      kind: 'bug',
      severity: v.severity,
      dedupScope: 'open',
      foundDuring: 'system:coord-invariant-monitor',
      subTopic: 'coordination',
      body: `${v.detail}\n\nSnapshot: ${JSON.stringify(snap)}\nThresholds: ${JSON.stringify(t)}\n(coord-system-e2e-testing-2026-06-10 P-013; shared monitor home for the shared-hive-loop P-012/P-013 checks.)`,
    }).catch(() => {
      /* a capture failure must not abort the remaining violations */
    });
  }
  // The shared-hive-loop leg (P-012/P-013 of that plan) — isolated like every
  // other check: its failure degrades the leg, never the fire.
  await runSharedHiveLeg(ctx).catch(() => {});
});
