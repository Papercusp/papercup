/**
 * `system:unguarded-halt-rescue` — the SYSTEM-side leg of the unguarded-halt
 * guard (turn-end-tracking P-016, the enforcement half P-015 deferred).
 *
 * THE DEFECT THIS CLOSES (WI-6054, observed 2026-07-26 on fleet
 * nonp2p-bug-drain-0725): an autonomous agent that ends a turn with no armed
 * loop and no registered event-await has NO wake source left except the
 * always-armed `coord:inbox-wake:` keepalive — which only fires when a HUMAN or
 * a peer messages it. Nothing re-arms it, so it silently halts forever. Four of
 * ten members halted this way for 3.3-4.1h (~14 agent-hours) while 13 items
 * were claimable under their own claim spec.
 *
 * The detector for exactly this already existed and was correct
 * (`turn-end-tracking.detectUnguardedHalt`, assembled from live stores by
 * `turn-end-tracking-io.sweepUnguardedHalt`). Its ONLY production call site,
 * however, was `agent-tools/journal/record-turn.ts` — an AGENT-INVOKED MCP tool.
 * So the guard fired only when the agent voluntarily called `journal:record-turn`
 * at turn end, and an agent that simply STOPS never calls it: the guard was
 * structurally incapable of catching the failure it was built for. This routine
 * moves that SAME sweep onto a system path and re-implements no predicate, so
 * the rescue and the agent-side warning can never disagree about "unguarded".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TARGETING IS BY *REASON TO WAKE*, NEVER BY LIVENESS
 *
 * The obvious gate — "heartbeat fresh ⇒ the process is alive, so wake it" — is
 * WRONG here, and measurably so. Run against live data on this box, 30+ agents
 * had made no tool call for 6-9 DAYS while still heartbeating every ~50s; a
 * liveness-gated sweep fires a wake storm at long-dead sessions, each wake a
 * real billable turn.
 *
 * The derived `sessionState` oracle does not rescue the design either: those
 * 9-day-abandoned sessions read `state='parked', wakeable=true` — identical to
 * how the four genuine orphans read before they were woken (27 of 41 presence
 * rows were 'parked'). Heartbeat, sessionState and wakeable ALL fail to
 * separate "abandoned" from "recoverable".
 *
 * So this routine does not ask "is it alive?" — no available signal answers
 * that usefully. It asks "is there a REASON to wake it?", which is decidable:
 *   (1) it belongs to a fleet that is still `active`   — an abandoned session's
 *       fleet has wound down, so this alone drops the 6-9-day population;
 *   (2) it holds no work (load 0)                       — nothing to resume;
 *   (3) it is idle INSIDE a window — longer than one turn could plausibly take,
 *       but not so long that it is abandoned rather than halted;
 *   (4) the existing halt predicate trips (no loop, no real await);
 *   (5) AND there is claimable work under that fleet's OWN claim spec.
 * (5) is the decisive one: never wake an agent unless work actually exists for
 * it. Together these encode the real invariant — "an idle agent with a nonempty
 * queue is a bug" — instead of guessing at liveness.
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
import { getFleet } from '../../agent-fleets-store';
import { groupByAgent, lastToolCallAtByOwner, listFleetAssignments } from '../../fleet/assignments';
import { sendMessage, readOutbox } from '../../agent-tools/coordination/messages';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { getClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { claimSpecReferencesField } from '../../scheduler/claim-spec';
import { readIssueClaimability } from '../../scheduler/get-next';
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

/** One rescue wake per agent per hour. An agent that is woken and halts again is
 *  a real (and interesting) repeat — but it must not become a wake loop billing
 *  a turn every tick. */
export const DEFAULT_RESCUE_THROTTLE_MS = 60 * 60 * 1000;

/**
 * LOWER bound: a halted agent must have taken no turn for at least this long.
 * DELIBERATELY well beyond the 5-min "speaking" window, because an agent that is
 * genuinely working can make NO tool calls for several minutes while one long
 * call runs — a build, a full test suite, a typecheck. Waking it mid-turn is a
 * spurious billable interruption that teaches exactly the wrong lesson.
 */
