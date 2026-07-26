/**
 * `system:unguarded-halt-rescue` — the SYSTEM-side leg of the unguarded-halt
 * guard (turn-end-tracking P-016, the enforcement half P-015 deferred).
 *
 * THE DEFECT THIS CLOSES (WI-6054, observed 2026-07-26 on fleet
 * nonp2p-bug-drain-0725): an autonomous agent that ends a turn with no armed
 * loop and no registered event-await has NO wake source left except the
 * always-armed `coord:inbox-wake:` keepalive — which only fires when a HUMAN or
 * a peer messages it. Nothing re-arms it, so it silently halts forever.
 *
 * The detector for exactly this already existed and was correct
 * (`turn-end-tracking.detectUnguardedHalt`, assembled from live stores by
 * `turn-end-tracking-io.sweepUnguardedHalt`). Its ONLY production call site,
 * however, was `agent-tools/journal/record-turn.ts` — an AGENT-INVOKED MCP tool.
 * So the guard fired only when the agent voluntarily called `journal:record-turn`
 * at turn end, and an agent that simply STOPS never calls it: the guard was
 * structurally incapable of catching the failure it was built for. Four of ten
 * fleet members halted this way for 3.3-4.1h (~14 agent-hours) while 13 items
 * were claimable under their own claim spec.
 *
 * This routine moves that SAME sweep off the voluntary agent path onto a system
 * path: each tick it runs the EXISTING `boundedUnguardedHaltSweep` for every
 * live agent and WAKES the ones it flags. It deliberately re-implements no
 * predicate — the halt condition stays defined in exactly one place
 * (turn-end-tracking.ts), so this rescue and the agent-side warning can never
 * disagree about what "unguarded" means.
 *
 * WAKE, not inject: an injected coord message lands on the recipient's NEXT
 * turn, and the defining property of a halted agent is that there will never be
 * a next turn. `claim-discipline-watch` is inject-only for the opposite reason
 * (its targets are live and taking turns; a nudge is not worth a wake).
 *
 * Self-throttled via its OWN outbox (no new state table), the same
 * derived-from-PG, restart-safe pattern as `claim-discipline-action.ts`.
 */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { STALE_MS } from '../../liveness';
import { lastToolCallAtByOwner } from '../../fleet/assignments';
import { listPresence } from '../../agent-tools/coordination/presence';
import { sendMessage, readOutbox } from '../../agent-tools/coordination/messages';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { boundedUnguardedHaltSweep } from '../../turn-end-tracking-io';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const HALT_RESCUE_OWNER = 'unguarded-halt-rescue';

