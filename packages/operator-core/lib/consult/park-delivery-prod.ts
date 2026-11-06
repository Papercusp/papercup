/**
 * Production wiring for the park verdict delivery check
 * (consult-backed-parking-2026-10-12 P-007, WI-6554700010009495).
 *
 * park-delivery.ts decides the one owed step from a ParkDeliveryState. This module:
 *  - finds parks whose latest verdict needs the parked agent to act
 *    (proceed / consider-alternative / owner-decided — 'adopted' is the parker's own act and
 *    'owner-deciding' waits on the owner, not the parker);
 *  - builds the state from consult_state.park_state, verdict-specific wake pickup proof and
 *    the shared liveness oracle;
 *  - binds the three effects: re-wake (inbox row + wake), resume (capability:launch-agent
 *    { resume }) and owner notification (a coord message to `human`);
 *  - keeps the bookkeeping in consult_state.park_state.delivery, keyed to the verdict it
 *    refers to (`verdictAt`), so a later verdict on the same park starts a fresh check.
 *
 * Imports of the coord / launch graphs are dynamic for the same reason as park-prod.ts:
 * this module is loaded from the consult expiry routine.
 */
import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { TURN_PROOF_CONFIRMED } from '../events/await/turn-proof';
import { turnProofColumnsReady } from '../events/await/turn-proof-schema';
import { decisionReviewMetaFromRouting } from './decision-review';
import type { StoredParkState } from './park-adapters';
import {
  runParkDeliveryCheck,
  type ParkDeliveryDeps,
  type ParkDeliveryResult,
  type ParkDeliveryState,
  type ParkerSessionState,
} from './park-delivery';
import { parkVerdictEventKey, type ParkOutcomeRecord, type ParkVerdict } from './park-resolver';
import { PARK_SYSTEM_ACTOR } from './park-prod';

/** Verdicts the parked agent must act on. */
export const PARKER_ACTION_VERDICTS: ReadonlySet<ParkVerdict> = new Set(['proceed', 'consider-alternative', 'owner-decided']);

/** Verdicts older than this are not chased: the check is for fresh verdicts, not an archive sweep. */
export const PARK_DELIVERY_HORIZON_MS = 2 * 24 * 60 * 60_000;

/** Delivery bookkeeping stored at consult_state.park_state.delivery. */
export interface StoredParkDelivery {
  /** The verdict (`outcome.at`) these fields refer to. */
  verdictAt?: string | null;
  rewakeAttemptedAt?: string | null;
  resumeAttemptedAt?: string | null;
  resumeResult?: 'ok' | 'failed' | null;
  ownerNotifiedAt?: string | null;
  /** First check that saw a parker turn after the verdict; stops further checks. */
  deliveredAt?: string | null;
}

export interface ParkDeliveryRow {
  workspace_id: string;
  conversation_id: string;
  routing: unknown;
  park_state: (StoredParkState & { delivery?: StoredParkDelivery | null }) | string | null;
}

function parseParkState(raw: ParkDeliveryRow['park_state']): (StoredParkState & { delivery?: StoredParkDelivery | null }) | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as StoredParkState & { delivery?: StoredParkDelivery | null };
    } catch {
      return null;
    }
  }
  return raw;
}

function latest(outcomes: readonly ParkOutcomeRecord[] | undefined): ParkOutcomeRecord | null {
  return outcomes && outcomes.length > 0 ? outcomes[outcomes.length - 1]! : null;
}

/**
 * Map one consult row plus the parker's activity to the delivery state. Null when the row
 * is not a decision-review park, its latest verdict is not one the parker acts on, or the
 * check for that verdict is already finished (delivered or owner notified).
 */
export function parkDeliveryStateFromRow(
  row: ParkDeliveryRow,
  parker: { lastTurnAt: string | null; sessionState: ParkerSessionState | null },
): ParkDeliveryState | null {
  const meta = decisionReviewMetaFromRouting(row.routing);
  if (!meta) return null;
  const stored = parseParkState(row.park_state);
  const outcome = latest(stored?.outcomes);
  if (!outcome || !PARKER_ACTION_VERDICTS.has(outcome.verdict)) return null;
  // Bookkeeping written for an earlier verdict does not apply to this one.
  const d: StoredParkDelivery = stored?.delivery && stored.delivery.verdictAt === outcome.at ? stored.delivery : {};
  if (d.deliveredAt || d.ownerNotifiedAt) return null;
  return {
    consultId: row.conversation_id,
    workItemId: meta.workItemId,
    parkerId: meta.setterId,
    verdict: outcome.verdict,
    emittedAt: outcome.at,
    parkerLastTurnAt: parker.lastTurnAt,
    parkerSessionState: parker.sessionState,
    rewakeAttemptedAt: d.rewakeAttemptedAt ?? null,
    resumeAttemptedAt: d.resumeAttemptedAt ?? null,
    resumeResult: d.resumeResult ?? null,
    ownerNotifiedAt: null,
  };
}

