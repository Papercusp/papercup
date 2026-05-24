/**
 * ensure-schema-dogfood — runtime DDL for the tables introduced by
 * `apps/operator/docs/plans/papercusp-dogfood-v5-2026-05-23.md` §7.1 / §7.8.
 *
 * Sibling to `ensure-schema.ts` (the original monolithic ensure file).
 * Split here so:
 *   - Diff-review of the dogfood schema is bounded
 *   - Whole-file delete is clean if the plan changes shape
 *   - No risk of mass-edit hazards in the 1860-line original
 *
 * Same pattern as the original:
 *   - flags pinned to globalThis under their own key
 *   - each ensureXxx fn is idempotent CREATE TABLE IF NOT EXISTS
 *   - only `harness_shared.*` is creatable at runtime (runtime roles
 *     have CREATE on that schema, not on per-harness schemas).
 *
 * Buckets per v5 §7 (sync behavior, NOT PG schema): all of these live in
 * `harness_shared` regardless of HYPERBEE / LOCAL classification — the
 * bucket name only governs which projection / non-projection wiring fires
 * downstream.
 */

import { getOrgPg } from '@restart/db-org';

type DogfoodFlags = {
  featureQueue: boolean;
  contributors: boolean;
  featureClaims: boolean;
  prReviewerSettings: boolean;
  prCheckStatusCache: boolean;
  knownSchemaVersions: boolean;
  autoReviewAudit: boolean;
  claimAudit: boolean;
  webhookAudit: boolean;
  trustedAuthors: boolean;
};

type _G = { __dogfoodEnsureFlags?: DogfoodFlags };
const _g = globalThis as unknown as _G;
const flags: DogfoodFlags =
  _g.__dogfoodEnsureFlags ??
  (_g.__dogfoodEnsureFlags = {
    featureQueue: false,
    contributors: false,
    featureClaims: false,
    prReviewerSettings: false,
    prCheckStatusCache: false,
    knownSchemaVersions: false,
    autoReviewAudit: false,
    claimAudit: false,
    webhookAudit: false,
    trustedAuthors: false,
  });

/* ─── HYPERBEE-bucket (v5 §7.1) ───────────────────────────────────── */

/** harness_shared.feature_queue — pointer table per (user, feature).
 *  HYPERBEE-synced (per §7.1). One row per queue entry. */
export async function ensureFeatureQueueTable(): Promise<void> {
  if (flags.featureQueue) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.feature_queue (
      workspace_id   TEXT   NOT NULL DEFAULT '',
      harness_slug   TEXT   NOT NULL,
      github_user_id BIGINT NOT NULL,
      feature_id     TEXT   NOT NULL,
      queued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      removed_at     TIMESTAMPTZ,
      schema_version BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, harness_slug, github_user_id, feature_id)
    );
    CREATE INDEX IF NOT EXISTS feature_queue_feature_idx
      ON harness_shared.feature_queue (workspace_id, harness_slug, feature_id);
    CREATE INDEX IF NOT EXISTS feature_queue_user_idx
      ON harness_shared.feature_queue (workspace_id, harness_slug, github_user_id)
      WHERE removed_at IS NULL;
  `);
  flags.featureQueue = true;
}

/** harness_shared.contributors — human identity per shared harness, with
 *  device attestation list + revocation set. HYPERBEE-synced (per §7.1).
 *  Keyed by stable numeric github_user_id, NOT username (D-010). */
export async function ensureContributorsTable(): Promise<void> {
  if (flags.contributors) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.contributors (
      workspace_id        TEXT   NOT NULL DEFAULT '',
      harness_slug        TEXT   NOT NULL,
      github_user_id      BIGINT NOT NULL,
      github_username     TEXT   NOT NULL,
      display_name        TEXT,
      avatar_url          TEXT,
      device_attestations JSONB  NOT NULL DEFAULT '[]'::jsonb,
      revoked_pubkeys     TEXT[] NOT NULL DEFAULT '{}',
      joined_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at        TIMESTAMPTZ,
      schema_version      BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, harness_slug, github_user_id)
    );
    CREATE INDEX IF NOT EXISTS contributors_username_idx
      ON harness_shared.contributors (workspace_id, harness_slug, github_username);
  `);
  flags.contributors = true;
}