export const DEFAULT_HALT_IDLE_MS = 15 * 60_000;

/**
 * UPPER bound: past this, the session is ABANDONED, not halted mid-work — the
 * idle reaper's business, not a wake target. Without this bound the sweep reaches
 * the 6-9-day heartbeating population described above. Generous enough to cover
 * a real halt (the observed orphans were 3.3-4.1h idle) and far short of days.
 */
export const DEFAULT_HALT_MAX_IDLE_MS = 6 * 60 * 60_000;

/** Bound the per-tick wake fan. A mass halt (e.g. a host restart) recovers
 *  steadily rather than detonating hundreds of billable turns in one tick. */
export const MAX_RESCUES_PER_TICK = 10;

/** A fleet member this routine may consider. */
export interface HaltCandidate {
  agentId: string;
  /** The fleet it belongs to; a non-member is never a rescue target. */
  fleetSlug: string | null;
  /** Work-items currently held. Only an EMPTY-handed agent is a rescue target. */
  load: number;
  /** Epoch ms of the agent's last tool call — its last real TURN activity. */
  lastToolCallMs: number | null;
}

export interface SelectOpts {
  idleMs?: number;
  maxIdleMs?: number;
}

/**
 * PURE: which fleet members are eligible to be SWEPT this tick.
 *
 * See the module doc for why none of these conjuncts is a liveness signal.
 * `activeFleets` carries the slugs whose fleet `controlState === 'active'`; a
 * member of a winding-down or unknown fleet is never woken.
 *
 * Ordering is stable by agentId so a capped tick is deterministic and the same
 * agent is not starved.
 */
