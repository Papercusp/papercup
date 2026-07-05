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
import { STALE_MS } from '../../liveness';
import { listPresence } from '../../agent-tools/coordination/presence';
import { sendMessage, readOutbox } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { planSlugExistsInWorkspace } from '../../agent-tools/plans/source';

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
  const PRESENCE_STALE_MS = STALE_MS; // 10 min — the canonical liveness window (P-014 single source)
  const now = Date.now();

  return presenceRows
    .filter(
      (p) =>
        p.ownerId &&
        // Alive: heartbeat within 10 minutes
        p.heartbeatAt &&
        now - new Date(p.heartbeatAt).getTime() < PRESENCE_STALE_MS &&
        // Not revoked: ignore sessions whose auth was revoked (logged out, etc)
        !p.revoked,
    )
    .map((p) => ({
      agentId: p.ownerId,
      alive: true,
      declaredPlanSlug: p.currentPlanSlug ?? null,
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

/**
 * EI-7402: drop targets whose declared plan is NOT backed by any harness_plans
 * row (a file-only plan the store never ingested) — the plans:set-status remedy
 * this watch teaches can never succeed against one, so nudging it every wake is
 * pure, undischargeable noise. Pure over a precomputed existence map so the
 * decision is unit-testable without a PG round-trip; `existsByKey` keys on
 * `${workspaceId}::${planSlug}` (matching `storeExistsKey`). A slug missing
 * from the map (a lookup that failed) fails OPEN — kept, not silently dropped.
 */
export function storeExistsKey(workspaceId: string, planSlug: string): string {
  return `${workspaceId}::${planSlug}`;
}

export function filterStoreBackedTargets<T extends { agentId: string; declaredPlanSlug: string | null }>(
  targets: readonly T[],
  workspaceByAgent: ReadonlyMap<string, string>,
  existsByKey: ReadonlyMap<string, boolean>,
): { keep: T[]; skippedStoreAbsent: number } {
  const keep: T[] = [];
  let skippedStoreAbsent = 0;
  for (const t of targets) {
    const plan = t.declaredPlanSlug;
    if (plan) {
      const workspaceId = workspaceByAgent.get(t.agentId) ?? 'default';
      const exists = existsByKey.get(storeExistsKey(workspaceId, plan));
      if (exists === false) {
        skippedStoreAbsent += 1;
        continue;
      }
    }
    keep.push(t);
  }
  return { keep, skippedStoreAbsent };
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
  // Re-read presence to ensure we don't have cached/stale data from a prior run.
  const presenceRows = await listPresence();
  const declaredAgents = selectDeclaredPresence(presenceRows).filter((agent) => {
    // EI-483: verify the declared plan is current by checking the presence row
    // was recently heartbeaten (within 2 minutes). A stale currentPlanSlug after
    // an agent cleared its intent would show as a recent heartbeat but with null
    // currentPlanSlug, filtering it out at selectDeclaredPresence level.
    // This extra check handles the race where presence was read before the agent
    // wrote an updated row.
    const row = presenceRows.find((p) => p.ownerId === agent.agentId);
    if (!row || !row.heartbeatAt) return false;
    const now = Date.now();
    const heartbeatMs = new Date(row.heartbeatAt).getTime();
    return now - heartbeatMs < 2 * 60 * 1000; // Within 2 minutes
  });

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

  const preTargets = selectNudgeTargets(declaredAgents, claimedPlansByAgent, recentlyNudged);

  // EI-7402: a declared plan slug that the plans:* store never ingested (authored
  // only as repo markdown, no harness_plans row in ANY harness) makes the
  // plans:set-status remedy below undischargeable — the agent would be nudged
  // every wake for a fix that can never succeed. Resolve existence per distinct
  // (workspace, plan) pair once, then let the pure filter decide who's kept.
  const workspaceByAgent = new Map(presenceRows.map((p) => [p.ownerId, p.workspaceId]));
  const existsByKey = new Map<string, boolean>();
  const distinctKeys = new Set(
    preTargets
      .filter((t): t is typeof t & { declaredPlanSlug: string } => !!t.declaredPlanSlug)
      .map((t) => storeExistsKey(workspaceByAgent.get(t.agentId) ?? 'default', t.declaredPlanSlug)),
  );
  await Promise.all(
    Array.from(distinctKeys).map(async (key) => {
      const [workspaceId, plan] = key.split('::');
      // Fail-open on a lookup error — never suppress a possibly-real nudge on a
      // transient PG hiccup; only an AFFIRMED absence skips the nudge.
      const exists = await planSlugExistsInWorkspace(workspaceId, plan).catch(() => true);
      existsByKey.set(key, exists);
    }),
  );

  const { keep: targets, skippedStoreAbsent } = filterStoreBackedTargets(
    preTargets,
    workspaceByAgent,
    existsByKey,
  );
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
      (skippedStoreAbsent ? `, ${skippedStoreAbsent} skipped (declared plan not in store — undischargeable remedy)` : '') +
      (recentlyNudged.size ? `, ${recentlyNudged.size} in throttle window` : ''),
  );
});
