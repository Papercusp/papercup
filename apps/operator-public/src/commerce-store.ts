/**
 * D1 persistence for the provider-neutral commerce ledger (shared-pot DAO plan P-010).
 *
 * The pure logic lives in `@papercusp/operator-core/lib/cupboard/*` and is shared
 * verbatim with the operator: this file is ONLY the storage seam those modules
 * declare (`WebhookInboxStore`) plus the append-only event log and the projection
 * the read path serves. Nothing here re-implements a ledger rule — a second copy
 * of the refund/entitlement invariants living in a Worker is exactly the drift
 * this seam exists to prevent.
 *
 * Shape: `commerce_ledger_events` is the source of truth (append-only), and the
 * entity tables are a PROJECTION rebuilt by folding it through `reduceLedger`.
 * That keeps the reducer the single authority on what an entitlement means, and
 * makes the projection reconstructible from the log after any bug fix.
 */

import {
  reduceLedger,
  serializeLedgerState,
  type LedgerEvent,
} from '@papercusp/operator-core/lib/cupboard/commerce-ledger';
import type {
  WebhookInboxRecord,
  WebhookInboxStore,
} from '@papercusp/operator-core/lib/cupboard/webhook-inbox';
import type { Organization } from '@papercusp/operator-core/lib/cupboard/commerce-accounts';

/** The `WebhookInboxStore` the pure `ingestWebhook` asks for, backed by D1.
 *  Idempotency is enforced by the table's UNIQUE(provider, provider_event_id). */
export function d1WebhookInboxStore(db: D1Database): WebhookInboxStore {
  return {
    async get(provider: string, providerEventId: string): Promise<WebhookInboxRecord | null> {
      const row = await db
        .prepare(
          'SELECT provider, provider_event_id, provider_event_type, body_digest, received_at_ms, outcome, rejection_code, ledger_event_ids_json FROM commerce_webhook_inbox WHERE provider = ? AND provider_event_id = ?',
        )
        .bind(provider, providerEventId)
        .first<Record<string, unknown>>();
      if (!row) return null;
      return {
        provider: String(row.provider),
        providerEventId: String(row.provider_event_id),
        providerEventType: row.provider_event_type == null ? null : String(row.provider_event_type),
        bodyDigest: String(row.body_digest),
        receivedAtMs: Number(row.received_at_ms),
        outcome: String(row.outcome) as WebhookInboxRecord['outcome'],
        rejectionCode: row.rejection_code == null ? null : String(row.rejection_code),
        ledgerEventIds: parseIds(row.ledger_event_ids_json),
      };
    },
    async put(record: WebhookInboxRecord): Promise<void> {
      await db
        .prepare(
          'INSERT INTO commerce_webhook_inbox (provider, provider_event_id, provider_event_type, body_digest, received_at_ms, outcome, rejection_code, ledger_event_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider, provider_event_id) DO NOTHING',
        )
        .bind(
          record.provider,
          record.providerEventId,
          record.providerEventType,
          record.bodyDigest,
          record.receivedAtMs,
          record.outcome,
          record.rejectionCode,
          JSON.stringify(record.ledgerEventIds),
        )
        .run();
    },
  };
}

function parseIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Append accepted ledger events. `ledger_event_id` is the primary key, so a
 *  replay that slipped past the inbox is still idempotent at the log. */
export async function appendLedgerEvents(db: D1Database, events: readonly LedgerEvent[]): Promise<void> {
  for (const event of events) {
    await db
      .prepare(
        'INSERT INTO commerce_ledger_events (ledger_event_id, kind, occurred_at_ms, provider, provider_event_id, payload_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (ledger_event_id) DO NOTHING',
      )
      .bind(
        event.ledgerEventId,
        event.kind,
        event.occurredAtMs,
        event.source.provider,
        event.source.providerEventId,
        JSON.stringify(event.payload),
      )
      .run();
  }
}

