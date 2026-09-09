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
import { getSessionBrief, type SessionBriefLifecycle } from '../../session-brief';
import { notifyAgentOrdersChanged } from '../../agent-orders-notify';
import { fetchSelfWake, type SelfWakeSignals, type SelfWakeSource } from './presence-selfwake';
import { stackRefsForSession } from '../../stack-binding-channel';
import type { SessionActivation } from '@papercusp/orchestrator/blueprint';
import {
  desiredActivation,
  normalizeSessionActivation,
  requestActivation,
  restartActivation,
  type ActivationAttribution,
} from '../../session-activation';
import {
  recordCurrentSessionIdentityActivation,
  sessionIdentityStateRevision,
  type SessionIdentityActivationSource,
} from '../../session-identity-attribution';
import {
  readGoalHolderAuthority,
  type GoalHolderAuthority,
} from '../../goals/holder-authority';

export const CONTROL_ANCHOR_SCHEMA = 'ctrl-v1' as const;
export const CONTROL_TRANSITION_SCHEMA = 'ctrl-transition-v1' as const;
/** D-008: duplication is allowed only under a measured, enforced budget. */
export const CONTROL_ANCHOR_MAX_TOKENS = 384;
export const CONTROL_TRANSITION_MAX_TOKENS = 384;
const MAX_SCOPE_ITEMS = 12;
const MAX_ID_CHARS = 120;

export interface ControlAnchorState {
  modes: string[];
  /** D-030/P-040: explicit desired/prepared/applied activation truth. */
  activation?: SessionActivation;
  /**
   * identities-v1 P-012 — the session's STACK BINDING: the identity layers bound beyond
   * the kernel, as `slot:id` refs (`fleet-posture:su.fleet-leader`). DERIVED from the
   * same authorities this anchor already projects (`route.role` → the fleet posture;
   * `modes` → one definition identity per mode axis, P-021) by
   * `stack-binding-channel.ts`, so a posture change bumps the generation exactly like a
   * mode flip; the turn-start hook then delivers the layer TEXT beside the `⟦CTRL⟧`
   * line. Present only when non-empty — costs nothing on the common unbound session.
   */
  stack?: string[];
  loop: { active: boolean; intervalSec: number | null };
  /**
   * WI-7302 part 2 — will ANYTHING wake this session unprompted?
   * `loop` (an armed engine loop) | `event` (a standing policy='wake' await) |
   * `none` (nothing will).
   *
   * Deliberately NOT derivable from `loop.active` above: a session correctly
   * parked on `events:await { work-item:claimable }` has `loop.active:false`
   * and is still perfectly wakeable. The member contract PRESCRIBES that park,
   * so treating !loop.active as "no wake source" would fire hardest at exactly
   * the sanctioned behaviour. See presence-selfwake.ts.
   *
   * OPTIONAL on purpose: absent = the leg was not resolved (UNKNOWN), never
   * `'none'`. Costs ~5 tokens against the anchor's 384 budget when present.
   */
  wakeSource?: SelfWakeSource;
  carry: 'warm' | 'cold';
  /**
   * Durable, re-derived stand-down instruction for an expired GOAL predecessor.
   * Omitted for every non-superseded session to keep the compact anchor small.
   * This is a projection of agent_modes election state, never a second lease.
   */
  goalAuthority?: {
    status: 'superseded';
    goalId: string;
    electedOwnerId: string | null;
    electedEpoch: number | null;
    handoffExpiresAt: string | null;
    standDown: true;
  };
  /** EI-203843: a durable fleet release marker carried by the compact anchor. */
  lifecycle?: SessionBriefLifecycle;
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
  source: 'mode:set' | 'loop:arm' | 'loop:end' | 'loop:transfer' | 'fleet:membership' | 'control-anchor:reconcile' | 'session:activation';
  ownerDirected: boolean;
  recordedAt: string;
}

