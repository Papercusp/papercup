/**
 * Idempotent schema ensures, applied at runtime via postgres-js.
 *
 * Scope: only `harness_shared` tables can be ensured at runtime, because
 * runtime roles (harness_app / harness_admin) have CREATE on harness_shared
 * but NOT on per-harness schemas. Per-harness DDL (columns on
 * harness_<slug>.harness_features etc.) must happen at scaffold time
 * via libs/papercusp/libs/db/sql/002-per-harness-template.sql, applied
 * by `bin/scaffold-harness-schema.sh` (psql).
 *
 * For per-harness schema additions to existing harnesses, run:
 *   bin/migrate-installed-harnesses-add-<thing>.sh
 * or apply the ALTER manually as postgres_app.
 *
 * The canonical runtime-DDL pattern (see lib/autoloop.ts,
 * lib/provision/operator-claims.ts) only works for harness_shared.
 */
import { getOrgPg } from '@restart/db-org';

// Pin the "already-ensured" flags to globalThis so that instrumentation.ts's
// pre-warm and the API route handlers share the same flag set even when
// Next bundles them into separate modules. Without this, in standalone
// builds pre-warm sets its module-local flag, the route handler's
// module-local flag stays false, and the route re-runs the DDL on first
// request — net-negative perf. Diagnostic 2026-05-06.
type _G = {
  __ensureSchemaFlags?: {
    snapshotFeatures: boolean;
    userActions: boolean;
    toastLog: boolean;
    operatorScans: boolean;
    delegateInbox: boolean;
    harnessSummaries: boolean;
    pendingReviews: boolean;
    harnessProposalsShared: boolean;
    harnessStatus: boolean;
    harnessLanes: boolean;
    harnessPendingIssues: boolean;
    harnessPhases: boolean;
    harnessTests: boolean;
    harnessEscalations: boolean;
    harnessArchives: boolean;
    harnessPlanReview: boolean;
    harnessSmokeTest: boolean;
    harnessCheckpoints: boolean;
    harnessHookLogs: boolean;
    harnessScreenshots: boolean;
    harnessDecisions: boolean;
    harnessGitLog: boolean;
    harnessHealth: boolean;
    harnessBranchActions: boolean;
    harnessBrainstorm: boolean;
    harnessProjectFiles: boolean;
    harnessTextArtifacts: boolean;
    harnessFeatureDebugNotes: boolean;
    harnessFeaturePrs: boolean;
    orgCharter: boolean;
    orgDepartments: boolean;
    orgProjects: boolean;
    orgInbox: boolean;
    orgOutbox: boolean;
    orgNotes: boolean;
    orgDecisions: boolean;
    mobileDevices: boolean;
    operatorSecrets: boolean;
    spawnSigVerificationFailures: boolean;
    uiClients: boolean;
    uiIntents: boolean;
    identityFiles: boolean;
    adaptiveTelemetry: boolean;
    harnessMissionState: boolean;
    harnessDispatches: boolean;
    harnessRunOutput: boolean;
    harnessSnapshots: boolean;
    harnessCheckpointsConsumed: boolean;
    harnessRunChunks: boolean;
    harnessPromotions: boolean;
    harnessExpertFeedback: boolean;
    harnessExpertTurns: boolean;
    operatorConversations: boolean;
    workspaceBackupSettings: boolean;
    backupSnapshots: boolean;
    backupEvents: boolean;
  };
};
const _g = globalThis as unknown as _G;
const flags = _g.__ensureSchemaFlags ?? (_g.__ensureSchemaFlags = {
  snapshotFeatures: false,
  userActions: false,
  toastLog: false,
  operatorScans: false,
  delegateInbox: false,
  harnessSummaries: false,
  pendingReviews: false,
  harnessProposalsShared: false,
  harnessStatus: false,
  harnessLanes: false,
  harnessPendingIssues: false,
  harnessPhases: false,
  harnessTests: false,
  harnessEscalations: false,
  harnessArchives: false,
  harnessPlanReview: false,
  harnessSmokeTest: false,
  harnessCheckpoints: false,
  harnessHookLogs: false,
  harnessScreenshots: false,
  harnessDecisions: false,
  harnessGitLog: false,
  harnessHealth: false,
  harnessBranchActions: false,
  harnessBrainstorm: false,
  harnessProjectFiles: false,
  harnessTextArtifacts: false,
  harnessFeatureDebugNotes: false,
  harnessFeaturePrs: false,
  orgCharter: false,
  orgDepartments: false,
  orgProjects: false,
  orgInbox: false,
  orgOutbox: false,
  orgNotes: false,
  orgDecisions: false,
  mobileDevices: false,
  operatorSecrets: false,
  spawnSigVerificationFailures: false,
  uiClients: false,
  uiIntents: false,
  identityFiles: false,
  adaptiveTelemetry: false,
  harnessMissionState: false,
  harnessDispatches: false,
  harnessRunOutput: false,
  harnessSnapshots: false,
  harnessCheckpointsConsumed: false,
  harnessRunChunks: false,
  harnessPromotions: false,
  harnessExpertFeedback: false,
  harnessExpertTurns: false,
  operatorConversations: false,
  workspaceBackupSettings: false,
  backupSnapshots: false,
  backupEvents: false,
});

/**
 * Creates harness_shared.user_actions (cross-harness log of long-running
 * user-initiated actions: replan, cleanup, snapshot create/fork/publish,
 * plugin install). Used by recordUserAction() in lib/user-actions.ts and
 * subscribed from OperatorActionLog.tsx via Zero.
 */
export async function ensureUserActionsTable(): Promise<void> {
  if (flags.userActions) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.user_actions (
      id            BIGSERIAL PRIMARY KEY,
      harness_slug  TEXT NOT NULL,
      kind          TEXT NOT NULL,
      status        TEXT NOT NULL,
      summary       TEXT,
      detail_url    TEXT,
      error_text    TEXT,
      invocation_id TEXT,
      started_at    BIGINT NOT NULL,
      finished_at   BIGINT,
      actor         TEXT,
      workspace_id  TEXT NOT NULL DEFAULT ''
    );
    -- Idempotent ALTER for tables created before workspace scoping landed.
    ALTER TABLE harness_shared.user_actions
      ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS user_actions_slug_started_idx
      ON harness_shared.user_actions (harness_slug, started_at DESC);
    CREATE INDEX IF NOT EXISTS user_actions_running_idx
      ON harness_shared.user_actions (harness_slug)
      WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS user_actions_workspace_idx
      ON harness_shared.user_actions (workspace_id);
  `);
  flags.userActions = true;
}

/**
 * Creates harness_shared.toast_log — persisted history of every sonner
 * toast shown anywhere in the app. Captured client-side via a
 * MutationObserver on the Toaster `<ol>` (see ToastHistoryRecorder)
 * and read by the NotificationCenter bell. `harness_slug` is the active
 * harness at the moment the toast was shown, or NULL for chrome-level
 * toasts (workspace switch, update check, etc.).
 */
export async function ensureToastLogTable(): Promise<void> {
  if (flags.toastLog) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.toast_log (
      id            BIGSERIAL PRIMARY KEY,
      level         TEXT NOT NULL,
      message       TEXT NOT NULL,
      description   TEXT,
      harness_slug  TEXT,
      created_at    BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS toast_log_created_idx
      ON harness_shared.toast_log (created_at DESC);
    CREATE INDEX IF NOT EXISTS toast_log_slug_created_idx
      ON harness_shared.toast_log (harness_slug, created_at DESC)
      WHERE harness_slug IS NOT NULL;
    -- Idempotent column adds for existing deployments.
    ALTER TABLE harness_shared.toast_log
      ADD COLUMN IF NOT EXISTS action_label TEXT,
      ADD COLUMN IF NOT EXISTS action_href  TEXT;
  `);
  flags.toastLog = true;
}

