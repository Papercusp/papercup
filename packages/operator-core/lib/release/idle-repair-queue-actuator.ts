/**
 * Idle frozen-repair-queue ACTUATOR — plan green-main-cycle-time-2026-10-08 P-002 (WI-10007476).
 *
 * ## What this replaces
 *
 * `checkStrandedRepairQueue` (green-stall-watchdog.ts) used to answer a stalled frozen queue with
 * a fleet-wide `broadcastSevereEvent` ("Frozen repair queue has held main ~Nh") on every 8h age
 * rung. Nobody acted on it: on 2026-10-08 the 65h alarm made at least four agents each spend a
 * turn reading gate ownership and replying, while the gate already had a live owner. A broadcast
 * that names no actor and performs no action costs turns and moves nothing.
 *
 * ## What this does instead
 *
 * When no repair round has STARTED for more than {@link IDLE_REPAIR_QUEUE_MS} while failing legs
 * exist, it climbs a three-rung ladder, at most one rung per idle episode each:
 *
 *   1. `dispatch-fixer`  — dispatch the release fixer (only when the queue awaits one).
 *   2. `wake-gate-owner` — failing that, wake the CURRENT gate holder directly, naming the next
 *                          action for the queue's phase.
 *   3. `escalate-owner`  — failing that, raise an urgent intervention on the human owner's
 *                          attention surface.
 *
 * "Failing that" means one of three things. The rung did not apply (no fixer is awaited, or no
 * wakeable gate holder exists), so the next rung runs in the same pass. Its action failed, so the
 * next rung also runs in the same pass. Or it acted and still no round started within
 * {@link IDLE_RUNG_GRACE_MS}, so the next rung runs on a later tick.
 *
 * ## The idle episode
 *
 * An episode is keyed by `(candidate, idleSinceMs)` where `idleSinceMs` is the later of the
 * queue's `openedAtMs` and its `lastResumeRunStartedAtMs`. A new round starting moves
 * `idleSinceMs`, which starts a fresh episode, so a queue that keeps stalling is acted on again,
 * once per stall, never once per tick. With all three rungs spent the episode is `exhausted` and
 * the actuator stays silent until the queue moves.
 *
 * The decision half ({@link decideIdleQueueAction}) is PURE. The pass
 * ({@link runIdleQueueActuatorPass}) takes every effect as an injected dependency, so the
 * stalled-queue fixture in the test file walks the real ladder without a database.
 */

import type { Sql } from 'postgres';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';

export const IDLE_REPAIR_QUEUE_MS = 60 * 60_000;
export const IDLE_RUNG_GRACE_MS = 30 * 60_000;
/** Below the 15-min watchdog interval, so the ladder runs once per tick across all hosts. */
export const IDLE_PASS_LEASE_MS = 10 * 60_000;
/** `harness_escalations.phase` the episode is persisted under (one row per install). */
export const IDLE_REPAIR_QUEUE_PHASE = 'idle-repair-queue-actuator';

export const IDLE_QUEUE_RUNGS = ['dispatch-fixer', 'wake-gate-owner', 'escalate-owner'] as const;
export type IdleQueueRung = (typeof IDLE_QUEUE_RUNGS)[number];

/**
 * `acted` = the rung's action happened (or, for `dispatch-fixer`, a live fixer already exists);
 * the next rung waits out the grace. `failed` / `not-applicable` = the next rung runs at once.
 */
export type IdleRungOutcome = 'acted' | 'failed' | 'not-applicable';

export interface IdleRungRecord {
  atMs: number;
  outcome: IdleRungOutcome;
  detail: string;
}

export interface IdleQueueEpisode {
  candidate: string;
  idleSinceMs: number;
  rungs: Partial<Record<IdleQueueRung, IdleRungRecord>>;
}

export interface IdleQueueSnapshot {
  candidate: string;
  repairHead: string;
  phase: string;
  openedAtMs: number;
  lastResumeRunStartedAtMs: number | null;
  /** Failing legs still outstanding on the frozen candidate (the queue's `failingTests`). */
  failingLegs: number;
  fixerSpawnId: string | null;
  /** true = live, false = definitively dead, null = unknown / none recorded. */
  fixerAlive: boolean | null;
  /** The gate holder's ownerId, or null when nobody holds the gate. */
  gateHolder: string | null;
  /** True only when the holder's session can take a turn (live or parked). */
  gateHolderWakeable: boolean;
  blockedReason: string | null;
}

