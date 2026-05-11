-- workspace_backup_settings / backup_snapshots / backup_events
--
-- Per-workspace kopia repo metadata + UI state. Kopia is the source of
-- truth for snapshot contents; PG is the source of truth for settings,
-- per-snapshot metadata (timing, trigger, bytes, source list), and the
-- audit/event stream consumed by the /dev backups tab and the
-- /settings/backups page.
--
-- Why both layers: kopia exposes its own snapshot list via CLI, but
-- (a) it doesn't carry our trigger-reason, (b) querying it from the UI
-- means shelling out per request, and (c) we want to render history
-- even when the kopia binary or repo is temporarily unavailable.
-- Every kopia write is paired with a PG row in the same TS
-- transaction so the two stay in sync.
--
-- Repo location convention: ~/.papercusp-workspaces/<workspace_id>/backups/kopia-repo/
-- Repo password: HKDF derived from the workspace's db-encryption-key
-- (no separate secret to store; lost key = lost backups, same domain
-- as existing PG encryption).

CREATE TABLE IF NOT EXISTS harness_shared.workspace_backup_settings (
  workspace_id           TEXT PRIMARY KEY,
  enabled                BOOLEAN     NOT NULL DEFAULT TRUE,
  cadence_mode           TEXT        NOT NULL DEFAULT 'both',          -- 'event' | 'interval' | 'both'
  cadence_minutes        INT         NOT NULL DEFAULT 5,               -- only used when mode includes 'interval'
  retention_preset       TEXT        NOT NULL DEFAULT 'default',       -- 'aggressive' | 'default' | 'conservative' | 'custom'
  retention_custom_json  JSONB,                                        -- {keepLatest, keepHourly, keepDaily, keepWeekly, keepMonthly}
  event_triggers_json    JSONB       NOT NULL DEFAULT '["pre_destructive","post_run","plugin_install","secret_change"]',
  excluded_paths_json    JSONB       NOT NULL DEFAULT '[]',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS harness_shared.backup_snapshots (
  id                  BIGSERIAL    PRIMARY KEY,
  workspace_id        TEXT         NOT NULL,
  kopia_snapshot_id   TEXT,                                            -- null while in-flight; populated on success
  started_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  status              TEXT         NOT NULL DEFAULT 'running',         -- 'running' | 'ok' | 'failed' | 'aborted'
  trigger_reason      TEXT         NOT NULL,                           -- 'manual' | 'interval' | 'pre_destructive' | 'post_run' | 'plugin_install' | 'secret_change' | 'startup'
  trigger_context     JSONB,                                           -- free-form: { harness, run, agent, etc. }
  bytes_added         BIGINT,                                          -- post-dedup
  bytes_total         BIGINT,                                          -- raw scanned
  sources_json        JSONB        NOT NULL DEFAULT '[]',
  error_text          TEXT
);
CREATE INDEX IF NOT EXISTS backup_snapshots_workspace_idx
  ON harness_shared.backup_snapshots (workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS harness_shared.backup_events (
  id            BIGSERIAL   PRIMARY KEY,
  workspace_id  TEXT        NOT NULL,
  snapshot_id   BIGINT      REFERENCES harness_shared.backup_snapshots(id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL,                                  -- 'progress' | 'hook_pg_dump' | 'hook_sqlite' | 'maintenance' | 'verify' | 'restore'
  payload_json  JSONB,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_events_workspace_idx
  ON harness_shared.backup_events (workspace_id, at DESC);
