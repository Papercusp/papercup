/**
 * Compact durable CTRL anchor (agent-operability improvements P-013).
 *
 * This is a PROJECTION, not a second state authority. It reconciles the tiny
 * control facts an agent must not lose across compaction from their existing
 * canonical stores, then persists the projection on the existing durable
 * session_briefs row. A semantic change increments one monotonic generation;
 * an identical reconciliation does not. Consumers replace from the full
 * post-compaction anchor on any missing base/schema/generation mismatch and
 * never merge a generation-behind payload.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getModes } from '../../modes/store';
import { getLoopStatus, type LoopStatus } from '../../harness/routines/loop';
import { latestFleetMembership } from '../../fleet-membership-store';
import { getSessionBrief } from '../../session-brief';

export const CONTROL_ANCHOR_SCHEMA = 'ctrl-v1' as const;
export const CONTROL_TRANSITION_SCHEMA = 'ctrl-transition-v1' as const;
/** D-008: duplication is allowed only under a measured, enforced budget. */
export const CONTROL_ANCHOR_MAX_TOKENS = 384;
export const CONTROL_TRANSITION_MAX_TOKENS = 384;
const MAX_SCOPE_ITEMS = 12;
const MAX_ID_CHARS = 120;

export interface ControlAnchorState {
  modes: string[];
  loop: { active: boolean; intervalSec: number | null };
  carry: 'warm' | 'cold';
  route:
    | { kind: 'self' }
    | { kind: 'mug' }
    | { kind: 'fleet'; fleet: string; role: string | null };
  scope: {
    workspace: string;
    harness: string | null;
    plan: string | null;
    items: string[];
    itemsMore?: number;
  };
}

export interface ControlAnchor {
  schemaVersion: typeof CONTROL_ANCHOR_SCHEMA;
  generation: number;
  state: ControlAnchorState;
  provenance: {
    source: 'harness_shared.session_briefs.control_state';
    ownerId: string;
    updatedAt: string;
  };
  resync: {
    on: readonly ['missing-base', 'schema-mismatch', 'generation-mismatch'];
    verb: 'coord:orient';
    args: { afterCompaction: true };
    rule: 'replace-full-never-merge-behind';
  };
  budget: { estimatedTokens: number; maxTokens: number };
}

export type ControlTransitionOrigin = 'owner' | 'agent' | 'system';

export interface ControlTransitionProvenance {
  origin: ControlTransitionOrigin;
  actorId: string;
  source: 'mode:set' | 'loop:arm' | 'loop:end' | 'loop:transfer' | 'fleet:membership' | 'control-anchor:reconcile';
  ownerDirected: boolean;
  recordedAt: string;
}

export interface ControlTransition {
  schemaVersion: typeof CONTROL_TRANSITION_SCHEMA;
  previousGeneration: number;
  generation: number;
  state: ControlAnchorState;
  provenance: ControlTransitionProvenance;
  resync: {
    verb: 'coord:orient';
    args: { afterCompaction: true };
    rule: 'replace-full-never-merge-behind';
  };
}

export interface ControlTransitionDelivery extends ControlTransition {
  kind: 'transition' | 'full-resync';
  reason: 'next-generation' | 'missing-transition' | 'schema-mismatch' | 'generation-mismatch';
  budget: { estimatedTokens: number; maxTokens: number };
}

interface PersistedControlAnchor {
  generation: number;
  state: ControlAnchorState;
  updatedAt: string;
  transition: ControlTransition | null;
}

interface ScopeClaimRow {
  harness_slug: string;
  plan_slug: string;
  item_id: string;
}

function cap(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, MAX_ID_CHARS);
}

/** Stable semantic form: sorted/deduped modes + items, bounded identifiers. */
export function normalizeControlAnchorState(input: ControlAnchorState): ControlAnchorState {
  const allItems = [...new Set(input.scope.items.map(String))].sort();
  const items = allItems.slice(0, MAX_SCOPE_ITEMS).map((v) => v.slice(0, MAX_ID_CHARS));
  const route = input.route.kind === 'fleet'
    ? {
        kind: 'fleet' as const,
        fleet: input.route.fleet.slice(0, MAX_ID_CHARS),
        role: cap(input.route.role),
      }
    : input.route;
  return {
    modes: [...new Set(input.modes.map(String))].sort().map((v) => v.slice(0, 40)),
    loop: {
      active: Boolean(input.loop.active),
      intervalSec: input.loop.intervalSec == null ? null : Math.max(0, Math.floor(input.loop.intervalSec)),
    },
    carry: input.carry === 'cold' ? 'cold' : 'warm',
    route,
    scope: {
      workspace: input.scope.workspace.slice(0, MAX_ID_CHARS),
      harness: cap(input.scope.harness),
      plan: cap(input.scope.plan),
      items,
      ...(allItems.length > items.length ? { itemsMore: allItems.length - items.length } : {}),
    },
  };
}

