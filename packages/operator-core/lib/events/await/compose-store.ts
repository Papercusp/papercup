/**
 * Composed event awaits — the STORE layer (composable-event-awaits-2026-07-11 P-003).
 *
 * PG access for the threshold-tree substrate (migration 572): the interior/root nodes in
 * `harness_shared.event_await_nodes`, and the composed-leaf / root-anchor columns on
 * `harness_shared.event_awaits`. Mirrors store.ts's conventions exactly: `getOrgPg().sql`,
 * every row in the single coord workspace (`eventsWs()` — the WI-3575 flat-plane rule),
 * ISO-text timestamps (the org postgres-js client throws on Date binding), `::text::jsonb`
 * for jsonb params, and the `parseJsonb` both-shapes tolerance.
 *
 * The delivery shim (why an anchor row exists): the wake pump joins `wake_handle` from
 * `event_awaits` by `await_id` (store.ts claimDueDeliveries) and `await_id` is NOT NULL, so
 * a node's handle is unreachable by that join. Each tree therefore carries ONE ANCHOR
 * `event_awaits` row (synthetic key `composed-root:<rootId>`, node_id NULL, root_id set,
 * carrying the wake_handle) that real emits never match; a root trip queues its delivery
 * against the anchor's id, so the existing exactly-once delivery pump resumes it UNCHANGED.
 */

import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { WakeHandle, TimeoutBehavior } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const eventsWs = (): string => DEFAULT_COORD_WORKSPACE;

function parseJsonb<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

const jsonbParam = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

export interface ComposedNodeRow {
  id: number;
  rootId: number;
  parentId: number | null;
  subscriberId: string;
  requiredCount: number;
  firedCount: number;
  firedAt: string | null;
  spec: unknown | null;
  wakeHandle: WakeHandle | null;
  note: string | null;
  expiresTs: string | null;
  timeoutBehavior: TimeoutBehavior;
  cancelledAt: string | null;
}

function mapNode(r: any): ComposedNodeRow {
  return {
    id: Number(r.id),
    rootId: Number(r.root_id),
    parentId: r.parent_id != null ? Number(r.parent_id) : null,
    subscriberId: r.subscriber_id,
    requiredCount: Number(r.required_count),
    firedCount: Number(r.fired_count),
    firedAt: r.fired_at ? new Date(r.fired_at).toISOString() : null,
    spec: parseJsonb(r.spec),
    wakeHandle: parseJsonb<WakeHandle>(r.wake_handle),
    note: r.note ?? null,
    expiresTs: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
    timeoutBehavior: r.timeout_behavior,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
  };
}

/** A composed LEAF row (event_awaits with node_id) — the fields the fire/assembly paths read. */
export interface ComposedLeafRow {
  id: number;
  eventKey: string;
  nodeId: number;
  rootId: number;
  memberFiredAt: string | null;
  memberPayload: unknown | null;
  firedAt: string | null;
  cancelledAt: string | null;
}

function mapLeaf(r: any): ComposedLeafRow {
  return {
    id: Number(r.id),
    eventKey: r.event_key,
    nodeId: Number(r.node_id),
    rootId: Number(r.root_id),
    memberFiredAt: r.member_fired_at ? new Date(r.member_fired_at).toISOString() : null,
    memberPayload: parseJsonb(r.member_payload),
    firedAt: r.fired_at ? new Date(r.fired_at).toISOString() : null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
  };
}

// ── registration inserts ────────────────────────────────────────────────────────

/**
 * Insert the ROOT node and set its `root_id` to its own id in one round-trip (the
 * migration's documented "root_id equals its own id" convention). Root-only columns
 * (spec, wake_handle, expires_ts) are populated here; interior nodes leave them NULL.
 */