export async function loadLedgerEvents(db: D1Database): Promise<LedgerEvent[]> {
  const { results } = await db
    .prepare(
      'SELECT ledger_event_id, kind, occurred_at_ms, provider, provider_event_id, payload_json FROM commerce_ledger_events ORDER BY occurred_at_ms ASC, ledger_event_id ASC',
    )
    .all<Record<string, unknown>>();
  return (results ?? []).map((row) => ({
    ledgerEventId: String(row.ledger_event_id),
    kind: String(row.kind) as LedgerEvent['kind'],
    occurredAtMs: Number(row.occurred_at_ms),
    source: {
      provider: String(row.provider),
      providerEventId: row.provider_event_id == null ? null : String(row.provider_event_id),
    },
    payload: parsePayload(row.payload_json),
  }));
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Rebuild the projection tables by folding the whole event log through the
 * shared reducer. Deliberately a full rebuild rather than an incremental patch:
 * the log is small, and it means a reducer fix (as landed for the pending-refund
 * reservation, EI-22438759043480870) is picked up on the next delivery instead
 * of leaving a wrong projection behind forever.
 */
export async function projectLedger(db: D1Database): Promise<void> {
  const state = reduceLedger(await loadLedgerEvents(db));
  const s = serializeLedgerState(state);
  const stmts: D1PreparedStatement[] = [];

  for (const p of s.products) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO commerce_products (product_id, sku_ref, creator_id, title, active) VALUES (?, ?, ?, ?, ?) ON CONFLICT (product_id) DO UPDATE SET sku_ref = excluded.sku_ref, creator_id = excluded.creator_id, title = excluded.title, active = excluded.active',
        )
        .bind(p.productId, p.skuRef, p.creatorId, p.title, p.active ? 1 : 0),
    );
  }
  for (const o of s.offers) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO commerce_offers (offer_id, product_id, pricing_model, amount_minor, currency, active) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (offer_id) DO UPDATE SET product_id = excluded.product_id, pricing_model = excluded.pricing_model, amount_minor = excluded.amount_minor, currency = excluded.currency, active = excluded.active',
        )
        .bind(o.offerId, o.productId, o.pricingModel, o.price.amountMinor, o.price.currency, o.active ? 1 : 0),
    );
  }
  for (const o of s.orders) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO commerce_orders (order_id, offer_id, product_id, buyer_id, amount_minor, currency, state, provider, provider_ref, refunded_minor, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (order_id) DO UPDATE SET state = excluded.state, provider = excluded.provider, provider_ref = excluded.provider_ref, refunded_minor = excluded.refunded_minor, updated_at_ms = excluded.updated_at_ms',
        )
        .bind(
          o.orderId, o.offerId, o.productId, o.buyerId, o.amount.amountMinor, o.amount.currency,
          o.state, o.provider, o.providerRef, o.refundedMinor, o.createdAtMs, o.updatedAtMs,
        ),
    );
  }
  for (const e of s.entitlements) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO commerce_entitlements (entitlement_id, order_id, product_id, buyer_id, state, granted_at_ms, revoked_at_ms, revoke_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (entitlement_id) DO UPDATE SET state = excluded.state, revoked_at_ms = excluded.revoked_at_ms, revoke_reason = excluded.revoke_reason',
        )
        .bind(e.entitlementId, e.orderId, e.productId, e.buyerId, e.state, e.grantedAtMs, e.revokedAtMs, e.revokeReason),
    );
  }
  for (const r of s.refunds) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO commerce_refunds (refund_id, order_id, amount_minor, currency, state, provider, provider_ref, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (refund_id) DO UPDATE SET state = excluded.state, amount_minor = excluded.amount_minor, currency = excluded.currency, provider_ref = excluded.provider_ref, updated_at_ms = excluded.updated_at_ms',
        )
        .bind(r.refundId, r.orderId, r.amount.amountMinor, r.amount.currency, r.state, r.provider, r.providerRef, r.createdAtMs, r.updatedAtMs),
    );
  }
  for (const p of s.payouts) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO commerce_payouts (payout_id, creator_id, amount_minor, currency, state, provider, provider_ref, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (payout_id) DO UPDATE SET state = excluded.state, provider_ref = excluded.provider_ref, updated_at_ms = excluded.updated_at_ms',
        )
        .bind(p.payoutId, p.creatorId, p.amount.amountMinor, p.amount.currency, p.state, p.provider, p.providerRef, p.createdAtMs, p.updatedAtMs),
    );
  }
  for (const stmt of stmts) await stmt.run();
}

export interface EntitlementView {
  entitlement_id: string;
  order_id: string;
  product_id: string;
  buyer_id: string;
  state: string;
  granted_at_ms: number;
  revoked_at_ms: number | null;
  revoke_reason: string | null;
}

/**
 * The organizations this deployment knows, for the checkout door's actor check.
 *
 * Deliberately EMPTY, and deliberately a function rather than a constant. There
 * is no org writer anywhere yet (`commerce-door-gate-io.loadCommerceState` says
 * the same thing for the desktop half, and hardcodes the same empty map), and
 * the money ledger has no `org.created`/`member.added` kinds to fold — P-010's
 * `LEDGER_EVENT_KINDS` covers orders, refunds and payouts only, and widening it
 * with identity would put membership inside the reducer that D-043 reserves for
 * money.
 *
 * Returning an empty map is therefore the honest answer, not a stub: with no
 * organizations, `authorizeOrgActor` refuses every org-named checkout
 * (`unknown-org`) and only a self-purchase can proceed. Synthesising rows here
 * would make org purchases look authorized when nothing has ever verified a
 * membership. When an org writer lands, this function is the only thing that
 * changes.
 */
export async function loadOrganizations(_db: D1Database): Promise<ReadonlyMap<string, Organization>> {
  return new Map<string, Organization>();
}

/** The P-009 delivery gate's read: which products may this buyer receive? */
export async function listActiveEntitlements(db: D1Database, buyerId: string): Promise<EntitlementView[]> {
  const { results } = await db
    .prepare(
      "SELECT entitlement_id, order_id, product_id, buyer_id, state, granted_at_ms, revoked_at_ms, revoke_reason FROM commerce_entitlements WHERE buyer_id = ? AND state = 'active' ORDER BY granted_at_ms ASC",
    )
    .bind(buyerId)
    .all<EntitlementView>();
  return results ?? [];
}
