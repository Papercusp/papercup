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

import { getOrgPg } from '@papercusp/db-org';
import { decideWake } from '@papercusp/debounce-coalesce';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { admitSpawn } from '../../fleet/governor';
import { activeWorkspaceId, backgroundWorkspaceIds } from '../../workspace-registry';
import { runWithWorkspace } from '../../workspace-als';
import {
  claimDueDeliveries,
  expireLapsedAwaits,
  fireAwaitsForKey,
  fireTimedOutAwaits,
  insertDeliveries,
  lastWokenAtForSubscribers,
  markDeliveriesCoalesced,
  markDeliveryDeferred,
  markDeliveryDelivered,
  markDeliveryDropped,
  markDeliveryFailed,
  markDeliveryParked,
  recoverStuckDeliveries,
} from './store';
import { executeWake, type ExecuteWakeDeps } from './wake-executor';
import type { ResumeTurnExitRaw } from './resume-turn-outcome';
import type { AwaitRow, DeliveryWork } from './types';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

const log = (msg: string) => console.warn(`[await-event] ${msg}`);

/**
 * su-cold-auto-mode-2026-07-03 P-007: the master availability gate the wake-executor cold-fork
 * consults. Resolved HERE (the production wake pump) so wake-executor.ts stays a pure liveness
 * module with no flag-system coupling. Only CONSULTED when a wake carries a `carry:'cold'` loop
 * marker (a warm fleet never reads it), and even ON a loop goes cold only when armed
 * `carry:'cold'` AND a carry-note exists (decideColdWake). Default ON (owner-enabled 2026-07-03).
 */
const defaultColdAutoEnabled = (): Promise<boolean> => getFlag(FLAGS.SU_COLD_AUTO, 'system');

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
  /** Urgent: bypass the per-subscriber wake floor for the wake deliveries this emit
   *  queues (a human message, an escalation, a hard deadline). */
  urgent?: boolean;
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
    await insertDeliveries({
      awaits: wakes,
      payload: opts.payload,
      summary: opts.summary ?? null,
      urgent: opts.urgent,
      // P0a: persist the emit attribution on the delivery so a later turn-death is
      // attributable to its source (e.g. a loop fire's `loop:<routineId>`).
      source: opts.source ?? null,
      workspaceId: ws,
    });
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

// Keyed per workspace (audit P-033): a single module-global boolean made workspace
// A's in-flight pump silently swallow workspace B's emit kick — the kick is
// fire-and-forget, so the dropped tick was invisible and B's wakes starved until
// the next sweep. Concurrent pumps for DIFFERENT workspaces are safe (claiming is
// SKIP LOCKED and workspace-scoped); the guard only exists to stop one workspace
// from pumping itself reentrantly.
const pumpsInFlight = new Set<string>();

export interface PumpStats {
  claimed: number;
  delivered: number;
  parked: number;
  dropped: number;
  failed: number;
  deferred: number;
  /** Deliveries folded into another wake for the same subscriber (no turn spent). */
  coalesced: number;
}

/**
 * Fold a subscriber's due deliveries into ONE wake (unify-watch-primitive P-005): the
 * newest is the headline; its summary/payload carry the union ("here are the N things
 * that fired while you slept"). The siblings settle as `coalesced` (no extra turns).
 */
export function coalesceDeliveries(group: DeliveryWork[]): DeliveryWork {
  const headline = group[group.length - 1];
  if (group.length === 1) return headline;
  const keys = group.map((d) => d.eventKey);
  return {
    ...headline,
    summary:
      `${group.length} events fired while you slept: ${keys.join(', ')}` +
      (headline.summary ? ` — latest: ${headline.summary}` : ''),
    payload: {
      coalesced: true,
      count: group.length,
      events: group.map((d) => ({ event: d.eventKey, summary: d.summary, payload: d.payload, delivery_id: d.id })),
      latest: { event: headline.eventKey, payload: headline.payload },
    },
    coalescedCount: group.length,
  };
}

