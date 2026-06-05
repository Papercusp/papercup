/**
 * fanout-projection — the LOCAL subscribe→inject fan-out, run as a consumer on
 * the EXISTING substrate_outbox drain (coordination-substrate-2026-06-03,
 * Phase 2). The drain already appends each captured change to the device's
 * Hypercore log for federation; this runs ALONGSIDE that (same drain, same row,
 * not a second consumer) to ALSO resolve the changed object's subscribers and
 * inject a notice into each subscriber's inbox.
 *
 * Source of truth: `substrate_outbox`. A change to a subscribable object
 * (feature / issue / plan / … — whatever has a capture trigger) lands one row;
 * `runFanoutForOutboxRow` maps it to an {kind, ref} ObjectRef via the registry
 * below, resolves direct + topic subscribers (capabilities/resolveObjectSubscribers),
 * and delivers per delivery_mode (full | digest | mention — D-006). Tables not in
 * the registry (claims, presence, usage, …) are a no-op.
 *
 * AT-LEAST-ONCE: the drain re-runs a row whose processing failed before it was
 * marked drained, so delivery is idempotent — each notify has a DETERMINISTIC
 * msg_id (`fan-<outbox_id>-<subscriber>`) inserted ON CONFLICT DO NOTHING against
 * the partial unique index (migration 126), so a redrain is a no-op not a dup.
 *
 * Federation registration of NEW objects (plans, conversations, engineer-issues)
 * is the companion plans' job (op-keys + a projection module). This file only
 * needs the table→ObjectRef MAPPING — companions call registerSubscribableTable
 * for their object so its changes fan out, without touching this file.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  PgEntitySubscriptionStore,
  PgTaggableStore,
  PgTopicStore,
  resolveObjectSubscribers,
  type ObjectRef,
  type ResolvedSubscriber,
} from '@papercusp/coordination/capabilities';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { buildInjectEnvelope, shouldDeliver, type InjectEvent, type InjectSink } from '../../agent-tools/coordination/fanout-delivery';

type OutboxOp = 'put' | 'del';

/** How to turn a captured change to one table into a subscribable-object notice. */
export interface SubscribableMapping {
  /** ObjectRef.kind for this object (e.g. 'feature'). */
  kind: string;
  /** ObjectRef.ref from the outbox row's key (the capture key column) + jsonb row. */
  ref: (key: string, row: Record<string, unknown> | null) => string;
  /** One-line notice summary. */
  summary: (op: OutboxOp, row: Record<string, unknown> | null, ref: string) => string;
  /** notify_kind sub-type for rendering. */
  notifyKind: (op: OutboxOp) => string;
  /** True if this change is a lifecycle resolution (mention-mode also receives these). */
  isResolution?: (op: OutboxOp, row: Record<string, unknown> | null) => boolean;
}

const SUBSCRIBABLE_TABLES = new Map<string, SubscribableMapping>();

/** Register a table whose captured changes fan out to subscribers of the mapped
 *  object. Companions call this for their domain object (idempotent — last wins). */
export function registerSubscribableTable(tableName: string, mapping: SubscribableMapping): void {
  SUBSCRIBABLE_TABLES.set(tableName, mapping);
}