/** Conservative token estimate used only for the hard compactness budget. */
export function estimateControlAnchorTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
}

const TRANSITION_RESYNC = {
  verb: 'coord:orient' as const,
  args: { afterCompaction: true as const },
  rule: 'replace-full-never-merge-behind' as const,
};

function defaultTransitionProvenance(ownerId: string): ControlTransitionProvenance {
  return {
    origin: 'system',
    actorId: ownerId,
    source: 'control-anchor:reconcile',
    ownerDirected: false,
    recordedAt: new Date().toISOString(),
  };
}

export function renderControlTransitionDelivery(
  input: Omit<ControlTransitionDelivery, 'budget'>,
): ControlTransitionDelivery {
  const base = {
    ...input,
    state: normalizeControlAnchorState(input.state),
  };
  let estimatedTokens = estimateControlAnchorTokens({
    ...base,
    budget: { estimatedTokens: 0, maxTokens: CONTROL_TRANSITION_MAX_TOKENS },
  });
  estimatedTokens = estimateControlAnchorTokens({
    ...base,
    budget: { estimatedTokens, maxTokens: CONTROL_TRANSITION_MAX_TOKENS },
  });
  if (estimatedTokens > CONTROL_TRANSITION_MAX_TOKENS) {
    throw new Error(
      `control_transition_budget_exceeded: ${estimatedTokens} > ${CONTROL_TRANSITION_MAX_TOKENS} tokens`,
    );
  }
  return { ...base, budget: { estimatedTokens, maxTokens: CONTROL_TRANSITION_MAX_TOKENS } };
}

/** Pure ordering decision. Never returns a generation-behind transition. */
export function decideControlTransitionDelivery(input: {
  ownerId: string;
  deliveredGeneration: number;
  generation: number;
  state: ControlAnchorState;
  transition: ControlTransition | null;
  updatedAt: string;
}): ControlTransitionDelivery {
  const pending = input.transition;
  const exactNext =
    pending?.schemaVersion === CONTROL_TRANSITION_SCHEMA &&
    pending.previousGeneration === input.deliveredGeneration &&
    pending.generation === input.generation;
  if (exactNext) {
    return renderControlTransitionDelivery({
      ...pending,
      kind: 'transition',
      reason: 'next-generation',
    });
  }
  const reason: ControlTransitionDelivery['reason'] = !pending
    ? 'missing-transition'
    : pending.schemaVersion !== CONTROL_TRANSITION_SCHEMA
      ? 'schema-mismatch'
      : 'generation-mismatch';
  // Reject the pending payload wholesale. Full-state replacement is built
  // from the current authoritative anchor row, never the stale transition.
  return renderControlTransitionDelivery({
    schemaVersion: CONTROL_TRANSITION_SCHEMA,
    kind: 'full-resync',
    reason,
    previousGeneration: input.deliveredGeneration,
    generation: input.generation,
    state: input.state,
    provenance:
      pending?.generation === input.generation
        ? pending.provenance
        : {
            ...defaultTransitionProvenance(input.ownerId),
            recordedAt: input.updatedAt,
          },
    resync: TRANSITION_RESYNC,
  });
}

export function renderControlAnchor(input: {
  ownerId: string;
  generation: number;
  state: ControlAnchorState;
  updatedAt: string;
}): ControlAnchor {
  const base = {
    schemaVersion: CONTROL_ANCHOR_SCHEMA,
    generation: input.generation,
    state: normalizeControlAnchorState(input.state),
    provenance: {
      source: 'harness_shared.session_briefs.control_state' as const,
      ownerId: input.ownerId,
      updatedAt: input.updatedAt,
    },
    resync: {
      on: ['missing-base', 'schema-mismatch', 'generation-mismatch'] as const,
      verb: 'coord:orient' as const,
      args: { afterCompaction: true as const },
      rule: 'replace-full-never-merge-behind' as const,
    },
  };
  // Include the budget record itself in the measurement. One second pass makes
  // the estimate exact for the final digit width without an unbounded loop.
  let estimatedTokens = estimateControlAnchorTokens({
    ...base,
    budget: { estimatedTokens: 0, maxTokens: CONTROL_ANCHOR_MAX_TOKENS },
  });
  estimatedTokens = estimateControlAnchorTokens({
    ...base,
    budget: { estimatedTokens, maxTokens: CONTROL_ANCHOR_MAX_TOKENS },
  });
  if (estimatedTokens > CONTROL_ANCHOR_MAX_TOKENS) {
    throw new Error(
      `control_anchor_budget_exceeded: ${estimatedTokens} > ${CONTROL_ANCHOR_MAX_TOKENS} tokens`,
    );
  }
  return {
    ...base,
    budget: { estimatedTokens, maxTokens: CONTROL_ANCHOR_MAX_TOKENS },
  };
}