/**
 * Process due wake deliveries: claim (SKIP LOCKED) → GROUP by subscriber → per-subscriber
 * floor + coalesce (the unify-watch-primitive gap) → execute the liveness ladder → settle.
 *
 * Per subscriber, per tick: a `min_sleep` floor defers the whole group until the floor next
 * allows a wake (`decideWake`); when it does wake, the group's due deliveries COALESCE into a
 * single wake carrying their union — one turn for N events, not N turns. `urgent` deliveries
 * bypass the floor. Resume-spawns are still capped per tick across subscribers (D-007).
 */
export async function pumpWakeDeliveries(workspaceId?: string, deps: ExecuteWakeDeps = {}): Promise<PumpStats> {
  const stats: PumpStats = { claimed: 0, delivered: 0, parked: 0, dropped: 0, failed: 0, deferred: 0, coalesced: 0 };
  const ws = workspaceId ?? activeWorkspaceId();
  if (pumpsInFlight.has(ws)) return stats;
  pumpsInFlight.add(ws);
  try {
    const claimed = await claimDueDeliveries({ limit: 25, workspaceId: ws });
    stats.claimed = claimed.length;
    if (claimed.length === 0) return stats;

    // Group claimed deliveries by subscriber — the coalesce + floor unit.
    const bySubscriber = new Map<string, DeliveryWork[]>();
    for (const d of claimed) {
      const arr = bySubscriber.get(d.subscriberId);
      if (arr) arr.push(d);
      else bySubscriber.set(d.subscriberId, [d]);
    }

    // The per-subscriber floor anchor (last actual wake). Only queried when some delivery
    // declares a floor — the common one-shot-grant case (min_sleep=0) needs no extra read.
    const needFloor = claimed.some((d) => (d.minSleepSec ?? 0) > 0);
    const lastWoken = needFloor
      ? await lastWokenAtForSubscribers([...bySubscriber.keys()], ws)
      : new Map<string, number>();

    const now = Date.now();
    let resumes = 0;

    for (const [subscriberId, group] of bySubscriber) {
      // Oldest→newest: the union is ordered and the headline is the latest fire.
      group.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

      // Floor: the most eager (smallest declared) min_sleep in the group sets the cadence;
      // urgent on any delivery bypasses it (decideWake handles both). Only the POSITIVE
      // floors count — a co-incident floor-less one-shot (min_sleep=0) must NOT nullify a
      // standing watch's floor (`Math.min(…, 0)` → 0 would disable throttling and let the
      // one-shot's tick defeat the standing wake's cost discipline). No positive floor in
      // the group → 0 (no throttle), the genuine one-shot-grant default.
      const positiveFloors = group
        .map((d) => d.minSleepSec)
        .filter((s): s is number => s != null && s > 0);
      const minSleepMs = positiveFloors.length > 0 ? 1000 * Math.min(...positiveFloors) : 0;
      const decision = decideWake({
        lastWokenAt: lastWoken.get(subscriberId) ?? null,
        pending: group.map((d) => ({ at: Date.parse(d.createdAt), payload: d, urgent: d.urgent })),
        now,
        cfg: { minSleepMs, leadingEdge: true },
      });

      if (!decision.wake) {
        // Within the floor — defer the WHOLE group until the floor next allows a wake.
        const deferMs = Math.max(1_000, (decision.dueAt ?? now + DEFER_MS) - now);
        for (const d of group) {
          await markDeliveryDeferred(d.id, deferMs);
          stats.deferred++;
        }
        log(`floor: ${subscriberId} deferred ${group.length} wake(s) ${Math.round(deferMs / 1000)}s (min_sleep)`);
        continue;
      }

      const headline = group[group.length - 1];
      const siblings = group.slice(0, -1);
      const needsSpawnLikely = headline.wakeHandle != null;

      // Resume cap: pace mass-unblocks across subscribers (the rest re-admit next tick).
      if (needsSpawnLikely && resumes >= maxResumesPerTick()) {
        for (const d of group) {
          await markDeliveryDeferred(d.id, DEFER_MS);
          stats.deferred++;
        }
        continue;
      }

      // D-007: a wake-resume is an agent spawn — pass it through the fleet governor's
      // admission (role 'await-wake'). One admit per COALESCED wake (N events, one spawn).
      // Fail-open: a governor-store hiccup must never strand a wake.
      if (needsSpawnLikely) {
        try {
          const verdict = await admitSpawn(getOrgPg().sql, { workspaceId: ws, role: 'await-wake' });
          if (!verdict.admitted) {
            for (const d of group) {
              await markDeliveryDeferred(d.id, DEFER_MS);
              stats.deferred++;
            }
            log(`wake for ${subscriberId} deferred by the fleet governor (${JSON.stringify(verdict)})`);
            continue;
          }
        } catch {
          /* fail-open */
        }
      }

      const outcome = await executeWake(coalesceDeliveries(group), {
        ...deps,
        // P0a: observe the detached resume turn's eventual exit (the loop turn-outcome
        // handler registered the default). An explicit dep (tests) still wins.
        onResumeTurnExit: deps.onResumeTurnExit ?? resumeTurnOutcomeHandler ?? undefined,
        // su-cold-auto P-007: the cold-auto master gate (default ON, owner-enabled) — only
        // read when a wake carries a cold loop marker. An explicit dep (tests) still wins.
        coldAutoEnabled: deps.coldAutoEnabled ?? defaultColdAutoEnabled,
      });

      if (outcome.kind === 'delivered') {
        if (outcome.channel === 'resume' || outcome.channel === 'resume-headless' || outcome.channel === 'plan-run-resume') resumes++;
        await markDeliveryDelivered(headline.id, outcome.channel, group.length);
        stats.delivered++;
        if (siblings.length > 0) {
          await markDeliveriesCoalesced(siblings.map((d) => d.id), headline.id);
          stats.coalesced += siblings.length;
        }
        log(`wake #${headline.id} delivered → ${subscriberId} via ${outcome.channel} (${group.length} event(s): ${group.map((d) => d.eventKey).join(', ')})`);
        continue;
      }
      if (outcome.kind === 'park') {
        // One-time inbox nudge on the first park: the awake-but-uninjectable agent sees it
        // mid-turn (PostToolUse hook) or on its next turn; the parked row converts to a
        // resume when its process exits. Siblings re-coalesce with the headline next tick.
        if (headline.attempts <= 1) {
          try {
            await sendMessage(emitterIdentity('await-event', headline.workspaceId), {
              to: [subscriberId],
              summary: `[await-event] ${headline.eventKey} fired — wake parked (${outcome.reason})`,
              body: `${headline.summary ?? ''}\nIf you act on this now, ack it with events:cancel { delivery_id: ${headline.id} } so you are not also resumed for it later.`.trim(),
              category: 'event',
              extra: { auto: true, event_key: headline.eventKey, wake_delivery_id: headline.id },
            });
          } catch {
            /* nudge is best-effort; the parked row is the durable truth */
          }
        }
        await markDeliveryParked(headline.id, outcome.reason, PARK_RECHECK_MS);
        stats.parked++;
        for (const d of siblings) await markDeliveryDeferred(d.id, PARK_RECHECK_MS);
        continue;
      }
      if (outcome.kind === 'drop') {
        await markDeliveryDropped(headline.id, outcome.reason);
        stats.dropped++;
        // The waiter is dead → its other coalesced wakes are equally undeliverable. Drop them
        // visibly rather than re-pumping a dead subscriber forever.
        for (const d of siblings) {
          await markDeliveryDropped(d.id, `subscriber dead (coalesced with #${headline.id})`);
          stats.dropped++;
        }
        log(`wake #${headline.id} DROPPED (dead waiter) → ${subscriberId}: ${outcome.reason} (${headline.eventKey})`);
        continue;
      }
      const verdict = await markDeliveryFailed({
        id: headline.id,
        error: outcome.error,
        attempts: headline.attempts,
        maxAttempts: MAX_ATTEMPTS,
        backoffMs: backoffMs(headline.attempts),
      });
      stats.failed++;
      for (const d of siblings) await markDeliveryDeferred(d.id, DEFER_MS);
      if (verdict === 'dead') log(`wake #${headline.id} DEAD after ${headline.attempts} attempts → ${subscriberId}: ${outcome.error}`);
    }
    return stats;
  } finally {
    pumpsInFlight.delete(ws);
  }
}