export interface ControlTransition {
  schemaVersion: typeof CONTROL_TRANSITION_SCHEMA;
  /** The owner/session this transition was produced for, not merely its actor. */
  targetOwnerId: string;
  previousGeneration: number;
  generation: number;
  state: ControlAnchorState;
  /**
   * P-012: the `stack` refs of the generation this transition REPLACES (stamped by
   * `persistControlAnchor` from the previous row), so the turn-start hook can diff
   * before → after into attach / detach payloads. ABSENT on a full-resync (unknown
   * predecessor) — the channel then re-delivers every bound layer.
   */
  stackBefore?: string[];
  provenance: ControlTransitionProvenance;
  resync: {
    verb: 'coord:orient';
    args: { afterCompaction: true };
    rule: 'replace-full-never-merge-behind';
  };
}

export interface ControlTransitionDelivery extends ControlTransition {
  kind: 'transition' | 'full-resync';
  reason:
    | 'next-generation'
    | 'missing-transition'
    | 'schema-mismatch'
    | 'generation-mismatch'
    | 'owner-mismatch';
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
  /**
   * Is the coordination LEASE still in force (`expires_ts > now`)? False means
   * the lease lapsed — peers may take the item — but NOT that this agent stopped
   * working it. See the query in `buildControlAnchorState` for why self-scope
   * deliberately keeps a lapsed row.
   */
  lease_valid: boolean;
}

/** What the claim rows say this agent's own lane is. */
export interface DerivedClaimScope {
  harness: string | null;
  plan: string | null;
  items: string[];
  /** Items whose coordination lease has lapsed — still ours, but re-claim before editing. */
  lapsed: string[];
}

/**
 * Derive an agent's OWN plan lane from its claim rows. Pure so the rule is
 * testable without PG — the guard that matters is the regression below.
 *
 * `briefPlanSlug` (the session brief's durable current plan) wins when set;
 * otherwise the lane is inferred from the claims themselves, which is what lets
 * a respawned agent recover its mission when the brief has not been rewritten
 * yet.
 *
 * ⚠ A LAPSED LEASE IS STILL OUR LANE. Rows arrive here unfiltered by
 * `expires_ts` on purpose (see the query in `buildControlAnchorState`): expiry
 * governs whether a PEER may take the item, not whether WE were working it.
 * Dropping lapsed rows here is what made a live agent's mission vanish
 * mid-flight (2026-08-10).
 */
