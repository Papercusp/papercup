import type { Env } from './env.ts';

export interface TenantRow {
  id: string;
  secret_b64: string;
  secret_v: number;
  rotated_from: string | null;
  created_at: number;
  last_used_at: number | null;
  last_ip: string | null;
  status: 'active' | 'revoked' | 'banned';
  tier: 'free' | 'paid' | 'self-host-byo';
  notes: string | null;
}

export interface ProjectRow {
  tenant_id: string;
  harness_slug: string;
  cf_project_name: string;
  cf_subdomain: string | null;
  vanity_subdomain: string | null;
  created_at: number;
}

export interface DeploymentRow {
  id: string;
  tenant_id: string;
  harness_slug: string;
  cf_deployment_id: string | null;
  vanity_url: string | null;
  manifest_sha: string | null;
  archive_path: string | null;
  bytes_total: number | null;
  files_count: number | null;
  status: 'pending_create' | 'uploading' | 'building' | 'live' | 'failed';
  failure_reason: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface DeploymentFileRow {
  deployment_id: string;
  path: string;
  sha256: string;
  bytes: number;
  uploaded: number;
}

export async function insertTenant(
  db: D1Database,
  row: Omit<TenantRow, 'last_used_at' | 'last_ip' | 'rotated_from' | 'notes'> &
    Partial<Pick<TenantRow, 'rotated_from'>>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenants (id, secret_b64, secret_v, rotated_from, created_at, status, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.secret_b64,
      row.secret_v,
      row.rotated_from ?? null,
      row.created_at,
      row.status,
      row.tier,
    )
    .run();
}

export async function getTenant(db: D1Database, id: string): Promise<TenantRow | null> {
  return (await db
    .prepare('SELECT * FROM tenants WHERE id = ?')
    .bind(id)
    .first<TenantRow>()) ?? null;
}

export async function touchTenant(
  db: D1Database,
  id: string,
  ip: string | null,
  ts: number,
): Promise<void> {
  await db
    .prepare('UPDATE tenants SET last_used_at = ?, last_ip = ? WHERE id = ?')
    .bind(ts, ip, id)
    .run();
}

export async function rotateTenantSecret(
  db: D1Database,
  id: string,
  newSecretB64: string,
): Promise<void> {
  await db
    .prepare('UPDATE tenants SET secret_b64 = ?, rotated_from = id WHERE id = ?')
    .bind(newSecretB64, id)
    .run();
}

export async function getProject(
  db: D1Database,
  tenantId: string,
  harnessSlug: string,
): Promise<ProjectRow | null> {
  return (await db
    .prepare(
      'SELECT * FROM projects WHERE tenant_id = ? AND harness_slug = ?',
    )
    .bind(tenantId, harnessSlug)
    .first<ProjectRow>()) ?? null;
}

export async function getProjectByVanity(
  db: D1Database,
  vanity: string,
): Promise<ProjectRow | null> {
  return (await db
    .prepare('SELECT * FROM projects WHERE vanity_subdomain = ?')
    .bind(vanity)
    .first<ProjectRow>()) ?? null;
}

export async function insertProject(db: D1Database, row: ProjectRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO projects (tenant_id, harness_slug, cf_project_name, cf_subdomain, vanity_subdomain, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.tenant_id,
      row.harness_slug,
      row.cf_project_name,
      row.cf_subdomain,
      row.vanity_subdomain,
      row.created_at,
    )
    .run();
}

export async function insertDeployment(
  db: D1Database,
  row: Omit<DeploymentRow, 'cf_deployment_id' | 'vanity_url' | 'archive_path' | 'failure_reason' | 'completed_at'> & {
    vanity_url: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO deployments (id, tenant_id, harness_slug, vanity_url, manifest_sha, bytes_total, files_count, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.tenant_id,
      row.harness_slug,
      row.vanity_url,
      row.manifest_sha,
      row.bytes_total,
      row.files_count,
      row.status,
      row.created_at,
    )
    .run();
}

export async function getDeployment(
  db: D1Database,
  id: string,
): Promise<DeploymentRow | null> {
  return (await db
    .prepare('SELECT * FROM deployments WHERE id = ?')
    .bind(id)
    .first<DeploymentRow>()) ?? null;
}

export async function findRecentDeploymentByManifest(
  db: D1Database,
  tenantId: string,
  harnessSlug: string,
  manifestSha: string,
  sinceTs: number,
): Promise<DeploymentRow | null> {
  return (await db
    .prepare(
      `SELECT * FROM deployments
       WHERE tenant_id = ? AND harness_slug = ? AND manifest_sha = ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(tenantId, harnessSlug, manifestSha, sinceTs)
    .first<DeploymentRow>()) ?? null;
}

export async function setDeploymentStatus(
  db: D1Database,
  id: string,
  status: DeploymentRow['status'],
  patch: Partial<
    Pick<
      DeploymentRow,
      'cf_deployment_id' | 'archive_path' | 'failure_reason' | 'completed_at'
    >
  > = {},
): Promise<void> {
  await db
    .prepare(
      `UPDATE deployments
         SET status = ?,
             cf_deployment_id = COALESCE(?, cf_deployment_id),
             archive_path = COALESCE(?, archive_path),
             failure_reason = COALESCE(?, failure_reason),
             completed_at = COALESCE(?, completed_at)
       WHERE id = ?`,
    )
    .bind(
      status,
      patch.cf_deployment_id ?? null,
      patch.archive_path ?? null,
      patch.failure_reason ?? null,
      patch.completed_at ?? null,
      id,
    )
    .run();
}

export async function listDeploymentFiles(
  db: D1Database,
  deploymentId: string,
): Promise<DeploymentFileRow[]> {
  const r = await db
    .prepare('SELECT * FROM deployment_files WHERE deployment_id = ?')
    .bind(deploymentId)
    .all<DeploymentFileRow>();
  return r.results ?? [];
}

export async function insertDeploymentFiles(
  db: D1Database,
  deploymentId: string,
  files: { path: string; sha256: string; bytes: number }[],
): Promise<void> {
  if (files.length === 0) return;
  const stmts = files.map((f) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO deployment_files (deployment_id, path, sha256, bytes, uploaded)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .bind(deploymentId, f.path, f.sha256, f.bytes),
  );
  await db.batch(stmts);
}

export async function markFileUploaded(
  db: D1Database,
  deploymentId: string,
  sha256: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE deployment_files SET uploaded = 1
       WHERE deployment_id = ? AND sha256 = ?`,
    )
    .bind(deploymentId, sha256)
    .run();
}

export async function consumeJti(
  db: D1Database,
  jti: string,
  exp: number,
): Promise<boolean> {
  try {
    await db
      .prepare('INSERT INTO jti_used (jti, exp) VALUES (?, ?)')
      .bind(jti, exp)
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function audit(
  db: D1Database,
  ts: number,
  outcome: string,
  fields: {
    tenantId?: string | null;
    harnessSlug?: string | null;
    deploymentId?: string | null;
    ip?: string | null;
    ua?: string | null;
    manifestSha?: string | null;
    bytesTotal?: number | null;
  } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_publishes (tenant_id, harness_slug, deployment_id, ip, ua, manifest_sha, bytes_total, outcome, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fields.tenantId ?? null,
      fields.harnessSlug ?? null,
      fields.deploymentId ?? null,
      fields.ip ?? null,
      fields.ua ?? null,
      fields.manifestSha ?? null,
      fields.bytesTotal ?? null,
      outcome,
      ts,
    )
    .run();
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? '';
}
