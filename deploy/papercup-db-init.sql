-- One-time bootstrap on the existing restart-postgres container.
-- Run as superuser:
--   docker exec -i restart-postgres-1 psql -U postgres < deploy/papercusp-db-init.sql
--
-- Creates:
--   1. database `papercusp` owned by postgres_app (the harness DB,
--      previously named restart_harness on local).
--   2. schema `papercup_shared` inside the existing `restart` database
--      (papercup-specific tables: messages, recipients, comments,
--      directive_summaries — see memory note papercup_shared schema).
--
-- After this:
--   - pg_dump local papercusp DB → restore into Hetzner papercusp.
--   - pg_dump local restart DB papercup_shared schema → restore into
--     Hetzner restart.papercup_shared.

CREATE DATABASE papercusp OWNER postgres_app;
\c restart
CREATE SCHEMA IF NOT EXISTS papercup_shared AUTHORIZATION postgres_app;
GRANT ALL ON SCHEMA papercup_shared TO postgres_app;
