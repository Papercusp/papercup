/**
 * coord-invariant-actions.ts — Layer D of coord-system-e2e-testing-2026-06-10:
 * the live fleet's coordination-substrate watchers (P-012 + P-013). This module
 * is the ONE home for substrate monitor routines — the shared-hive-loop plan's
 * P-012/P-013 monitor family (double-completion detector, convergence-lag
 * probe, outbox depth, orphaned-lease sweep) plugs in here as further checks
 * rather than growing a second framework.
 *
 *   - `system:coord-probe-canary` (P-012, every 15 min): two synthetic probe
 *     identities run the live verb cycle — baseline → ping → inbox → ack →
 *     file-lock acquire → contend-busy → release → contender wins — through the
 *     REAL host adapters (sendMessage/readInbox/appendAck, tryAcquire/tryRelease
 *     over the live su-lock store). The leading `baseline` step is a control
 *     DB round-trip (SELECT 1) that touches neither the coord write path nor its
 *     NOTIFY triggers, so a breach is self-attributing: baseline slow ⇒ DB-wide
 *     / pool contention; baseline fast but ping/ack slow ⇒ the coord
 *     INSERT+commit+NOTIFY path (EI-401 — the first real breach was mis-read as
 *     a slow read path; see agent-insight coord-canary-breach-attribute-per-step).
 *     Per-step latency + a 30s total-cycle SLO (EI-401 owner ruling: a 10s SLO
 *     false-alarmed on transient shared-box peak-load write spikes). A failed
 *     step or a coord-attributed SLO breach files a forensics-laden improvement
 *     (coord-log + lock-table rows) through the watchdog capture core (deduped,
 *     dedupScope 'open'); a breach the baseline pins on DB-wide / pool contention
 *     is DOWNGRADED to a logged note, not an EI (breachDisposition). Probe
 *     hygiene: rows older than 24h are swept each fire, so the canary never
 *     becomes its own bloat incident.
 *
 *   - `system:coord-invariant-monitor` (P-013, hourly): cheap SQL/adapter
 *     snapshots checked against thresholds —
 *       · handoffs stuck pending          (open > stuckHandoffHours, def 12)
 *       · operational escalations undrained (operational + open past the reconcile
 *                                          TTL + a grace window — the substrate's own
 *                                          drain is failing; EI-6910: was "any open
 *                                          escalation past 6h", which fired perpetually
 *                                          on the human's normal decision backlog;
 *                                          EI-7087: the grace absorbs the normal
 *                                          reconcile-tick-vs-check-tick cadence race)
 *       · locks held past TTL, unswept    (expired > expiredLockGraceMin, def 60)
 *       · presence ghosts                 (heartbeat stale > presenceGhostHours,
 *                                          def 72, rows never cleaned)
 *       · wake-queue depth / age          (pending_wakes > wakeQueueDepthMax, def 50,
 *                                          or oldest past the auto-expiry deadline
 *                                          pendingWakeStaleHours + grace — a sweep
 *                                          failure, not the human's normal review
 *                                          backlog; EI-8664)
 *     Each violation files ONE deduped improvement with a STABLE title (the
 *     dedup key), so a persisting violation never floods the backlog.
 *
 *   - `system:claim-integrity-sweep` (fleet-reliability-verification-2026-07-10
 *     P-001 / EI-8999, every 10 min): a LIVE double-placement risk, not a slow
 *     leak, so unlike the two checks above it ALARMS — a directed, WOKEN message
 *     to the holder + its fleet leader — in addition to filing the durable
 *     dedup record. Two desyncs —
 *       · orphaned wip           (work_item `wip` + null taken_by, but its linked
 *                                 plan item shows a LIVE claim held by a
 *                                 presence-live owner — the work-item's own
 *                                 tracking desynced from the authoritative
 *                                 plan-item lease)
 *       · unbacked active assignment (an ACTIVE plan_item_assignments row whose
 *                                 assignee is presence-live, but no live
 *                                 plan_item_claims lease backs it — the
 *                                 stale-claims.ts reapers only clean this up
 *                                 once the holder goes dead/stalls; this is
 *                                 their live-holder complement)
 *     Pure planner `planClaimIntegrityAlarms` (holder + leader targets) is
 *     exported for unit tests; the leader lookup is injectable via
 *     `resolveLeadersForHolders`.
 *
 * All three handlers are replay-safe (read-only checks + idempotent probe
 * writes + dedup-gated filing) and every check is isolated — one failing query
 * degrades that check, never the fire. Pure planners (`evaluateProbe`,
 * `evaluateInvariants`, `planClaimIntegrityAlarms`) are exported for unit
 * tests; the probe cycle takes an injectable deps bag for the same reason.
 *
 * Seed: seed-coord-invariant-routines.ts. Registered via register-system-actions.
 */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
// Reuse the per-handle drain GC's retention window + batch bounds so the global
// sweep below (EI-436) stays consistent with the inline GC it backstops.
import { OUTBOX_GC_AGE_MS, OUTBOX_GC_BATCH, OUTBOX_GC_MAX_BATCHES } from '../../sync/hyperbee/outbox-drain';
import { captureImprovement } from '../improvements/capture-core';
import { lockAuthorityForHive } from '../../authority/lock-authority';
import {
  runSharedHiveMonitorPass,
  type LeaseHolderRow,
  type MonitorIncident,
  type PresenceRow,
} from '../../shared-pot-loop/fleet-monitors';
import { sendMessage, readInbox, appendAck, readAckedMsgIds } from '../../agent-tools/coordination/messages';
import { listHandoffs, acceptHandoff } from '../../agent-tools/coordination/handoffs';
import { listEscalations } from '../../agent-tools/coordination/escalations';
// EI-6910: the escalation invariant measures coordination-SUBSTRATE drain-health, so it
// must know (a) which escalations the substrate is responsible for draining
// (isOperationalEscalation — the same queue-pending-accuracy D-005 classifier the
// reader + reconcile sweep already agree on) and (b) the reconcile drain deadline
// (OPERATIONAL_ESCALATION_TTL_MS — the single source of truth in reconcile-escalations.ts).
import { isOperationalEscalation } from '../../attention/adapters';
import { OPERATIONAL_ESCALATION_TTL_MS, reconcileStaleEscalationsOnce } from '../../attention/reconcile-escalations';

/**
 * EI-7087: grace window added ON TOP of OPERATIONAL_ESCALATION_TTL_MS before the
 * invariant flags an undrained escalation. Without it, this check false-positives
 * on ordinary tick-cadence drift, not a real drain failure: the reconcile sweep
 * fires hourly at :20 (attentionReconcileTick) and this invariant checks hourly at
 * :37 (seed-coord-invariant-routines) — 17 minutes later. An operational escalation
 * that crosses the 48h TTL boundary in the 17–43min window BETWEEN a reconcile tick
 * and the next one is, by construction, still open when this check runs, even
 * though the reconcile sweep is working perfectly and will drain it at its very
 * next tick. Given the near-continuous operational-escalation traffic (e.g.
 * system:infra-liveness-alarm bursts), that race hits often enough to keep this
 * "minor" EI perpetually re-opening despite zero real backlog (verified live,
 * 2026-07-04: max age of any open operational escalation was 46.4h — under the
 * 48h TTL — at the moment this fired citing "still open past TTL").
 * One hour comfortably covers the normal cadence race (which is at most ~43min)
 * with margin, while staying tiny next to what a GENUINE drain failure looks like
 * (reconcile repeatedly shed/stuck for multiple hours against a fast-growing
 * operational-escalation stream) — so this still catches the real failure this
 * invariant exists for, just not the tick-timing noise.
 */
