/**
 * `system:claim-discipline-watch` — the claim-discipline backstop
 * (claim-discipline-enforcement-2026-06-10).
 *
 * Each tick, sweep LIVE presence for agents that are ALIVE and DECLARED on a
 * plan but hold NO claim backing it (the `declaredUnclaimed` smell), and
 * inject a coord nudge teaching the fix (claim-on-wip / declare-intent items).
 * Inject only — never wake: the nudge lands on the agent's next natural turn;
 * a discipline reminder is not worth a turn (turn-lifecycle D-007).
 *
 * Reads DIRECTLY from coord_presence (not the fleet_assignment view) to ensure
 * LIVE data — the view aggregates from multiple tables and may lag presence
 * updates (EI-483).
 *
 * Self-throttled via its OWN outbox (no new state table): an agent nudged
 * within the throttle window is skipped — derived from PG, restart-safe. The
 * "grace period" before a first nudge is the routine's own cadence (the seed's
 * 10-min cron): an agent that declares and claims within one tick is never
 * nudged at all.
 *
 * Agents with an intent but NO declared plan are NOT targeted — ad-hoc,
 * non-plan work has nothing to claim.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { listFleetAssignments, type AgentAssignment } from '../../fleet/assignments';
import { listPresence } from '../../agent-tools/coordination/presence';
import { sendMessage, readOutbox } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';

export const CLAIM_WATCH_OWNER = 'claim-discipline-watch';
const WATCH_IDENTITY: AgentIdentity = {
  ownerId: CLAIM_WATCH_OWNER,
  ownerLabel: CLAIM_WATCH_OWNER,
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

export const DEFAULT_THROTTLE_MS = 60 * 60 * 1000; // 1h between nudges per agent

/**
 * Select live presence rows that are ALIVE and have a DECLARED PLAN.
 * Checked against claims and throttle history to identify nudge targets.
 */
export function selectDeclaredPresence(
  presenceRows: ReturnType<typeof listPresence> extends Promise<infer R> ? R : never,
): Array<{
  agentId: string;
  alive: boolean;
  declaredPlanSlug: string | null;
}> {
  const PRESENCE_STALE_MS = 10 * 60 * 1000; // 10 min
  const now = Date.now();

  return presenceRows
    .filter(
      (p) =>
        p.owner_id &&
        // Alive: heartbeat within 10 minutes
        p.heartbeat_at &&
        now - new Date(p.heartbeat_at).getTime() < PRESENCE_STALE_MS,
    )
    .map((p) => ({
      agentId: p.owner_id,
      alive: true,
      declaredPlanSlug: p.current_plan_slug ?? null,
    }));
}

/** Pure target selection — alive, declared a plan, claimed nothing on it, not recently nudged. */
export function selectNudgeTargets(
  declaredPresence: ReturnType<typeof selectDeclaredPresence>,
  claimedPlansByAgent: Map<string, Set<string>>,
  recentlyNudged: ReadonlySet<string>,
): typeof declaredPresence {
  return declaredPresence.filter((p) => {
    // Must be alive
    if (!p.alive) return false;
    // Must have a declared plan
    if (!p.declaredPlanSlug) return false;
    // Must not be in throttle window
    if (recentlyNudged.has(p.agentId)) return false;
    // Must have NO claims on the declared plan (declaredUnclaimed)
    const claims = claimedPlansByAgent.get(p.agentId);
    if (claims && claims.has(p.declaredPlanSlug)) return false;
    return true;
  });
}

/** The stable summary prefix — also the outbox-throttle marker. */
export const NUDGE_PREFIX = 'claim-discipline:';

export function nudgeSummary(planSlug: string): string {
  return `${NUDGE_PREFIX} you declared "${planSlug}" but hold no plan-item claims — claim your lane`;
}

export function nudgeBody(planSlug: string): string {
  return [
    `You declared intent on plan "${planSlug}" but hold no claim on any of its items, so the Queen, the colony tab, and your peers cannot see which items are yours — work can be double-placed or look abandoned.`,
    '',
    'Claim your lane (either way works):',
    `  - plans:set-status { slug: '${planSlug}', itemId: 'P-NNN', status: 'wip' } — the wip flip now AUTO-CLAIMS the item for you.`,
    `  - coord:declare-intent { intent, current_plan_slug: '${planSlug}', items: ['P-NNN', …] } — claims the whole set and releases items you've moved off.`,
    '',
    'Flipping an item to done releases its claim automatically. If you are not actually working this plan anymore, re-declare your intent without it.',
  ].join('\n');
}

registerSystemAction('claim-discipline-watch', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const throttleMin = Number(cfg.throttle_min);
  const throttleMs =
    Number.isFinite(throttleMin) && throttleMin > 0 ? throttleMin * 60_000 : DEFAULT_THROTTLE_MS;

  // Read LIVE presence (not the fleet_assignment view which may lag presence updates).
  const presenceRows = await listPresence();
  const declaredAgents = selectDeclaredPresence(presenceRows);

  // Read which agents have claimed on which plans (to identify declaredUnclaimed).
  const assignmentRows = await listFleetAssignments({ workspaceId: null });
  const claimedPlansByAgent = new Map<string, Set<string>>();
  for (const row of assignmentRows) {
    // Only consider rows that represent actual claims (not presence rows).
    if (!row.agentId || row.source === 'presence' || !row.planSlug) continue;
    const set = claimedPlansByAgent.get(row.agentId) ?? new Set<string>();
    set.add(row.planSlug);
    claimedPlansByAgent.set(row.agentId, set);
  }

  const since = new Date(Date.now() - throttleMs).toISOString();
  const recent = await readOutbox(CLAIM_WATCH_OWNER, { since_ts: since });
  const recentlyNudged = new Set(
    recent
      .filter((e) => typeof e.summary === 'string' && e.summary.startsWith(NUDGE_PREFIX))
      .flatMap((e) => e.to),
  );

  const targets = selectNudgeTargets(declaredAgents, claimedPlansByAgent, recentlyNudged);
  for (const t of targets) {
    const plan = t.declaredPlanSlug!;
    await sendMessage(WATCH_IDENTITY, {
      to: [t.agentId],
      summary: nudgeSummary(plan),
      body: nudgeBody(plan),
      plan_slug: plan,
    }).catch((e) =>
      console.warn(`[claim-discipline-watch] nudge to ${t.agentId} failed:`, (e as Error)?.message ?? e),
    );
  }
  console.log(
    `[claim-discipline-watch] ${declaredAgents.length} agent(s) declared → ${targets.length} nudged` +
      (recentlyNudged.size ? `, ${recentlyNudged.size} in throttle window` : ''),
  );
});