export function getSubscribableMapping(tableName: string): SubscribableMapping | undefined {
  return SUBSCRIBABLE_TABLES.get(tableName);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ── Seed the pipeline objects that already federate (capture triggers exist /
//    are coming via the companion plans). Plans flow once mig 124/125 land. ──

registerSubscribableTable('harness_features_consolidated', {
  kind: 'feature',
  ref: (key) => key, // capture key = feature_id
  summary: (op, row, ref) =>
    op === 'del' ? `feature ${ref} removed` : `feature ${ref}${row?.status ? ` → ${str(row.status)}` : ''}${row?.title ? `: ${str(row.title)}` : ''}`,
  notifyKind: (op) => (op === 'del' ? 'feature_removed' : 'feature_updated'),
  isResolution: (op, row) => op !== 'del' && ['passed', 'deprecated'].includes(str(row?.status)),
});

registerSubscribableTable('harness_issues_consolidated', {
  kind: 'issue',
  ref: (key) => key, // capture key = issue_id
  summary: (op, row, ref) =>
    op === 'del' ? `issue ${ref} removed` : `issue ${ref}${row?.status ? ` → ${str(row.status)}` : ''}${row?.title ? `: ${str(row.title)}` : ''}`,
  notifyKind: (op) => (op === 'del' ? 'issue_removed' : 'issue_updated'),
  isResolution: (op, row) => op !== 'del' && ['resolved', 'closed'].includes(str(row?.status)),
});

registerSubscribableTable('harness_plans', {
  kind: 'plan',
  ref: (key) => key, // capture key = plan_slug (su-fcb0d confirmed)
  summary: (op, row, ref) =>
    op === 'del' ? `plan ${ref} removed` : `plan ${ref}${row?.status ? ` → ${str(row.status)}` : ''}${row?.title ? `: ${str(row.title)}` : ''}`,
  notifyKind: (op) => (op === 'del' ? 'plan_removed' : 'plan_updated'),
  isResolution: (op, row) => op !== 'del' && str(row?.status) === 'shipped',
});

// ── The runner ──────────────────────────────────────────────────────────────

export interface OutboxFanoutRow {
  id: string | number;
  table_name: string;
  op: OutboxOp;
  key: string;
  row: Record<string, unknown> | null;
}

export interface FanoutDeps {
  /** Resolve direct + topic subscribers of an object (capabilities). */
  resolve: (object: ObjectRef) => Promise<ResolvedSubscriber[]>;
  /** Idempotent delivery of one notify to one subscriber. Returns true if a row
   *  was written (false = deduped redelivery). */
  deliver: (outboxId: string, sub: ResolvedSubscriber, ev: InjectEvent) => Promise<boolean>;
}

/**
 * Fan one substrate_outbox row out to the changed object's subscribers. Returns
 * the count delivered. A table with no mapping (or an empty ref / no subscribers)
 * is a no-op. Pure over injected deps, so it is unit-testable without PG.
 */
export async function runFanoutForOutboxRow(outboxRow: OutboxFanoutRow, deps: FanoutDeps): Promise<number> {
  const mapping = SUBSCRIBABLE_TABLES.get(outboxRow.table_name);
  if (!mapping) return 0;
  const ref = mapping.ref(outboxRow.key, outboxRow.row);
  if (!ref) return 0;

  const object: ObjectRef = { kind: mapping.kind, ref };
  const subscribers = await deps.resolve(object);
  if (subscribers.length === 0) return 0;

  const ev: InjectEvent = {
    from: 'substrate',
    subject: `${mapping.kind}:${ref}`,
    summary: mapping.summary(outboxRow.op, outboxRow.row, ref),
    notify_kind: mapping.notifyKind(outboxRow.op),
    isResolution: mapping.isResolution?.(outboxRow.op, outboxRow.row) ?? false,
  };

  let delivered = 0;
  for (const sub of subscribers) {
    if (!shouldDeliver(sub.delivery_mode, ev, sub.subscriber_id)) continue;
    if (await deps.deliver(String(outboxRow.id), sub, ev)) delivered += 1;
  }
  return delivered;
}

// ── Production wiring (PG singletons over the coord workspace) ────────────────

const coordWs = DEFAULT_COORD_WORKSPACE;
const storeOpts = { getSql: () => getOrgPg().sql, ensureSchema: async () => {}, workspaceId: coordWs };
const subscriptions = new PgEntitySubscriptionStore(storeOpts);
const tags = new PgTaggableStore(storeOpts);
const topics = new PgTopicStore(storeOpts);

/** Idempotent insert of one fan-out notify (deterministic msg_id + ON CONFLICT,
 *  migration 126). Mirrors PgCoordLog.appendLine's row shape so coord:inbox
 *  reads it identically. Exported for the integration test (driven against a
 *  test PG handle). */
export async function insertFanoutNotify(
  pg: Sql,
  outboxId: string,
  sub: ResolvedSubscriber,
  ev: InjectEvent,
): Promise<boolean> {
  const msgId = `fan-${outboxId}-${sub.subscriber_id}`;
  const env = buildInjectEnvelope(sub, ev, msgId);
  const rows = await pg<{ id: string }[]>`
    INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body)
    VALUES (${coordWs}, 'messages', ${sub.subscriber_id}, ${msgId}, ${JSON.stringify(env)}::text::jsonb)
    ON CONFLICT (workspace_id, msg_id) WHERE (surface = 'messages' AND (body ->> 'notify_kind') IS NOT NULL)
    DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/**
 * The production fan-out consumer the drain calls per outbox row. Best-effort at
 * the drain level is NOT used: errors propagate so the drain's at-least-once
 * retry re-runs (idempotent insert makes that safe). Returns count delivered.
 */
export async function fanoutOutboxRow(outboxRow: OutboxFanoutRow): Promise<number> {
  const pg = getOrgPg().sql;
  return runFanoutForOutboxRow(outboxRow, {
    resolve: (object) => resolveObjectSubscribers(object, { subscriptions, tags, topics }),
    deliver: (outboxId, sub, ev) => insertFanoutNotify(pg, outboxId, sub, ev),
  });
}

/**
 * The canonical synchronous fan-out seam for a change that does NOT flow through
 * the substrate_outbox drain — i.e. a LOCAL-only coordination object (conversation,
 * engineer_issue, thread post). Resolves the object's subscribers (direct ∪ the
 * subscribers of every topic it is tagged with — resolveObjectSubscribers) and
 * delivers per delivery_mode, optionally excluding the actor so an agent is never
 * notified of its own action. Uses a wall-clock msg_id (no redelivery → no
 * idempotency needed). Best-effort: a delivery failure cannot break the caller's
 * write.
 *
 * NB: this unions topic-tag subscribers (via resolveObjectSubscribers), so a
 * local object tagged with a topic DOES reach that topic's subscribers — the
 * concern that the local path only reaches direct subscribers is unfounded.
 * Both issues-engineer.ts and conversations-core.ts route through here (A6).
 *
 * `opts.stores` + `opts.sink` let a caller inject the subscriber stores + the
 * delivery sink (both default to the production getOrgPg singletons + coordLog).
 * conversations-core threads its fully-injected `deps` (subs/tags/topics over a
 * throwaway test container + an in-memory sink) so it can route through here
 * without losing the dependency injection its tests rely on (A6).
 */
export async function fanoutForObject(
  object: ObjectRef,
  ev: InjectEvent,
  opts: {
    excludeId?: string;
    sink?: InjectSink;
    stores?: Parameters<typeof resolveObjectSubscribers>[1];
  } = {},
): Promise<number> {
  try {
    const subscribers = (
      await resolveObjectSubscribers(object, opts.stores ?? { subscriptions, tags, topics })
    ).filter((s) => opts.excludeId == null || s.subscriber_id !== opts.excludeId);
    const { deliverInjectMany } = await import('../../agent-tools/coordination/fanout-delivery');
    return await deliverInjectMany(subscribers, ev, opts.sink);
  } catch {
    return 0;
  }
}
