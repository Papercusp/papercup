/**
 * await-event engine — emit + the delivery pump + the background sweeper
 * (await-event-primitive-2026-06-05 P-002/P-005, D-001/D-002/D-004/D-007).
 *
 * `emitAwaitedEvent` is the ONE emit surface for sources (locks, plan runs,
 * conversations, CI, agents via events:emit). Per the layering (D-001) the
 * source has already resolved WHO the event concerns — a targeted key
 * (`lock:grant:<ticket>`) or an explicit `to[]` — and the delivery here is
 * dumb: wake the wake-awaiters (durable queue + the liveness ladder), put it
 * in everyone else's coord inbox (the notify path — durable in
 * coord_event_log, mid-turn injected by the PostToolUse hook when awake,
 * read on the next natural turn otherwise; NEVER wakes, D-002).
 *
 * Cost discipline (D-007): every wake is a turn. The pump caps resume-spawns
 * per tick and runs one wake per subscriber at a time (mass-unblock events
 * re-admit waiters paced, not all at once); the deliveries table is the
 * meter (per-agent attribution + channel; events:status reads it).
 */

import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  claimDueDeliveries,
  expireLapsedAwaits,
  fireAwaitsForKey,
  fireTimedOutAwaits,
  insertDeliveries,
  markDeliveryDeferred,
  markDeliveryDelivered,
  markDeliveryDropped,
  markDeliveryFailed,
  markDeliveryParked,
  recoverStuckDeliveries,
} from './store';
import { executeWake, type ExecuteWakeDeps } from './wake-executor';
import type { AwaitRow } from './types';

const log = (msg: string) => console.warn(`[await-event] ${msg}`);