export const ESCALATION_RECONCILE_GRACE_MS = (() => {
  const env = Number(process.env.PAPERCUSP_ESCALATION_RECONCILE_GRACE_MS);
  return Number.isFinite(env) && env > 0 ? env : 60 * 60 * 1000;
})();
import { sweepDeadOwnerPendingWakes, sweepStalePendingWakes } from '../../agent-tools/coordination/pending-wakes';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import {
  ensureBootstrap,
  getTxPool,
  normalizePaths,
  tryAcquire,
  tryRelease,
} from '../../agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import { fetchPresenceFleet } from '../../agent-tools/coordination/presence-fleet';
import { getFleet } from '../../agent-fleets-store';

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
  /** True when this step failed SOLELY because its per-workspace txn could not
   *  serialize in time — a `WorkspaceContendedError` (pg 55P03 lock_timeout /
   *  57014 statement_timeout), i.e. transient shared-box contention, NOT a coord
   *  correctness regression. Drives the file-vs-note disposition (EI-3019). */
  contended?: boolean;
}

/** PG SQLSTATEs / error shapes that mean "same-workspace contention timeout"
 *  (advisory-lock lock_timeout 55P03 / statement_timeout 57014) — the locks layer
 *  maps these into a `WorkspaceContendedError`. We detect by name OR raw code so
 *  the check is robust whether the wrapper or the raw postgres error propagates. */
const CONTENTION_PG_CODES = new Set(['55P03', '57014']);

/** Pure: was a thrown error a transient same-workspace contention timeout (vs a
 *  real correctness/logic failure)? Exported for unit tests. */
export function isContentionTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; pgCode?: string };
  if (e.name === 'WorkspaceContendedError') return true;
  return (
    (typeof e.pgCode === 'string' && CONTENTION_PG_CODES.has(e.pgCode)) ||
    (typeof e.code === 'string' && CONTENTION_PG_CODES.has(e.code))
  );
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

/** How a breach attributes against the control `baseline`: 'db-wide' = the whole
 *  DB/pool was contended (baseline itself slow) — NOT a coord regression;
 *  'coord' = baseline fast but ping/ack slow ⇒ the coord INSERT+commit+NOTIFY
 *  path; 'cumulative' = no single step dominates; 'none' = no baseline sampled. */
export type BreachClass = 'db-wide' | 'coord' | 'cumulative' | 'none';

/** Pure: classify an SLO breach by comparing the control `baseline` round-trip
 *  against the coord write steps (the EI-401 self-attribution model — see
 *  agent-insight coord-canary-breach-attribute-per-step). Drives both the
 *  human-readable attribution line AND the file-vs-note disposition below. */
export function classifyBreach(steps: ProbeStep[], slowMs = 2_000): BreachClass {
  const ms = (step: string) => steps.find((s) => s.step === step)?.ms;
  const baseline = ms('baseline');
  if (baseline == null) return 'none';
  const ping = ms('ping') ?? 0;
  const ack = ms('ack') ?? 0;
  if (baseline > slowMs) return 'db-wide';
  if (Math.max(ping, ack) > slowMs) return 'coord';
  return 'cumulative';
}

/** Pure: a one-line attribution hint for an SLO breach. Compares the control
 *  `baseline` round-trip against the coord write steps so a breach is not
 *  mis-read as a read-path cost — the EI-401 failure mode (see agent-insight
 *  coord-canary-breach-attribute-per-step). */
export function attributeBreach(steps: ProbeStep[], slowMs = 2_000): string {
  const ms = (step: string) => steps.find((s) => s.step === step)?.ms;
  const baseline = ms('baseline');
  const ping = ms('ping') ?? 0;
  const ack = ms('ack') ?? 0;
  switch (classifyBreach(steps, slowMs)) {
    case 'none':
      return 'Attribution: no baseline control sampled.';
    case 'db-wide':
      return `Attribution: baseline control (SELECT 1) took ${baseline}ms — DB-wide / connection-pool contention, NOT coord-specific.`;
    case 'coord':
      return `Attribution: baseline control fast (${baseline}ms) but coord write slow (ping ${ping}ms / ack ${ack}ms) — the cost is the coord INSERT+commit+NOTIFY path (NOTIFY-queue serialization / substrate_outbox capture), not the read path or the DB at large.`;
    case 'cumulative':
      return `Attribution: baseline ${baseline}ms, ping ${ping}ms, ack ${ack}ms — no single step dominates; likely cumulative load.`;
  }
}

/** Pure: should a non-clean cycle FILE an EI, or downgrade to a logged NOTE?
 *  EI-401 owner ruling ("accept + tune", 2026-06-13): a *pure* SLO breach (no
 *  step failed) that the baseline control attributes to DB-wide / pool
 *  contention is a transient shared-box peak-load spike, not an actionable coord
 *  regression — log a forensic note instead of minting an EI. Everything else
 *  still files: a failed step (correctness), a coord-attributed breach (the real
 *  coord INSERT+NOTIFY cost), and cumulative/unattributable breaches (fail
 *  open — never silently swallow a breach we cannot pin on the DB at large). */
export function breachDisposition(verdict: ProbeVerdict, steps: ProbeStep[]): 'ok' | 'note' | 'file' {
  if (verdict.ok) return 'ok';
  if (verdict.sloBreached && classifyBreach(steps) === 'db-wide') return 'note';
  // EI-3019: a step that failed SOLELY because its per-workspace txn could not
  // serialize in time (WorkspaceContendedError — pg 55P03/57014) is the same
  // transient shared-box contention as the db-wide SLO breach above, just
  // surfacing as a step failure rather than an SLO breach — downgrade it instead
  // of minting a bogus correctness bug. A GENUINE correctness failure
  // (mutual-exclusion breach, regrant refused, dead query) returns {ok:false}
  // WITHOUT throwing, so `contended` stays false and it still FILES (fail open).
  if (verdict.failedStep) {
    const failed = steps.find((s) => s.step === verdict.failedStep);
    if (failed?.contended) return 'note';
  }
  return 'file';
}