// ── source reconcilers ────────────────────────────────────────────────────────

/** A source-side reconciliation hook run each sweep tick (D-004's durable
 *  backstop for missed NOTIFYs): e.g. the lock-grant bridge re-derives
 *  `lock:grant:<ticket>` fires from waiter-table truth. Must be cheap and
 *  self-catching; registered once at import (Set-deduped by identity). */
const reconcilers = new Set<(workspaceId: string) => Promise<void>>();

export function registerAwaitReconciler(fn: (workspaceId: string) => Promise<void>): void {
  reconcilers.add(fn);
}

/**
 * The resume-turn-exit observer (loop-wake-rate-limit-robustness P0a/P0b). A
 * `resume-headless` wake spawns a DETACHED turn whose later 429-death is otherwise
 * invisible (the delivery is 'delivered' on spawn). When set, the pump passes this to
 * `executeWake`, which fires it once the detached turn exits — the seam the loop
 * turn-outcome handler (harness/routines/loop-turn-outcome.ts) uses to feed the autoloop
 * circuit on a dead loop turn. A REGISTRATION seam (not a static import) so events/await
 * never imports harness/routines (no cycle). Fire-and-forget + best-effort: a missed exit
 * degrades to the reconcile stuck-park backstop (≥30min), exactly as today.
 */
