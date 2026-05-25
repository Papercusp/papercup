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
  contributorUsageEvents: boolean;
  insightsFirstVisit: boolean;
  sharedRepoBindingCache: boolean;
  sharedPresence: boolean;
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
    contributorUsageEvents: false,
    insightsFirstVisit: false,
    sharedRepoBindingCache: false,
    sharedPresence: false,
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
    -- P-075: two-channel binding status columns (addendum 3 §7.1)
    ALTER TABLE harness_shared.contributors
      ADD COLUMN IF NOT EXISTS binding_status       TEXT NOT NULL DEFAULT 'unverified',
      ADD COLUMN IF NOT EXISTS channel1_verified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS channel2_verified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS channel2_branch_ref  TEXT,
      ADD COLUMN IF NOT EXISTS binding_last_checked_at TIMESTAMPTZ;
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

/** harness_shared.contributor_usage_events — append-only per-event
 *  activity ledger (v5 addendum 3 §7.1, D-027). Source of truth for
 *  all tier-C activity stats; rollups derived on read. Never store
 *  mutable counters on `contributors`. HYPERBEE-synced. */
export async function ensureContributorUsageEventsTable(): Promise<void> {
  if (flags.contributorUsageEvents) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.contributor_usage_events (
      harness_slug    TEXT NOT NULL,
      event_id        TEXT NOT NULL,
      github_user_id  BIGINT NOT NULL,
      device_pubkey   TEXT NOT NULL,
      kind            TEXT NOT NULL,
      ref_id          TEXT,
      payload         JSONB,
      ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
      schema_version  BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (harness_slug, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_user
      ON harness_shared.contributor_usage_events (harness_slug, github_user_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_kind
      ON harness_shared.contributor_usage_events (harness_slug, kind, ts DESC);
  `);
  flags.contributorUsageEvents = true;
}

/** harness_shared.insights_first_visit — per-(workspace, harness) flag
 *  driving the §9.0 post-install default landing. Null seen_at_ts means
 *  the operator force-routes new contributors to /harness/<slug>/insights
 *  on next nav; set to now() on first dismissal. LOCAL bucket — never
 *  cross-machines (each user dismisses for themselves). */
export async function ensureInsightsFirstVisitTable(): Promise<void> {
  if (flags.insightsFirstVisit) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.insights_first_visit (
      workspace_id  TEXT   NOT NULL DEFAULT '',
      harness_slug  TEXT   NOT NULL,
      user_id       TEXT   NOT NULL,
      seen_at_ts    TIMESTAMPTZ,
      PRIMARY KEY (workspace_id, harness_slug, user_id)
    );
  `);
  flags.insightsFirstVisit = true;
}

/** harness_shared.shared_repo_binding_cache — per-engineer cache of
 *  canonical-binding lookups from the binding service (v5 §5.1 +
 *  papercusp-dogfood-phase1a §P-013a). LOCAL-only by design — each
 *  engineer's operator does its own GitHub resolves + caches the result
 *  for 24h. Closes Phase 1a's outstanding schema gap; the eventual
 *  Phase 1b P-068 binding-service implementation consumes this cache.
 *
 *  Column shape mirrors `BindingRecord` from
 *  `apps/operator/lib/harness/binding-types.ts` (commit f05997aa)
 *  verbatim. Primary key `(provider, github_repository_id)` per
 *  memo D-B — owner/name renames, numeric ids don't. */
export async function ensureSharedRepoBindingCacheTable(): Promise<void> {
  if (flags.sharedRepoBindingCache) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.shared_repo_binding_cache (
      workspace_id                     TEXT   NOT NULL DEFAULT '',
      provider                         TEXT   NOT NULL DEFAULT 'github'
        CHECK (provider IN ('github')),
      github_repository_id             BIGINT NOT NULL,
      github_full_name                 TEXT   NOT NULL,
      harness_topic                    TEXT   NOT NULL,
      harness_slug                     TEXT   NOT NULL,
      harness_link                     TEXT   NOT NULL,
      privacy                          TEXT   NOT NULL
        CHECK (privacy IN ('shared-private','shared-public')),
      claim_status                     TEXT   NOT NULL DEFAULT 'unclaimed'
        CHECK (claim_status IN ('unclaimed','claimed','stale','superseded')),
      provisional_owner_github_user_id BIGINT NOT NULL,
      claimed_by_github_user_ids       BIGINT[] NOT NULL DEFAULT '{}',
      created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at                       TIMESTAMPTZ,
      last_permission_verified_at      TIMESTAMPTZ,
      superseded_by_harness_topic      TEXT,
      cached_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, provider, github_repository_id)
    );
    CREATE INDEX IF NOT EXISTS srbc_by_full_name_idx
      ON harness_shared.shared_repo_binding_cache (workspace_id, github_full_name);
    CREATE INDEX IF NOT EXISTS srbc_by_harness_topic_idx
      ON harness_shared.shared_repo_binding_cache (workspace_id, harness_topic);
    CREATE INDEX IF NOT EXISTS srbc_stale_cache_idx
      ON harness_shared.shared_repo_binding_cache (workspace_id, cached_at)
      WHERE claim_status IN ('unclaimed','claimed');
  `);
  flags.sharedRepoBindingCache = true;
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
/** harness_shared.shared_presence — per-(harness, contributor, machine)
 *  presence pings. HYPERBEE-synced (v5 §7.1 `presence/<github_user_id>/<machine_label>`).
 *  Distinct from the operator-internal coord_presence table (which is
 *  per-owner_id, not per-user/machine, and serves the agent-mcp
 *  presence dashboard). LWW per (harness, user, machine). */
export async function ensureSharedPresenceTable(): Promise<void> {
  if (flags.sharedPresence) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.shared_presence (
      workspace_id     TEXT   NOT NULL DEFAULT '',
      harness_slug     TEXT   NOT NULL,
      github_user_id   BIGINT NOT NULL,
      machine_label    TEXT   NOT NULL,
      device_pubkey    TEXT   NOT NULL,
      intent           TEXT,
      current_view     TEXT,
      last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      schema_version   BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
    );
    CREATE INDEX IF NOT EXISTS shared_presence_user_idx
      ON harness_shared.shared_presence (workspace_id, harness_slug, github_user_id);
    CREATE INDEX IF NOT EXISTS shared_presence_recent_idx
      ON harness_shared.shared_presence (workspace_id, harness_slug, last_seen_at DESC);
  `);
  flags.sharedPresence = true;
}

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
    ensureContributorUsageEventsTable(),
    ensureInsightsFirstVisitTable(),
    ensureSharedRepoBindingCacheTable(),
    ensureSharedPresenceTable(),
  ]);
}