export type IdleQueueDecision =
  | { kind: 'not-idle'; reason: string }
  | { kind: 'wait'; reason: string; episode: IdleQueueEpisode; nextRungAtMs: number }
  | { kind: 'act'; rung: IdleQueueRung; reason: string; nextAction: string; episode: IdleQueueEpisode }
  | { kind: 'exhausted'; reason: string; episode: IdleQueueEpisode };

const short = (sha: string): string => sha.slice(0, 12);

function hoursText(ms: number): string {
  const h = ms / 3_600_000;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
}

/** The single concrete step that moves a queue in this phase. Named in every rung's message. */
export function namedNextAction(s: IdleQueueSnapshot): string {
  switch (s.phase) {
    case 'awaiting-fixer':
      return (
        `Dispatch a release fixer for frozen candidate ${short(s.candidate)}, or author the fix on staging ` +
        `and land it with release:repair-queue { op:'admit', paths:[...] }.`
      );
    case 'ready-to-test':
      return `Fire release:checkpoint-run: it resumes the frozen candidate ${short(s.candidate)} (no new cut).`;
    case 'ready-to-verify':
      return `Fire release:checkpoint-run: it re-tests repairHead ${short(s.repairHead)} on the frozen lineage.`;
    case 'blocked':
      return (
        `Read release:repair-queue { op:'status' } (blocked: ${s.blockedReason ?? 'reason not recorded'}); ` +
        `retire only per the documented unreachable-green test.`
      );
    default:
      return `Read release:repair-queue { op:'status' } for the per-leg picture.`;
  }
}

function notApplicableReason(rung: IdleQueueRung, s: IdleQueueSnapshot): string | null {
  switch (rung) {
    case 'dispatch-fixer':
      return s.phase === 'awaiting-fixer' ? null : `phase '${s.phase}' is not waiting on a fixer`;
    case 'wake-gate-owner':
      if (!s.gateHolder) return 'nobody holds the gate';
      return s.gateHolderWakeable ? null : `gate holder ${s.gateHolder} cannot take a turn`;
    case 'escalate-owner':
      return null;
  }
}