let resumeTurnOutcomeHandler: ((d: DeliveryWork, exit: ResumeTurnExitRaw) => void) | null = null;

export function registerResumeTurnOutcomeHandler(fn: (d: DeliveryWork, exit: ResumeTurnExitRaw) => void): void {
  resumeTurnOutcomeHandler = fn;
}

// ── the sweeper ───────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 30_000;

type Globals = typeof globalThis & { __papercuspAwaitSweeperStarted?: boolean };

/**
 * Background sweeper (locks-janitor pattern: lazy, unref'd, restart-safe —
 * all state is PG): recover stuck 'delivering' rows, fire timed-out awaits
 * (timeout_behavior 'wake' → a TIMEOUT wake delivery; 'expire' → visible
 * lapse), then pump anything due (incl. parked rows whose process died).
 *
 * A background reader has no request to scope it, so each tick sweeps every
 * workspace `backgroundWorkspaceIds()` names (per-window-workspace-context
 * P-020) — under the shared-operator model that is EVERY registered
 * workspace, so an await registered in a non-global workspace still times
 * out / resumes. Each sweep runs inside that workspace's ALS scope so nested
 * `activeWorkspaceId()` reads (reconcilers, wake delivery) resolve it.
 */
export function startAwaitSweeper(): void {
  const g = globalThis as Globals;
  if (g.__papercuspAwaitSweeperStarted) return;
  g.__papercuspAwaitSweeperStarted = true;
  managedSetInterval('await-event-sweeper', SWEEP_INTERVAL_MS, () => {
    void sweepAllWorkspaces();
  }, { category: 'global-sweep' });
}

/** One tick of the sweeper: sweepOnce per background workspace (P-020). */
export async function sweepAllWorkspaces(): Promise<void> {
  for (const ws of backgroundWorkspaceIds()) {
    await runWithWorkspace(ws, () => sweepOnce(ws)).catch(
      (e: unknown) => log(`sweep failed (ws=${ws}): ${e instanceof Error ? e.message : e}`),
    );
  }
}

export async function sweepOnce(workspaceId?: string): Promise<void> {
  const ws = workspaceId ?? activeWorkspaceId();

  // Source reconcilers first — they may fire awaits this very sweep delivers.
  for (const fn of reconcilers) {
    try {
      await fn(ws);
    } catch (e) {
      log(`reconciler failed: ${e instanceof Error ? e.message : e}`);
    }
  }

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