/* ─── P-019: reactivity trigger wiring ────────────────────────────── */

/**
 * Tables that should fire `harness_shared.emit_change_notify()` on every
 * INSERT / UPDATE / DELETE. Producer side of the reactivity stack from
 * v5 §13.
 *
 *   - All NEW dogfood tables (this file). Safe — no pre-existing
 *     triggers on them; created here by us.
 *
 *   - Some LOCAL-bucket tables (`known_schema_versions`,
 *     `auto_review_audit`) don't need the notify because nothing in the
 *     UI subscribes to changes — they're write-only audit logs. We
 *     attach anyway because: (a) the surface is uniform, (b) listeners
 *     can filter, (c) future UIs may want to subscribe.
 */
export const DOGFOOD_REACTIVE_TABLES = [
  'feature_queue',
  'contributors',
  'feature_claims',
  'pr_reviewer_settings',
  'pr_check_status_cache',
  'known_schema_versions',
  'auto_review_audit',
  'claim_audit',
  'webhook_audit',
  'trusted_authors',
  'contributor_usage_events',
  'insights_first_visit',
  'shared_repo_binding_cache',
] as const;

/**
 * Existing HYPERBEE-bucket consolidated tables (v5 §7.1) — the tables
 * the UI actually reads from today. Wired in P-019 part 2 (2026-05-24
 * after trigger consolidation).
 *
 * Trigger-interaction audit: each of these tables already carries
 * existing triggers, but those triggers fire on PER-HARNESS tables
 * (`{{schema}}.harness_issues` etc.) and write INTO the consolidated
 * table. My `emit_change_notify` trigger fires AFTER an INSERT/UPDATE/
 * DELETE on the consolidated table itself — different table, no
 * conflict. The chain becomes:
 *
 *   1. App writes per-harness table → existing trigger fires
 *   2. Existing trigger upserts into consolidated table
 *   3. My emit_change_notify trigger fires on the consolidated row
 *   4. pg_notify('sync_invalidate', ...) → existing SSE consumer
 *
 * Direct consolidated-table writes (no per-harness mirror) also get
 * caught — my trigger is the catch-all.
 *
 * Dedup note: coord_presence sees heartbeats every ~30s per active
 * agent. The 90s dedup window in sync-sse.ts collapses identical
 * (name, args) notifies — `{name: 'coord_presence.changed', args:
 * {workspace_id, op:'UPDATE'}}` matches across all agents in one
 * workspace, so the notify cascade is bounded to one event per 90s
 * even with 10+ agents. Sufficient signal for "presence changed,
 * refetch".
 */