/**
 * Atomically persist one semantic projection. The row's generation advances
 * only when jsonb structural equality says the state changed.
 */
export async function persistControlAnchor(
  input: {
    ownerId: string;
    workspaceId: string;
    state: ControlAnchorState;
    transition?: Omit<ControlTransitionProvenance, 'recordedAt'> & { recordedAt?: string };
  },
  sql: Sql = getOrgPg().sql,
): Promise<PersistedControlAnchor> {
  const state = normalizeControlAnchorState(input.state);
  const stateJson = JSON.stringify(state);
  const provenance: ControlTransitionProvenance = {
    ...(input.transition ?? defaultTransitionProvenance(input.ownerId)),
    recordedAt: input.transition?.recordedAt ?? new Date().toISOString(),
  };
  const initialTransition: ControlTransition = {
    schemaVersion: CONTROL_TRANSITION_SCHEMA,
    previousGeneration: 0,
    generation: 1,
    state,
    provenance,
    resync: TRANSITION_RESYNC,
  };
  const transitionJson = JSON.stringify(initialTransition);
  const rows = await sql<Array<{
    control_generation: number | string;
    control_state: ControlAnchorState;
    control_updated_at: Date | string;
    control_transition: ControlTransition | null;
  }>>`
    INSERT INTO harness_shared.session_briefs
      (owner_id, workspace_id, control_generation, control_state, control_updated_at, control_transition)
    VALUES (${input.ownerId}, ${input.workspaceId}, 1, ${stateJson}::text::jsonb, now(), ${transitionJson}::text::jsonb)
    ON CONFLICT (owner_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      control_transition = CASE
        WHEN harness_shared.session_briefs.control_state IS DISTINCT FROM EXCLUDED.control_state
          THEN jsonb_set(
            jsonb_set(EXCLUDED.control_transition, '{previousGeneration}', to_jsonb(harness_shared.session_briefs.control_generation), true),
            '{generation}', to_jsonb(harness_shared.session_briefs.control_generation + 1), true
          )
        ELSE harness_shared.session_briefs.control_transition
      END,
      control_generation = CASE
        WHEN harness_shared.session_briefs.control_state IS DISTINCT FROM EXCLUDED.control_state
          THEN harness_shared.session_briefs.control_generation + 1
        ELSE harness_shared.session_briefs.control_generation
      END,
      control_updated_at = CASE
        WHEN harness_shared.session_briefs.control_state IS DISTINCT FROM EXCLUDED.control_state
          THEN now()
        ELSE harness_shared.session_briefs.control_updated_at
      END,
      control_state = EXCLUDED.control_state
    RETURNING control_generation, control_state, control_updated_at, control_transition
  `;
  const row = rows[0];
  if (!row) throw new Error('control_anchor_persist_returned_no_row');
  return {
    generation: Number(row.control_generation),
    state: normalizeControlAnchorState(row.control_state),
    updatedAt: new Date(row.control_updated_at).toISOString(),
    transition: row.control_transition ?? null,
  };
}

