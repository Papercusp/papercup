/**
 * slot-parked-store.ts — durable park/drain for slot-addressed coord messages
 * (park-for-slot addressing / B2 — directed-wake-honesty-and-spawn-handoff-2026-06-14,
 * P-025; D-005).
 *
 * A coord:send addressed to a SLOT that has no agent yet (`@role:`/`@wave:`/
 * `@feature:`, parsed by ./slot-selector) is PARKED here instead of delivered.
 * When an agent later spawns into that slot, deliver-on-spawn (P-023) DRAINS the
 * pending rows into its handoff brief. A row is claimed EXACTLY ONCE — the drain
 * UPDATE … RETURNING flips delivered_ts atomically, so a concurrent drainer can't
 * double-deliver — or dropped VISIBLY on TTL expiry (a diagnostic row remains),
 * never silently lost, mirroring the await-event delivery ladder.
 *
 * The `sql` handle is injected (the capabilities-store pattern: pg-stores.ts) so
 * the store unit/integration-tests against a throwaway DB without mocking; the
 * host/callers pass `getOrgPg().sql` (the coord 'default' workspace,
 * DEFAULT_COORD_WORKSPACE). Schema = migration 280; this file does NO DDL
 * (storage policy: migrations only).
 */
import type postgres from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import type { SlotSelector } from './slot-selector';

export interface ParkSlotMessageInput {
  /** The slot the message is addressed to. */
  slot: SlotSelector;
  /** Harness scope; null/undefined = workspace-level. */
  harnessSlug?: string | null;
  /** The full coord envelope (its `to` carries the slot selector verbatim). */
  envelope: CoordEnvelope;
  /** Optional expiry window in ms; omit/null = never expires. */
  ttlMs?: number | null;
  /** epoch ms "now" — injected so the call site owns the clock (tests pass fixed). */
  nowMs: number;
  workspaceId?: string;
}

/** Park a slot-addressed message. Idempotent on the envelope's msg_id. */
export async function parkSlotMessage(
  sql: postgres.Sql,
  input: ParkSlotMessageInput,
): Promise<{ id: string }> {
  const ws = input.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  await sql`
    INSERT INTO harness_shared.slot_parked_messages
      (id, workspace_id, slot_kind, slot_ref, harness_slug, from_owner, envelope, created_ts, ttl_ms)
    VALUES (
      ${input.envelope.msg_id}, ${ws}, ${input.slot.kind}, ${input.slot.ref},
      ${input.harnessSlug ?? null}, ${input.envelope.from},
      ${JSON.stringify(input.envelope)}::jsonb,
      ${input.nowMs}, ${input.ttlMs ?? null}
    )
    ON CONFLICT (workspace_id, id) DO NOTHING
  `;
  return { id: input.envelope.msg_id };
}

export interface DrainSlotInput {
  slot: SlotSelector;
  harnessSlug?: string | null;
  /** The spawnee ownerId the parked messages are being delivered to. */
  toOwner: string;
  /** epoch ms "now" — also the expiry cutoff. */
  nowMs: number;
  workspaceId?: string;
}

/**
 * Claim-and-return every pending (un-delivered, un-dropped, un-expired) message
 * parked for `slot`. Atomic claim: the UPDATE … RETURNING flips delivered_ts so a
 * concurrent drainer can't double-deliver. Expired rows are LEFT for
 * expireStaleSlotMessages so they drop visibly rather than being silently skipped.
 * Returned in park order (ts then msg_id).
 */
export async function drainSlotMessages(
  sql: postgres.Sql,
  input: DrainSlotInput,
): Promise<CoordEnvelope[]> {
  const ws = input.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const rows = await sql<{ envelope: CoordEnvelope }[]>`
    UPDATE harness_shared.slot_parked_messages
       SET delivered_ts = ${input.nowMs}, delivered_to = ${input.toOwner}
     WHERE workspace_id = ${ws}
       AND slot_kind = ${input.slot.kind}
       AND slot_ref = ${input.slot.ref}
       AND harness_slug IS NOT DISTINCT FROM ${input.harnessSlug ?? null}
       AND delivered_ts IS NULL
       AND dropped_ts IS NULL
       AND (ttl_ms IS NULL OR created_ts + ttl_ms > ${input.nowMs})
     RETURNING envelope
  `;
  return rows
    .map((r) => r.envelope)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
}

/**
 * Mark every pending message whose TTL has elapsed as dropped (visibly — the row
 * stays with dropped_reason='ttl-expired' for diagnostics), returning how many.
 * A periodic sweep / the deliver-on-spawn path calls this so an unfilled slot's
 * mail is never silently stranded.
 */
export async function expireStaleSlotMessages(
  sql: postgres.Sql,
  nowMs: number,
  workspaceId: string = DEFAULT_COORD_WORKSPACE,
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.slot_parked_messages
       SET dropped_ts = ${nowMs}, dropped_reason = 'ttl-expired'
     WHERE workspace_id = ${workspaceId}
       AND delivered_ts IS NULL
       AND dropped_ts IS NULL
       AND ttl_ms IS NOT NULL
       AND created_ts + ttl_ms <= ${nowMs}
     RETURNING id
  `;
  return rows.length;
}

/**
 * Read (without claiming) the pending, un-expired messages parked for `slot`.
 * Diagnostics + tests; the delivery path uses drainSlotMessages.
 */
export async function listPendingForSlot(
  sql: postgres.Sql,
  input: {
    slot: SlotSelector;
    harnessSlug?: string | null;
    nowMs: number;
    workspaceId?: string;
  },
): Promise<CoordEnvelope[]> {
  const ws = input.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const rows = await sql<{ envelope: CoordEnvelope }[]>`
    SELECT envelope
      FROM harness_shared.slot_parked_messages
     WHERE workspace_id = ${ws}
       AND slot_kind = ${input.slot.kind}
       AND slot_ref = ${input.slot.ref}
       AND harness_slug IS NOT DISTINCT FROM ${input.harnessSlug ?? null}
       AND delivered_ts IS NULL
       AND dropped_ts IS NULL
       AND (ttl_ms IS NULL OR created_ts + ttl_ms > ${input.nowMs})
     ORDER BY created_ts ASC, id ASC
  `;
  return rows.map((r) => r.envelope);
}