/** Creates harness_shared.snapshot_features (cross-harness). */
export async function ensureSnapshotFeaturesTable(): Promise<void> {
  if (flags.snapshotFeatures) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.snapshot_features (
      harness_slug         TEXT NOT NULL,
      snapshot_id          TEXT NOT NULL,
      feature_id           TEXT NOT NULL,
      title                TEXT NOT NULL,
      summary              TEXT,
      status               TEXT NOT NULL,
      attempts             BIGINT NOT NULL,
      claims               TEXT,
      notes                TEXT,
      metadata             JSONB,
      kind                 TEXT,
      project_id           TEXT,
      expected_cost_cents  BIGINT,
      tags                 JSONB,
      needs_human_review   BOOLEAN NOT NULL DEFAULT FALSE,
      deprecation_reason   TEXT,
      parent_id            TEXT,
      goal_id              TEXT,
      ts                   BIGINT,
      created_ts           BIGINT NOT NULL,
      PRIMARY KEY (harness_slug, snapshot_id, feature_id)
    )
  `);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS sf_snapshot_idx ON harness_shared.snapshot_features(harness_slug, snapshot_id)`);
  try {
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.snapshot_features TO harness_app, harness_admin`);
  } catch { /* not all roles can grant; fine */ }
  flags.snapshotFeatures = true;
}

/**
 * Creates harness_shared.operator_scans — one row per Operator scan.
 * Captures the summary, the suggestions emitted, the cost, and (post
 * Phase 3) the claude_session_id used to resume across scans. Read
 * by the Scan History tab in the operator panel.
 *
 * `error` is populated when a scan fails (so the history view can
 * show "scan errored" entries instead of silently dropping them).
 */
export async function ensureOperatorScansTable(): Promise<void> {
  if (flags.operatorScans) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.operator_scans (
      id                 BIGSERIAL PRIMARY KEY,
      workspace_id       TEXT NOT NULL,
      started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at           TIMESTAMPTZ,
      claude_session_id  TEXT,
      request_text       TEXT,
      summary            TEXT,
      suggestions        JSONB NOT NULL DEFAULT '[]'::jsonb,
      suggestion_count   INT NOT NULL DEFAULT 0,
      cost_usd           NUMERIC(10, 4) NOT NULL DEFAULT 0,
      cached             BOOLEAN NOT NULL DEFAULT FALSE,
      error              TEXT
    );
    CREATE INDEX IF NOT EXISTS operator_scans_ws_started_idx
      ON harness_shared.operator_scans (workspace_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS operator_scans_session_idx
      ON harness_shared.operator_scans (claude_session_id)
      WHERE claude_session_id IS NOT NULL;
  `);
  try {
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE ON harness_shared.operator_scans TO harness_app, harness_admin`);
    await sql.unsafe(`GRANT USAGE, SELECT ON SEQUENCE harness_shared.operator_scans_id_seq TO harness_app, harness_admin`);
  } catch { /* not all roles can grant; fine on read replicas */ }
  flags.operatorScans = true;
}


/**
 * Creates harness_shared.delegate_inbox — pending notifications for the
 * EL agent. When an async delegate finishes but no live EL session is
 * active (user closed the panel, navigated away, restarted), the
 * headline lands here. The next EL session drains the inbox on connect
 * and folds the entries into a single contextual update so the agent
 * can speak about what happened while it was offline.
 */
export async function ensureDelegateInboxTable(): Promise<void> {
  if (flags.delegateInbox) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.delegate_inbox (
      id                 BIGSERIAL PRIMARY KEY,
      workspace_id       TEXT NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at       TIMESTAMPTZ,
      kind               TEXT NOT NULL DEFAULT 'delegate-complete',
      headline           TEXT NOT NULL,
      claude_session_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS delegate_inbox_ws_pending_idx
      ON harness_shared.delegate_inbox (workspace_id, created_at)
      WHERE delivered_at IS NULL;
  `);
  try {
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE ON harness_shared.delegate_inbox TO harness_app, harness_admin`);
    await sql.unsafe(`GRANT USAGE, SELECT ON SEQUENCE harness_shared.delegate_inbox_id_seq TO harness_app, harness_admin`);
  } catch { /* not all roles can grant; fine on read replicas */ }
  flags.delegateInbox = true;
}


/**
 * harness_shared.harness_summaries — one row per harness slug, mirrored
 * from .harness/summary.md by harness-fs-watcher. SummaryPanel reads via
 * Zero (queries.summary.byHarness) instead of polling /api/harness/<slug>/summary.
 */
export async function ensureHarnessSummariesTable(): Promise<void> {
  if (flags.harnessSummaries) return;
  const { sql } = getOrgPg();
  // PK is (harness_slug, phase). The default 'staging' lets pre-existing
  // single-PK rows survive the migration without interpretation changes —
  // staging is the only phase the watcher mirrors today.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_summaries (
      harness_slug  TEXT NOT NULL,
      phase         TEXT NOT NULL DEFAULT 'staging',
      content       TEXT NOT NULL DEFAULT '',
      mtime_ms      BIGINT NOT NULL DEFAULT 0,
      updated_at    BIGINT NOT NULL DEFAULT 0,
      workspace_id  TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase)
    );
    ALTER TABLE harness_shared.harness_summaries
      ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE harness_shared.harness_summaries
      ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'staging';
    -- Recompose PK to include phase. Do nothing if the new constraint
    -- already exists; otherwise drop the old single-column PK and add
    -- the composite. \`harness_summaries_pkey\` is the auto-name PG
    -- assigns when PRIMARY KEY is declared inline.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'harness_shared.harness_summaries'::regclass
           AND contype = 'p'
           AND pg_get_constraintdef(oid) ILIKE '%(harness_slug, phase)%'
      ) THEN
        ALTER TABLE harness_shared.harness_summaries
          DROP CONSTRAINT IF EXISTS harness_summaries_pkey;
        ALTER TABLE harness_shared.harness_summaries
          ADD CONSTRAINT harness_summaries_pkey PRIMARY KEY (harness_slug, phase);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS harness_summaries_workspace_idx
      ON harness_shared.harness_summaries (workspace_id);
  `);
  flags.harnessSummaries = true;
}

/**
 * harness_shared.pending_reviews — mirror of .harness/pending-reviews/*.json,
 * keyed by (harness_slug, review_id where review_id = file basename without .json).
 * Source of truth is still the JSON files; PG is a Zero-readable mirror.
 * Resolution writes back to JSON; the watcher then deletes from PG (or marks
 * resolved=true depending on how the agent persists resolution).
 */