export const EXISTING_HYPERBEE_REACTIVE_TABLES = [
  'harness_features_consolidated',
  'harness_issues_consolidated',
  'coord_presence',
  'harness_feature_prs',
] as const;

type _TG = { __dogfoodTriggersWired?: boolean };
const _gTrig = globalThis as unknown as _TG;

/**
 * Attach `harness_shared.emit_change_notify()` (defined in migration 078)
 * to every table in `DOGFOOD_REACTIVE_TABLES`. Idempotent via
 * `CREATE OR REPLACE TRIGGER` (PG 14+). Safe to call on every boot.
 *
 * Pre-condition: migration 078 has run (the trigger function exists).
 * That migration is bundled with the embedded-postgres-server boot
 * sequence, so by the time runtime code calls this helper, the function
 * is guaranteed to be there. If somehow it isn't, this throws cleanly —
 * caller should surface the error rather than swallowing.
 */
export async function wireDogfoodTriggers(): Promise<void> {
  if (_gTrig.__dogfoodTriggersWired) return;
  // Ensure every target table exists first; trigger DDL otherwise
  // refers to a missing relation and fails.
  await ensureAllDogfoodTables();
  const { sql } = getOrgPg();

  // Phase 3 P-019 part 1: new dogfood tables (this file).
  for (const tableName of DOGFOOD_REACTIVE_TABLES) {
    await sql.unsafe(
      'CREATE OR REPLACE TRIGGER emit_change_notify_trg ' +
        'AFTER INSERT OR UPDATE OR DELETE ' +
        'ON harness_shared.' + tableName + ' ' +
        'FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify()',
    );
  }

  // Phase 3 P-019 part 2 (2026-05-24): existing HYPERBEE consolidated
  // tables. These may not exist yet on a freshly-installed harness
  // before scaffold-harness runs; tolerate missing tables silently —
  // the trigger will get attached on the next boot once scaffold has
  // run. Other tables in this list almost always exist (e.g.
  // harness_features_consolidated is in 001-shared.sql, which is part
  // of the universal bootstrap).
  for (const tableName of EXISTING_HYPERBEE_REACTIVE_TABLES) {
    try {
      await sql.unsafe(
        'CREATE OR REPLACE TRIGGER emit_change_notify_trg ' +
          'AFTER INSERT OR UPDATE OR DELETE ' +
          'ON harness_shared.' + tableName + ' ' +
          'FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify()',
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/does not exist|relation .* does not exist/i.test(msg)) {
        // Table not yet provisioned in this workspace — fine, will retry
        // on next boot. Don't log noisily; this is the expected pre-
        // scaffold state.
        continue;
      }
      throw e;
    }
  }

  _gTrig.__dogfoodTriggersWired = true;
}