/** The verb cycle, over an injectable deps bag (unit tests run on fakes). */
export interface ProbeDeps {
  /** Control round-trip (SELECT 1) — no coord write path, no NOTIFY. Isolates
   *  DB-wide / pool latency from coord-substrate latency in a breach report. */
  baseline: () => Promise<{ ok: boolean; detail?: string }>;
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
      steps.push({
        step,
        ok: false,
        ms: now() - t0,
        detail: err instanceof Error ? err.message : String(err),
        contended: isContentionTimeout(err),
      });
      return false;
    }
  };

  // 0. Baseline control: a trivial DB round-trip that does NOT touch the coord
  //    write path or its NOTIFY triggers. If `baseline` is slow too, the whole
  //    DB is contended (pool/IO); if it is fast but ping/ack are slow, the cost
  //    is in the coord INSERT+commit+NOTIFY path. A hard failure means the DB is
  //    unreachable, so the rest of the cycle would fail anyway — abort.
  if (!(await timed('baseline', () => deps.baseline()))) return steps;
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
      return {
        ok: !r.ok && r.busyOwner === idA.ownerId,
        detail: r.ok ? 'contender was GRANTED a held lock' : undefined,
      };
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
    baseline: async () => {
      // Control: pure connection-acquire + query, no coord write, no NOTIFY.
      const { sql } = getOrgPg();
      await sql`SELECT 1`;
      return { ok: true };
    },
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
    parts.push(
      `coord_event_log (probe rows, newest 20):\n${rows.map((r) => `  ${r.ts} ${r.surface} ${r.msg_id} by ${r.writer_key}`).join('\n') || '  (none)'}`,
    );
  } catch (err) {
    parts.push(`coord_event_log forensics unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const sql = getTxPool();
    const locks = await sql<{ path: string; owner: string; expires_ts: string }[]>`
      SELECT path, owner, expires_ts::text FROM agent_file_locks
      WHERE coordination_domain = ${PROBE_DOMAIN} LIMIT 20`;
    parts.push(
      `agent_file_locks (probe domain):\n${locks.map((l) => `  ${l.path} held by ${l.owner} until ${l.expires_ts}`).join('\n') || '  (none)'}`,
    );
  } catch (err) {
    parts.push(`lock-table forensics unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parts.join('\n\n');
}

registerSystemAction('coord-probe-canary', async (ctx: SystemActionCtx) => {
  // Default 30s (EI-401): a 10s cycle SLO false-alarmed on transient peak-load coord-write
  // spikes on a shared dev box. The live value is the routine's payload_template.totalSloMs.
  const sloMs = Number((ctx.payloadTemplate?.totalSloMs as number | undefined) ?? 30_000);
  await ensureBootstrap();
  const idA = probeIdentity(PROBE_A, ctx.workspaceId);
  const idB = probeIdentity(PROBE_B, ctx.workspaceId);

  const steps = await runProbeCycle(liveProbeDeps(), idA, idB);
  const verdict = evaluateProbe(steps, sloMs);

  await sweepProbeRows(ctx.workspaceId).catch(() => {});

  const disposition = breachDisposition(verdict, steps);
  if (disposition !== 'ok') {
    const stepLines = steps
      .map((s) => `  ${s.ok ? '✓' : '×'} ${s.step} ${s.ms}ms${s.detail ? ` — ${s.detail}` : ''}`)
      .join('\n');

    // EI-401 (owner-ratified "accept + tune", 2026-06-13): a pure SLO breach the
    // baseline control pins on DB-wide / pool contention is a transient shared-box
    // peak-load spike, not a coord regression — log a forensic note instead of
    // minting a non-actionable EI. The probe-row sweep above already ran, so this
    // path leaves no debris. A failed step or a coord-attributed breach still files.
    if (disposition === 'note') {
      console.warn(
        `[coord-probe-canary] SLO breach DOWNGRADED to note (not filed) — completed in ${verdict.totalMs}ms (SLO ${sloMs}ms).\n` +
          `Cycle:\n${stepLines}\n${attributeBreach(steps)}`,
      );
      return;
    }

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
        `Cycle:\n${stepLines}\n\n` +
        (verdict.sloBreached ? `${attributeBreach(steps)}\n\n` : '') +
        `${await probeForensics(ctx.workspaceId)}`,
    });
  }
});

// ── P-013: invariant monitors ───────────────────────────────────────────────

export interface InvariantThresholds {
  stuckHandoffHours: number;
  // NOTE (EI-6910): the old `staleEscalationHours` (6h) was removed. It measured the
  // human's normal decision backlog (any open escalation past 6h), which is NEVER a
  // substrate leak, so it fired a perpetual, un-closeable bug. The escalation check now
  // follows the reconcile drain deadline (OPERATIONAL_ESCALATION_TTL_MS) instead — the
  // substrate is only responsible for draining OPERATIONAL escalations.
  expiredLockGraceMin: number;
  presenceGhostHours: number;
  wakeQueueDepthMax: number;
  /** WI-3097: auto-EXPIRE any staged wake (live owner or dead) past this age
   *  (sweepStalePendingWakes, run in-pass just before the invariant check). EI-8664:
   *  this is ALSO the sole basis for the wake-queue AGE alarm — a wake aged UNDER it is
   *  EXPECTED live-owner review backlog the sweep will reap (the pui wake board is the
   *  owner's review surface, not a filed EI); a wake that SURVIVES past it
   *  (+ WAKE_QUEUE_STALE_GRACE_MS) means the sweep is genuinely not keeping up, the only
   *  real substrate leak. There is deliberately NO separate lower "alert" threshold — a
   *  lower one fires an EI on the human's normal review backlog every hour, the EI-6910
   *  anti-pattern (and the two knobs could silently drift apart, reopening the gap). */
  pendingWakeStaleHours: number;
  /** WI-3959: a coord_event_log-touching pg_stat_statements entry averaging more
   *  rows/call than this is flagged as a "furnace" — an unbounded full-surface
   *  read (the WI-3937/WI-3869 class: readLines-shaped, no LIMIT/id-cursor). The
   *  original WI-3937 incident sustained ~28k rows/call across 285k calls before
   *  it was caught, so 50k comfortably clears any legitimate bounded read
   *  (a single page, a small delta) while still catching the class early. */
  coordLogFurnaceRowsPerCall: number;
  /** A coord_event_log statement averaging slower than this (ms) is ALSO flagged
   *  as a furnace, even under the rows/call threshold — a slow-but-not-huge scan
   *  (e.g. missing an index) is the same drain-starving pattern the rows check
   *  exists to catch. */
  coordLogFurnaceMeanExecMs: number;
}

export const DEFAULT_THRESHOLDS: InvariantThresholds = {
  stuckHandoffHours: 12,
  expiredLockGraceMin: 60,
  presenceGhostHours: 72,
  wakeQueueDepthMax: 50,
  pendingWakeStaleHours: 24,
  coordLogFurnaceRowsPerCall: 50_000,
  coordLogFurnaceMeanExecMs: 2_000,
};

/**
 * EI-8664: grace added on top of pendingWakeStaleHours before the wake-queue AGE alarm
 * fires. The auto-expiry sweep (sweepStalePendingWakes) runs in the SAME pass immediately
 * before the check and reaps every wake past pendingWakeStaleHours, so any wake surviving
 * past that deadline already means the sweep is failing. This grace only absorbs the
 * boundary/clock race (a row that was a hair under the cap at sweep time, now a hair over
 * at measure time) so a single hourly pass never false-fires on the 24h edge — only a
 * genuinely-stuck queue keeps a wake past the deadline + grace. One hour matches the
 * hourly monitor cadence.
 */