export async function ensurePendingReviewsTable(): Promise<void> {
  if (flags.pendingReviews) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.pending_reviews (
      harness_slug TEXT NOT NULL,
      phase        TEXT NOT NULL DEFAULT 'staging',
      review_id    TEXT NOT NULL,
      feature_id   TEXT,
      kind         TEXT NOT NULL,
      payload      JSONB NOT NULL,
      ts           BIGINT NOT NULL,
      resolved     BOOLEAN NOT NULL DEFAULT FALSE,
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase, review_id)
    );
    ALTER TABLE harness_shared.pending_reviews
      ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE harness_shared.pending_reviews
      ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'staging';
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'harness_shared.pending_reviews'::regclass
           AND contype = 'p'
           AND pg_get_constraintdef(oid) ILIKE '%(harness_slug, phase, review_id)%'
      ) THEN
        ALTER TABLE harness_shared.pending_reviews
          DROP CONSTRAINT IF EXISTS pending_reviews_pkey;
        ALTER TABLE harness_shared.pending_reviews
          ADD CONSTRAINT pending_reviews_pkey PRIMARY KEY (harness_slug, phase, review_id);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS pending_reviews_slug_resolved_ts_idx
      ON harness_shared.pending_reviews (harness_slug, resolved, ts DESC);
    CREATE INDEX IF NOT EXISTS pending_reviews_workspace_idx
      ON harness_shared.pending_reviews (workspace_id);
  `);
  flags.pendingReviews = true;
}

/**
 * harness_shared.harness_proposals_shared — cross-harness mirror of
 * .harness/proposals/*.json. ProposalsPanel reads this table directly
 * (Phase 2.5 migration); the per-harness `harness_<slug>.harness_proposals`
 * is no longer the panel's source of truth.
 *
 * Rich columns (status/verdict/timestamps) come from the JSON payload,
 * which is the single source of truth — accept/reject endpoints write
 * applied_at/rejected_at into the JSON file, the watcher mirrors here.
 */
export async function ensureHarnessProposalsSharedTable(): Promise<void> {
  if (flags.harnessProposalsShared) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_proposals_shared (
      harness_slug    TEXT NOT NULL,
      phase           TEXT NOT NULL DEFAULT 'staging',
      proposal_id     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      review_verdict  TEXT,
      review_summary  TEXT,
      reviewed_at     BIGINT,
      applied_at      BIGINT,
      rejected_at     BIGINT,
      size_bytes      BIGINT NOT NULL DEFAULT 0,
      payload         JSONB NOT NULL,
      ts              BIGINT NOT NULL,
      mtime_ms        BIGINT NOT NULL DEFAULT 0,
      workspace_id    TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase, proposal_id)
    );
    -- Idempotent column adds for tables that pre-date Phase 2.5.
    ALTER TABLE harness_shared.harness_proposals_shared
      ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE harness_shared.harness_proposals_shared
      ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'staging';
    ALTER TABLE harness_shared.harness_proposals_shared
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE harness_shared.harness_proposals_shared
      ADD COLUMN IF NOT EXISTS review_verdict TEXT;
    ALTER TABLE harness_shared.harness_proposals_shared
      ADD COLUMN IF NOT EXISTS review_summary TEXT;
    ALTER TABLE harness_shared.harness_proposals_shared
      ADD COLUMN IF NOT EXISTS reviewed_at BIGINT;
    ALTER TABLE harness_shared.harness_proposals_shared
      ADD COLUMN IF NOT EXISTS applied_at BIGINT;
    ALTER TABLE harness_shared.harness_proposals_shared
      ADD COLUMN IF NOT EXISTS rejected_at BIGINT;
    ALTER TABLE harness_shared.harness_proposals_shared
      ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'harness_shared.harness_proposals_shared'::regclass
           AND contype = 'p'
           AND pg_get_constraintdef(oid) ILIKE '%(harness_slug, phase, proposal_id)%'
      ) THEN
        ALTER TABLE harness_shared.harness_proposals_shared
          DROP CONSTRAINT IF EXISTS harness_proposals_shared_pkey;
        ALTER TABLE harness_shared.harness_proposals_shared
          ADD CONSTRAINT harness_proposals_shared_pkey
          PRIMARY KEY (harness_slug, phase, proposal_id);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS harness_proposals_shared_slug_ts_idx
      ON harness_shared.harness_proposals_shared (harness_slug, ts DESC);
    CREATE INDEX IF NOT EXISTS harness_proposals_shared_status_idx
      ON harness_shared.harness_proposals_shared (harness_slug, status);
    CREATE INDEX IF NOT EXISTS harness_proposals_shared_workspace_idx
      ON harness_shared.harness_proposals_shared (workspace_id);
  `);
  flags.harnessProposalsShared = true;
}


/**
 * harness_shared.harness_status — one row per (slug, phase). Written by
 * the orchestrator (`run.sh` via pg-status.sh helper) at iteration
 * boundaries; the operator's sweeper updates only the `status` column
 * (when it detects stalled iterations) and never touches `iteration`,
 * which is orchestrator-owned.
 *
 * status values:
 *   'idle'    — between iterations, no agent_runs running
 *   'running' — orchestrator is mid-iteration, ≥1 agent_run live
 *   'stalled' — sweeper detected updated_at > 5 min + no live runs
 *   'paused'  — operator-pause-flag set or run.sh paused via signal
 *   'error'   — orchestrator hit a fatal error and exited unhealthy
 */
export async function ensureHarnessStatusTable(): Promise<void> {
  if (flags.harnessStatus) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_status (
      harness_slug   TEXT NOT NULL,
      phase          TEXT NOT NULL DEFAULT 'staging',
      status         TEXT NOT NULL CHECK (status IN ('idle','running','stalled','paused','error')),
      iteration      INT NOT NULL DEFAULT 0,
      total_features INT NOT NULL DEFAULT 0,
      passed_count   INT NOT NULL DEFAULT 0,
      todo_count     INT NOT NULL DEFAULT 0,
      blocked_count  INT NOT NULL DEFAULT 0,
      last_active_ts BIGINT,
      cost_usd       NUMERIC(10, 4),
      workspace_id   TEXT NOT NULL DEFAULT '',
      updated_at     BIGINT NOT NULL,
      -- expires_at: when the row is considered stale and gets flipped
      -- from 'running' → 'stalled' by the expirable-registry sweeper.
      -- Writers set this to updated_at + STATUS_LEASE_MS (5 min) on each
      -- pg_write_status call. Defaults to 0 for legacy rows so they get
      -- swept on first sweep tick after the migration lands.
      expires_at     BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (harness_slug, phase)
    );
    -- Idempotent column adds for tables that pre-date this revision.
    ALTER TABLE harness_shared.harness_status
      ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE harness_shared.harness_status
      ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS harness_status_workspace_idx
      ON harness_shared.harness_status (workspace_id);
    CREATE INDEX IF NOT EXISTS harness_status_updated_idx
      ON harness_shared.harness_status (updated_at);
    CREATE INDEX IF NOT EXISTS harness_status_expires_idx
      ON harness_shared.harness_status (expires_at);
  `);
  flags.harnessStatus = true;
}

/**
 * harness_shared.harness_lanes — per-iteration ephemeral lane state. One
 * row per (slug, phase, role); deleted by run.sh at iteration end. Carries
 * the recorded PID so the SIGKILL sweeper can detect stale rows when run.sh
 * exits without running its trap EXIT.
 */
export async function ensureHarnessLanesTable(): Promise<void> {
  if (flags.harnessLanes) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_lanes (
      harness_slug TEXT NOT NULL,
      phase        TEXT NOT NULL DEFAULT 'staging',
      role         TEXT NOT NULL,
      feature_id   TEXT,
      pid          INT,
      started_at   BIGINT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase, role)
    );
    ALTER TABLE harness_shared.harness_lanes
      ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE harness_shared.harness_lanes
      ADD COLUMN IF NOT EXISTS pid INT;
    CREATE INDEX IF NOT EXISTS harness_lanes_workspace_idx
      ON harness_shared.harness_lanes (workspace_id);
    CREATE INDEX IF NOT EXISTS harness_lanes_started_idx
      ON harness_shared.harness_lanes (started_at);
  `);
  flags.harnessLanes = true;
}