const RESCUE_IDENTITY: AgentIdentity = {
  ownerId: HALT_RESCUE_OWNER,
  ownerLabel: HALT_RESCUE_OWNER,
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Marks this routine's own outbox rows so the throttle can find them. */
export const RESCUE_PREFIX = 'unguarded-halt rescue:';

/** One rescue wake per agent per hour. A halted agent that is woken and halts
 *  again is a real (and interesting) repeat — but it must not become a wake
 *  loop billing a turn every tick. */
export const DEFAULT_RESCUE_THROTTLE_MS = 60 * 60 * 1000;

/** Bound the per-tick wake fan. A mass halt (e.g. a host restart) should recover
 *  steadily rather than detonate hundreds of billable turns in one tick; the
 *  remainder is picked up next tick. */
export const MAX_RESCUES_PER_TICK = 10;

/** A presence row this routine may consider. */
export interface HaltCandidate {
  agentId: string;
  workspaceId: string | null;
  /** Epoch ms of the last heartbeat (process keepalive), or null when unknown. */
  heartbeatMs: number | null;
  /** Epoch ms of the agent's last tool call — its last real TURN activity. */
  lastToolCallMs: number | null;
}

/**
 * A halted agent must have taken no turn for at least this long.
 *
 * DELIBERATELY well beyond `VERDICT_SPEAKING_FRESH_MS` (5 min, the "speaking"
 * window): an agent that is genuinely working can make NO tool calls for
 * several minutes while a single long call runs — a build, a full test suite, a
 * typecheck. Waking it mid-turn would be a spurious, billable interruption AND
 * would teach exactly the wrong lesson. A halted agent, by contrast, is idle
 * forever, so a conservative threshold costs one extra tick of latency and
 * removes the whole false-positive class.
 */
export const DEFAULT_HALT_IDLE_MS = 15 * 60_000;

/**
 * PURE: which live agents are eligible to be SWEPT this tick.
 *
 * The discriminator is deliberately TWO-SIDED, because neither signal alone is
 * sufficient (WI-6054):
 *   - heartbeat FRESH  ⇒ the process is alive. A stale heartbeat is a truly dead
 *     session — the idle reaper's job, not a wake target (waking a corpse burns
 *     a wake and teaches nothing). Note a halted agent DOES keep heartbeating:
 *     the observed orphans read heartbeatFresh:true with lastActive 3-4h ago, so
 *     heartbeat alone can never distinguish halted from working.
 *   - last tool call OLD ⇒ it is not mid-turn. This is the signal that separates
 *     "halted" from "actively working", and it is the one heartbeat cannot give.
 * An agent with no tool call on record at all is SKIPPED (conservative): it has
 * never taken a turn, so there is no halt to rescue.
 *
 * Ordering is stable by agentId so a capped tick is deterministic and the same
 * agent is not starved.
 */
export function selectSweepCandidates(
  candidates: readonly HaltCandidate[],
  recentlyRescued: ReadonlySet<string>,
  nowMs: number,
  opts: { staleMs?: number; idleMs?: number } = {},
): HaltCandidate[] {
  const staleMs = opts.staleMs ?? STALE_MS;
  const idleMs = opts.idleMs ?? DEFAULT_HALT_IDLE_MS;
  return candidates
    .filter((c) => {
      if (!c.agentId) return false;
      if (recentlyRescued.has(c.agentId)) return false;
      // Process must be alive.
      if (c.heartbeatMs == null) return false;
      if (nowMs - c.heartbeatMs >= staleMs) return false;
      // ...and it must not be mid-turn.
      if (c.lastToolCallMs == null) return false;
      return nowMs - c.lastToolCallMs >= idleMs;
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

export function rescueSummary(): string {
  return `${RESCUE_PREFIX} no wake source — re-arm a loop or an await`;
}

export function rescueBody(): string {
  return [
    'You ended a turn under an autonomous mode (auto/drain) with NO guaranteed re-wake:',
    'no armed engine loop, no registered event-await (the always-armed coord:inbox-wake',
    'keepalive does not count — it only fires when a human or a peer messages you), and',
    'no owner present to speak next. Nothing was going to re-invoke you. This wake came',
    'from the system-side unguarded-halt sweep, not from a peer.',
    '',
    'RE-MEASURE BEFORE YOU CONCLUDE ANYTHING. If you parked or stopped because your lane',
    'looked drained, that verdict had a TIMESTAMP and is very likely stale now — "drained"',
    'is a measurement, not a state. Re-read the queue before deciding you have nothing to do:',
    '  work_items:claimable { harness, spec: <your fleet> }   (the authoritative claim floors)',
    '  scheduler:get_next { harness }                          (inherits your claim spec)',
    '',
    'THEN, before you end your next turn, make sure a re-wake actually exists:',
    '  - loop:arm { intervalSec, goal }   — for ongoing work (verify loop:status.active === true)',
    '  - events:await { event }           — when blocked on a specific completion',
    '  - session:request-compaction { autoContinue: true } — to continue on fresh context',
    'Ending a turn with none of these is the halt that stranded you.',
  ].join('\n');
}

/**
 * Read presence and return the live-agent candidate rows. Split out so the
 * handler stays a thin composition and the shape is easy to stub in tests.
 */
export async function readHaltCandidates(): Promise<HaltCandidate[]> {
  const rows = await listPresence();
  // The last-tool-call read is what separates "halted" from "mid-turn"; without
  // it every busy agent looks halted. Fail-soft to an empty map, which (because
  // a null lastToolCallMs is SKIPPED) means "rescue nobody this tick" — the safe
  // direction for a routine whose action is a billable wake.
  const lastCalls = await lastToolCallAtByOwner(rows.map((r) => r.ownerId)).catch(
    () => new Map<string, string>(),
  );
  return rows.map((r) => {
    const hb = r.heartbeatAt ? Date.parse(r.heartbeatAt) : NaN;
    const callIso = lastCalls.get(r.ownerId);
    const call = callIso ? Date.parse(callIso) : NaN;
    return {
      agentId: r.ownerId,
      workspaceId: r.workspaceId ?? null,
      heartbeatMs: Number.isFinite(hb) ? hb : null,
      lastToolCallMs: Number.isFinite(call) ? call : null,
    };
  });
}

registerSystemAction('unguarded-halt-rescue', async (ctx: SystemActionCtx) => {
  // Fail-CLOSED on a flag-IO error, matching fleet-headcount-action: a wake costs
  // a real billable turn, and a missed rescue is recovered by the next tick.
  if (!(await getFlag(FLAGS.UNGUARDED_HALT_RESCUE, 'system').catch(() => false))) return;

  const cfg = ctx.triggerConfig ?? {};
  const throttleMin = Number(cfg.throttle_min);
  const throttleMs =
    Number.isFinite(throttleMin) && throttleMin > 0 ? throttleMin * 60_000 : DEFAULT_RESCUE_THROTTLE_MS;
  const capRaw = Number(cfg.max_per_tick);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : MAX_RESCUES_PER_TICK;

  const nowMs = Date.now();
  const since = new Date(nowMs - throttleMs).toISOString();
  const recent = await readOutbox(HALT_RESCUE_OWNER, { since_ts: since }).catch(() => []);
  const recentlyRescued = new Set(
    recent
      .filter((e) => typeof e.summary === 'string' && e.summary.startsWith(RESCUE_PREFIX))
      .flatMap((e) => e.to),
  );

  const idleRaw = Number(cfg.idle_min);
  const idleMs = Number.isFinite(idleRaw) && idleRaw > 0 ? idleRaw * 60_000 : DEFAULT_HALT_IDLE_MS;
  const candidates = selectSweepCandidates(await readHaltCandidates(), recentlyRescued, nowMs, { idleMs });

  // The sweep is per-agent IO; run it concurrently but keep the wake fan capped.
  const verdicts = await Promise.all(
    candidates.map(async (c) => ({
      agentId: c.agentId,
      tripwire: await boundedUnguardedHaltSweep({
        ownerId: c.agentId,
        workspaceId: c.workspaceId ?? ctx.workspaceId,
      }).catch(() => null),
    })),
  );
  const halted = verdicts.filter((v) => v.tripwire != null).map((v) => v.agentId);
  const rescuing = halted.slice(0, cap);

  for (const agentId of rescuing) {
    // Durable inbox row first (the record survives even if the wake fan fails),
    // then the wake — the same ordering coord:send uses.
    await sendMessage(RESCUE_IDENTITY, {
      to: [agentId],
      summary: rescueSummary(),
      body: rescueBody(),
    }).catch((e) =>
      console.warn(`[unguarded-halt-rescue] inbox write for ${agentId} failed:`, (e as Error)?.message ?? e),
    );
    await wakeRecipients([agentId], {
      summary: rescueSummary(),
      source: HALT_RESCUE_OWNER,
      workspaceId: ctx.workspaceId,
    }).catch((e) =>
      console.warn(`[unguarded-halt-rescue] wake for ${agentId} failed:`, (e as Error)?.message ?? e),
    );
  }

  console.log(
    `[unguarded-halt-rescue] ${candidates.length} live agent(s) swept → ${halted.length} halted → ` +
      `${rescuing.length} woken` +
      (halted.length > rescuing.length ? ` (${halted.length - rescuing.length} deferred to next tick)` : '') +
      (recentlyRescued.size > 0 ? `, ${recentlyRescued.size} within throttle` : ''),
  );
});
