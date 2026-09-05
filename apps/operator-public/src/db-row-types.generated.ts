/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: apps/operator-public/migrations/*.sql applied in filename order
 * Migration digest: f9eaffc468834e8b2b81ae82cde170bd2f2fbde7f36f7e5f37e7bc5f36eaca1f
 * Regenerate with: npm run db:types:generate --workspace @papercusp/cupboard-worker
 */

export const GENERATED_MIGRATION_DIGEST =
  "f9eaffc468834e8b2b81ae82cde170bd2f2fbde7f36f7e5f37e7bc5f36eaca1f";
export const GENERATED_TABLES = [
  "audit",
  "banned_publisher_pubkeys",
  "commerce_entitlements",
  "commerce_ledger_events",
  "commerce_offers",
  "commerce_orders",
  "commerce_payouts",
  "commerce_products",
  "commerce_refunds",
  "commerce_webhook_inbox",
  "creator_drafts",
  "harnesses",
  "indexer_runs",
  "publish_rate_limit",
  "reports",
] as const;

export interface AuditRow {
  id: number;
  ts: number;
  kind: string;
  detail: string | null;
}

export interface BannedPublisherPubkeysRow {
  pubkey: string;
  reason: string;
  added_at: number;
  added_by_operator_user_id: number | null;
  updated_at: number;
}

export interface CommerceEntitlementsRow {
  entitlement_id: string;
  order_id: string;
  product_id: string;
  buyer_id: string;
  state: string;
  granted_at_ms: number;
  revoked_at_ms: number | null;
  revoke_reason: string | null;
}

export interface CommerceLedgerEventsRow {
  ledger_event_id: string;
  kind: string;
  occurred_at_ms: number;
  provider: string;
  provider_event_id: string | null;
  payload_json: string;
}

export interface CommerceOffersRow {
  offer_id: string;
  product_id: string;
  pricing_model: string;
  amount_minor: number;
  currency: string;
  active: number;
}

export interface CommerceOrdersRow {
  order_id: string;
  offer_id: string;
  product_id: string;
  buyer_id: string;
  amount_minor: number;
  currency: string;
  state: string;
  provider: string | null;
  provider_ref: string | null;
  refunded_minor: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommercePayoutsRow {
  payout_id: string;
  creator_id: string;
  amount_minor: number;
  currency: string;
  state: string;
  provider: string | null;
  provider_ref: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommerceProductsRow {
  product_id: string;
  sku_ref: string;
  creator_id: string;
  title: string;
  active: number;
}

export interface CommerceRefundsRow {
  refund_id: string;
  order_id: string;
  amount_minor: number;
  currency: string;
  state: string;
  provider: string | null;
  provider_ref: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommerceWebhookInboxRow {
  provider: string;
  provider_event_id: string;
  provider_event_type: string | null;
  body_digest: string;
  received_at_ms: number;
  outcome: string;
  rejection_code: string | null;
  ledger_event_ids_json: string;
}

export interface CreatorDraftsRow {
  id: string;
  owner_github_user_id: number;
  owner_github_login: string;
  listing_kind: string;
  listing_ref: string | null;
  title: string;
  description: string | null;
  manifest_json: string;
  provenance_json: string;
  state: string;
  artifact_key: string | null;
  artifact_content_hash: string | null;
  artifact_size_bytes: number | null;
  artifact_content_type: string | null;
  upload_token_hash: string | null;
  upload_expires_at: number | null;
  reviewed_at: number | null;
  reviewed_by_github_user_id: number | null;
  review_reason: string | null;
  published_listing_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface HarnessesRow {
  id: string;
  listing_kind: string;
  blueprint_kind: string | null;
  project_ref: string | null;
  listing_ref: string | null;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title: string;
  description: string | null;
  topic_hex: string | null;
  publisher_github_user_id: number;
  publisher_github_login: string;
  publisher_permission: string | null;
  publisher_device_pubkey: string | null;
  publisher_attestation_gist_id: string | null;
  claim_status: string;
  claimant_github_user_id: number | null;
  claimant_github_login: string | null;
  superseded_by: string | null;
  stars: number;
  contributor_count: number;
  last_activity_at: number | null;
  languages: string | null;
  stats_refreshed_at: number | null;
  created_at: number;
  updated_at: number;
  unlisted_at: number | null;
  unlisted_reason: string | null;
  tarball_r2_key: string | null;
  tarball_content_hash: string | null;
  tarball_bytes: number | null;
  provides_tools: string | null;
  hive_pubkey: string | null;
  hive_title: string | null;
  review_status: string;
  reviewed_at: number | null;
  review_reason: string | null;
  provides_events: string | null;
  requires_events: string | null;
  delivery_type: string | null;
  latest_json_url: string | null;
  release_repo: string | null;
  icon_url: string | null;
  platforms: string | null;
  requires_rubrics: string | null;
  visibility: string;
  tenant_id: string | null;
  sku_ref: string | null;
  pricing_model: string | null;
  price_amount_micros: number | null;
  price_currency: string | null;
  compatibility_json: string | null;
  required_permissions: string | null;
  release_version: string | null;
  release_content_hash: string | null;
  release_manifest_digest: string | null;
  release_signature: string | null;
  release_published_at: number | null;
  yanked_at: number | null;
  yanked_reason: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface IndexerRunsRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  harnesses_examined: number;
  harnesses_updated: number;
  errors_count: number;
  error_summary: string | null;
}

export interface PublishRateLimitRow {
  github_user_id: number;
  window_start: number;
  count: number;
}

export interface ReportsRow {
  id: string;
  harness_id: string;
  reporter_github_user_id: number;
  reporter_github_login: string;
  reason: string;
  ip_hash: string | null;
  status: string;
  resolved_at: number | null;
  resolved_by_operator_note: string | null;
  created_at: number;
}