/** harness_shared.harness_pending_issues — mirror of .harness/pending-issues.jsonl. */
export async function ensureHarnessPendingIssuesTable(): Promise<void> {
  if (flags.harnessPendingIssues) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_pending_issues (
      harness_slug TEXT NOT NULL,
      phase        TEXT NOT NULL DEFAULT 'staging',
      issue_id     TEXT NOT NULL,
      feature_id   TEXT,
      title        TEXT NOT NULL DEFAULT '',
      severity     TEXT NOT NULL DEFAULT 'normal',
      source       TEXT NOT NULL DEFAULT '',
      payload      JSONB NOT NULL,
      ts           BIGINT NOT NULL DEFAULT 0,
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase, issue_id)
    );
  `);
  flags.harnessPendingIssues = true;
}

/** harness_shared.harness_phases — mirror of harness phase metadata. */
export async function ensureHarnessPhasesTable(): Promise<void> {
  if (flags.harnessPhases) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_phases (
      harness_slug      TEXT NOT NULL,
      phase             TEXT NOT NULL,
      phase_path        TEXT NOT NULL DEFAULT '',
      branch            TEXT,
      port              INTEGER,
      public_url        TEXT,
      exists_on_disk    BOOLEAN NOT NULL DEFAULT false,
      alive             BOOLEAN NOT NULL DEFAULT false,
      passed_count      INTEGER NOT NULL DEFAULT 0,
      total_count       INTEGER NOT NULL DEFAULT 0,
      cost_usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
      iteration         INTEGER NOT NULL DEFAULT 0,
      promotion_in_flight BOOLEAN NOT NULL DEFAULT false,
      mtime_ms          BIGINT NOT NULL DEFAULT 0,
      workspace_id      TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase)
    );
  `);
  flags.harnessPhases = true;
}

/** harness_shared.harness_tests — mirror of .harness/tests/*.json. */
export async function ensureHarnessTestsTable(): Promise<void> {
  if (flags.harnessTests) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_tests (
      harness_slug TEXT NOT NULL,
      phase        TEXT NOT NULL DEFAULT 'staging',
      test_id      TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      last_run_ts  BIGINT,
      payload      JSONB NOT NULL,
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase, test_id)
    );
  `);
  flags.harnessTests = true;
}

/** harness_shared.harness_escalations — mirror of .harness/escalation.md. */
export async function ensureHarnessEscalationsTable(): Promise<void> {
  if (flags.harnessEscalations) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_escalations (
      harness_slug      TEXT NOT NULL,
      phase             TEXT NOT NULL DEFAULT 'staging',
      escalation        TEXT,
      supervisor_notes  TEXT,
      mtime_ms          BIGINT NOT NULL DEFAULT 0,
      workspace_id      TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase)
    );
  `);
  flags.harnessEscalations = true;
}

/** harness_shared.harness_archives — mirror of .harness/archives/*.tar.gz. */
export async function ensureHarnessArchivesTable(): Promise<void> {
  if (flags.harnessArchives) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_archives (
      harness_slug TEXT NOT NULL,
      phase        TEXT NOT NULL DEFAULT 'staging',
      id           TEXT NOT NULL,
      size_bytes   BIGINT NOT NULL DEFAULT 0,
      ts           BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase, id)
    );
    CREATE INDEX IF NOT EXISTS harness_archives_slug_phase_ts_idx
      ON harness_shared.harness_archives (harness_slug, phase, ts DESC);
  `);
  flags.harnessArchives = true;
}

/** harness_shared.harness_feature_prs — mirror of .harness/prs.json
 *  (one row per (harness, feature) with the PR URL/state). */
export async function ensureHarnessFeaturePrsTable(): Promise<void> {
  if (flags.harnessFeaturePrs) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_feature_prs (
      workspace_id TEXT NOT NULL DEFAULT '',
      harness_slug TEXT NOT NULL,
      feature_id   TEXT NOT NULL,
      pr_url       TEXT NOT NULL,
      pr_state     TEXT NOT NULL DEFAULT 'unknown',
      opened_ts    BIGINT NOT NULL DEFAULT 0,
      updated_ts   BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    );
    CREATE INDEX IF NOT EXISTS hfp_harness_idx
      ON harness_shared.harness_feature_prs (workspace_id, harness_slug);
  `);
  flags.harnessFeaturePrs = true;
}

/** harness_shared.harness_feature_debug_notes — mirror of
 *  .harness/debug/<featureId>.md (one row per (harness, feature)).
 *  Written by the debugger role; read eagerly by FeaturePeekPanel. */
export async function ensureHarnessFeatureDebugNotesTable(): Promise<void> {
  if (flags.harnessFeatureDebugNotes) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_feature_debug_notes (
      workspace_id TEXT NOT NULL DEFAULT '',
      harness_slug TEXT NOT NULL,
      feature_id   TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    );
    CREATE INDEX IF NOT EXISTS hfdn_harness_idx
      ON harness_shared.harness_feature_debug_notes (workspace_id, harness_slug);
  `);
  flags.harnessFeatureDebugNotes = true;
}

/** harness_shared.harness_plan_review — mirror of .harness/plan-review.md. */
export async function ensureHarnessPlanReviewTable(): Promise<void> {
  if (flags.harnessPlanReview) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_plan_review (
      harness_slug TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug)
    );
  `);
  flags.harnessPlanReview = true;
}

/** harness_shared.harness_smoke_test — denormalized smoke-{pass,failure,results,startup} aggregate. */
export async function ensureHarnessSmokeTestTable(): Promise<void> {
  if (flags.harnessSmokeTest) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_smoke_test (
      harness_slug    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'unknown',
      pass_content    TEXT,
      failure_content TEXT,
      results         JSONB,
      startup_log     TEXT,
      mtime_ms        BIGINT NOT NULL DEFAULT 0,
      workspace_id    TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug)
    );
  `);
  flags.harnessSmokeTest = true;
}

/** harness_shared.harness_checkpoints — mirror of .harness/checkpoint-*.md (+ .granted). */
export async function ensureHarnessCheckpointsTable(): Promise<void> {
  if (flags.harnessCheckpoints) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_checkpoints (
      harness_slug      TEXT NOT NULL,
      name              TEXT NOT NULL,
      content           TEXT NOT NULL DEFAULT '',
      waiting_since_ms  BIGINT NOT NULL DEFAULT 0,
      granted           BOOLEAN NOT NULL DEFAULT false,
      workspace_id      TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, name)
    );
    CREATE INDEX IF NOT EXISTS harness_checkpoints_slug_waiting_idx
      ON harness_shared.harness_checkpoints (harness_slug, waiting_since_ms ASC);
  `);
  flags.harnessCheckpoints = true;
}

/** harness_shared.harness_hook_logs — mirror of .harness/logs/hooks/*.log metadata. */
export async function ensureHarnessHookLogsTable(): Promise<void> {
  if (flags.harnessHookLogs) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_hook_logs (
      harness_slug  TEXT NOT NULL,
      log_id        TEXT NOT NULL,
      name          TEXT NOT NULL DEFAULT '',
      ts            BIGINT NOT NULL DEFAULT 0,
      size_bytes    BIGINT NOT NULL DEFAULT 0,
      workspace_id  TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, log_id)
    );
    CREATE INDEX IF NOT EXISTS harness_hook_logs_slug_ts_idx
      ON harness_shared.harness_hook_logs (harness_slug, ts DESC);
  `);
  flags.harnessHookLogs = true;
}

/** harness_shared.harness_screenshots — mirror of .harness/screenshots/* metadata. */
export async function ensureHarnessScreenshotsTable(): Promise<void> {
  if (flags.harnessScreenshots) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_screenshots (
      harness_slug TEXT NOT NULL,
      phase        TEXT NOT NULL DEFAULT 'staging',
      id           TEXT NOT NULL,
      size_bytes   BIGINT NOT NULL DEFAULT 0,
      ts           BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase, id)
    );
    CREATE INDEX IF NOT EXISTS harness_screenshots_slug_phase_ts_idx
      ON harness_shared.harness_screenshots (harness_slug, phase, ts DESC);
  `);
  flags.harnessScreenshots = true;
}