/** harness_shared.feature_claims — orchestrator claim audit (mirror of
 *  the Autobase-only feature_claims log). HYPERBEE-synced for diagnostics;
 *  the authoritative store is the Autobase log itself (per §0.6).
 *  Append-only. */
export async function ensureFeatureClaimsTable(): Promise<void> {
  if (flags.featureClaims) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.feature_claims (
      workspace_id           TEXT   NOT NULL DEFAULT '',
      harness_slug           TEXT   NOT NULL,
      feature_id             TEXT   NOT NULL,
      seq                    BIGINT NOT NULL,
      claimer_pubkey         TEXT   NOT NULL,
      claimer_github_user_id BIGINT NOT NULL,
      claimed_at             TIMESTAMPTZ NOT NULL,
      outcome                TEXT,
      schema_version         BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, harness_slug, feature_id, seq)
    );
    CREATE INDEX IF NOT EXISTS feature_claims_outcome_idx
      ON harness_shared.feature_claims (workspace_id, harness_slug, feature_id, outcome);
  `);
  flags.featureClaims = true;
}

/* ─── SECURITY-bucket (v5 §7.5) ───────────────────────────────────── */

/** harness_shared.pr_reviewer_settings — per-reviewer config.
 *  LOCAL only, NEVER synced (per §7.5). Identity = github_user_id (D-003). */
export async function ensurePrReviewerSettingsTable(): Promise<void> {
  if (flags.prReviewerSettings) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.pr_reviewer_settings (
      workspace_id              TEXT   NOT NULL DEFAULT '',
      harness_slug              TEXT   NOT NULL,
      github_user_id            BIGINT NOT NULL,
      pr_reviewer_role_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
      auto_review               BOOLEAN NOT NULL DEFAULT FALSE,
      auto_merge                BOOLEAN NOT NULL DEFAULT FALSE,
      merge_method              TEXT   NOT NULL DEFAULT 'squash'
        CHECK (merge_method IN ('squash','merge','rebase')),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, github_user_id)
    );
  `);
  flags.prReviewerSettings = true;
}

/** harness_shared.trusted_authors — per-reviewer trust list.
 *  LOCAL only, NEVER synced (§7.5 + §15.3). Trust keyed by trusted
 *  github_user_id (the human, not the device). No "trust anyone" toggle
 *  (D-014); every row is a deliberate gesture. */
export async function ensureTrustedAuthorsTable(): Promise<void> {
  if (flags.trustedAuthors) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.trusted_authors (
      workspace_id              TEXT   NOT NULL DEFAULT '',
      harness_slug              TEXT   NOT NULL,
      trusted_github_user_id    BIGINT NOT NULL,
      trusted_by_github_user_id BIGINT NOT NULL,
      trusted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, trusted_github_user_id)
    );
    CREATE INDEX IF NOT EXISTS trusted_authors_by_idx
      ON harness_shared.trusted_authors (workspace_id, harness_slug, trusted_by_github_user_id);
  `);
  flags.trustedAuthors = true;
}

/* ─── LOCAL-bucket (v5 §7.4) ──────────────────────────────────────── */

/** harness_shared.pr_check_status_cache — per-engineer cache of GitHub
 *  check-run details fetched on click (§7.4). LOCAL-only by design;
 *  populated lazily on user expand of a PR's checks panel. */
export async function ensurePrCheckStatusCacheTable(): Promise<void> {
  if (flags.prCheckStatusCache) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.pr_check_status_cache (
      workspace_id TEXT   NOT NULL DEFAULT '',
      harness_slug TEXT   NOT NULL,
      head_sha     TEXT   NOT NULL,
      check_name   TEXT   NOT NULL,
      status       TEXT   NOT NULL,
      conclusion   TEXT,
      details_url  TEXT,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      raw          JSONB,
      PRIMARY KEY (workspace_id, harness_slug, head_sha, check_name)
    );
    CREATE INDEX IF NOT EXISTS pr_check_status_cache_sha_idx
      ON harness_shared.pr_check_status_cache (workspace_id, harness_slug, head_sha);
  `);
  flags.prCheckStatusCache = true;
}