/** PURE. One rung per call; records not-applicable rungs on the returned episode as it walks. */
export function decideIdleQueueAction(
  s: IdleQueueSnapshot | null,
  prior: IdleQueueEpisode | null,
  nowMs: number,
): IdleQueueDecision {
  if (!s) return { kind: 'not-idle', reason: 'no frozen repair queue' };
  if (s.phase === 'ready-to-promote') return { kind: 'not-idle', reason: 'queue is ready to promote' };
  if (s.failingLegs <= 0) return { kind: 'not-idle', reason: 'no failing legs outstanding' };

  const idleSinceMs = Math.max(s.openedAtMs, s.lastResumeRunStartedAtMs ?? 0);
  const idleMs = nowMs - idleSinceMs;
  if (!(idleMs > IDLE_REPAIR_QUEUE_MS)) {
    return { kind: 'not-idle', reason: `last round started ${hoursText(Math.max(0, idleMs))} ago` };
  }

  const episode: IdleQueueEpisode =
    prior && prior.candidate === s.candidate && prior.idleSinceMs === idleSinceMs
      ? { ...prior, rungs: { ...prior.rungs } }
      : { candidate: s.candidate, idleSinceMs, rungs: {} };

  for (const rung of IDLE_QUEUE_RUNGS) {
    const rec = episode.rungs[rung];
    if (rec) {
      if (rec.outcome === 'acted' && nowMs < rec.atMs + IDLE_RUNG_GRACE_MS) {
        return {
          kind: 'wait',
          reason: `${rung} acted at ${new Date(rec.atMs).toISOString()} (${rec.detail}); waiting for a round to start`,
          episode,
          nextRungAtMs: rec.atMs + IDLE_RUNG_GRACE_MS,
        };
      }
      if (rung === 'escalate-owner' && rec.outcome === 'failed') {
        // The last rung has nothing to fall through to, so a failed escalation is retried after
        // the grace rather than leaving the episode silently exhausted with nobody told.
        if (nowMs < rec.atMs + IDLE_RUNG_GRACE_MS) {
          return {
            kind: 'wait',
            reason: `owner escalation failed (${rec.detail}); retrying after the grace`,
            episode,
            nextRungAtMs: rec.atMs + IDLE_RUNG_GRACE_MS,
          };
        }
        return {
          kind: 'act',
          rung,
          reason: `retrying the owner escalation that failed at ${new Date(rec.atMs).toISOString()}`,
          nextAction: namedNextAction(s),
          episode,
        };
      }
      continue;
    }
    if (rung === 'dispatch-fixer' && s.phase === 'awaiting-fixer' && s.fixerAlive === true) {
      // A live fixer is already the action this rung would take. Dispatching a second one would
      // race it; give it the grace before going over its head.
      episode.rungs[rung] = {
        atMs: nowMs,
        outcome: 'acted',
        detail: `fixer ${s.fixerSpawnId ?? '(unrecorded)'} already live; no second dispatch`,
      };
      return {
        kind: 'wait',
        reason: `a live fixer holds the queue; waiting ${hoursText(IDLE_RUNG_GRACE_MS)} for it to start a round`,
        episode,
        nextRungAtMs: nowMs + IDLE_RUNG_GRACE_MS,
      };
    }
    const na = notApplicableReason(rung, s);
    if (na) {
      episode.rungs[rung] = { atMs: nowMs, outcome: 'not-applicable', detail: na };
      continue;
    }
    return {
      kind: 'act',
      rung,
      reason: `no repair round has started for ${hoursText(idleMs)} with ${s.failingLegs} failing leg(s)`,
      nextAction: namedNextAction(s),
      episode,
    };
  }
  return {
    kind: 'exhausted',
    reason: 'every rung has run for this idle episode; silent until a round starts',
    episode,
  };
}

/** PURE. The episode with `rung`'s outcome recorded. */
export function recordIdleRungOutcome(
  episode: IdleQueueEpisode,
  rung: IdleQueueRung,
  outcome: IdleRungOutcome,
  detail: string,
  nowMs: number,
): IdleQueueEpisode {
  return { ...episode, rungs: { ...episode.rungs, [rung]: { atMs: nowMs, outcome, detail } } };
}

/** PURE. The message a wake or an escalation carries: what is idle, what already ran, what to do. */
export function idleQueueMessage(
  installSlug: string,
  s: IdleQueueSnapshot,
  episode: IdleQueueEpisode,
  nowMs: number,
): { summary: string; body: string } {
  const idle = hoursText(nowMs - episode.idleSinceMs);
  const ran = IDLE_QUEUE_RUNGS.filter((r) => episode.rungs[r])
    .map((r) => `${r}: ${episode.rungs[r]!.outcome} (${episode.rungs[r]!.detail})`)
    .join('; ');
  const nextAction = namedNextAction(s);
  return {
    summary: `Frozen repair queue on ${installSlug} idle ${idle} — ${nextAction}`,
    body:
      `Frozen candidate ${short(s.candidate)} (repairHead ${short(s.repairHead)}, phase '${s.phase}') has ` +
      `${s.failingLegs} failing leg(s) and no repair round has started for ${idle}. ` +
      (ran ? `Earlier rungs this episode: ${ran}. ` : '') +
      `Next action: ${nextAction}`,
  };
}

export interface IdleRungResult {
  ok: boolean;
  detail: string;
}

export interface IdleQueueActuatorDeps {
  installSlug: string;
  nowMs: () => number;
  readSnapshot: () => Promise<IdleQueueSnapshot | null>;
  loadEpisode: () => Promise<IdleQueueEpisode | null>;
  saveEpisode: (episode: IdleQueueEpisode | null) => Promise<void>;
  dispatchFixer: (s: IdleQueueSnapshot) => Promise<IdleRungResult>;
  wakeGateOwner: (holder: string, msg: { summary: string; body: string }) => Promise<IdleRungResult>;
  escalateOwner: (msg: { summary: string; body: string }) => Promise<IdleRungResult>;
}