export async function insertRootNode(input: {
  subscriberId: string;
  requiredCount: number;
  firedCount: number;
  spec: unknown;
  wakeHandle: WakeHandle | null;
  note?: string | null;
  timeoutSec?: number | null;
  timeoutBehavior: TimeoutBehavior;
}): Promise<ComposedNodeRow> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const expiresTs = input.timeoutSec != null ? new Date(Date.now() + input.timeoutSec * 1000).toISOString() : null;
  const rows = await sql`
    WITH ins AS (
      INSERT INTO harness_shared.event_await_nodes
        (workspace_id, root_id, parent_id, subscriber_id, required_count, fired_count,
         spec, wake_handle, note, expires_ts, timeout_behavior)
      VALUES
        (${ws}, 0, NULL, ${input.subscriberId}, ${input.requiredCount}, ${input.firedCount},
         ${jsonbParam(input.spec)}::text::jsonb,
         ${input.wakeHandle ? JSON.stringify(input.wakeHandle) : null}::text::jsonb,
         ${input.note ?? null}, ${expiresTs}, ${input.timeoutBehavior})
      RETURNING id
    )
    UPDATE harness_shared.event_await_nodes n
       SET root_id = ins.id
      FROM ins
     WHERE n.id = ins.id
    RETURNING n.*
  `;
  return mapNode(rows[0]);
}

/** Insert an INTERIOR combinator node (root + parent already inserted). */
export async function insertInteriorNode(input: {
  rootId: number;
  parentId: number;
  subscriberId: string;
  requiredCount: number;
  firedCount: number;
  note?: string | null;
}): Promise<ComposedNodeRow> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    INSERT INTO harness_shared.event_await_nodes
      (workspace_id, root_id, parent_id, subscriber_id, required_count, fired_count, note)
    VALUES
      (${ws}, ${input.rootId}, ${input.parentId}, ${input.subscriberId}, ${input.requiredCount},
       ${input.firedCount}, ${input.note ?? null})
    RETURNING *
  `;
  return mapNode(rows[0]);
}

/**
 * Insert a composed LEAF: an ordinary one-shot `event_awaits` row (the matching machinery
 * fires it exactly as today) tagged with node_id/root_id so its claim PROPAGATES to its
 * parent node instead of waking the subscriber. `when` rides the existing payload_filter.
 * The leaf owns no deadline — the ROOT owns the tree's timeout.
 */
export async function insertComposedLeaf(input: {
  subscriberId: string;
  eventKey: string;
  nodeId: number;
  rootId: number;
  when?: unknown;
  note?: string | null;
}): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    INSERT INTO harness_shared.event_awaits
      (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts,
       once, min_sleep_sec, urgency, payload_filter, node_id, root_id)
    VALUES
      (${ws}, ${input.subscriberId}, ${input.eventKey}, 'wake', ${input.note ?? null}, NULL,
       'expire', NULL, true, NULL, false,
       ${input.when != null ? JSON.stringify(input.when) : null}::text::jsonb,
       ${input.nodeId}, ${input.rootId})
    RETURNING id
  `;
  return Number(rows[0].id);
}

/**
 * Insert the tree's ROOT ANCHOR — the delivery shim. Its synthetic key never matches a real
 * emit, so it is never fired by fireAwaitsForKey; it exists only so a root-trip delivery has
 * an `event_awaits` row to hang the wake_handle on for the pump's join. node_id NULL / root_id
 * set distinguishes it from leaves; no expires_ts (the root NODE owns the deadline, so the
 * generic timeout sweep leaves the anchor alone).
 */