export const WAKE_QUEUE_STALE_GRACE_MS = 60 * 60 * 1000;

/** One open escalation, reduced to what the substrate-drain invariant needs to tell a
 *  genuine human decision (the human's attention queue — never a substrate leak) from an
 *  OPERATIONAL escalation the substrate auto-drains. */
export interface OpenEscalationLite {
  ts: string;
  from: string | null;
  hasOptions: boolean;
}

/** One pg_stat_statements row touching `coord_event_log` — raw, NOT yet
 *  threshold-judged (evaluateInvariants does the judging, same split as every
 *  other check here). Populated best-effort: empty when pg_stat_statements is
 *  not installed (it is superuser-only / opt-in — see sql/002-tables.sql). */
export interface CoordLogFurnaceStatement {
  queryid: string;
  /** Truncated query text — enough to identify the call site, never the full
   *  (potentially huge) statement. */
  queryPreview: string;
  calls: number;
  rowsPerCall: number;
  meanExecMs: number;
}

/** A CURRENTLY-RUNNING pg_stat_activity row whose query text also touches
 *  `coord_event_log` — best-effort forensics so a furnace violation can name
 *  the offending client (application_name/pid) when caught in the act, not
 *  just the aggregate historical pattern. Correlation is by text pattern, not
 *  a precise queryid join (pg_stat_activity carries no queryid column here). */
export interface CoordLogActiveOffender {
  pid: number;
  applicationName: string | null;
  durationSeconds: number;
}

export interface InvariantSnapshot {
  openHandoffTs: string[];
  openEscalations: OpenEscalationLite[];
  /** Locks whose expiry is older than the grace window and still present. */
  longExpiredLocks: number;
  /** Presence rows whose heartbeat is stale past the ghost window. */
  presenceGhosts: number;
  wakeQueueDepth: number;
  wakeQueueOldestMs: number | null;
  /** WI-3959: coord_event_log-touching pg_stat_statements rows (raw, unjudged). */
  coordLogFurnaces: CoordLogFurnaceStatement[];
  /** WI-3959: currently-running queries matching the same pattern, for naming
   *  the live offender when one is caught mid-scan. */
  coordLogActiveOffenders: CoordLogActiveOffender[];
}

export interface Violation {
  /** STABLE dedup title — a persisting violation re-files into its open issue. */
  title: string;
  detail: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
}