/** harness_shared.harness_decisions — mirror of parsed run.log ORCH decisions. */
export async function ensureHarnessDecisionsTable(): Promise<void> {
  if (flags.harnessDecisions) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_decisions (
      harness_slug TEXT NOT NULL,
      line_hash    TEXT NOT NULL,
      ts           BIGINT NOT NULL DEFAULT 0,
      iso          TEXT NOT NULL DEFAULT '',
      verb         TEXT NOT NULL,
      args         TEXT NOT NULL DEFAULT '',
      iteration    INTEGER,
      is_ghost     BOOLEAN NOT NULL DEFAULT false,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, line_hash)
    );
    CREATE INDEX IF NOT EXISTS harness_decisions_slug_ts_idx
      ON harness_shared.harness_decisions (harness_slug, ts ASC);
  `);
  flags.harnessDecisions = true;
}

/** harness_shared.harness_git_log — mirror of `git log` output for the harness's repo. */
export async function ensureHarnessGitLogTable(): Promise<void> {
  if (flags.harnessGitLog) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_git_log (
      harness_slug TEXT NOT NULL,
      sha          TEXT NOT NULL,
      parents      JSONB NOT NULL DEFAULT '[]',
      subject      TEXT NOT NULL DEFAULT '',
      author       TEXT NOT NULL DEFAULT '',
      ts           BIGINT NOT NULL DEFAULT 0,
      refs         JSONB NOT NULL DEFAULT '[]',
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, sha)
    );
    CREATE INDEX IF NOT EXISTS harness_git_log_slug_ts_idx
      ON harness_shared.harness_git_log (harness_slug, ts DESC);
  `);
  flags.harnessGitLog = true;
}

/** harness_shared.harness_health — file-presence checks for HealthBadge. */
export async function ensureHarnessHealthTable(): Promise<void> {
  if (flags.harnessHealth) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_health (
      harness_slug      TEXT NOT NULL,
      spec_present      BOOLEAN NOT NULL DEFAULT false,
      contract_present  BOOLEAN NOT NULL DEFAULT false,
      last_check_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id      TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug)
    );
  `);
  flags.harnessHealth = true;
}

/** harness_shared.harness_branch_actions — JSONB-blob mirror of /branch/<b>/actions. */
export async function ensureHarnessBranchActionsTable(): Promise<void> {
  if (flags.harnessBranchActions) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_branch_actions (
      harness_slug    TEXT NOT NULL,
      branch          TEXT NOT NULL,
      payload         JSONB NOT NULL,
      last_check_ms   BIGINT NOT NULL DEFAULT 0,
      workspace_id    TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, branch)
    );
  `);
  flags.harnessBranchActions = true;
}

/**
 * harness_shared.harness_brainstorm — PG-canonical store for brainstorm
 * artifacts. The .harness/brainstorm.{md,canvas.json,mindmap.json} files
 * are derived mirrors written on each PUT; PG is authoritative. Migration
 * 033 (Phase 2 of un-hardcode).
 */
export async function ensureBrainstormTable(): Promise<void> {
  if (flags.harnessBrainstorm) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_brainstorm (
      harness_slug TEXT NOT NULL,
      phase        TEXT NOT NULL DEFAULT 'staging',
      content      TEXT NOT NULL DEFAULT '',
      canvas       JSONB,
      mindmap      JSONB,
      updated_at   BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, phase)
    );
    CREATE INDEX IF NOT EXISTS harness_brainstorm_workspace_idx
      ON harness_shared.harness_brainstorm (workspace_id);
  `);
  try {
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_brainstorm TO harness_app, harness_admin`);
  } catch { /* read replicas */ }
  flags.harnessBrainstorm = true;
}

/**
 * harness_shared.harness_project_files — PG-canonical store for SPEC.md,
 * AGENTS.md, .harness/validation-contract.md, .harness/config.json.
 * Project-dir copies are best-effort mirrors. Migration 034 (Phase 2).
 */
export async function ensureProjectFilesTable(): Promise<void> {
  if (flags.harnessProjectFiles) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_project_files (
      harness_slug TEXT NOT NULL,
      spec         TEXT,
      agents       TEXT,
      contract     TEXT,
      config       TEXT,
      updated_at   BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug)
    );
    CREATE INDEX IF NOT EXISTS harness_project_files_workspace_idx
      ON harness_shared.harness_project_files (workspace_id);
  `);
  try {
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_project_files TO harness_app, harness_admin`);
  } catch { /* read replicas */ }
  flags.harnessProjectFiles = true;
}

/**
 * harness_shared.harness_text_artifacts — generic (harness_slug, rel_path)
 * text store for memory/raw.md, memory/summary.md, memory/MEMORY.md,
 * supervisor-notes.md, issues.md, and any future per-file text artifact
 * that doesn't deserve its own column. Migration 035 (Phase 2).
 */
export async function ensureTextArtifactsTable(): Promise<void> {
  if (flags.harnessTextArtifacts) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_text_artifacts (
      harness_slug TEXT NOT NULL,
      rel_path     TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      updated_at   BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (harness_slug, rel_path)
    );
    CREATE INDEX IF NOT EXISTS hta_workspace_idx
      ON harness_shared.harness_text_artifacts (workspace_id);
    CREATE INDEX IF NOT EXISTS hta_updated_idx
      ON harness_shared.harness_text_artifacts (harness_slug, updated_at DESC);
  `);
  try {
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_text_artifacts TO harness_app, harness_admin`);
  } catch { /* read replicas */ }
  flags.harnessTextArtifacts = true;
}

/** harness_shared.org_charter — mirror of <org-root>/charter.md. */
export async function ensureOrgCharterTable(): Promise<void> {
  if (flags.orgCharter) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.org_charter (
      org_id       TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (org_id)
    );
  `);
  flags.orgCharter = true;
}

/** harness_shared.org_departments — mirror of <org-root>/departments.json. */
export async function ensureOrgDepartmentsTable(): Promise<void> {
  if (flags.orgDepartments) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.org_departments (
      org_id       TEXT NOT NULL,
      dept_slug    TEXT NOT NULL,
      harness_slug TEXT NOT NULL DEFAULT '',
      name         TEXT NOT NULL DEFAULT '',
      mandate      TEXT NOT NULL DEFAULT '',
      inbox_kinds  JSONB NOT NULL DEFAULT '[]'::jsonb,
      outbox_kinds JSONB NOT NULL DEFAULT '[]'::jsonb,
      payload      JSONB NOT NULL,
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (org_id, dept_slug)
    );
  `);
  flags.orgDepartments = true;
}