export function deriveClaimScope(
  claims: readonly ScopeClaimRow[],
  briefPlanSlug: string | null | undefined,
  briefHarnessSlug: string | null | undefined,
): DerivedClaimScope {
  // The brief is a durable hint, but a held claim is the live lane authority.
  // If a stale brief names a control/objective plan that has no matching claim,
  // following it hides the actual plan and items from the successor. Keep the
  // brief plan only when there are no claims to contradict it.
  const briefPlanClaims = briefPlanSlug
    ? claims.filter((c) => c.plan_slug === briefPlanSlug)
    : [];
  const claimPlan = claims[0]?.plan_slug ?? null;
  const selectedPlan = briefPlanClaims.length > 0
    ? briefPlanSlug!
    : claimPlan ?? briefPlanSlug ?? null;
  const planClaims = selectedPlan
    ? claims.filter((c) => c.plan_slug === selectedPlan)
    : [];
  const chosen = planClaims[0] ?? claims[0] ?? null;
  return {
    harness: briefHarnessSlug ?? chosen?.harness_slug ?? null,
    plan: selectedPlan,
    items: planClaims.map((c) => c.item_id),
    lapsed: planClaims.filter((c) => !c.lease_valid).map((c) => c.item_id),
  };
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
  const released = input.lifecycle?.released;
  const goalAuthority = input.goalAuthority?.status === 'superseded' && input.goalAuthority.goalId
    ? {
        status: 'superseded' as const,
        goalId: input.goalAuthority.goalId.slice(0, MAX_ID_CHARS),
        electedOwnerId: cap(input.goalAuthority.electedOwnerId),
        electedEpoch: input.goalAuthority.electedEpoch == null
          ? null
          : Math.max(0, Math.floor(input.goalAuthority.electedEpoch)),
        handoffExpiresAt: cap(input.goalAuthority.handoffExpiresAt),
        standDown: true as const,
      }
    : undefined;
  const stack = [...new Set((input.stack ?? []).map(String))].sort().map((v) => v.slice(0, MAX_ID_CHARS));
  const activation = normalizeSessionActivation(input.activation);
  return {
    modes: [...new Set(input.modes.map(String))].sort().map((v) => v.slice(0, 40)),
    ...(activation ? { activation } : {}),
    // P-012: spread-when-present — an unbound session carries no `stack` key at all.
    ...(stack.length ? { stack } : {}),
    loop: {
      active: Boolean(input.loop.active),
      intervalSec: input.loop.intervalSec == null ? null : Math.max(0, Math.floor(input.loop.intervalSec)),
    },
    // WI-7302: spread-when-present so UNKNOWN stays absent rather than being
    // normalized into a `'none'` that would read as a positive finding.
    ...(input.wakeSource ? { wakeSource: input.wakeSource } : {}),
    carry: input.carry === 'cold' ? 'cold' : 'warm',
    ...(goalAuthority ? { goalAuthority } : {}),
    ...(released?.fleet && released.at && released.by
      ? {
          lifecycle: {
            released: {
              fleet: released.fleet.slice(0, MAX_ID_CHARS),
              at: released.at.slice(0, MAX_ID_CHARS),
              by: released.by.slice(0, MAX_ID_CHARS),
            },
          },
        }
      : {}),
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

/** Pure projection used by the live reconciler and focused acceptance tests. */
export function projectGoalHolderAuthority(
  authority: GoalHolderAuthority,
): ControlAnchorState['goalAuthority'] {
  if (authority.status !== 'superseded' || !authority.goalId) return undefined;
  return {
    status: 'superseded',
    goalId: authority.goalId,
    electedOwnerId: authority.electedOwnerId,
    electedEpoch: authority.electedEpoch,
    handoffExpiresAt: authority.handoffExpiresAt,
    standDown: true,
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
  const targetMatches = pending?.targetOwnerId === input.ownerId;
  const exactNext =
    pending?.schemaVersion === CONTROL_TRANSITION_SCHEMA &&
    targetMatches &&
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
      : !targetMatches
        ? 'owner-mismatch'
      : 'generation-mismatch';
  // Reject the pending payload wholesale. Full-state replacement is built
  // from the current authoritative anchor row, never the stale transition.
  return renderControlTransitionDelivery({
    schemaVersion: CONTROL_TRANSITION_SCHEMA,
    targetOwnerId: input.ownerId,
    kind: 'full-resync',
    reason,
    previousGeneration: input.deliveredGeneration,
    generation: input.generation,
    state: input.state,
    provenance:
      pending?.generation === input.generation && targetMatches
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
    targetOwnerId: input.ownerId,
    previousGeneration: 0,
    generation: 1,
    state,
    // P-012: a first generation replaces nothing; on conflict the SQL below overwrites
    // this with the PREVIOUS row's `stack` so the hook can diff the binding.
    stackBefore: [],
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
            jsonb_set(
              jsonb_set(EXCLUDED.control_transition, '{previousGeneration}', to_jsonb(harness_shared.session_briefs.control_generation), true),
              '{generation}', to_jsonb(harness_shared.session_briefs.control_generation + 1), true
            ),
            '{stackBefore}', COALESCE(harness_shared.session_briefs.control_state->'stack', '[]'::jsonb), true
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
  // WI-6974 — push the Orders panel ONLY when the control state actually moved.
  //
  // This is the whole argument for a producer push over a `session_briefs` row
  // trigger. `persistControlAnchor` runs on essentially every orient, and the
  // upsert above deliberately treats an unchanged state as a no-op (the three
  // `IS DISTINCT FROM` CASEs). A trigger fires on the UPDATE regardless, so it
  // would push every open Orders panel on every agent's every wake — a timer,
  // not an orders change.
  //
  // Detecting "did it move" needs no extra query: on a real change the row keeps
  // OUR transition (EXCLUDED.control_transition, with the generations jsonb_set
  // onto it), so its provenance.recordedAt is the one we just minted; on a no-op
  // it keeps the PREVIOUS transition, recorded at an earlier instant. Comparing
  // generation numbers cannot distinguish them — the stored transition's
  // `generation` equals `control_generation` in BOTH cases.
  const persistedAt = row.control_transition?.provenance?.recordedAt;
  if (persistedAt === provenance.recordedAt) await notifyAgentOrdersChanged(input.ownerId);
  return {
    generation: Number(row.control_generation),
    state: normalizeControlAnchorState(row.control_state),
    updatedAt: new Date(row.control_updated_at).toISOString(),
    transition: row.control_transition ?? null,
  };
}

/**
 * Read the newest undelivered generation for the turn-start hook.
 *
 * This is intentionally the first phase of delivery, not the acknowledgement:
 * stack rendering happens after this query and can fail softly. The caller must
 * acknowledge the returned generation only after it has assembled the complete
 * prompt block; otherwise a render failure would advance the watermark while
 * the stack layer was never delivered.
 */
export async function preparePendingControlTransition(
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
    SELECT owner_id, control_generation, control_state, control_updated_at,
           control_transition, control_delivered_generation AS delivered_generation
      FROM harness_shared.session_briefs
     WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
       AND control_state IS NOT NULL
       AND control_generation > control_delivered_generation
     FOR UPDATE
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

/** Persist the prepared phase after the complete stack/render validation succeeds. */
export async function markControlTransitionPrepared(
  ownerId: string,
  workspaceId: string,
  generation: number,
  revision: SessionActivation['desired'],
  sql: Sql = getOrgPg().sql,
): Promise<boolean> {
  const rev = JSON.stringify({ specificationRevision: revision.specificationRevision, stateRevision: revision.stateRevision });
  const rows = await sql<Array<{ control_generation: number | string }>>`
    UPDATE harness_shared.session_briefs
       SET control_state = jsonb_set(
         jsonb_set(
           jsonb_set(control_state, '{activation,prepared}', ${rev}::jsonb, true),
           '{activation,status}', '"prepared"'::jsonb, true
         ),
         '{activation,failure}', 'null'::jsonb, true
       )
     WHERE owner_id = ${ownerId}
       AND workspace_id = ${workspaceId}
       AND control_generation = ${generation}
       AND control_delivered_generation < ${generation}
       AND control_state->'activation'->'desired' = ${rev}::jsonb
    RETURNING control_generation
  `;
  if (rows.length === 0) return false;
  const recorded = await recordCurrentSessionIdentityActivation({
    ownerId, workspaceId, generation, phase: 'prepared', source: 'control', revision, sql,
  });
  return recorded !== 'missing';
}

/** Persist a render/delivery failure while retaining the previous applied revision. */
export async function failControlTransitionActivation(
  ownerId: string,
  workspaceId: string,
  generation: number,
  revision: SessionActivation['desired'],
  failure: string,
  sql: Sql = getOrgPg().sql,
): Promise<boolean> {
  if (!failure.trim()) return false;
  const rev = JSON.stringify({ specificationRevision: revision.specificationRevision, stateRevision: revision.stateRevision });
  const reason = JSON.stringify(failure.trim());
  const rows = await sql<Array<{ control_generation: number | string }>>`
    UPDATE harness_shared.session_briefs
       SET control_state = jsonb_set(
         jsonb_set(
           jsonb_set(control_state, '{activation,prepared}', 'null'::jsonb, true),
           '{activation,status}', '"failed"'::jsonb, true
         ),
         '{activation,failure}', ${reason}::jsonb, true
       )
     WHERE owner_id = ${ownerId}
       AND workspace_id = ${workspaceId}
       AND control_generation = ${generation}
       AND control_delivered_generation < ${generation}
       AND control_state->'activation'->'desired' = ${rev}::jsonb
    RETURNING control_generation
  `;
  if (rows.length === 0) return false;
  const recorded = await recordCurrentSessionIdentityActivation({
    ownerId, workspaceId, generation, phase: 'failed', source: 'control', revision,
    failure: failure.trim(), sql,
  });
  return recorded !== 'missing';
}

/**
 * Backwards-compatible name for callers that still use the original
 * one-shot-delivery vocabulary. The operation is now deliberately a
 * prepare/read; pair it with {@link acknowledgeControlTransition} after the
 * prompt has been assembled.
 */
export const consumePendingControlTransition = preparePendingControlTransition;

/**
 * Phase two of CTRL delivery: acknowledge one generation after the complete
 * prompt has been assembled successfully.
 *
 * The update is conditional and monotonic. If a newer generation appeared
 * while the caller was rendering, only the generation that this caller
 * actually prepared is acknowledged; the newer one remains pending for the
 * next turn. If the process dies before this call, the same generation is
 * returned again, preserving at-least-once delivery instead of losing a stack
 * mutation.
 */
export async function acknowledgeControlTransition(
  ownerId: string,
  workspaceId: string,
  generation: number,
  sql: Sql = getOrgPg().sql,
  activationRevision?: SessionActivation['desired'],
): Promise<boolean> {
  if (!Number.isSafeInteger(generation) || generation < 0) return false;
  const rows = activationRevision
    ? await sql<Array<{ control_delivered_generation: number | string }>>`
        UPDATE harness_shared.session_briefs
           SET control_delivered_generation = GREATEST(control_delivered_generation, ${generation}),
               control_state = jsonb_set(
                 jsonb_set(
                   jsonb_set(control_state, '{activation,applied}', ${JSON.stringify(activationRevision)}::jsonb, true),
                   '{activation,prepared}', 'null'::jsonb, true
                 ),
                 '{activation,status}', '"applied"'::jsonb, true
               )
         WHERE owner_id = ${ownerId}
           AND workspace_id = ${workspaceId}
           AND control_generation >= ${generation}
           AND control_delivered_generation < ${generation}
           AND control_state->'activation'->'desired' = ${JSON.stringify(activationRevision)}::jsonb
           AND control_state->'activation'->'prepared' = ${JSON.stringify(activationRevision)}::jsonb
        RETURNING control_delivered_generation
      `
    : await sql<Array<{ control_delivered_generation: number | string }>>`
        UPDATE harness_shared.session_briefs
           SET control_delivered_generation = GREATEST(control_delivered_generation, ${generation})
         WHERE owner_id = ${ownerId}
           AND workspace_id = ${workspaceId}
           AND control_generation >= ${generation}
           AND control_delivered_generation < ${generation}
        RETURNING control_delivered_generation
      `;
  if (rows.length === 0) return false;
  if (activationRevision) {
    const recorded = await recordCurrentSessionIdentityActivation({
      ownerId, workspaceId, generation, phase: 'applied', source: 'control',
      revision: activationRevision, sql,
    });
    return recorded !== 'missing';
  }
  return true;
}

export function renderControlTransitionContext(delivery: ControlTransitionDelivery): string {
  return `⟦CTRL:${delivery.kind}⟧ ${JSON.stringify(delivery)}`;
}

/** Reconcile the existing authoritative stores into the compact projection. */
export async function buildControlAnchorState(
  ownerId: string,
  workspaceId: string,
  opts: {
    sql?: Sql;
    loop?: LoopStatus | null;
    /** WI-7302: DI seam so the wake-source leg unit-tests without PG. */
    fetchSelfWakeFn?: (ids: string[]) => Promise<Map<string, SelfWakeSignals>>;
  } = {},
): Promise<ControlAnchorState> {
  const sql = opts.sql ?? getOrgPg().sql;
  // ⚠ Each leg is guarded AT CREATION, not after the whole set is built.
  //
  // These legs are started eagerly and settled together, so two different
  // failures can orphan a rejection with no handler — and on Node's default
  // --unhandled-rejections=throw an orphan takes the process down. That breaks
  // the fail-soft guarantee refreshControlAnchorAfterMutation advertises at
  // exactly the moment it matters most, because a DB fault fails SEVERAL legs
  // at once rather than one:
  //   1. Promise.all rejects with the FIRST failure and abandons the rest; the
  //      losers keep running and reject into nothing.
  //   2. Worse, a leg whose construction throws SYNCHRONOUSLY (`claimsP` is a
  //      tagged template — an `sql` that is not callable throws right here)
  //      aborts the remaining legs, orphaning every promise already created.
  //      A guard placed after the set is assembled never even runs.
  //
  // `guard` is identity — it only marks a rejection handled, so Promise.all
  // still rejects with the first failure and callers see identical behaviour.
  // Measured 2026-08-29 in canonical run 4: standing-goal-boot-arm.test.ts
  // (whose `sql` is `{}`) passed all 11 tests and still exited 1 on exactly
  // three orphans — the three legs built before the tagged template threw —
  // which failed the whole @papercusp/operator-core test:lane-pure task.
  const guard = <T>(leg: T): T => {
    void Promise.resolve(leg).catch(() => {});
    return leg;
  };
  const modesP = guard(getModes(workspaceId, ownerId, sql));
  const loopP = guard(
    opts.loop === undefined ? getLoopStatus(ownerId, { sql }) : Promise.resolve(opts.loop),
  );
  const membershipP = guard(latestFleetMembership(workspaceId, ownerId, sql));
  const briefP = guard(getSessionBrief({ ownerId }));
  // Fail closed: an unreadable authority leg must not emit a fresh anchor that
  // silently omits a predecessor's stand-down order. The enclosing orient or
  // mutation refresh can retry; it may never manufacture authority from absence.
  const goalAuthorityP = guard(readGoalHolderAuthority(sql, workspaceId, ownerId));
    // ⚠ NO `expires_ts > clock_timestamp()` FILTER HERE — deliberately.
    //
    // `plan_item_claims` is a TTL'd coordination LEASE (default ttl_sec 1200 =
    // 20 min). Expiry answers "may a PEER take this item?" — it does NOT answer
    // "what is this agent working on". Filtering self-scope by it made an
    // agent's own mission evaporate 20 minutes into working a single item.
    //
    // Measured 2026-08-10: a session driving plan
    // retire-mug-kettle-su-only-2026-08-09 respawned and reported
    // `scope: { plan: null, items: [] }`. Its P-034 claim row was still there,
    // unreleased — the lease had simply lapsed 13h earlier. Both symptoms came
    // from this one predicate: `items` emptied, and `plan` then fell through
    // `chosen?.plan_slug` to null. The agent lost its mission and asked the
    // owner which plan it was on.
    //
    // Reading a lapsed row here CANNOT steal a peer's work: the primary key is
    // (workspace_id, harness_slug, plan_slug, item_id), one row per item, and a
    // peer's claim overwrites `owner`. So a surviving row still owned by US
    // means nobody else took it. Rows are DELETED on release, so presence means
    // claimed-and-never-released.
    //
    // `lease_valid` is carried so callers can tell "mine, lease live" from
    // "mine, lease lapsed — re-claim before editing".
  const claimsP = guard(sql<ScopeClaimRow[]>`
      SELECT harness_slug, plan_slug, item_id,
             expires_ts > clock_timestamp() AS lease_valid
        FROM harness_shared.plan_item_claims
       WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND owner = ${ownerId}
       ORDER BY (expires_ts > clock_timestamp()) DESC, plan_slug, item_id
    `);
    // WI-7302 part 2: the forward-looking wake-source leg. Best-effort — on any
    // failure this resolves to an empty map and `wakeSource` is simply absent
    // (UNKNOWN), because a degraded query must never be able to tell a healthy
    // session that nothing will ever wake it.
  const selfWakeP = guard(
    (opts.fetchSelfWakeFn ?? fetchSelfWake)([ownerId]).catch(
      () => new Map<string, SelfWakeSignals>(),
    ),
  );
  const [modes, loop, membership, brief, goalAuthority, claims, selfWake] = await Promise.all([
    modesP,
    loopP,
    membershipP,
    briefP,
    goalAuthorityP,
    claimsP,
    selfWakeP,
  ]);
  const derived = deriveClaimScope(claims, brief?.currentPlanSlug, brief?.harnessSlug);
  const fleet = membership?.fleetSlug;
  const source = brief?.source?.toLowerCase() ?? '';
  const route: ControlAnchorState['route'] = fleet
    ? { kind: 'fleet', fleet, role: membership?.fleetRole ?? null }
    : source.includes('mug')
      ? { kind: 'mug' }
      : { kind: 'self' };
  return normalizeControlAnchorState({
    modes: modes.map((m) => m.mode),
    // P-009: preserve the current desired/prepared/applied truth while the
    // other canonical control legs are reconciled. The brief is only a carrier;
    // normalizeSessionActivation remains the validator/owner of this field.
    activation: normalizeSessionActivation(
      (brief?.controlState as Record<string, unknown> | null | undefined)?.activation,
    ),
    // P-012 / P-021: the stack binding is a projection of the route (fleet posture) and of
    // the active modes (one definition identity per mode axis) — no new leg.
    stack: stackRefsForSession({ route, modes: modes.map((m) => m.mode) }),
    loop: { active: Boolean(loop?.active), intervalSec: loop?.intervalSec ?? null },
    wakeSource: selfWake.get(ownerId)?.selfWake,
    carry: loop?.carry ?? 'warm',
    goalAuthority: projectGoalHolderAuthority(goalAuthority),
    lifecycle: brief?.lifecycle ?? undefined,
    route,
    scope: {
      workspace: workspaceId,
      harness: derived.harness,
      plan: derived.plan,
      items: derived.items,
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

/**
 * Start one acknowledged identity delivery on the existing control anchor.
 * Launch and carry-restart both use this door; `restart` deliberately creates a
 * new generation even when its revisions are unchanged.
 */
export async function requestSessionIdentityActivation(input: {
  ownerId: string;
  workspaceId: string;
  revision: SessionActivation['desired'];
  attribution?: ActivationAttribution;
  source: Exclude<SessionIdentityActivationSource, 'control'>;
  restart?: boolean;
  sql?: Sql;
}): Promise<ControlAnchor> {
  const sql = input.sql ?? getOrgPg().sql;
  const state = await buildControlAnchorState(input.ownerId, input.workspaceId, { sql });
  const activation = state.activation
    ? input.restart
      ? restartActivation(state.activation, input.revision)
      : requestActivation(state.activation, input.revision)
    : desiredActivation(
        input.attribution ?? {
          actorId: input.ownerId,
          principalId: input.ownerId,
          sessionId: input.ownerId,
        },
        input.revision,
      );
  const persisted = await persistControlAnchor(
    {
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      state: { ...state, activation },
      transition: {
        origin: 'system',
        actorId: input.ownerId,
        source: 'session:activation',
        ownerDirected: false,
      },
    },
    sql,
  );
  const recorded = await recordCurrentSessionIdentityActivation({
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    generation: persisted.generation,
    phase: 'desired',
    source: input.source,
    revision: input.revision,
    sql,
  });
  if (recorded === 'missing') throw new Error('session_identity_activation_desired_not_recorded');
  return renderControlAnchor({ ownerId: input.ownerId, ...persisted });
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
    const sql = input.sql ?? getOrgPg().sql;
    const state = await buildControlAnchorState(input.ownerId, input.workspaceId, { sql });
    const identityMoved = input.source === 'mode:set' || input.source === 'fleet:membership';
    const nextState = identityMoved && state.activation
      ? {
          ...state,
          activation: requestActivation(state.activation, {
            specificationRevision: state.activation.desired.specificationRevision,
            stateRevision: sessionIdentityStateRevision(state),
          }),
        }
      : state;
    const persisted = await persistControlAnchor({
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      state: nextState,
      transition: {
        origin: input.origin,
        actorId: input.actorId,
        source: input.source,
        ownerDirected: Boolean(input.ownerDirected),
      },
    }, sql);
    if (identityMoved && persisted.state.activation?.status === 'desired') {
      await recordCurrentSessionIdentityActivation({
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        generation: persisted.generation,
        phase: 'desired',
        source: 'control',
        revision: persisted.state.activation.desired,
        sql,
      });
    }
    return renderControlAnchor({ ownerId: input.ownerId, ...persisted });
  } catch {
    return null;
  }
}