export interface IdleQueuePassResult {
  decision: IdleQueueDecision['kind'];
  acted: Array<{ rung: IdleQueueRung; outcome: IdleRungOutcome; detail: string }>;
}

/**
 * One actuator pass. A failed rung falls through to the next rung IN THE SAME PASS, so a dead
 * dispatcher costs no extra tick before the gate owner hears about it. Never throws on a rung's
 * failure; a read/persist failure propagates to the caller's watchdog-health record.
 */
export async function runIdleQueueActuatorPass(deps: IdleQueueActuatorDeps): Promise<IdleQueuePassResult> {
  const s = await deps.readSnapshot();
  let episode = await deps.loadEpisode();
  const acted: IdleQueuePassResult['acted'] = [];

  for (let i = 0; i <= IDLE_QUEUE_RUNGS.length; i++) {
    const now = deps.nowMs();
    const d = decideIdleQueueAction(s, episode, now);
    if (d.kind === 'not-idle') {
      if (episode) await deps.saveEpisode(null);
      return { decision: d.kind, acted };
    }
    if (d.kind !== 'act') {
      await deps.saveEpisode(d.episode);
      return { decision: d.kind, acted };
    }
    const msg = idleQueueMessage(deps.installSlug, s!, d.episode, now);
    let result: IdleRungResult;
    try {
      result =
        d.rung === 'dispatch-fixer'
          ? await deps.dispatchFixer(s!)
          : d.rung === 'wake-gate-owner'
            ? await deps.wakeGateOwner(s!.gateHolder!, msg)
            : await deps.escalateOwner(msg);
    } catch (e) {
      result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    const outcome: IdleRungOutcome = result.ok ? 'acted' : 'failed';
    episode = recordIdleRungOutcome(d.episode, d.rung, outcome, result.detail, now);
    acted.push({ rung: d.rung, outcome, detail: result.detail });
    await deps.saveEpisode(episode);
    if (result.ok) return { decision: 'act', acted };
  }
  return { decision: 'exhausted', acted };
}

/** `harness_escalations.escalation` is TEXT, so a stored episode reads back as a JSON string. */
export function parseEpisode(raw: unknown): IdleQueueEpisode | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.candidate !== 'string' || typeof r.idleSinceMs !== 'number') return null;
  const rungs: IdleQueueEpisode['rungs'] = {};
  const src = r.rungs && typeof r.rungs === 'object' ? (r.rungs as Record<string, unknown>) : {};
  for (const rung of IDLE_QUEUE_RUNGS) {
    const rec = src[rung] as Record<string, unknown> | undefined;
    if (
      rec &&
      typeof rec.atMs === 'number' &&
      (rec.outcome === 'acted' || rec.outcome === 'failed' || rec.outcome === 'not-applicable')
    ) {
      rungs[rung] = { atMs: rec.atMs, outcome: rec.outcome, detail: String(rec.detail ?? '') };
    }
  }
  return { candidate: r.candidate, idleSinceMs: r.idleSinceMs, rungs };
}

/**
 * The episode row is the actuator's own state, not a request for triage. Without a note,
 * `collectEscalationSignals` (harness/improvements/watchdog.ts) files a major "Unresolved
 * escalation" bug for ANY row lacking `supervisor_notes`, which would page a second time,
 * through a worker dispatch, for a stall that rung 3 already put in front of the owner.
 */
export const IDLE_ACTUATOR_SELF_MANAGED_NOTE =
  'self-managed: idle-repair-queue-actuator state; the actuator escalates to the owner itself (rung 3)';

/**
 * One host per tick. The watchdog starts from DBOS bootstrap, so every DBOS-running process ticks
 * it; without a claim two hosts could read the same episode and both wake or escalate. The claim
 * is ONE atomic upsert on the episode row: it advances `mtime_ms` only when the last pass (any
 * host) is at least {@link IDLE_PASS_LEASE_MS} old, and returns the stored episode. An
 * `mtime_ms`-only change is a refresh stamp to git-export (WI-10003624), so this causes no churn.
 */