/** harness_shared.org_projects — mirror of <org-root>/projects.json. */
export async function ensureOrgProjectsTable(): Promise<void> {
  if (flags.orgProjects) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.org_projects (
      org_id       TEXT NOT NULL,
      project_id   TEXT NOT NULL,
      slug         TEXT NOT NULL DEFAULT '',
      name         TEXT NOT NULL DEFAULT '',
      vertical     TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT '',
      payload      JSONB NOT NULL,
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (org_id, project_id)
    );
  `);
  flags.orgProjects = true;
}

/** harness_shared.org_inbox — per-dept mirror of inbox-view.jsonl. */
export async function ensureOrgInboxTable(): Promise<void> {
  if (flags.orgInbox) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.org_inbox (
      org_id       TEXT NOT NULL,
      dept_slug    TEXT NOT NULL,
      message_id   TEXT NOT NULL,
      ts           BIGINT NOT NULL DEFAULT 0,
      msg_from     TEXT NOT NULL DEFAULT '',
      msg_to       JSONB NOT NULL DEFAULT '[]'::jsonb,
      kind         TEXT NOT NULL DEFAULT '',
      subject      TEXT NOT NULL DEFAULT '',
      body         TEXT NOT NULL DEFAULT '',
      ref_id       TEXT,
      project_id   TEXT,
      directive_id TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      payload      JSONB NOT NULL,
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (org_id, dept_slug, message_id)
    );
  `);
  flags.orgInbox = true;
}

/** harness_shared.org_outbox — per-dept mirror of outbox-view.jsonl. */
export async function ensureOrgOutboxTable(): Promise<void> {
  if (flags.orgOutbox) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.org_outbox (
      org_id       TEXT NOT NULL,
      dept_slug    TEXT NOT NULL,
      message_id   TEXT NOT NULL,
      ts           BIGINT NOT NULL DEFAULT 0,
      msg_from     TEXT NOT NULL DEFAULT '',
      msg_to       JSONB NOT NULL DEFAULT '[]'::jsonb,
      kind         TEXT NOT NULL DEFAULT '',
      subject      TEXT NOT NULL DEFAULT '',
      body         TEXT NOT NULL DEFAULT '',
      ref_id       TEXT,
      project_id   TEXT,
      directive_id TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      payload      JSONB NOT NULL,
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (org_id, dept_slug, message_id)
    );
  `);
  flags.orgOutbox = true;
}

/** harness_shared.org_notes — per-dept mirror of director-notes.md. */
export async function ensureOrgNotesTable(): Promise<void> {
  if (flags.orgNotes) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.org_notes (
      org_id       TEXT NOT NULL,
      dept_slug    TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (org_id, dept_slug)
    );
  `);
  flags.orgNotes = true;
}

/** harness_shared.org_decisions — per-dept mirror of decision-log.md. */
export async function ensureOrgDecisionsTable(): Promise<void> {
  if (flags.orgDecisions) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.org_decisions (
      org_id       TEXT NOT NULL,
      dept_slug    TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (org_id, dept_slug)
    );
  `);
  flags.orgDecisions = true;
}

/**
 * Creates harness_shared.mobile_devices and harness_shared.mobile_push_tokens.
 * See migrations/009_mobile_devices.sql for the canonical definition; this
 * mirror exists so the runtime DDL pattern picks them up without a separate
 * migration step. RLS policies match workspace-scoping conventions.
 */
export async function ensureMobileDevicesTable(): Promise<void> {
  if (flags.mobileDevices) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.mobile_devices (
      device_id      TEXT PRIMARY KEY,
      user_email     TEXT NOT NULL,
      workspace_id   TEXT NOT NULL,
      device_kind    TEXT NOT NULL DEFAULT 'mobile' CHECK (device_kind IN ('mobile')),
      device_label   TEXT,
      paired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen      TIMESTAMPTZ,
      revoked_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS mobile_devices_workspace_idx
      ON harness_shared.mobile_devices (workspace_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS mobile_devices_user_idx
      ON harness_shared.mobile_devices (user_email);

    CREATE TABLE IF NOT EXISTS harness_shared.mobile_push_tokens (
      device_id      TEXT NOT NULL REFERENCES harness_shared.mobile_devices(device_id) ON DELETE CASCADE,
      platform       TEXT NOT NULL CHECK (platform IN ('apns', 'fcm')),
      token          TEXT NOT NULL,
      registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, platform)
    );

    ALTER TABLE harness_shared.mobile_devices ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS mobile_devices_workspace_policy ON harness_shared.mobile_devices;
    CREATE POLICY mobile_devices_workspace_policy
      ON harness_shared.mobile_devices
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

    ALTER TABLE harness_shared.mobile_push_tokens ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS mobile_push_tokens_workspace_policy ON harness_shared.mobile_push_tokens;
    CREATE POLICY mobile_push_tokens_workspace_policy
      ON harness_shared.mobile_push_tokens
      USING (
        EXISTS (
          SELECT 1 FROM harness_shared.mobile_devices d
          WHERE d.device_id = mobile_push_tokens.device_id
            AND d.workspace_id = current_setting('app.workspace_id', true)
        )
      );

    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.mobile_devices TO harness_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.mobile_push_tokens TO harness_app;
  `);
  flags.mobileDevices = true;
}

/** harness_shared.identity_files — mirror of ~/autonomous-harness/identity/<role>.md. */
export async function ensureIdentityFilesTable(): Promise<void> {
  if (flags.identityFiles) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.identity_files (
      role         TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      bytes        INTEGER NOT NULL DEFAULT 0,
      mtime_ms     BIGINT NOT NULL DEFAULT 0,
      updated_at   BIGINT NOT NULL DEFAULT 0,
      workspace_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (role)
    );
    CREATE INDEX IF NOT EXISTS identity_files_workspace_idx
      ON harness_shared.identity_files (workspace_id);
  `);
  try {
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.identity_files TO harness_app, harness_admin`);
  } catch { /* read replicas */ }
  flags.identityFiles = true;
}

/**
 * harness_shared.adaptive_telemetry — append-only log of adaptive-mode
 * worker allocation decisions and outcomes.
 *
 * Each NEXT_WORKER F-X N=k decision in adaptive mode writes one row
 * (outcome=null, pending). When the validator finishes, the matching row
 * gets outcome='pass' or 'fail' + outcome_ts. Used by /settings/orchestrator
 * telemetry table for human inspection (no auto-calibration).
 */
export async function ensureAdaptiveTelemetryTable(): Promise<void> {
  if (flags.adaptiveTelemetry) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.adaptive_telemetry (
      id                     BIGSERIAL PRIMARY KEY,
      harness_slug           TEXT    NOT NULL,
      ts                     BIGINT  NOT NULL,
      feature_id             TEXT    NOT NULL,
      requested_n            INTEGER NOT NULL,
      actual_n               INTEGER NOT NULL,
      tier_label             TEXT,
      available_at_decision  INTEGER,
      max_slots              INTEGER,
      outcome                TEXT,
      outcome_ts             BIGINT,
      duration_ms            BIGINT,
      workspace_id           TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS adaptive_telemetry_harness_idx
      ON harness_shared.adaptive_telemetry (harness_slug, ts DESC);
    CREATE INDEX IF NOT EXISTS adaptive_telemetry_pending_idx
      ON harness_shared.adaptive_telemetry (harness_slug, feature_id)
      WHERE outcome IS NULL;
  `);
  try {
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE ON harness_shared.adaptive_telemetry TO harness_app, harness_admin`,
    );
    await sql.unsafe(
      `GRANT USAGE, SELECT ON SEQUENCE harness_shared.adaptive_telemetry_id_seq TO harness_app, harness_admin`,
    );
  } catch { /* read replicas */ }
  flags.adaptiveTelemetry = true;
}