const ROUTING_JSONB = `(CASE WHEN jsonb_typeof(routing) = 'string' THEN (routing #>> '{}')::jsonb ELSE routing END)`;

/** Parks whose latest verdict the parker must act on and whose delivery check is open. */
export async function findParksAwaitingDelivery(sql: Sql, nowIso: string, limit: number): Promise<ParkDeliveryRow[]> {
  const horizon = new Date(Date.parse(nowIso) - PARK_DELIVERY_HORIZON_MS).toISOString();
  return sql<ParkDeliveryRow[]>`
    SELECT workspace_id, conversation_id, routing, park_state
      FROM harness_shared.consult_state
     WHERE ${sql.unsafe(ROUTING_JSONB)} #>> '{cascade,flavor}' = 'decision-review'
       AND jsonb_typeof(park_state->'outcomes') = 'array'
       AND park_state->'outcomes'->-1->>'verdict' IN ('proceed', 'consider-alternative', 'owner-decided')
       AND (park_state->'outcomes'->-1->>'at')::timestamptz >= ${horizon}::timestamptz
       AND NOT (
         COALESCE(park_state #>> '{delivery,verdictAt}', '') = park_state->'outcomes'->-1->>'at'
         AND (park_state #>> '{delivery,deliveredAt}' IS NOT NULL OR park_state #>> '{delivery,ownerNotifiedAt}' IS NOT NULL))
     ORDER BY (park_state->'outcomes'->-1->>'at')::timestamptz
     LIMIT ${limit}`;
}

/** Merge a delivery patch for the verdict at `verdictAt`, discarding bookkeeping for an older verdict. */
export async function recordParkDelivery(
  sql: Sql,
  workspaceId: string,
  consultId: string,
  verdictAt: string,
  patch: StoredParkDelivery,
): Promise<void> {
  const next = { ...patch, verdictAt };
  await sql`
    UPDATE harness_shared.consult_state
       SET park_state = jsonb_set(
             COALESCE(park_state, '{}'::jsonb), '{delivery}',
             (CASE WHEN park_state #>> '{delivery,verdictAt}' = ${verdictAt}
                   THEN COALESCE(park_state->'delivery', '{}'::jsonb) ELSE '{}'::jsonb END)
               || ${sql.json(next as never)}::jsonb)
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${consultId}`;
}

/** Reuse the wake engine's verdict-specific pickup proof, never unrelated tool activity. */
async function parkerLastTurnAt(sql: Sql, state: ParkDeliveryState): Promise<string | null> {
  if (await turnProofColumnsReady()) {
    const rows = await sql<Array<{ turn_started_at: Date | string }>>`
      SELECT turn_started_at FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND subscriber_id = ${state.parkerId}
         AND event_key = ${parkVerdictEventKey(state.consultId)}
         AND payload->>'verdict' = ${state.verdict}
         AND status = 'delivered'
         AND turn_proof = ANY(${[...TURN_PROOF_CONFIRMED]})
         AND delivered_at >= ${state.emittedAt}::timestamptz
         AND turn_started_at >= delivered_at
       ORDER BY turn_started_at DESC
       LIMIT 1`;
    const at = rows[0]?.turn_started_at;
    if (at != null) return at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  }

  // A re-wake uses the inbox channel and an exact resume need not create another
  // verdict delivery. In those cases use the host's existing native turn witness
  // after the recovery attempt; an older running turn still proves nothing.
  const recoveryAt = state.resumeAttemptedAt ?? state.rewakeAttemptedAt;
  if (recoveryAt) {
    const { readPickupHostView } = await import('../events/await/pickup-sweep');
    const host = await readPickupHostView(state.parkerId);
    const startedAt = host?.execution?.turnStartedAt;
    if (typeof startedAt === 'number' && Number.isFinite(startedAt)
      && startedAt >= Math.max(Date.parse(recoveryAt), Date.parse(state.emittedAt))) {
      return new Date(startedAt).toISOString();
    }
  }
  return null;
}

async function parkerSessionState(parkerId: string): Promise<ParkerSessionState | null> {
  const { resolveSessionStates } = await import('../agent-tools/coordination/liveness-oracle');
  const verdicts = await resolveSessionStates([{ ownerId: parkerId }], { hydratePerId: true });
  return (verdicts.get(parkerId)?.sessionState as ParkerSessionState | null | undefined) ?? null;
}

