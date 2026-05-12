-- 001-telemetry-events.sql
--
-- Schema for the reference telemetry sink. Mirrors the shape the
-- operator's flush worker POSTs:
--
--   { workspace_id, received_at, kind, app_version, os, payload }
--
-- This table is the long-term store. The sink writes one row per
-- inbound report; retention is the operator's call (DELETE by
-- received_at on a schedule, or partition + drop).

CREATE SCHEMA IF NOT EXISTS papercusp_telemetry;

CREATE TABLE IF NOT EXISTS papercusp_telemetry.events (
  id             BIGSERIAL PRIMARY KEY,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id   TEXT NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL,
  kind           TEXT NOT NULL,
  app_version    TEXT,
  os             TEXT,
  payload        JSONB,
  source_ip      INET
);

CREATE INDEX IF NOT EXISTS telemetry_events_ingested_at_idx
  ON papercusp_telemetry.events (ingested_at DESC);

CREATE INDEX IF NOT EXISTS telemetry_events_workspace_kind_idx
  ON papercusp_telemetry.events (workspace_id, kind, ingested_at DESC);

CREATE INDEX IF NOT EXISTS telemetry_events_kind_idx
  ON papercusp_telemetry.events (kind, ingested_at DESC);

-- Daily-rollup view for cheap dashboard queries.
CREATE OR REPLACE VIEW papercusp_telemetry.events_daily AS
  SELECT
    date_trunc('day', ingested_at) AS day,
    kind,
    app_version,
    os,
    COUNT(*) AS n
  FROM papercusp_telemetry.events
  GROUP BY 1, 2, 3, 4
  ORDER BY 1 DESC, 5 DESC;