export function selectSweepCandidates(
  candidates: readonly HaltCandidate[],
  recentlyRescued: ReadonlySet<string>,
  activeFleets: ReadonlySet<string>,
  nowMs: number,
  opts: SelectOpts = {},
): HaltCandidate[] {
  const idleMs = opts.idleMs ?? DEFAULT_HALT_IDLE_MS;
  const maxIdleMs = opts.maxIdleMs ?? DEFAULT_HALT_MAX_IDLE_MS;
  return candidates
    .filter((c) => {
      if (!c.agentId) return false;
      if (recentlyRescued.has(c.agentId)) return false;
      // (1) still belongs to a fleet that is doing something.
      if (!c.fleetSlug || !activeFleets.has(c.fleetSlug)) return false;
      // (2) empty-handed — an agent holding work has something to resume.
      if (c.load > 0) return false;
      // (3) idle INSIDE the window: past a plausible long turn, short of abandoned.
      if (c.lastToolCallMs == null) return false;
      const idle = nowMs - c.lastToolCallMs;
      return idle >= idleMs && idle <= maxIdleMs;
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

export function rescueSummary(): string {
  return `${RESCUE_PREFIX} no wake source, and work is waiting`;
}

export function rescueBody(fleetSlug: string, claimable: number): string {
  return [
    `You ended a turn under an autonomous mode with NO guaranteed re-wake: no armed`,
    `engine loop, no registered event-await (the always-armed coord:inbox-wake keepalive`,
    `does not count — it only fires when a human or a peer messages you), and no owner`,
    `present to speak next. Nothing was going to re-invoke you. This wake came from the`,
    `system-side unguarded-halt sweep, not from a peer — there is no one to reply to.`,
    ``,
    `You were woken because WORK IS ACTUALLY WAITING: ${claimable} item(s) are claimable`,
    `right now under your effective claim spec inside fleet "${fleetSlug}". If you stopped because your`,
    `lane looked drained, that verdict had a TIMESTAMP and is stale — "drained" is a`,
    `measurement, not a state.`,
    ``,
    `NEXT: pull work with scheduler:get_next { harness } (it inherits your claim spec).`,
    ``,
    `THEN, before you end your next turn, make sure a re-wake actually exists:`,
    `  - loop:arm { intervalSec, goal }   — for ongoing work (verify loop:status.active)`,
    `  - events:await { event }           — when blocked on a specific completion`,
    `  - session:request-compaction { autoContinue: true } — to continue on fresh context`,
    `Ending a turn with none of these is the halt that stranded you.`,
  ].join('\n');
}

/** Read fleet members + their turn-recency into candidate rows. */
export async function readHaltCandidates(): Promise<HaltCandidate[]> {
  const rows = await listFleetAssignments({});
  const agents = groupByAgent(rows);
  const lastCalls = await lastToolCallAtByOwner(agents.map((a) => a.agentId)).catch(
    () => new Map<string, string>(),
  );
  return agents.map((a) => {
    const iso = lastCalls.get(a.agentId);
    const ms = iso ? Date.parse(iso) : NaN;
    return {
      agentId: a.agentId,
      fleetSlug: a.fleetSlug ?? null,
      load: a.load ?? 0,
      lastToolCallMs: Number.isFinite(ms) ? ms : null,
    };
  });
}

/**
 * Claimable count under one candidate's EFFECTIVE claim spec — the "is there a
 * reason to wake this member" question. The scheduler resolves specs in the
 * order bee override → fleet inheritance → default, and every caller-relative
 * floor must receive the same member/fleet context as `scheduler:get_next`.
 * Fail-soft to 0, i.e. "rescue nobody", the safe direction for a billable wake.
 */
export async function claimableForCandidate(
  candidate: Pick<HaltCandidate, 'agentId' | 'fleetSlug'>,
  workspaceId: string,
): Promise<number> {
  if (!candidate.agentId || !candidate.fleetSlug) return 0;
  try {
    const resolved = await getClaimSpecRecord({ cupId: candidate.agentId, workspaceId });
    // A fleet member whose sentinel is missing/invalid is in the same
    // fail-closed transition state as scheduler:get_next. Never turn that
    // uncertainty into a broad default-backlog rescue wake.
    if (resolved.source === 'default' && resolved.fleetSlug) return 0;
    const spec = resolved.spec;
    const harness = resolved.harnessSlug;
    if (!spec || !harness) return 0;
    const { breakdown } = await readIssueClaimability(
      spec.view?.filter,
      {
        harness,
        states: spec.states,
        spec,
        workspaceId,
        assignee: candidate.agentId,
        ...(resolved.fleetSlug ? { claimantFleetSlug: resolved.fleetSlug } : {}),
        claimSpecReferencesFleet: claimSpecReferencesField(spec, 'fleet'),
      },
      { limit: 1, breakdownOnly: true },
    );
    return breakdown.claimable;
  } catch {
    return 0;
  }
}

registerSystemAction('unguarded-halt-rescue', async (ctx: SystemActionCtx) => {
  // Fail-CLOSED on a flag-IO error, matching fleet-headcount-action: a wake costs
  // a real billable turn, and a missed rescue is recovered by the next tick.
  if (!(await getFlag(FLAGS.UNGUARDED_HALT_RESCUE, 'system').catch(() => false))) return;

  const cfg = ctx.triggerConfig ?? {};
  const num = (v: unknown, fallback: number, scale = 1): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n * scale : fallback;
  };
  const throttleMs = num(cfg.throttle_min, DEFAULT_RESCUE_THROTTLE_MS, 60_000);
  const idleMs = num(cfg.idle_min, DEFAULT_HALT_IDLE_MS, 60_000);
  const maxIdleMs = num(cfg.max_idle_min, DEFAULT_HALT_MAX_IDLE_MS, 60_000);
  const cap = Math.floor(num(cfg.max_per_tick, MAX_RESCUES_PER_TICK));

  const nowMs = Date.now();
  const recent = await readOutbox(HALT_RESCUE_OWNER, {
    since_ts: new Date(nowMs - throttleMs).toISOString(),
  }).catch(() => []);
  const recentlyRescued = new Set(
    recent
      .filter((e) => typeof e.summary === 'string' && e.summary.startsWith(RESCUE_PREFIX))
      .flatMap((e) => e.to),
  );

  const all = await readHaltCandidates();

  // Which fleets are still active? Resolved once per distinct slug.
  const slugs = [...new Set(all.map((c) => c.fleetSlug).filter((s): s is string => !!s))];
  const activeFleets = new Set<string>();
  await Promise.all(
    slugs.map(async (slug) => {
      const fleet = await getFleet(ctx.workspaceId, slug).catch(() => null);
      if (fleet?.controlState === 'active') activeFleets.add(slug);
    }),
  );

  const candidates = selectSweepCandidates(all, recentlyRescued, activeFleets, nowMs, {
    idleMs,
    maxIdleMs,
  });
  if (candidates.length === 0) {
    // A quiet sweep must still be OBSERVABLE. Returning silently makes "ran and
    // correctly found nothing" byte-identical to "never ran at all" — and the
    // routines row cannot break the tie, because last_fired_at advances either
    // way (it advanced on every tick while this handler was undeployed and the
    // engine skipped it with a warn). One line per tick is the only cheap proof
    // that the DEPLOYED handler is actually executing, which is exactly what
    // verifying this routine after a deploy requires.
    console.log(
      `[unguarded-halt-rescue] ${all.length} member(s) → 0 idle in an active fleet → nothing to rescue` +
        (recentlyRescued.size > 0 ? ` (${recentlyRescued.size} within throttle)` : ''),
    );
    return;
  }

  // Is there work for each candidate? The effective spec, assignee-relative
  // cooldown, and fleet authorization can differ even within one fleet.
  const claimableByCandidate = new Map<string, number>();
  await Promise.all(
    candidates.map(async (candidate) => {
      claimableByCandidate.set(
        candidate.agentId,
        await claimableForCandidate(candidate, ctx.workspaceId),
      );
    }),
  );
  const withWork = candidates.filter((c) => (claimableByCandidate.get(c.agentId) ?? 0) > 0);

  // Only now — for agents that are idle in an active fleet WITH work waiting — is
  // the (more expensive, per-agent) halt predicate worth evaluating.
  const verdicts = await Promise.all(
    withWork.map(async (c) => ({
      c,
      tripwire: await boundedUnguardedHaltSweep({
        ownerId: c.agentId,
        workspaceId: ctx.workspaceId,
      }).catch(() => null),
    })),
  );
  const halted = verdicts.filter((v) => v.tripwire != null);
  const rescuing = halted.slice(0, cap);

  for (const { c } of rescuing) {
    const slug = c.fleetSlug!;
    const claimable = claimableByCandidate.get(c.agentId) ?? 0;
    // Durable inbox row first (the record survives even if the wake fan fails),
    // then the wake — the same ordering coord:send uses.
    await sendMessage(RESCUE_IDENTITY, {
      to: [c.agentId],
      summary: rescueSummary(),
      body: rescueBody(slug, claimable),
    }).catch((e) =>
      console.warn(`[unguarded-halt-rescue] inbox write for ${c.agentId} failed:`, (e as Error)?.message ?? e),
    );
    await wakeRecipients([c.agentId], {
      summary: rescueSummary(),
      source: HALT_RESCUE_OWNER,
      workspaceId: ctx.workspaceId,
    }).catch((e) =>
      console.warn(`[unguarded-halt-rescue] wake for ${c.agentId} failed:`, (e as Error)?.message ?? e),
    );
  }

  console.log(
    `[unguarded-halt-rescue] ${all.length} member(s) → ${candidates.length} idle in an active fleet → ` +
      `${withWork.length} with claimable work → ${halted.length} halted → ${rescuing.length} woken` +
      (halted.length > rescuing.length ? ` (${halted.length - rescuing.length} deferred)` : '') +
      (recentlyRescued.size > 0 ? `, ${recentlyRescued.size} within throttle` : ''),
  );
});