/** Pure: judge a snapshot against the thresholds. */
export function evaluateInvariants(snap: InvariantSnapshot, t: InvariantThresholds, nowMs: number): Violation[] {
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
  // EI-6910: This check measures coordination-SUBSTRATE drain-health, NOT the human's
  // decision backlog. The substrate auto-drains only OPERATIONAL escalations
  // (system/infra-emitter, option-less) — via the hourly attention-reconcile sweep on the
  // OPERATIONAL_ESCALATION_TTL_MS (48h) deadline (reconcile-escalations.ts). GENUINE
  // human-decision escalations are surfaced + tiered in the attention queue and are, by
  // design, NEVER substrate-drained (a human clears them). The old "open escalation past
  // 6h" count included those, so it fired on the normal steady-state human backlog (554+
  // open) and minted an un-closeable bug that re-filed every hour. So the invariant now
  // fires only on a genuine substrate DRAIN FAILURE: an operational escalation still open
  // past the reconcile TTL, i.e. the reconcile sweep is not keeping up. Mirrors the sibling
  // handoff invariant (auto-accept stale before measure, F-FIX-037) and the wake-queue
  // invariant (sweep dead-owner wakes before measure, EI-314): measure genuine stalls, not
  // expected/human-owned state.
  const undrainedOperationalEsc = snap.openEscalations.filter((e) => {
    if (!isOperationalEscalation(e.from, e.hasOptions)) return false;
    const openedMs = Date.parse(e.ts);
    // EI-7087: TTL + a grace window, not the bare TTL — see ESCALATION_RECONCILE_GRACE_MS
    // doc comment for why (absorbs the normal reconcile-tick-vs-invariant-check cadence
    // race instead of false-firing on it every time an escalation crosses the TTL boundary
    // between two reconcile ticks).
    return (
      Number.isFinite(openedMs) && nowMs - openedMs > OPERATIONAL_ESCALATION_TTL_MS + ESCALATION_RECONCILE_GRACE_MS
    );
  }).length;
  if (undrainedOperationalEsc > 0) {
    const ttlHours = Math.round((OPERATIONAL_ESCALATION_TTL_MS + ESCALATION_RECONCILE_GRACE_MS) / 3_600_000);
    out.push({
      title: 'coord invariant: operational escalations undrained past reconcile TTL',
      detail: `${undrainedOperationalEsc} operational escalation(s) still open past the ${ttlHours}h attention-reconcile TTL (${Math.round(OPERATIONAL_ESCALATION_TTL_MS / 3_600_000)}h TTL + ${Math.round(ESCALATION_RECONCILE_GRACE_MS / 3_600_000)}h grace) — the reconcile sweep (reconcile-escalations.ts) is not draining them.`,
      severity: 'minor',
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
  // EI-8664: the AGE alarm fires on the auto-EXPIRY deadline (pendingWakeStaleHours + a
  // small boundary grace), NOT a separate lower "alert" threshold. sweepStalePendingWakes
  // runs in-pass immediately before this check and reaps every wake past
  // pendingWakeStaleHours, so a wake that survives past it means that sweep is genuinely
  // failing — a real substrate leak. A wake aged UNDER the deadline is expected live-owner
  // review backlog (the pui wake board is the owner's review surface, not a filed EI);
  // alarming on it is the EI-6910 anti-pattern (measuring the human's normal backlog as a
  // leak) and re-files a non-actionable EI every hour.
  const graceH = WAKE_QUEUE_STALE_GRACE_MS / 3_600_000;
  const wakeAgeAlarmH = t.pendingWakeStaleHours + graceH;
  if (snap.wakeQueueDepth > t.wakeQueueDepthMax || oldestH > wakeAgeAlarmH) {
    out.push({
      title: 'coord invariant: wake-queue depth/age growth',
      detail: `pending_wakes depth=${snap.wakeQueueDepth} (max ${t.wakeQueueDepthMax}), oldest=${oldestH.toFixed(1)}h (auto-expiry ${t.pendingWakeStaleHours}h + ${graceH.toFixed(0)}h grace) — the stale-wake sweep is not keeping the queue bounded.`,
      severity: 'minor',
    });
  }
  // WI-3959: recurrence guard for the WI-3937/WI-3869 class — an unbounded
  // full-surface read against coord_event_log (8.04B rows / 48h of DB time in
  // the original incident, which starved the bg-host substrate drain into its
  // pass timeout). Fires MAJOR (not minor, like the other substrate-hygiene
  // checks above) because this class has already once taken the whole drain
  // down, not just left debris.
  const furnaces = snap.coordLogFurnaces.filter(
    (f) => f.rowsPerCall > t.coordLogFurnaceRowsPerCall || f.meanExecMs > t.coordLogFurnaceMeanExecMs,
  );
  if (furnaces.length > 0) {
    const lines = furnaces.map(
      (f) =>
        `  queryid=${f.queryid} calls=${f.calls} rows/call=${Math.round(f.rowsPerCall)} mean_exec_ms=${Math.round(f.meanExecMs)} :: ${f.queryPreview}`,
    );
    const offenders = snap.coordLogActiveOffenders.length
      ? `\nCurrently-active client(s) matching the pattern (best-effort text correlation): ${snap.coordLogActiveOffenders
          .map((o) => `pid=${o.pid} app=${o.applicationName ?? 'unknown'} running=${o.durationSeconds.toFixed(1)}s`)
          .join(', ')}`
      : '';
    out.push({
      title: 'coord invariant: unbounded coord_event_log read pattern (furnace class)',
      detail: `${furnaces.length} coord_event_log-touching statement(s) averaging > ${t.coordLogFurnaceRowsPerCall} rows/call or > ${t.coordLogFurnaceMeanExecMs}ms mean exec time — an unbounded/near-unbounded scan (WI-3937/WI-3869 class):\n${lines.join('\n')}${offenders}`,
      severity: 'major',
    });
  }
  return out;
}

/** Coord identity for the monitor's own auto-remediation writes (mirrors the
 *  improvement-watchdog's synthetic identity, known-open-aging.ts). A system
 *  action runs in-process, so it attributes as a `principal` — never a real
 *  fleet agent, and never the bogus `'system-action'` that is not an
 *  IdentitySource (the original F-FIX-037 attempt did not type-check). */
const MONITOR_IDENTITY: AgentIdentity = {
  ownerId: 'system:coord-invariant-monitor',
  ownerLabel: 'system · coord-invariant-monitor',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Pure: the msg_ids of open handoffs older than the threshold — the set the
 *  monitor auto-accepts so a handoff nobody ever picked up is reaped instead of
 *  re-firing the stuck-handoff invariant every hour. Strict boundary, matching
 *  evaluateInvariants (age must EXCEED the window). Exported for unit tests. */
export function planStaleHandoffAccepts(
  open: { msg_id: string; ts: string }[],
  thresholdHours: number,
  nowMs: number,
): string[] {
  const threshold = thresholdHours * 3_600_000;
  return open.filter((h) => nowMs - Date.parse(h.ts) > threshold).map((h) => h.msg_id);
}

/** Auto-accept handoffs older than the threshold, BEFORE gatherSnapshot, so a
 *  handoff nobody ever accepted is reaped (with an audited `handoff_accepted`
 *  event that notifies the original hander) instead of persisting as a stuck
 *  invariant violation that re-files every pass. Best-effort — a failure never
 *  aborts the pass. Returns the count of auto-accepted handoffs. */
async function autoAcceptStaleHandoffs(thresholdHours: number): Promise<number> {
  try {
    const open = await listHandoffs({ status: 'open' });
    const toAccept = planStaleHandoffAccepts(
      open.map((h) => ({ msg_id: h.record.msg_id, ts: h.record.ts })),
      thresholdHours,
      Date.now(),
    );
    let count = 0;
    for (const msgId of toAccept) {
      const accepted = await acceptHandoff(
        MONITOR_IDENTITY,
        msgId,
        `auto-accepted after ${thresholdHours}h pending (system:coord-invariant-monitor)`,
      );
      if (accepted) count++;
    }
    return count;
  } catch {
    // Best-effort — a failure here never aborts the pass.
    return 0;
  }
}

/**
 * EI-8786: drain stale OPERATIONAL escalations IN-PASS, immediately before the
 * invariant measures them — exactly like the sibling handoff check
 * (autoAcceptStaleHandoffs) and wake-queue checks (sweepDeadOwnerPendingWakes /
 * sweepStalePendingWakes) already do above. Before this, the escalation invariant
 * ONLY measured, relying on the SEPARATE hourly attentionReconcile DBOS tick (:20)
 * having drained the operational backlog before this monitor runs (:37). A missed /
 * shed / stalled / cadence-lagged reconcile tick then leaves an operational
 * escalation past the TTL at measure time, firing this "minor" EI on tick-timing
 * noise rather than a genuine drain failure — the ESCALATION_RECONCILE_GRACE_MS 1h
 * grace only partially covers the tick cadence race and does NOT cover a missed/down
 * tick at all (observed live: an operational escalation open at 49.5h while the
 * separate reconcile tick had not resolved anything for 8h). Draining here makes the
 * check SELF-HEALING: after this the invariant fires ONLY when the reconcile ITSELF
 * cannot drain an operational escalation (a real stuck row), never because a separate
 * tick was late or down. Best-effort — a drain failure never aborts the pass (the
 * invariant then measures the un-drained state and files, which is the correct
 * fail-open behavior). The reconcile is injectable for unit tests; the default is the
 * live sweep, scoped (like gatherSnapshot) to this monitor's active workspace.
 * Returns the number of escalations resolved.
 */
export async function drainOperationalEscalationsBeforeMeasure(
  reconcile: () => Promise<{ resolved: number }> = reconcileStaleEscalationsOnce,
): Promise<number> {
  try {
    const r = await reconcile();
    return r.resolved;
  } catch {
    return 0;
  }
}

/**
 * WI-3959: pg_stat_statements rows touching `coord_event_log`, top-N by
 * rows/call. Best-effort — the extension is superuser-only / opt-in (see
 * sql/002-tables.sql), so an unavailable extension (undefined_table /
 * undefined_function) degrades to an empty list, same as every other check
 * here. Exported for unit tests (injectable sql).
 */
export async function gatherCoordLogFurnaceStatements(
  sql: postgres.Sql,
  limit = 10,
): Promise<CoordLogFurnaceStatement[]> {
  const rows = await sql<{ queryid: string; query_preview: string; calls: string; rows: string; mean_exec_time: number }[]>`
    SELECT
      queryid::text AS queryid,
      LEFT(query, 300) AS query_preview,
      calls::text AS calls,
      rows::text AS rows,
      mean_exec_time
    FROM pg_stat_statements
    WHERE query ILIKE '%coord_event_log%'
      AND calls > 0
    ORDER BY (rows::float8 / GREATEST(calls, 1)) DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => {
    const calls = Number(r.calls);
    return {
      queryid: r.queryid,
      queryPreview: r.query_preview,
      calls,
      rowsPerCall: Number(r.rows) / Math.max(calls, 1),
      meanExecMs: r.mean_exec_time,
    };
  });
}

/**
 * WI-3959: currently-running queries whose text also touches
 * `coord_event_log` — best-effort forensics (pg_stat_activity, mirrors
 * dev:pg_active_queries) so a furnace violation can name a live offender's
 * application_name/pid when caught mid-scan. Exported for unit tests.
 */
export async function gatherCoordLogActiveOffenders(sql: postgres.Sql, limit = 10): Promise<CoordLogActiveOffender[]> {
  const rows = await sql<{ pid: number; application_name: string | null; duration_seconds: number }[]>`
    SELECT pid, application_name, EXTRACT(EPOCH FROM (now() - query_start))::float AS duration_seconds
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'active'
      AND query ILIKE '%coord_event_log%'
    ORDER BY query_start ASC NULLS LAST
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ pid: r.pid, applicationName: r.application_name, durationSeconds: r.duration_seconds }));
}

/** Gather the live snapshot. Every leg is isolated — a failing query zeroes
 *  its own check (and notes it), never the fire. */
async function gatherSnapshot(t: InvariantThresholds): Promise<InvariantSnapshot> {
  const snap: InvariantSnapshot = {
    openHandoffTs: [],
    openEscalations: [],
    longExpiredLocks: 0,
    presenceGhosts: 0,
    wakeQueueDepth: 0,
    wakeQueueOldestMs: null,
    coordLogFurnaces: [],
    coordLogActiveOffenders: [],
  };
  try {
    snap.openHandoffTs = (await listHandoffs({ status: 'open' })).map((h) => h.record.ts);
  } catch {
    /* check degraded */
  }
  try {
    snap.openEscalations = (await listEscalations({ status: 'open' })).map((e) => ({
      ts: e.ts,
      from: e.from ?? null,
      hasOptions: Array.isArray(e.options) && e.options.length > 0,
    }));
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
  try {
    const { sql } = getOrgPg();
    snap.coordLogFurnaces = await gatherCoordLogFurnaceStatements(sql);
  } catch {
    // pg_stat_statements is superuser-only / opt-in — commonly absent (embedded-pg,
    // a fresh/unprivileged box). Degrades to an empty list, same as every other leg.
  }
  try {
    const { sql } = getOrgPg();
    snap.coordLogActiveOffenders = await gatherCoordLogActiveOffenders(sql);
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
  const scopes = await sql<{ harness_slug: string; pot_slug: string | null }[]>`
    SELECT DISTINCT harness_slug, pot_slug FROM harness_shared.work_item_claims
     WHERE workspace_id = ${ctx.workspaceId}`;
  for (const scope of scopes) {
    try {
      // The orphan sweep runs only on the elected authority for the scope
      // (sweepOrphanedTakenBy's contract); resolution failure ⇒ scan-only.
      let isAuthority = false;
      try {
        isAuthority = (await lockAuthorityForHive(scope.pot_slug ?? scope.harness_slug)).isSelf;
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
             AND ${scope.pot_slug ? sql`pot_slug = ${scope.pot_slug}` : sql`TRUE`}`;
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

// ── EI-8999 / fleet-reliability-verification-2026-07-10 P-001: claim-integrity
//    invariant sweep ──────────────────────────────────────────────────────────
//
// Every OTHER check in this file files a deduped `captureImprovement` — a
// backlog bug nobody urgently looks at (the right shape for "handoffs stuck
// pending" or "presence ghosts lingering", which are slow leaks). Claim
// integrity is different: it is a LIVE double-placement risk RIGHT NOW — two
// agents can genuinely collide on the same item while the desync persists.
// P-001 (2026-07-09/10 night shift, found-by-hand 6x: WI-3487 x4, WI-3490,
// WI-3583) asks for an ALARM — a directed, woken message to the affected
// holder AND its fleet leader — not a nudge. This still ALSO files a deduped
// improvement (the durable audit trail + the catch-all when nobody is
// reachable to wake), but the alarm is the primary signal.
//
// Two distinct desyncs, both "the durable/authoritative claim disagrees with
// what a live holder is doing":
//
//   (a) ORPHANED WIP — a work_item is `wip` with taken_by/assignee NULL, yet
//       its linked plan-item shows a LIVE (non-expired) plan_item_claims lease
//       held by someone with a fresh presence heartbeat. The work-item's own
//       claim tracking (taken_by) has desynced from the plan-item claim (the
//       authoritative live lease) while a real session is still working it.
//
//   (b) UNBACKED ACTIVE ASSIGNMENT — a durable plan_item_assignments row is
//       ACTIVE (released_ts IS NULL) and its assignee has a fresh presence
//       heartbeat (session LIVE, actively "declared" onto this lane), but NO
//       live plan_item_claims lease backs it. The reapers in stale-claims.ts
//       already clean this up once the holder goes DEAD (60m) or STALLS (30m)
//       — this check is their live-holder complement: a genuinely-alive holder
//       whose assignment has no backing lease is a double-placement risk
//       *right now*, not after a decay window, and nothing else surfaces it.

/** How fresh a presence heartbeat must be to count as "session LIVE" for the
 *  claim-integrity checks. Deliberately generous (vs the 60s liveness ladder
 *  elsewhere): a long single turn between heartbeats must never mask a real
 *  desync as "holder went away". */
export const CLAIM_INTEGRITY_PRESENCE_GRACE_SEC = 15 * 60;

/** How long an active assignment must sit before the unbacked-assignment check
 *  considers it a violation — settles the normal assign→claim call sequence
 *  (declare-intent / claimForWork run milliseconds apart, but a slow request
 *  or a retried call could briefly show the assignment before the claim
 *  lands). Short: this is a LIVE alarm, not a decay sweep. */
export const CLAIM_INTEGRITY_ASSIGNMENT_SETTLE_SEC = 120;

export type ClaimIntegrityViolationKind = 'orphaned-wip' | 'unbacked-assignment';

export interface ClaimIntegrityViolation {
  kind: ClaimIntegrityViolationKind;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  /** The live session that should be alarmed as the holder. */
  holderOwnerId: string;
  holderOwnerLabel: string | null;
  detail: string;
}

interface OrphanedWipRow {
  harness_slug: string;
  feature_id: string;
  title: string | null;
  plan_slug: string;
  item_id: string;
  claim_owner: string;
  claim_owner_label: string | null;
}

/** (a) ORPHANED WIP: a `wip` work-item with no assignee whose linked plan item
 *  shows a live claim held by a presence-live owner. One isolated query — a
 *  failure degrades this leg only (caller wraps with `.catch(() => [])`). */
export async function findOrphanedWipClaims(
  sql: postgres.Sql,
  workspaceId: string,
  opts: { presenceGraceSec?: number } = {},
): Promise<ClaimIntegrityViolation[]> {
  const graceSec = Math.max(1, Math.round(opts.presenceGraceSec ?? CLAIM_INTEGRITY_PRESENCE_GRACE_SEC));
  const rows = await sql<OrphanedWipRow[]>`
    SELECT wi.harness_slug, wi.feature_id, wi.title, wi.source_plan_slug AS plan_slug,
           pic.item_id, pic.owner AS claim_owner, pic.owner_label AS claim_owner_label
      FROM harness_shared.work_items wi
      JOIN harness_shared.plan_item_claims pic
        ON pic.workspace_id = wi.workspace_id
       AND pic.harness_slug = wi.harness_slug
       AND pic.plan_slug = wi.source_plan_slug
       AND pic.item_id = ANY(wi.source_plan_item_ids)
       AND pic.expires_ts > clock_timestamp()
      JOIN harness_shared.coord_presence cp
        ON cp.owner_id = pic.owner
       AND cp.heartbeat_at > now() - make_interval(secs => ${graceSec})
     WHERE wi.workspace_id = ${workspaceId}
       AND wi.status = 'wip'
       AND (wi.taken_by IS NULL OR wi.taken_by = '')
       AND wi.source_plan_slug IS NOT NULL
       AND wi.source_plan_item_ids IS NOT NULL`;
  return rows.map((r) => ({
    kind: 'orphaned-wip' as const,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    itemId: r.item_id,
    holderOwnerId: r.claim_owner,
    holderOwnerLabel: r.claim_owner_label,
    detail:
      `work-item ${r.harness_slug}/${r.feature_id}${r.title ? ` ("${r.title}")` : ''} is 'wip' with NO assignee ` +
      `(taken_by is null/empty), but its linked plan item ${r.plan_slug}#${r.item_id} shows a LIVE claim held ` +
      `by ${r.claim_owner_label ?? r.claim_owner} (fresh presence heartbeat) — the work-item's own claim ` +
      `tracking has desynced from the authoritative plan-item lease while a real session works it.`,
  }));
}

interface UnbackedAssignmentRow {
  harness_slug: string;
  plan_slug: string;
  item_id: string;
  assignee_name: string;
  assigned_ts: string;
}

/** (b) UNBACKED ACTIVE ASSIGNMENT: an active plan_item_assignments row whose
 *  assignee is presence-live but has no backing live plan_item_claims lease.
 *  One isolated query — a failure degrades this leg only. */
export async function findUnbackedActiveAssignments(
  sql: postgres.Sql,
  workspaceId: string,
  opts: { presenceGraceSec?: number; settleSec?: number } = {},
): Promise<ClaimIntegrityViolation[]> {
  const graceSec = Math.max(1, Math.round(opts.presenceGraceSec ?? CLAIM_INTEGRITY_PRESENCE_GRACE_SEC));
  const settleSec = Math.max(0, Math.round(opts.settleSec ?? CLAIM_INTEGRITY_ASSIGNMENT_SETTLE_SEC));
  const rows = await sql<UnbackedAssignmentRow[]>`
    SELECT asg.harness_slug, asg.plan_slug, asg.item_id, asg.assignee_name,
           asg.assigned_ts::text AS assigned_ts
      FROM harness_shared.plan_item_assignments asg
      JOIN harness_shared.coord_presence cp
        ON cp.owner_id = asg.assignee_name
       AND cp.heartbeat_at > now() - make_interval(secs => ${graceSec})
     WHERE asg.workspace_id = ${workspaceId}
       AND asg.released_ts IS NULL
       AND asg.assignee_name IS NOT NULL AND asg.assignee_name <> ''
       AND asg.assigned_ts IS NOT NULL
       AND asg.assigned_ts < now() - make_interval(secs => ${settleSec})
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.plan_item_claims c
          WHERE c.workspace_id = asg.workspace_id AND c.harness_slug = asg.harness_slug
            AND c.plan_slug = asg.plan_slug AND c.item_id = asg.item_id
            AND c.owner = asg.assignee_name AND c.expires_ts > clock_timestamp()
       )`;
  return rows.map((r) => ({
    kind: 'unbacked-assignment' as const,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    itemId: r.item_id,
    holderOwnerId: r.assignee_name,
    holderOwnerLabel: r.assignee_name,
    detail:
      `plan item ${r.plan_slug}#${r.item_id} (harness ${r.harness_slug}) is actively ASSIGNED to ` +
      `${r.assignee_name} (assigned ${r.assigned_ts}, session LIVE) but has NO live plan_item_claims lease ` +
      `backing it — the durable assignment is unprotected: a peer can double-claim this item right now.`,
  }));
}

export interface PlannedClaimIntegrityAlarm {
  violation: ClaimIntegrityViolation;
  /** holder + its fleet leader (when resolvable and distinct), deduped. */
  targets: string[];
  summary: string;
}

/** Pure: turn violations into { targets, summary } alarms — holder + its
 *  fleet leader (when known and different from the holder), deduped. Exported
 *  for unit tests (no DB): the leader lookup is injected as a plain Map. */
export function planClaimIntegrityAlarms(
  violations: ClaimIntegrityViolation[],
  leaderByOwner: ReadonlyMap<string, string | null>,
): PlannedClaimIntegrityAlarm[] {
  return violations.map((v) => {
    const leader = leaderByOwner.get(v.holderOwnerId) ?? null;
    const targets = [...new Set([v.holderOwnerId, ...(leader && leader !== v.holderOwnerId ? [leader] : [])])];
    return {
      violation: v,
      targets,
      summary: `claim-integrity ALARM (${v.kind}): ${v.planSlug}#${v.itemId} — reconcile now, not a backlog item.`,
    };
  });
}

/** System identity for this monitor's own writes (mirrors MONITOR_IDENTITY). */
const CLAIM_INTEGRITY_IDENTITY: AgentIdentity = {
  ownerId: 'system:claim-integrity-monitor',
  ownerLabel: 'system · claim-integrity-monitor',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Resolve each distinct holder's CURRENT fleet leader (null when the holder
 *  has no fleet, or is itself the leader). Best-effort per holder — a lookup
 *  failure degrades that holder to "no leader known" rather than aborting the
 *  pass. Exported for unit tests. */
export async function resolveLeadersForHolders(
  workspaceId: string,
  holderOwnerIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (holderOwnerIds.length === 0) return out;
  let fleetByOwner: Map<string, { fleetSlug: string | null; fleetRole: string | null }>;
  try {
    fleetByOwner = await fetchPresenceFleet([...holderOwnerIds]);
  } catch {
    fleetByOwner = new Map();
  }
  const fleetSlugCache = new Map<string, string | null>();
  for (const id of holderOwnerIds) {
    const fleetSlug = fleetByOwner.get(id)?.fleetSlug ?? null;
    if (!fleetSlug) {
      out.set(id, null);
      continue;
    }
    try {
      if (!fleetSlugCache.has(fleetSlug)) {
        const fleet = await getFleet(workspaceId, fleetSlug);
        fleetSlugCache.set(fleetSlug, fleet?.leaderOwnerId ?? null);
      }
      out.set(id, fleetSlugCache.get(fleetSlug) ?? null);
    } catch {
      out.set(id, null);
    }
  }
  return out;
}

registerSystemAction('claim-integrity-sweep', async (ctx: SystemActionCtx) => {
  const presenceGraceSec = Number(
    (ctx.payloadTemplate?.presenceGraceSec as number | undefined) ?? CLAIM_INTEGRITY_PRESENCE_GRACE_SEC,
  );
  const settleSec = Number(
    (ctx.payloadTemplate?.settleSec as number | undefined) ?? CLAIM_INTEGRITY_ASSIGNMENT_SETTLE_SEC,
  );
  const { sql } = getOrgPg();
  const [orphaned, unbacked] = await Promise.all([
    findOrphanedWipClaims(sql, ctx.workspaceId, { presenceGraceSec }).catch(() => []),
    findUnbackedActiveAssignments(sql, ctx.workspaceId, { presenceGraceSec, settleSec }).catch(() => []),
  ]);
  const violations = [...orphaned, ...unbacked];
  if (violations.length === 0) return;

  const leaderByOwner = await resolveLeadersForHolders(
    ctx.workspaceId,
    [...new Set(violations.map((v) => v.holderOwnerId))],
  );
  const planned = planClaimIntegrityAlarms(violations, leaderByOwner);

  for (const alarm of planned) {
    // LOUD: a directed, WOKEN message to the holder + its fleet leader — the
    // primary signal (never blocks the pass on a delivery failure).
    try {
      await sendMessage(CLAIM_INTEGRITY_IDENTITY, {
        to: alarm.targets,
        summary: alarm.summary,
        body:
          `${alarm.violation.detail}\n\n` +
          `This is a LOUD claim-integrity alarm (fleet-reliability-verification-2026-07-10 P-001), not a ` +
          `filed backlog item — reconcile the claim now: confirm who actually holds the work, then either ` +
          `re-claim the plan item (coord:declare-intent / work_items:claim) or release the stale side ` +
          `(work_items:release / plans:set-status) so the two stay in agreement.`,
        category: 'claim-integrity-alarm',
      });
      await wakeRecipients(alarm.targets, { summary: alarm.summary, source: CLAIM_INTEGRITY_IDENTITY.ownerId });
    } catch {
      /* an alarm-delivery failure must not abort the pass — the improvement below still files */
    }
    // Durable audit trail (dedup-scoped): also the catch-all when nobody was
    // reachable to wake (a stale/dead holder — the alarm still records the fact).
    await captureImprovement({
      title: `claim integrity: ${alarm.violation.kind} on ${alarm.violation.planSlug}#${alarm.violation.itemId}`,
      kind: 'bug',
      severity: 'major',
      dedupScope: 'open',
      foundDuring: 'system:claim-integrity-sweep',
      subTopic: 'coordination',
      body: `${alarm.violation.detail}\n\nAlarmed (directed + woken): ${alarm.targets.join(', ')}\n(fleet-reliability-verification-2026-07-10 P-001 / EI-8999)`,
    }).catch(() => {
      /* a capture failure must not abort the remaining alarms */
    });
  }
});

// ── EI-436: dormant-harness substrate_outbox GC ─────────────────────────────
// The inline drain GC (outbox-drain.ts) deletes drained rows >24h ONLY for a
// CURRENTLY-BOOTED harness's own (workspace, slug) — by design, so N booted
// harnesses don't run N concurrent unscoped global DELETEs (the EI-125 trap that
// produced a 102GB table). But a harness that federated then STOPPED booting has
// no drain loop, so its drained rows never GC and leak forever (35,660 rows /
// 4.6GB cold TOAST observed). This is the ONE single-writer global sweep that
// reaches them: run by the hourly coord-invariant-monitor (a single authority),
// BOUNDED + BATCHED with the same window + predicate as the inline GC, but NOT
// scoped to a booted slug — it sweeps every slug in the workspace (the point).

/**
 * Single-writer, bounded+batched GC of drained `substrate_outbox` rows older than
 * the retention window, across EVERY harness_slug in the workspace (incl. dormant
 * ones the per-handle drain can't reach). Same predicate as the inline GC; only
 * the holder of this routine (one authority, hourly) ever runs it, so it is never
 * the unscoped concurrent DELETE storm of EI-125. Returns total rows deleted.
 */
export async function sweepDrainedOutbox(
  sql: postgres.Sql,
  workspaceId: string,
  nowMs: number,
  opts: { batch?: number; maxBatches?: number; ageMs?: number } = {},
): Promise<number> {
  const batch = opts.batch ?? OUTBOX_GC_BATCH;
  const maxBatches = opts.maxBatches ?? OUTBOX_GC_MAX_BATCHES;
  const cutoff = nowMs - (opts.ageMs ?? OUTBOX_GC_AGE_MS);
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    // Each batch is its own committed statement — progress survives a host recycle,
    // and the LIMIT keeps any single DELETE bounded (never the unbounded EI-125 one).
    const del = await sql`
      WITH del AS (
        SELECT id
          FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${workspaceId}
           AND drained_at IS NOT NULL
           AND drained_at < ${cutoff}
         LIMIT ${batch}
      )
      DELETE FROM harness_shared.substrate_outbox o
       USING del
       WHERE o.id = del.id`;
    const n = del.count ?? 0;
    total += n;
    if (n < batch) break; // fewer than a full batch ⇒ backlog cleared
  }
  return total;
}

registerSystemAction('coord-invariant-monitor', async (ctx: SystemActionCtx) => {
  const t: InvariantThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(ctx.payloadTemplate as Partial<InvariantThresholds> | null),
  };
  // EI-436: GC drained substrate_outbox rows for DORMANT harnesses (the inline
  // per-handle drain GC only reaches currently-booted slugs). Best-effort — a
  // sweep failure never aborts the pass.
  await sweepDrainedOutbox(getOrgPg().sql, ctx.workspaceId, Date.now()).catch(() => 0);
  // EI-314: GC staged wakes for ENDED sessions before measuring. A manual-mode
  // queue for a gone owner can never be released (only the owner releases it), so
  // it would trip the wake-queue invariant as pure debris and re-file forever.
  // Sweeping first means the violation only fires for a LIVE agent's genuinely-
  // stuck review queue. Best-effort — a sweep failure never aborts the pass.
  await sweepDeadOwnerPendingWakes().catch(() => 0);
  // WI-3097: GC staged wakes past a plain age cap regardless of owner liveness — the
  // dead-owner sweep above only reaps orphaned wakes for a GONE owner; a LIVE owner who
  // never reviews their wake board can otherwise let one sit indefinitely until the
  // wakeQueueAgeHours invariant below files it as a violation. Best-effort, same as the
  // sweep above — a failure never aborts the pass.
  await sweepStalePendingWakes({ staleHours: t.pendingWakeStaleHours }).catch(() => 0);
  // F-FIX-037: Auto-accept handoffs older than the stuck-handoff threshold. This
  // prevents them from persisting as open violations; handoffs waiting >12h for
  // acceptance are auto-accepted by the monitor before the invariant check runs.
  // Best-effort — a failure never aborts the pass.
  await autoAcceptStaleHandoffs(t.stuckHandoffHours).catch(() => 0);
  // EI-8786: Drain stale OPERATIONAL escalations BEFORE measuring, mirroring the
  // handoff auto-accept above and the wake-queue sweeps — so the escalation invariant
  // fires only on a genuine, unrecoverable drain failure, never because the separate
  // hourly attentionReconcile DBOS tick was late / shed / down (see the helper doc).
  // Best-effort — a failure never aborts the pass.
  await drainOperationalEscalationsBeforeMeasure().catch(() => 0);
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