/** Resume-spawn cap per pump tick (a wake = a turn = tokens — pace mass unblocks). */
function maxResumesPerTick(): number {
  const n = Number(process.env.PAPERCUSP_AWAIT_MAX_RESUMES_PER_TICK ?? 3);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

const MAX_ATTEMPTS = 8;
const PARK_RECHECK_MS = 45_000;
const DEFER_MS = 30_000;
const STUCK_DELIVERING_MS = 5 * 60_000;
const backoffMs = (attempts: number): number => Math.min(5_000 * 2 ** attempts, 10 * 60_000);

/** System identity for the notify-path sends (mirrors green-checkpoint's). */
function emitterIdentity(source: string | undefined, workspaceId: string): AgentIdentity {
  return {
    ownerId: source ?? 'await-event',
    ownerLabel: source ?? 'await-event',
    source: 'static-client',
    workspaceId,
    userId: null,
  } as AgentIdentity;
}

export interface EmitAwaitedEventOpts {
  /** Exact event key, e.g. `lock:grant:<ticket>` / `plan-run:finished:<id>`. */
  key: string;
  /** Carried on wake deliveries + the notify message body. */
  payload?: unknown;
  /** One human line — becomes part of the wake turn / notify summary. */
  summary?: string;
  /** Additional notify audience: ownerIds, Brief 28 @-selectors, '*' or 'human'.
   *  Wake-awaiters are woken regardless and EXCLUDED from the notify send
   *  (their wake already carries the reason). */
  to?: string[];
  /** Emitter attribution (ownerId or a system name). */
  source?: string;
  workspaceId?: string;
}

export interface EmitResult {
  ok: true;
  key: string;
  /** Wake awaits fired by this emit (deliveries queued). */
  woken: number;
  /** Notify recipients the inbox message went to (post-expansion happens in sendMessage). */
  notified: string[];
  msgId: string | null;
}

export async function emitAwaitedEvent(opts: EmitAwaitedEventOpts): Promise<EmitResult> {
  const ws = opts.workspaceId ?? activeWorkspaceId();

  // 1. One-shot fire the awaits on this key (atomic — D-002).
  const fired = await fireAwaitsForKey({ eventKey: opts.key, reason: 'event', workspaceId: ws });
  const wakes = fired.filter((a) => a.policy === 'wake');
  const notifyAwaits = fired.filter((a) => a.policy === 'notify');

  // 2. Queue durable wake deliveries + kick the pump off the hot path.
  if (wakes.length > 0) {
    await insertDeliveries({ awaits: wakes, payload: opts.payload, summary: opts.summary ?? null, workspaceId: ws });
    setImmediate(() => {
      void pumpWakeDeliveries(ws).catch((e) => log(`pump kick failed: ${e instanceof Error ? e.message : e}`));
    });
  }

  // 3. The notify path — one coord message to the remaining audience.
  const wokenIds = new Set(wakes.map((a) => a.subscriberId));
  const notifyTo = [
    ...new Set([...notifyAwaits.map((a) => a.subscriberId), ...(opts.to ?? [])]),
  ].filter((t) => !wokenIds.has(t));

  let msgId: string | null = null;
  if (notifyTo.length > 0) {
    try {
      const env = await sendMessage(emitterIdentity(opts.source, ws), {
        to: notifyTo,
        summary: `[event] ${opts.key}${opts.summary ? ` — ${opts.summary}` : ''}`,
        body: opts.payload != null ? JSON.stringify(opts.payload).slice(0, 2000) : undefined,
        category: 'event',
        extra: { auto: true, event_key: opts.key },
      });
      msgId = env.msg_id;
    } catch (e) {
      // The notify half is the politeness layer — never break the emit.
      log(`notify send failed for ${opts.key}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { ok: true, key: opts.key, woken: wakes.length, notified: notifyTo, msgId };
}

// ── the pump ──────────────────────────────────────────────────────────────────

let pumpInFlight = false;

export interface PumpStats {
  claimed: number;
  delivered: number;
  parked: number;
  dropped: number;
  failed: number;
  deferred: number;
}

/**
 * Process due wake deliveries: claim (SKIP LOCKED) → execute the liveness
 * ladder → settle each row. Non-overlapping per host; per-subscriber
 * single-flight inside a tick; resume-spawns capped per tick (D-007).
 */
export async function pumpWakeDeliveries(workspaceId?: string, deps: ExecuteWakeDeps = {}): Promise<PumpStats> {
  const stats: PumpStats = { claimed: 0, delivered: 0, parked: 0, dropped: 0, failed: 0, deferred: 0 };
  if (pumpInFlight) return stats;
  pumpInFlight = true;
  try {
    const ws = workspaceId ?? activeWorkspaceId();
    const claimed = await claimDueDeliveries({ limit: 10, workspaceId: ws });
    stats.claimed = claimed.length;
    if (claimed.length === 0) return stats;

    const seenSubscriber = new Set<string>();
    let resumes = 0;

    for (const d of claimed) {
      // Per-subscriber single-flight: one wake per agent per tick.
      if (seenSubscriber.has(d.subscriberId)) {
        await markDeliveryDeferred(d.id, DEFER_MS);
        stats.deferred++;
        continue;
      }
      // Resume cap: pace mass-unblocks (the rest re-admit next tick).
      const needsSpawnLikely = d.wakeHandle != null; // conservative — count every executed wake against the cap
      if (needsSpawnLikely && resumes >= maxResumesPerTick()) {
        await markDeliveryDeferred(d.id, DEFER_MS);
        stats.deferred++;
        continue;
      }

      seenSubscriber.add(d.subscriberId);
      const outcome = await executeWake(d, deps);

      if (outcome.kind === 'delivered') {
        if (outcome.channel === 'resume' || outcome.channel === 'resume-headless' || outcome.channel === 'plan-run-resume') resumes++;
        await markDeliveryDelivered(d.id, outcome.channel);
        stats.delivered++;
        log(`wake #${d.id} delivered → ${d.subscriberId} via ${outcome.channel} (${d.eventKey})`);
        continue;
      }
      if (outcome.kind === 'park') {
        // One-time inbox nudge on the first park: the awake-but-uninjectable
        // agent sees it mid-turn (PostToolUse hook) or on its next turn; the
        // parked row converts to a resume when its process exits.
        if (d.attempts <= 1) {
          try {
            await sendMessage(emitterIdentity('await-event', d.workspaceId), {
              to: [d.subscriberId],
              summary: `[await-event] ${d.eventKey} fired — wake parked (${outcome.reason})`,
              body: d.summary ?? undefined,
              category: 'event',
              extra: { auto: true, event_key: d.eventKey, wake_delivery_id: d.id },
            });
          } catch {
            /* nudge is best-effort; the parked row is the durable truth */
          }
        }
        await markDeliveryParked(d.id, outcome.reason, PARK_RECHECK_MS);
        stats.parked++;
        continue;
      }
      if (outcome.kind === 'drop') {
        await markDeliveryDropped(d.id, outcome.reason);
        stats.dropped++;
        log(`wake #${d.id} DROPPED (dead waiter) → ${d.subscriberId}: ${outcome.reason} (${d.eventKey})`);
        continue;
      }
      const verdict = await markDeliveryFailed({
        id: d.id,
        error: outcome.error,
        attempts: d.attempts,
        maxAttempts: MAX_ATTEMPTS,
        backoffMs: backoffMs(d.attempts),
      });
      stats.failed++;
      if (verdict === 'dead') log(`wake #${d.id} DEAD after ${d.attempts} attempts → ${d.subscriberId}: ${outcome.error}`);
    }
    return stats;
  } finally {
    pumpInFlight = false;
  }
}

// ── the sweeper ───────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 30_000;

type Globals = typeof globalThis & { __papercuspAwaitSweeperStarted?: boolean };

/**
 * Background sweeper (locks-janitor pattern: lazy, unref'd, restart-safe —
 * all state is PG): recover stuck 'delivering' rows, fire timed-out awaits
 * (timeout_behavior 'wake' → a TIMEOUT wake delivery; 'expire' → visible
 * lapse), then pump anything due (incl. parked rows whose process died).
 */
export function startAwaitSweeper(): void {
  const g = globalThis as Globals;
  if (g.__papercuspAwaitSweeperStarted) return;
  g.__papercuspAwaitSweeperStarted = true;
  setInterval(() => {
    void sweepOnce().catch((e) => log(`sweep failed: ${e instanceof Error ? e.message : e}`));
  }, SWEEP_INTERVAL_MS).unref?.();
}

export async function sweepOnce(workspaceId?: string): Promise<void> {
  const ws = workspaceId ?? activeWorkspaceId();

  const recovered = await recoverStuckDeliveries({ olderThanMs: STUCK_DELIVERING_MS, workspaceId: ws });
  if (recovered > 0) log(`recovered ${recovered} stuck deliveries`);

  const timedOut = await fireTimedOutAwaits(ws);
  if (timedOut.length > 0) {
    const wakes: AwaitRow[] = timedOut.filter((a) => a.policy === 'wake');
    if (wakes.length > 0) {
      await insertDeliveries({
        awaits: wakes,
        payload: { timeout: true },
        summary: 'await deadline passed without the event firing',
        workspaceId: ws,
      });
    }
    log(`fired ${timedOut.length} timed-out awaits`);
  }

  const lapsed = await expireLapsedAwaits(ws);
  if (lapsed > 0) log(`expired ${lapsed} lapsed awaits (timeout_behavior=expire)`);

  await pumpWakeDeliveries(ws);
}
