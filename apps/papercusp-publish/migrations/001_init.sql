-- §15.3 D1 schema for publish service.

-- secret_b64: tenantSecret stored directly (base64url, 32 raw bytes).
--   Spec §15.4 specified HMAC(secret, HASH_PEPPER) but that's one-way and
--   can't verify the per-publish JWT (which is HMAC-signed with the secret).
--   v1 stores the secret directly; D1 is at-rest encrypted by Cloudflare.
--   v1.1 hardening: AES-GCM envelope encryption keyed by HASH_PEPPER.
CREATE TABLE IF NOT EXISTS tenants (
  id              TEXT PRIMARY KEY,
  secret_b64      TEXT NOT NULL,
  secret_v        INTEGER NOT NULL DEFAULT 1,
  rotated_from    TEXT,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  last_ip         TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  tier            TEXT NOT NULL DEFAULT 'free',
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  tenant_id        TEXT NOT NULL,
  harness_slug     TEXT NOT NULL,
  cf_project_name  TEXT NOT NULL,
  cf_subdomain     TEXT,
  vanity_subdomain TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, harness_slug),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_projects_vanity ON projects(vanity_subdomain);

CREATE TABLE IF NOT EXISTS deployments (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  harness_slug     TEXT NOT NULL,
  cf_deployment_id TEXT,
  vanity_url       TEXT,
  manifest_sha     TEXT,
  archive_path     TEXT,
  bytes_total      INTEGER,
  files_count      INTEGER,
  status           TEXT NOT NULL DEFAULT 'pending_create',
  failure_reason   TEXT,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_deployments_tenant_created ON deployments(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deployments_manifest_sha ON deployments(tenant_id, harness_slug, manifest_sha);

CREATE TABLE IF NOT EXISTS deployment_files (
  deployment_id   TEXT NOT NULL,
  path            TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  uploaded        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (deployment_id, sha256),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id)
);
CREATE INDEX IF NOT EXISTS idx_deployment_files_dep ON deployment_files(deployment_id);

-- Replay protection — atomic via PRIMARY KEY (D1 serializable per-DB transactions).
CREATE TABLE IF NOT EXISTS jti_used (
  jti  TEXT PRIMARY KEY,
  exp  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jti_exp ON jti_used(exp);

CREATE TABLE IF NOT EXISTS audit_publishes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT,
  harness_slug    TEXT,
  deployment_id   TEXT,
  ip              TEXT,
  ua              TEXT,
  manifest_sha    TEXT,
  bytes_total     INTEGER,
  outcome         TEXT NOT NULL,
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_publishes(ts);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit_publishes(tenant_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_harness_ts ON audit_publishes(harness_slug, ts);
CREATE INDEX IF NOT EXISTS idx_audit_ip_ts ON audit_publishes(ip, ts);
