/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: apps/operator-public/migrations/*.sql applied in filename order
 * Migration digest: 084a825184e0e1ecdf3cf269e34c619f17506f1ef7c699eda6ef56e85fc143b1
 * Regenerate with: npm run db:types:generate --workspace @papercusp/cupboard-worker
 */

export const GENERATED_MIGRATION_DIGEST =
  "084a825184e0e1ecdf3cf269e34c619f17506f1ef7c699eda6ef56e85fc143b1";
export const GENERATED_TABLES = [
  "audit",
  "banned_publisher_pubkeys",
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