export async function insertRootAnchor(input: {
  subscriberId: string;
  rootId: number;
  wakeHandle: WakeHandle | null;
  note?: string | null;
}): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    INSERT INTO harness_shared.event_awaits
      (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts,
       once, min_sleep_sec, urgency, payload_filter, node_id, root_id)
    VALUES
      (${ws}, ${input.subscriberId}, ${`composed-root:${input.rootId}`}, 'wake', ${input.note ?? null},
       ${input.wakeHandle ? JSON.stringify(input.wakeHandle) : null}::text::jsonb,
       'expire', NULL, true, NULL, false, NULL, NULL, ${input.rootId})
    RETURNING id
  `;
  return Number(rows[0].id);
}

// ── fire path ─────────────────────────────────────────────────────────────────

/**
 * Atomically stamp a leaf's member-fire (idempotent on member_fired_at): capture WHEN it
 * claimed as a tree member + its emit payload, for the root wake's `{ fired: leaf→payload }`.
 * The leaf's exactly-once claim already happened in fireAwaitsForKey (fired_at); this owner
 * is therefore uncontended. Returns true if this call captured it (false if already captured).
 */
export async function stampLeafMemberFired(leafId: number, payload: unknown): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET member_fired_at = now(), member_payload = ${jsonbParam(payload)}::text::jsonb
     WHERE id = ${leafId} AND member_fired_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/** The result of bumping a node's counter: the post-update row, or null if the node was
 *  already fired/cancelled (a no-op bump). `justTripped` = this bump crossed the threshold. */
export interface NodeBumpResult {
  id: number;
  parentId: number | null;
  rootId: number;
  requiredCount: number;
  firedCount: number;
  justTripped: boolean;
}

/**
 * Atomically increment a node's fired_count and, if that reaches required_count, stamp
 * fired_at — in ONE guarded UPDATE (row lock serializes concurrent sibling claims, so the
 * counter is exact and the trip fires exactly once). `WHERE fired_at IS NULL` makes a bump on
 * an already-tripped node a harmless no-op (returns null). Monotone + local — the race-safe
 * core the design's theory relies on.
 */
export async function bumpNode(nodeId: number): Promise<NodeBumpResult | null> {
  const { sql } = getOrgPg();
  const rows = await sql`
    UPDATE harness_shared.event_await_nodes
       SET fired_count = fired_count + 1,
           fired_at = CASE WHEN fired_count + 1 >= required_count THEN now() ELSE fired_at END
     WHERE id = ${nodeId} AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id, parent_id, root_id, required_count, fired_count, fired_at
  `;
  if (rows.length === 0) return null;
  const r = rows[0] as any;
  return {
    id: Number(r.id),
    parentId: r.parent_id != null ? Number(r.parent_id) : null,
    rootId: Number(r.root_id),
    requiredCount: Number(r.required_count),
    firedCount: Number(r.fired_count),
    justTripped: r.fired_at != null,
  };
}

/** Load one node (the root, for its spec / handle / deadline). */
export async function loadNode(nodeId: number): Promise<ComposedNodeRow | null> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_await_nodes WHERE workspace_id = ${ws} AND id = ${nodeId} LIMIT 1
  `;
  return rows.length > 0 ? mapNode(rows[0]) : null;
}

/** Every LEAF of a tree (composed event_awaits rows), for the wake payload + status render. */
export async function loadTreeLeaves(rootId: number): Promise<ComposedLeafRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT id, event_key, node_id, root_id, member_fired_at, member_payload, fired_at, cancelled_at
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND root_id = ${rootId} AND node_id IS NOT NULL
     ORDER BY id
  `;
  return rows.map(mapLeaf);
}

/** The tree's anchor (its id + wake_handle) — the delivery target for a root trip. */
export async function findRootAnchor(rootId: number): Promise<{ awaitId: number; subscriberId: string; wakeHandle: WakeHandle | null } | null> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT id, subscriber_id, wake_handle
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND root_id = ${rootId} AND node_id IS NULL
     ORDER BY id
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0] as any;
  return { awaitId: Number(r.id), subscriberId: r.subscriber_id, wakeHandle: parseJsonb<WakeHandle>(r.wake_handle) };
}

/**
 * Queue the ONE wake delivery for a tripped root, against its anchor `event_awaits` row so the
 * existing pump (claimDueDeliveries → executeWake) delivers it unchanged. Returns the delivery id.
 */
export async function insertComposedRootDelivery(input: {
  anchorAwaitId: number;
  subscriberId: string;
  rootId: number;
  payload: unknown;
  summary: string;
  source?: string | null;
}): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    INSERT INTO harness_shared.event_wake_deliveries
      (workspace_id, await_id, subscriber_id, event_key, payload, summary, urgent, min_sleep_sec, source)
    VALUES (${ws}, ${input.anchorAwaitId}, ${input.subscriberId}, ${`composed-root:${input.rootId}`},
            ${jsonbParam(input.payload)}::text::jsonb, ${input.summary}, false, NULL, ${input.source ?? null})
    RETURNING id
  `;
  return Number(rows[0].id);
}