function systemIdentity(workspaceId: string) {
  return {
    ownerId: PARK_SYSTEM_ACTOR,
    ownerLabel: 'consult park delivery',
    source: 'static-client' as const,
    workspaceId,
    userId: null,
  };
}

export function parkResumeIdempotencyKey(s: Pick<ParkDeliveryState, 'consultId' | 'emittedAt'>): string {
  return `park-delivery-resume:${s.consultId}:${s.emittedAt}`;
}

/** The production effect seams for one workspace. */
export function makeProdParkDeliveryDeps(sql: Sql, workspaceId: string): ParkDeliveryDeps {
  const identity = systemIdentity(workspaceId);
  return {
    async rewake(s, note) {
      const [{ sendMessage }, { wakeRecipients }] = await Promise.all([
        import('../agent-tools/coordination/messages'),
        import('../agent-tools/coordination/inbox-wake'),
      ]);
      // Durable inbox row first, then the wake — the order coord:send uses.
      await sendMessage(identity as never, { to: [s.parkerId], summary: note, body: note });
      await wakeRecipients([s.parkerId], { summary: note, source: PARK_SYSTEM_ACTOR, workspaceId });
    },

    async resume(s, note) {
      const launch = (await import('../agent-tools/capability/launch-agent')).default.handler as unknown as (
        args: unknown,
        ctx: unknown,
      ) => Promise<{ isError?: boolean }>;
      const res = await launch(
        {
          resume: { agentId: s.parkerId },
          fork: false,
          brief: note,
          headless: true,
          idempotencyKey: parkResumeIdempotencyKey(s),
        },
        {
          workspaceId,
          principal: { kind: 'system', slug: PARK_SYSTEM_ACTOR, workspaceId },
          ownerId: PARK_SYSTEM_ACTOR,
          ownerLabel: 'consult park delivery',
          userId: null,
        },
      );
      return !res?.isError;
    },

    async notifyOwner(_s, text) {
      const { sendMessage } = await import('../agent-tools/coordination/messages');
      await sendMessage(identity as never, { to: ['human'], summary: text, body: text });
    },

    async record(s, patch) {
      await recordParkDelivery(sql, workspaceId, s.consultId, s.emittedAt, patch);
    },
  };
}

export interface ParkDeliverySweepResult {
  checked: ParkDeliveryResult[];
  failures: Array<{ conversationId: string; error: string }>;
  saturated: boolean;
}

export interface ParkDeliverySweepOpts {
  sql: Sql;
  depsFor?: (workspaceId: string) => ParkDeliveryDeps;
  /** Test seams; production uses verdict pickup/native turn proof and the liveness oracle. */
  lastTurnAt?: (parkerId: string) => Promise<string | null>;
  sessionState?: (parkerId: string) => Promise<ParkerSessionState | null>;
  now?: string;
  limit?: number;
}

/**
 * Run the delivery check for every park awaiting delivery (R-7, R-20, R-21). Called from
 * the consult expiry sweep each tick. One park's failure never stops the others.
 */
export async function sweepParkDeliveries(opts: ParkDeliverySweepOpts): Promise<ParkDeliverySweepResult> {
  const now = opts.now ?? new Date().toISOString();
  const limit = opts.limit ?? 100;
  const depsFor = opts.depsFor ?? ((ws: string) => makeProdParkDeliveryDeps(opts.sql, ws));
  const session = opts.sessionState ?? parkerSessionState;
  const rows = await findParksAwaitingDelivery(opts.sql, now, limit);
  const result: ParkDeliverySweepResult = { checked: [], failures: [], saturated: rows.length >= limit };
  for (const row of rows) {
    try {
      const meta = decisionReviewMetaFromRouting(row.routing);
      if (!meta) continue;
      const sessionState = await session(meta.setterId);
      const state = parkDeliveryStateFromRow(row, { lastTurnAt: null, sessionState });
      if (!state) continue;
      state.parkerLastTurnAt = opts.lastTurnAt
        ? await opts.lastTurnAt(meta.setterId)
        : await parkerLastTurnAt(opts.sql, state);
      const r = await runParkDeliveryCheck(depsFor(row.workspace_id), state, now);
      // A delivered verdict closes the check so later ticks skip it.
      if (r.action === 'none' && r.reason === 'delivered') {
        await recordParkDelivery(opts.sql, row.workspace_id, state.consultId, state.emittedAt, { deliveredAt: now });
      }
      result.checked.push(r);
    } catch (e) {
      result.failures.push({ conversationId: row.conversation_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
