/** Compact progress state on the existing read-cursor store, not a new ledger.
 * Effects are observed from the canonical portfolio. The timestamp is the FIRST
 * verification of that effect identity, not a claim/lease renewal timestamp. */
import { createHash } from 'node:crypto';
import type { GoalPortfolioBrief } from './goal-launch-settings';
import { advanceGoalPlacementProgress, goalPlacementProgressScopeKey,
  type GoalPlacementEffect, type GoalPlacementProgressState, type GoalPlacementProgressScope } from './goal-placement-progress';

function surface(scope: GoalPlacementProgressScope): string {
  return `goal-placement-progress-v1:${createHash('sha256').update(goalPlacementProgressScopeKey(scope)).digest('hex')}`;
}

/** Only the compiled, independently led, actual member-claim state is an effect.
 * Launch receipts, WIP labels, lease expiry/renewal and reads cannot change its identity. */
export function verifiedGoalPlacementEffects(input: {
  workspaceId: string; ownerId: string; goalId: string; portfolio: GoalPortfolioBrief | null;
}): Array<{ scope: GoalPlacementProgressScope; effect: GoalPlacementEffect }> {
  const { portfolio } = input;
  if (![input.workspaceId, input.ownerId, input.goalId].every((value) => value.trim()) ||
    !portfolio || portfolio.goal.id !== input.goalId || portfolio.goal.status !== 'active' ||
    portfolio.degradedReasons.length || !Number.isFinite(Date.parse(portfolio.assembledAt))) return [];
  return portfolio.worklist.flatMap((plan) => {
    const p = plan.placement;
    const lane = p.activeLane;
    const fleet = p.fleet;
    if (p.state !== 'working' || !p.reconciliation.consistent || !lane?.workItemId || !fleet ||
      !lane.holderLive || !fleet.leaderLive || !fleet.planScoped || fleet.controlState !== 'active' ||
      lane.ownerFleet !== fleet.slug || lane.ownerId === fleet.leaderOwnerId ||
      lane.ownerId === input.ownerId || fleet.leaderOwnerId === input.ownerId ||
      !lane.expiresAt || !Number.isFinite(Date.parse(lane.expiresAt)) ||
      Date.parse(lane.expiresAt) <= Date.parse(portfolio.assembledAt)) return [];
    return [{ scope: { workspaceId: input.workspaceId, ownerId: input.ownerId, goalId: input.goalId, planRef: plan.ref },
      effect: { kind: 'member-claim' as const,
        ref: JSON.stringify([plan.ref, fleet.slug, lane.ownerId, lane.itemId, lane.workItemId]),
        at: portfolio.assembledAt } }];
  });
}

/** Called by the existing orientation producer, never by the read-only agenda.
 * Row locking serializes observations and future receipt reductions for this
 * owner/goal/plan. Re-observation of an identical effect performs no UPDATE. */
export async function recordVerifiedGoalPlacementEffects(input: Parameters<typeof verifiedGoalPlacementEffects>[0]): Promise<number> {
  const effects = verifiedGoalPlacementEffects(input);
  if (!effects.length) return 0;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const existing = await readGoalPlacementProgress({ workspaceId: input.workspaceId, ownerId: input.ownerId,
    goalId: input.goalId, planRefs: effects.map(({ scope }) => scope.planRef) });
  let recorded = 0;
  for (const { scope, effect } of effects) {
    // Normal repeated orientation is one indexed read and NO write/row lock.
    // New effects still recheck under the transaction for concurrent producers.
    if (existing[scope.planRef]?.lastEffect?.ref === effect.ref) continue;
    const changed = await sql.begin(async (tx) => {
      const key = surface(scope);
      await tx`INSERT INTO harness_shared.coord_read_cursors (workspace_id, owner_id, surface, committed, pending, pending_at, updated_at)
        VALUES (${scope.workspaceId}, ${scope.ownerId}, ${key}, NULL, NULL, now(), now())
        ON CONFLICT (workspace_id, owner_id, surface) DO NOTHING`;
      const rows = await tx<Array<{ committed: GoalPlacementProgressState | null }>>`
        SELECT committed FROM harness_shared.coord_read_cursors
        WHERE workspace_id = ${scope.workspaceId} AND owner_id = ${scope.ownerId} AND surface = ${key} FOR UPDATE`;
      const previous = rows[0]?.committed ?? null;
      const next = advanceGoalPlacementProgress({ scopeKey: goalPlacementProgressScopeKey(scope), previous, now: effect.at, effect });
      if (next.status !== 'known' || JSON.stringify(next.state) === JSON.stringify(previous)) return false;
      await tx`UPDATE harness_shared.coord_read_cursors SET committed = ${JSON.stringify(next.state)}::text::jsonb, updated_at = now()
        WHERE workspace_id = ${scope.workspaceId} AND owner_id = ${scope.ownerId} AND surface = ${key}`;
      return true;
    });
    if (changed) recorded += 1;
  }
  return recorded;
}

/** Read only. A missing row is unmeasured, not an effect at read time. */
export async function readGoalPlacementProgress(input: {
  workspaceId: string; ownerId: string; goalId: string; planRefs: string[];
}): Promise<Record<string, GoalPlacementProgressState | null>> {
  if (!input.planRefs.length) return {};
  const pairs = input.planRefs.map((planRef) => ({ planRef, surface: surface({ ...input, planRef }) }));
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ surface: string; committed: GoalPlacementProgressState | null }>>`
    SELECT surface, committed FROM harness_shared.coord_read_cursors
    WHERE workspace_id = ${input.workspaceId} AND owner_id = ${input.ownerId}
      AND surface = ANY(${pairs.map((entry) => entry.surface)}::text[])`;
  const bySurface = new Map(rows.map((row) => [row.surface, row.committed]));
  return Object.fromEntries(pairs.map((entry) => [entry.planRef, bySurface.get(entry.surface) ?? null]));
}