/** harness_shared.known_schema_versions — per-engineer Hyperbee schema
 *  version tracking (D-024). Each Autobase op carries a schema_version;
 *  this table records the max known version per harness, driving the
 *  "newer Papercusp in use" toast on receipt of newer-than-known ops. */
export async function ensureKnownSchemaVersionsTable(): Promise<void> {
  if (flags.knownSchemaVersions) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.known_schema_versions (
      workspace_id      TEXT   NOT NULL DEFAULT '',
      harness_slug      TEXT   NOT NULL,
      max_known_version BIGINT NOT NULL DEFAULT 1,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug)
    );
  `);
  flags.knownSchemaVersions = true;
}

/** harness_shared.auto_review_audit — per-engineer log of auto-approve /
 *  auto-merge actions (§7.4 + §8.2 / §8.3). One row per Octokit action. */
export async function ensureAutoReviewAuditTable(): Promise<void> {
  if (flags.autoReviewAudit) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.auto_review_audit (
      workspace_id      TEXT   NOT NULL DEFAULT '',
      id                BIGSERIAL,
      harness_slug      TEXT   NOT NULL,
      pr_number         INTEGER NOT NULL,
      pr_url            TEXT,
      author_github_id  BIGINT,
      reviewer_github_id BIGINT NOT NULL,
      action            TEXT   NOT NULL
        CHECK (action IN ('auto_approve','auto_merge','manual_approve','manual_merge','skipped_untrusted','skipped_checks_failing','error')),
      detail            TEXT,
      ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS auto_review_audit_pr_idx
      ON harness_shared.auto_review_audit (workspace_id, harness_slug, pr_number, ts DESC);
  `);
  flags.autoReviewAudit = true;
}

/** harness_shared.claim_audit — per-engineer log of orchestrator claim
 *  attempts (§7.4 + §0.6). Diagnostics for "did this peer win/lose the
 *  claim race, why." */
export async function ensureClaimAuditTable(): Promise<void> {
  if (flags.claimAudit) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.claim_audit (
      workspace_id   TEXT   NOT NULL DEFAULT '',
      id             BIGSERIAL,
      harness_slug   TEXT   NOT NULL,
      feature_id     TEXT   NOT NULL,
      claimer_pubkey TEXT   NOT NULL,
      attempt_ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
      outcome        TEXT   NOT NULL
        CHECK (outcome IN ('won','lost','timeout','error')),
      detail         TEXT,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS claim_audit_feature_idx
      ON harness_shared.claim_audit (workspace_id, harness_slug, feature_id, attempt_ts DESC);
  `);
  flags.claimAudit = true;
}

/** harness_shared.webhook_audit — outbound webhook post log (§11 Discord
 *  integration). LOCAL-only; per-engineer. */
export async function ensureWebhookAuditTable(): Promise<void> {
  if (flags.webhookAudit) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.webhook_audit (
      workspace_id  TEXT   NOT NULL DEFAULT '',
      id            BIGSERIAL,
      harness_slug  TEXT   NOT NULL,
      target_url    TEXT   NOT NULL,
      event_kind    TEXT   NOT NULL,
      payload       JSONB,
      status_code   INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      error         TEXT,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS webhook_audit_recent_idx
      ON harness_shared.webhook_audit (workspace_id, harness_slug, sent_at DESC);
  `);
  flags.webhookAudit = true;
}

/* ─── batch helper ───────────────────────────────────────────────── */

/** Run all dogfood ensures in parallel. Cheap if flags are already set
 *  (each guard short-circuits). Intended for use by the Hyperbee
 *  projection process at boot, BEFORE replication starts, to satisfy
 *  the audit-A rule from v5 §7 (projection must wait for both
 *  ensure-paths — the original ensure-schema.ts AND this one). */
export async function ensureAllDogfoodTables(): Promise<void> {
  await Promise.all([
    ensureFeatureQueueTable(),
    ensureContributorsTable(),
    ensureFeatureClaimsTable(),
    ensurePrReviewerSettingsTable(),
    ensurePrCheckStatusCacheTable(),
    ensureKnownSchemaVersionsTable(),
    ensureAutoReviewAuditTable(),
    ensureClaimAuditTable(),
    ensureWebhookAuditTable(),
    ensureTrustedAuthorsTable(),
  ]);
}