export async function claimIdleActuatorPass(
  sql: Sql,
  o: { installSlug: string; workspaceId: string; nowMs: number },
): Promise<{ claimed: false } | { claimed: true; episode: IdleQueueEpisode | null }> {
  const rows = await sql<{ escalation: unknown }[]>`
    INSERT INTO harness_shared.harness_escalations
           (harness_slug, phase, escalation, supervisor_notes, mtime_ms, workspace_id)
    VALUES (${o.installSlug}, ${IDLE_REPAIR_QUEUE_PHASE}, NULL, ${IDLE_ACTUATOR_SELF_MANAGED_NOTE},
            ${o.nowMs}, ${o.workspaceId})
    ON CONFLICT (harness_slug, phase) DO UPDATE SET mtime_ms = EXCLUDED.mtime_ms
     WHERE harness_shared.harness_escalations.mtime_ms <= ${o.nowMs - IDLE_PASS_LEASE_MS}
    RETURNING escalation`;
  return rows.length === 0 ? { claimed: false } : { claimed: true, episode: parseEpisode(rows[0].escalation) };
}

/** Persist (or, with `null`, clear) the episode. Always carries the self-managed note. */
export async function saveIdleActuatorEpisode(
  sql: Sql,
  o: { installSlug: string; workspaceId: string; nowMs: number; episode: IdleQueueEpisode | null },
): Promise<void> {
  if (!o.episode) {
    await sql`
      UPDATE harness_shared.harness_escalations
         SET escalation = NULL, mtime_ms = ${o.nowMs}
       WHERE harness_slug = ${o.installSlug} AND phase = ${IDLE_REPAIR_QUEUE_PHASE}
         AND escalation IS NOT NULL`;
    return;
  }
  await sql`
    INSERT INTO harness_shared.harness_escalations
           (harness_slug, phase, escalation, supervisor_notes, mtime_ms, workspace_id)
    VALUES (${o.installSlug}, ${IDLE_REPAIR_QUEUE_PHASE},
            ${JSON.stringify({ kind: IDLE_REPAIR_QUEUE_PHASE, harness_slug: o.installSlug, ...o.episode })},
            ${IDLE_ACTUATOR_SELF_MANAGED_NOTE}, ${o.nowMs}, ${o.workspaceId})
    ON CONFLICT (harness_slug, phase)
    DO UPDATE SET escalation = EXCLUDED.escalation, supervisor_notes = EXCLUDED.supervisor_notes,
                  mtime_ms = EXCLUDED.mtime_ms`;
}

const IDLE_ACTUATOR_IDENTITY = {
  ownerId: 'system-watchdog',
  ownerLabel: 'system-watchdog',
  source: 'static-client' as const,
  workspaceId: null,
  userId: null,
};

/**
 * The production pass, wired into `startGreenStallWatchdog` beside `checkStrandedRepairQueue`.
 * Every effect is real: `dispatchReleaseFixer` (which dedups against a live fixer and takes a
 * CAS-written reservation, so a watchdog dispatch cannot double-spawn), a directed message plus
 * wake to the gate holder alone, and an urgent intervention on the owner's attention surface.
 * The episode persists in `harness_escalations` under {@link IDLE_REPAIR_QUEUE_PHASE}.
 */