/**
 * Whole-tree one-shot consumption (D-002): on root fire, void every UNFIRED descendant so no
 * survivor ever wakes the subscriber again — the leaves + anchor in event_awaits, and the
 * unfired interior nodes in event_await_nodes (the root itself is already fired). Two
 * root_id-scoped statements (one per table). Returns { leaves, nodes } voided.
 */
export async function voidTreeDescendants(rootId: number): Promise<{ leaves: number; nodes: number }> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const leafRows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND root_id = ${rootId}
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  const nodeRows = await sql`
    UPDATE harness_shared.event_await_nodes
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND root_id = ${rootId} AND parent_id IS NOT NULL
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  return { leaves: leafRows.length, nodes: nodeRows.length };
}

/**
 * events:cancel on a composed root (P-004): soft-void the whole tree — root node + every
 * descendant node + every leaf + the anchor — subscriber-scoped (you cannot cancel a peer's).
 * Returns true if the root was live and got cancelled.
 */
export async function cancelComposedTree(input: { rootId: number; subscriberId: string }): Promise<boolean> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const root = await sql`
    UPDATE harness_shared.event_await_nodes
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND id = ${input.rootId} AND parent_id IS NULL
       AND subscriber_id = ${input.subscriberId}
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  if (root.length === 0) return false;
  await sql`
    UPDATE harness_shared.event_await_nodes
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND root_id = ${input.rootId} AND parent_id IS NOT NULL
       AND fired_at IS NULL AND cancelled_at IS NULL
  `;
  await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND root_id = ${input.rootId}
       AND fired_at IS NULL AND cancelled_at IS NULL
  `;
  return true;
}

/** A root claimed by the timeout sweep (fired_at already stamped by the claim). */
export interface DueComposedRoot {
  id: number;
  rootId: number;
  subscriberId: string;
  spec: unknown | null;
  timeoutBehavior: TimeoutBehavior;
}

/**
 * Sweep half (composed): atomically claim every ROOT past its deadline (fired_at guard ⇒ each
 * claimed once, even across concurrent sweep ticks — same idempotence as fireTimedOutAwaits).
 * The engine then, per root, delivers a partial-state timeout wake ('wake') or lapses silently
 * ('expire'), and voids the tree. Only ROOTS carry a deadline (interior nodes have NULL expires_ts).
 */
export async function claimDueComposedRoots(): Promise<DueComposedRoot[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_await_nodes
       SET fired_at = now()
     WHERE workspace_id = ${ws} AND parent_id IS NULL
       AND expires_ts IS NOT NULL AND expires_ts <= now()
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id, root_id, subscriber_id, spec, timeout_behavior
  `;
  return rows.map((r: any) => ({
    id: Number(r.id),
    rootId: Number(r.root_id),
    subscriberId: r.subscriber_id,
    spec: parseJsonb(r.spec),
    timeoutBehavior: r.timeout_behavior,
  }));
}

/** Active composed roots for a subscriber (events:status tree render, P-004). */
export async function listActiveComposedRoots(subscriberId: string): Promise<ComposedNodeRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_await_nodes
     WHERE workspace_id = ${ws} AND subscriber_id = ${subscriberId} AND parent_id IS NULL
       AND fired_at IS NULL AND cancelled_at IS NULL
     ORDER BY created_at DESC
     LIMIT 100
  `;
  return rows.map(mapNode);
}