// ── Orchestrator → PG arc (Phase 2/4/7): bootstrap the new tables ───
//
// The orchestrator package owns the canonical DDL via the `*_DDL`
// constants exported from each *-pg.ts module. These ensure-functions
// import those constants and execute them so the operator can keep
// schema bootstrap centralized in this file.
//
// Phase 3's harness_checkpoints already exists and was reconciled
// in-place (consumed BOOLEAN added via the orchestrator's CHECKPOINTS_DDL,
// which uses ALTER TABLE ADD COLUMN IF NOT EXISTS). ensureHarness
// CheckpointsTable already exists above; calling the orchestrator's
// DDL one more time is idempotent.

export async function ensureHarnessMissionStateTable(): Promise<void> {
  if (flags.harnessMissionState) return;
  const { sql } = getOrgPg();
  const { MISSION_STATE_DDL } = await import('@papercusp/orchestrator/mission-state-pg');
  await sql.unsafe(MISSION_STATE_DDL);
  flags.harnessMissionState = true;
}

export async function ensureHarnessDispatchesTable(): Promise<void> {
  if (flags.harnessDispatches) return;
  const { sql } = getOrgPg();
  const { DISPATCHES_DDL } = await import('@papercusp/orchestrator/dispatches-pg');
  await sql.unsafe(DISPATCHES_DDL);
  flags.harnessDispatches = true;
}

export async function ensureHarnessRunOutputTable(): Promise<void> {
  if (flags.harnessRunOutput) return;
  const { sql } = getOrgPg();
  const { RUN_OUTPUT_DDL } = await import('@papercusp/orchestrator/run-output-pg');
  await sql.unsafe(RUN_OUTPUT_DDL);
  flags.harnessRunOutput = true;
}

export async function ensureHarnessSnapshotsTable(): Promise<void> {
  if (flags.harnessSnapshots) return;
  const { sql } = getOrgPg();
  const { SNAPSHOTS_DDL } = await import('@papercusp/orchestrator/snapshots-pg');
  await sql.unsafe(SNAPSHOTS_DDL);
  flags.harnessSnapshots = true;
}

/**
 * harness_shared.harness_promotions — promotion + rollback log.
 *
 * Replaces per-worktree <toPath>/.harness/promotion-log.json files. Each
 * row is one promote-or-rollback event recorded by /:slug/promote/:id/confirm
 * and /:slug/rollback. Read by /:slug/rollback to find the prior SHA.
 */
export async function ensureHarnessPromotionsTable(): Promise<void> {
  if (flags.harnessPromotions) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_promotions (
      workspace_id  TEXT NOT NULL DEFAULT 'default',
      harness_slug  TEXT NOT NULL,
      promotion_id  TEXT NOT NULL,
      from_phase    TEXT NOT NULL,
      to_phase      TEXT NOT NULL,
      sha           TEXT,
      ts            BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, promotion_id)
    );
    CREATE INDEX IF NOT EXISTS harness_promotions_ts_idx
      ON harness_shared.harness_promotions (workspace_id, harness_slug, ts DESC);
  `);
  flags.harnessPromotions = true;
}

/** harness_run_chunks (Phase 4b) — live PG-streamed subprocess output rows. */
export async function ensureHarnessRunChunksTable(): Promise<void> {
  if (flags.harnessRunChunks) return;
  const { sql } = getOrgPg();
  const { RUN_CHUNKS_DDL } = await import('@papercusp/orchestrator/run-chunks-pg');
  await sql.unsafe(RUN_CHUNKS_DDL);
  flags.harnessRunChunks = true;
}

/** Apply the consumed-column ALTER on harness_checkpoints (Phase 3
 *  reconciliation). Re-uses the orchestrator's CHECKPOINTS_DDL which
 *  is fully idempotent. Doesn't replace ensureHarnessCheckpointsTable
 *  above — both can run; PG's IF NOT EXISTS makes them no-ops on
 *  re-call. */
export async function ensureOrchestratorCheckpointsAddon(): Promise<void> {
  if (flags.harnessCheckpointsConsumed) return;
  const { sql } = getOrgPg();
  const { CHECKPOINTS_DDL } = await import('@papercusp/orchestrator/checkpoints-pg');
  await sql.unsafe(CHECKPOINTS_DDL);
  flags.harnessCheckpointsConsumed = true;
}

/**
 * harness_shared.harness_expert_feedback — feedback conversations.
 * Replaces .harness/experts/<id>/feedback/<fb>/persona.txt + verdict.json.
 */
export async function ensureHarnessExpertFeedbackTable(): Promise<void> {
  if (flags.harnessExpertFeedback) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_expert_feedback (
      workspace_id TEXT NOT NULL DEFAULT 'default',
      harness_slug TEXT NOT NULL,
      expert_id    TEXT NOT NULL,
      feedback_id  TEXT NOT NULL,
      persona      TEXT NOT NULL,
      verdict      JSONB,
      created_at   BIGINT NOT NULL,
      ended_at     BIGINT,
      PRIMARY KEY (workspace_id, harness_slug, expert_id, feedback_id)
    );
    CREATE INDEX IF NOT EXISTS harness_expert_feedback_expert_idx
      ON harness_shared.harness_expert_feedback (workspace_id, harness_slug, expert_id);
  `);
  flags.harnessExpertFeedback = true;
}

/**
 * harness_shared.harness_expert_turns — feedback conversation turns.
 * Replaces .harness/experts/<id>/feedback/<fb>/turn-NNN-{expert,feedback}.md.
 */
export async function ensureHarnessExpertTurnsTable(): Promise<void> {
  if (flags.harnessExpertTurns) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_expert_turns (
      workspace_id TEXT NOT NULL DEFAULT 'default',
      harness_slug TEXT NOT NULL,
      expert_id    TEXT NOT NULL,
      feedback_id  TEXT NOT NULL,
      turn_idx     INT  NOT NULL,
      speaker      TEXT NOT NULL CHECK (speaker IN ('expert','feedback')),
      body         TEXT NOT NULL,
      created_at   BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, expert_id, feedback_id, turn_idx)
    );
    CREATE INDEX IF NOT EXISTS harness_expert_turns_fb_idx
      ON harness_shared.harness_expert_turns (workspace_id, harness_slug, expert_id, feedback_id, turn_idx);
  `);
  flags.harnessExpertTurns = true;
}

/**
 * Operator conversation log — one logical thread per (workspace_id, harness_slug),
 * shared between the text sidebar and the ElevenLabs voice session. Each turn
 * records its source so we can distinguish typed text vs voice STT/TTS.
 *
 * `el_conversation_ids` collects every ElevenLabs conv_id that has contributed
 * turns to this thread (one per voice session) — used as a citation list when
 * fetching server-side transcripts via GET /v1/convai/conversations/{id}.
 */
export async function ensureOperatorConversationsTable(): Promise<void> {
  if (flags.operatorConversations) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.operator_conversations (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id  TEXT NOT NULL DEFAULT '',
      harness_slug  TEXT,
      title         TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      started_at    BIGINT NOT NULL,
      ended_at      BIGINT,
      el_conversation_ids TEXT[] NOT NULL DEFAULT '{}',
      has_audio     BOOLEAN NOT NULL DEFAULT false
    );
    -- Idempotent column add for tables created before has_audio landed.
    ALTER TABLE harness_shared.operator_conversations
      ADD COLUMN IF NOT EXISTS has_audio BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS operator_conversations_active_idx
      ON harness_shared.operator_conversations (workspace_id, COALESCE(harness_slug,''))
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS operator_conversations_started_idx
      ON harness_shared.operator_conversations (workspace_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS harness_shared.operator_turns (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES harness_shared.operator_conversations(id) ON DELETE CASCADE,
      seq             INT NOT NULL,
      role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      text            TEXT NOT NULL,
      source          TEXT NOT NULL DEFAULT 'text_typed',
      el_conv_id      TEXT,
      audio_url       TEXT,
      created_at      BIGINT NOT NULL,
      UNIQUE (conversation_id, seq)
    );
    CREATE INDEX IF NOT EXISTS operator_turns_conv_seq_idx
      ON harness_shared.operator_turns (conversation_id, seq);
  `);
  flags.operatorConversations = true;
}