export async function checkIdleRepairQueue(
  sql: Sql,
  opts: { installSlug?: string; workspaceId?: string; nowMs?: () => number } = {},
): Promise<IdleQueuePassResult | null> {
  const installSlug = opts.installSlug ?? 'papercusp';
  const { recordWatchdogPassOutcome } = await import('./watchdog-health');
  let passError: unknown;
  try {
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND target_role = 'system:green-checkpoint'
       LIMIT 1`;
    if (rows.length === 0) return null;
    const workspaceId = opts.workspaceId ?? rows[0].workspace_id;

    const { readFrozenCandidateRepairQueueState, dispatchReleaseFixer } = await import(
      '../harness/routines/release-actions'
    );
    const { releaseFixerSpawnAlive } = await import('./fixer-liveness');
    const { readGateOwnership } = await import('../coord/gate-ownership');

    // One host per tick. The watchdog starts from DBOS bootstrap, so every DBOS-running process
    // ticks it; without this two hosts could read the same episode and both wake or escalate.
    // The claim is one atomic upsert on the episode row: it advances mtime_ms only when the last
    // pass (any host) is at least IDLE_PASS_LEASE_MS old, and hands back the stored episode.
    const claim = await claimIdleActuatorPass(sql, { installSlug, workspaceId, nowMs: (opts.nowMs ?? Date.now)() });
    if (!claim.claimed) return null;
    const storedEpisode = claim.episode;

    let queue: FrozenCandidateRepairQueue | null = null;
    const result = await runIdleQueueActuatorPass({
      installSlug,
      nowMs: opts.nowMs ?? Date.now,
      readSnapshot: async () => {
        const read = await readFrozenCandidateRepairQueueState({ workspaceId, installSlug });
        queue = read.status === 'value' ? read.queue : null;
        if (!queue) return null;
        const fixerAlive = queue.fixerSpawnId
          ? await releaseFixerSpawnAlive(sql as never, queue.fixerSpawnId).catch(() => null)
          : null;
        const own = await readGateOwnership({ harness: installSlug }).catch(() => null);
        const holderState = own?.holderSessionState ?? null;
        return {
          candidate: queue.candidate,
          repairHead: queue.repairHead,
          phase: queue.phase,
          openedAtMs: queue.openedAtMs,
          lastResumeRunStartedAtMs: queue.lastResumeRunStartedAtMs ?? null,
          failingLegs: queue.failingTests.length,
          fixerSpawnId: queue.fixerSpawnId,
          fixerAlive,
          gateHolder: own?.takenBy ?? null,
          gateHolderWakeable: holderState === 'live' || holderState === 'parked',
          blockedReason: queue.blockedReason ?? null,
        };
      },
      loadEpisode: async () => storedEpisode,
      saveEpisode: (episode) =>
        saveIdleActuatorEpisode(sql, { installSlug, workspaceId, nowMs: (opts.nowMs ?? Date.now)(), episode }),
      dispatchFixer: async () => {
        const q = queue;
        if (!q) return { ok: false, detail: 'queue vanished before dispatch' };
        const r = await dispatchReleaseFixer({ installSlug, workspaceId }, q.candidate, q.failingTests, q);
        return r?.spawnId
          ? { ok: true, detail: `dispatched fixer ${r.spawnId}` }
          : {
              ok: false,
              detail: r
                ? 'dispatcher reserved but produced no spawn'
                : 'dispatcher declined (see release-fixer-skipped pipeline events)',
            };
      },
      wakeGateOwner: async (holder, msg) => {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
        const env = await sendMessage(IDLE_ACTUATOR_IDENTITY, {
          to: [holder],
          summary: msg.summary,
          body: msg.body,
          expectsReply: true,
        });
        if (env.to.length === 0) return { ok: false, detail: `${holder} resolved to no recipient` };
        const w = await wakeRecipients(env.to, { summary: msg.summary, source: IDLE_REPAIR_QUEUE_PHASE, workspaceId });
        return w.woken > 0
          ? { ok: true, detail: `woke ${holder}` }
          : { ok: false, detail: `message sent but no live wake landed for ${holder}` };
      },
      escalateOwner: async (msg) => {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: msg.summary,
          body: msg.body,
          importance: 'urgent',
          workspaceId,
          data: { installSlug, phase: IDLE_REPAIR_QUEUE_PHASE },
        });
        return { ok: true, detail: 'urgent intervention raised on the owner attention surface' };
      },
    });
    if (result.acted.length > 0) {
      console.warn(
        `[idle-repair-queue-actuator] ${installSlug}: ` +
          result.acted.map((a) => `${a.rung}=${a.outcome} (${a.detail})`).join('; '),
      );
    }
    return result;
  } catch (e) {
    passError = e;
    console.warn(`[idle-repair-queue-actuator] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    await recordWatchdogPassOutcome(sql, 'idle-repair-queue', { routineName: 'green-checkpoint', installSlug }, passError);
  }
}
