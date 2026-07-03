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
 *                                          TTL — the substrate's own drain is failing;
 *                                          EI-6910: was "any open escalation past 6h",
 *                                          which fired perpetually on the human's normal
 *                                          decision backlog)
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
} from '../../shared-hive-loop/fleet-monitors';
import { sendMessage, readInbox, appendAck, readAckedMsgIds } from '../../agent-tools/coordination/messages';
import { listHandoffs, acceptHandoff } from '../../agent-tools/coordination/handoffs';
import { listEscalations } from '../../agent-tools/coordination/escalations';
// EI-6910: the escalation invariant measures coordination-SUBSTRATE drain-health, so it
// must know (a) which escalations the substrate is responsible for draining
// (isOperationalEscalation — the same queue-pending-accuracy D-005 classifier the
// reader + reconcile sweep already agree on) and (b) the reconcile drain deadline
// (OPERATIONAL_ESCALATION_TTL_MS — the single source of truth in reconcile-escalations.ts).
import { isOperationalEscalation } from '../../attention/adapters';
import { OPERATIONAL_ESCALATION_TTL_MS } from '../../attention/reconcile-escalations';
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
    const stepLines = steps.map((s) => `  ${s.ok ? '✓' : '×'} ${s.step} ${s.ms}ms${s.detail ? ` — ${s.detail}` : ''}`).join('\n');

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
  wakeQueueAgeHours: number;
}

export const DEFAULT_THRESHOLDS: InvariantThresholds = {
  stuckHandoffHours: 12,
  expiredLockGraceMin: 60,
  presenceGhostHours: 72,
  wakeQueueDepthMax: 50,
  wakeQueueAgeHours: 6,
};

/** One open escalation, reduced to what the substrate-drain invariant needs to tell a
 *  genuine human decision (the human's attention queue — never a substrate leak) from an
 *  OPERATIONAL escalation the substrate auto-drains. */
export interface OpenEscalationLite {
  ts: string;
  from: string | null;
  hasOptions: boolean;
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
    return Number.isFinite(openedMs) && nowMs - openedMs > OPERATIONAL_ESCALATION_TTL_MS;
  }).length;
  if (undrainedOperationalEsc > 0) {
    const ttlHours = Math.round(OPERATIONAL_ESCALATION_TTL_MS / 3_600_000);
    out.push({
      title: 'coord invariant: operational escalations undrained past reconcile TTL',
      detail: `${undrainedOperationalEsc} operational escalation(s) still open past the ${ttlHours}h attention-reconcile TTL — the reconcile sweep (reconcile-escalations.ts) is not draining them.`,
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
  if (snap.wakeQueueDepth > t.wakeQueueDepthMax || oldestH > t.wakeQueueAgeHours) {
    out.push({
      title: 'coord invariant: wake-queue depth/age growth',
      detail: `pending_wakes depth=${snap.wakeQueueDepth} (max ${t.wakeQueueDepthMax}), oldest=${oldestH.toFixed(1)}h (max ${t.wakeQueueAgeHours}h) — staged wakes are not being released.`,
      severity: 'minor',
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
  const t: InvariantThresholds = { ...DEFAULT_THRESHOLDS, ...(ctx.payloadTemplate as Partial<InvariantThresholds> | null) };
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
  // F-FIX-037: Auto-accept handoffs older than the stuck-handoff threshold. This
  // prevents them from persisting as open violations; handoffs waiting >12h for
  // acceptance are auto-accepted by the monitor before the invariant check runs.
  // Best-effort — a failure never aborts the pass.
  await autoAcceptStaleHandoffs(t.stuckHandoffHours).catch(() => 0);
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