/** Atomically consume the newest undelivered generation for the turn-start hook. */
export async function consumePendingControlTransition(
  ownerId: string,
  workspaceId: string,
  sql: Sql = getOrgPg().sql,
): Promise<ControlTransitionDelivery | null> {
  const rows = await sql<Array<{
    control_generation: number | string;
    control_state: ControlAnchorState;
    control_updated_at: Date | string | null;
    control_transition: ControlTransition | null;
    delivered_generation: number | string;
  }>>`
    WITH candidate AS (
      SELECT owner_id, control_generation, control_state, control_updated_at,
             control_transition, control_delivered_generation
        FROM harness_shared.session_briefs
       WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
         AND control_state IS NOT NULL
         AND control_generation > control_delivered_generation
       FOR UPDATE
    )
    UPDATE harness_shared.session_briefs brief
       SET control_delivered_generation = candidate.control_generation
      FROM candidate
     WHERE brief.owner_id = candidate.owner_id
    RETURNING candidate.control_generation, candidate.control_state,
              candidate.control_updated_at, candidate.control_transition,
              candidate.control_delivered_generation AS delivered_generation
  `;
  const row = rows[0];
  if (!row) return null;
  return decideControlTransitionDelivery({
    ownerId,
    deliveredGeneration: Number(row.delivered_generation),
    generation: Number(row.control_generation),
    state: row.control_state,
    transition: row.control_transition,
    updatedAt: row.control_updated_at
      ? new Date(row.control_updated_at).toISOString()
      : new Date().toISOString(),
  });
}

export function renderControlTransitionContext(delivery: ControlTransitionDelivery): string {
  return `⟦CTRL:${delivery.kind}⟧ ${JSON.stringify(delivery)}`;
}

/** Reconcile the existing authoritative stores into the compact projection. */
export async function buildControlAnchorState(
  ownerId: string,
  workspaceId: string,
  opts: { sql?: Sql; loop?: LoopStatus | null } = {},
): Promise<ControlAnchorState> {
  const sql = opts.sql ?? getOrgPg().sql;
  const [modes, loop, membership, brief, claims] = await Promise.all([
    getModes(workspaceId, ownerId, sql),
    opts.loop === undefined ? getLoopStatus(ownerId, { sql }) : Promise.resolve(opts.loop),
    latestFleetMembership(workspaceId, ownerId, sql),
    getSessionBrief({ ownerId }),
    sql<ScopeClaimRow[]>`
      SELECT harness_slug, plan_slug, item_id
        FROM harness_shared.plan_item_claims
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND owner = ${ownerId}
         AND expires_ts > clock_timestamp()
       ORDER BY plan_slug, item_id
    `,
  ]);
  const planClaims = brief?.currentPlanSlug
    ? claims.filter((c) => c.plan_slug === brief.currentPlanSlug)
    : claims;
  const chosen = planClaims[0] ?? claims[0] ?? null;
  const fleet = membership?.fleetSlug;
  const source = brief?.source?.toLowerCase() ?? '';
  const route: ControlAnchorState['route'] = fleet
    ? { kind: 'fleet', fleet, role: membership?.fleetRole ?? null }
    : source.includes('mug')
      ? { kind: 'mug' }
      : { kind: 'self' };
  return normalizeControlAnchorState({
    modes: modes.map((m) => m.mode),
    loop: { active: Boolean(loop?.active), intervalSec: loop?.intervalSec ?? null },
    carry: loop?.carry ?? 'warm',
    route,
    scope: {
      workspace: workspaceId,
      harness: brief?.harnessSlug ?? chosen?.harness_slug ?? null,
      plan: brief?.currentPlanSlug ?? chosen?.plan_slug ?? null,
      items: planClaims.map((c) => c.item_id),
    },
  });
}

export async function buildAndPersistControlAnchor(
  ownerId: string,
  workspaceId: string,
  opts: {
    sql?: Sql;
    loop?: LoopStatus | null;
    transition?: Omit<ControlTransitionProvenance, 'recordedAt'> & { recordedAt?: string };
  } = {},
): Promise<ControlAnchor> {
  const state = await buildControlAnchorState(ownerId, workspaceId, opts);
  const persisted = await persistControlAnchor(
    { ownerId, workspaceId, state, transition: opts.transition },
    opts.sql ?? getOrgPg().sql,
  );
  return renderControlAnchor({ ownerId, ...persisted });
}

/** Refresh after a canonical mutation. The projection is safety context, but
 * never a reason to roll back the already-committed mode/loop/route write. */
export async function refreshControlAnchorAfterMutation(input: {
  ownerId: string;
  workspaceId: string;
  origin: ControlTransitionOrigin;
  actorId: string;
  source: ControlTransitionProvenance['source'];
  ownerDirected?: boolean;
  sql?: Sql;
}): Promise<ControlAnchor | null> {
  try {
    return await buildAndPersistControlAnchor(input.ownerId, input.workspaceId, {
      sql: input.sql,
      transition: {
        origin: input.origin,
        actorId: input.actorId,
        source: input.source,
        ownerDirected: Boolean(input.ownerDirected),
      },
    });
  } catch {
    return null;
  }
}