/**
 * Creates harness_shared.operator_secrets — KV for operator-process
 * secrets that must outlive a restart without a flat-file footprint.
 * Canonical migration: 011_operator_secrets.sql. First user is the
 * per-spawn URL HMAC key (lib/spawn-signing.ts). PG storage stops the
 * `cat ~/.papercusp/<file>` one-liner; same-UID access via libpq is
 * still possible — friction, not enforcement.
 */
export async function ensureOperatorSecretsTable(): Promise<void> {
  if (flags.operatorSecrets) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.operator_secrets (
      name        TEXT PRIMARY KEY,
      value_b64   TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      rotated_at  TIMESTAMPTZ
    );
  `);
  flags.operatorSecrets = true;
}

/**
 * Creates harness_shared.spawn_sig_verification_failures — audit log of
 * per-spawn URL HMAC mismatches. Every failed verification lands here so
 * a dashboard / on-call can spot agents that are crafting their own URLs
 * (the prompt-injection signature). Includes the path + reason so it's
 * actionable without raw URL leakage. Bounded growth: prune to
 * last 30 days via a periodic job (TODO).
 */
export async function ensureSpawnSigVerificationFailuresTable(): Promise<void> {
  if (flags.spawnSigVerificationFailures) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.spawn_sig_verification_failures (
      id           BIGSERIAL PRIMARY KEY,
      ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
      reason       TEXT NOT NULL,
      claimed_role TEXT,
      claimed_harness TEXT,
      claimed_workspace TEXT,
      claimed_spawn TEXT,
      exp_claim    BIGINT,
      remote_addr  TEXT,
      user_agent   TEXT
    );
    CREATE INDEX IF NOT EXISTS spawn_sig_failures_ts_idx
      ON harness_shared.spawn_sig_verification_failures (ts DESC);
    CREATE INDEX IF NOT EXISTS spawn_sig_failures_reason_idx
      ON harness_shared.spawn_sig_verification_failures (reason, ts DESC);
  `);
  flags.spawnSigVerificationFailures = true;
}

/**
 * Creates harness_shared.ui_clients — presence table for the agent → UI
 * control surface. One row per open browser tab; rows older than 60s
 * (last_seen_at) are stale and filtered out at query time.
 *
 * Canonical migration: 012_ui_control.sql.
 *
 * See: apps/operator/docs/ui-control-plan.md
 */
export async function ensureUiClientsTable(): Promise<void> {
  if (flags.uiClients) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.ui_clients (
      client_id     TEXT PRIMARY KEY,
      workspace_id  TEXT,
      url           TEXT NOT NULL,
      title         TEXT,
      viewport      JSONB,
      opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ui_clients_last_seen_idx
      ON harness_shared.ui_clients (last_seen_at DESC);
  `);
  flags.uiClients = true;
}

/**
 * Creates harness_shared.ui_intents — command channel for the
 * agent → UI control surface. The dispatch tool inserts a row with
 * status='pending'; the browser-side dispatcher SSE-subscribes,
 * executes the named handler, posts back result/error which sets
 * status='done'|'error'. The dispatch tool long-polls until status
 * leaves 'pending' (or timeout).
 *
 * Canonical migration: 012_ui_control.sql.
 */
export async function ensureUiIntentsTable(): Promise<void> {
  if (flags.uiIntents) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.ui_intents (
      id              BIGSERIAL PRIMARY KEY,
      client_id       TEXT NOT NULL,
      intent          TEXT NOT NULL,
      args            JSONB NOT NULL DEFAULT '{}'::jsonb,
      status          TEXT NOT NULL DEFAULT 'pending',
      result          JSONB,
      error_message   TEXT,
      requested_by    TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS ui_intents_pending_idx
      ON harness_shared.ui_intents (client_id, id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS ui_intents_completed_idx
      ON harness_shared.ui_intents (completed_at)
      WHERE completed_at IS NOT NULL;
  `);
  flags.uiIntents = true;
}

/**
 * Backup tables — per-workspace kopia repo settings + snapshot log + event stream.
 * Canonical migration: 013_workspace_backups.sql.
 * See: apps/operator/lib/backup/README.md
 */
export async function ensureBackupTables(): Promise<void> {
  if (flags.workspaceBackupSettings && flags.backupSnapshots && flags.backupEvents) return;
  const { sql } = getOrgPg();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.workspace_backup_settings (
      workspace_id           TEXT PRIMARY KEY,
      enabled                BOOLEAN     NOT NULL DEFAULT TRUE,
      cadence_mode           TEXT        NOT NULL DEFAULT 'both',
      cadence_minutes        INT         NOT NULL DEFAULT 5,
      retention_preset       TEXT        NOT NULL DEFAULT 'default',
      retention_custom_json  JSONB,
      event_triggers_json    JSONB       NOT NULL DEFAULT '["pre_destructive","post_run","plugin_install","secret_change"]',
      excluded_paths_json    JSONB       NOT NULL DEFAULT '[]',
      destination_type             TEXT        NOT NULL DEFAULT 'local',
      destination_config_encrypted TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE harness_shared.workspace_backup_settings
      ADD COLUMN IF NOT EXISTS destination_type             TEXT        NOT NULL DEFAULT 'local';
    ALTER TABLE harness_shared.workspace_backup_settings
      ADD COLUMN IF NOT EXISTS destination_config_encrypted TEXT;
    CREATE TABLE IF NOT EXISTS harness_shared.backup_snapshots (
      id                  BIGSERIAL    PRIMARY KEY,
      workspace_id        TEXT         NOT NULL,
      kopia_snapshot_id   TEXT,
      started_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      finished_at         TIMESTAMPTZ,
      status              TEXT         NOT NULL DEFAULT 'running',
      trigger_reason      TEXT         NOT NULL,
      trigger_context     JSONB,
      bytes_added         BIGINT,
      bytes_total         BIGINT,
      sources_json        JSONB        NOT NULL DEFAULT '[]',
      error_text          TEXT
    );
    CREATE INDEX IF NOT EXISTS backup_snapshots_workspace_idx
      ON harness_shared.backup_snapshots (workspace_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS harness_shared.backup_events (
      id            BIGSERIAL   PRIMARY KEY,
      workspace_id  TEXT        NOT NULL,
      snapshot_id   BIGINT      REFERENCES harness_shared.backup_snapshots(id) ON DELETE CASCADE,
      kind          TEXT        NOT NULL,
      payload_json  JSONB,
      at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS backup_events_workspace_idx
      ON harness_shared.backup_events (workspace_id, at DESC);
  `);
  flags.workspaceBackupSettings = true;
  flags.backupSnapshots = true;
  flags.backupEvents = true;
}

/** Test-only: clear the per-process cache so DDL re-runs. */
export function _resetSchemaEnsureCaches(): void {
  
  
  
  
  
  
  
}
