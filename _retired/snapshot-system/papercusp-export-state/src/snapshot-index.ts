/**
 * Snapshot index — the PG half of the hybrid FS+PG snapshot home
 * (`harness-blueprint-distribution-2026-06-03` P-006 / D-010).
 *
 * Export-state snapshots are immutable `.tar.gz` blobs on the filesystem; this
 * module is the PG INDEX over them (`harness_shared.snapshot_index`, migration
 * 134) so discovery is a query, not an FS-walk that `tar -xzO`'s every manifest.
 * The tarball stays the blob — PG holds one row per snapshot.
 *
 * Two layers, deliberately split:
 *   - `buildSnapshotIndexRow` — PURE (manifest + blob facts → a row). No I/O;
 *     unit-tested without a DB.
 *   - `upsert/list/get/delete` — generic postgres-js table ops. The OPERATOR
 *     route layer decides WHEN to call them (write on create, read in
 *     discovery, delete on retract) — keeping the index an operator concern
 *     while the reusable mechanics live here next to the rest of the snapshot
 *     PG access (pg-dump.ts).
 *
 * NOT the legacy `harness_snapshots(_consolidated)` iteration-snapshot tables —
 * see migration 134's header.
 */
import type { Sql } from 'postgres';
import type { SnapshotManifest } from './manifest';

/** A publish record (mirrors the legacy `<id>.published.json` sidecar). */
export interface SnapshotPublishRecord {
  slug: string;
  version: string;
  browseUrl: string;
  publishedAtMs: number;
}

/** One row of `harness_shared.snapshot_index` (camelCase). */
export interface SnapshotIndexRow {
  workspaceId: string;
  harnessSlug: string;
  snapshotId: string;
  tarballPath: string;
  bytes: number;
  contentHash: string | null;
  createdAtMs: number;
  name: string | null;
  description: string | null;
  license: string | null;
  /** The full snapshot manifest, for rich discovery without re-tar-ing. */
  manifest: SnapshotManifest | Record<string, unknown>;
  published: SnapshotPublishRecord[];
}

/**
 * Build an index row from a snapshot manifest + the blob facts known at write
 * time. Pure — the single place manifest fields map onto index columns.
 */
export function buildSnapshotIndexRow(
  manifest: SnapshotManifest,
  opts: {
    workspaceId: string;
    tarballPath: string;
    bytes: number;
    contentHash?: string | null;
    published?: SnapshotPublishRecord[];
  },
): SnapshotIndexRow {
  return {
    workspaceId: opts.workspaceId,
    harnessSlug: manifest.harnessSlug,
    snapshotId: manifest.id,
    tarballPath: opts.tarballPath,
    bytes: opts.bytes,
    contentHash: opts.contentHash ?? null,
    createdAtMs: manifest.createdAt,
    name: manifest.name ?? null,
    description: manifest.description ?? null,
    license: manifest.license ?? null,
    manifest,
    published: opts.published ?? [],
  };
}

/** Map a raw DB row (snake_case; bigints come back as strings) → SnapshotIndexRow. */
function rowFromDb(r: Record<string, unknown>): SnapshotIndexRow {
  return {
    workspaceId: String(r.workspace_id),
    harnessSlug: String(r.harness_slug),
    snapshotId: String(r.snapshot_id),
    tarballPath: String(r.tarball_path),
    bytes: Number(r.bytes ?? 0),
    contentHash: r.content_hash == null ? null : String(r.content_hash),
    createdAtMs: Number(r.created_at_ms ?? 0),
    name: r.name == null ? null : String(r.name),
    description: r.description == null ? null : String(r.description),
    license: r.license == null ? null : String(r.license),
    manifest: (r.manifest as Record<string, unknown>) ?? {},
    published: Array.isArray(r.published) ? (r.published as SnapshotPublishRecord[]) : [],
  };
}

/** Insert-or-update one snapshot's index row (idempotent on re-index). */
export async function upsertSnapshotIndexRow(sql: Sql, row: SnapshotIndexRow): Promise<void> {
  // jsonb columns (manifest, published) are bound as `${JSON.stringify(x)}::text::jsonb`
  // — the client-agnostic form that stores a real jsonb object under BOTH the
  // operator runtime client (getOrgPg, where `sql.json()` / a bare object param
  // THROW "Buffer.byteLength received Object") AND a fresh/testcontainer pool. Do
  // NOT switch back to `sql.json()` here — it landed zero rows in prod elsewhere.
  // See /internal/docs/agent-insights/postgres-js-jsonb-binding.
  await sql`
    INSERT INTO harness_shared.snapshot_index
      (workspace_id, harness_slug, snapshot_id, tarball_path, bytes, content_hash,
       created_at_ms, name, description, license, manifest, published)
    VALUES (
      ${row.workspaceId}, ${row.harnessSlug}, ${row.snapshotId}, ${row.tarballPath},
      ${row.bytes}, ${row.contentHash}, ${row.createdAtMs}, ${row.name},
      ${row.description}, ${row.license}, ${JSON.stringify(row.manifest)}::text::jsonb,
      ${JSON.stringify(row.published)}::text::jsonb
    )
    ON CONFLICT (workspace_id, harness_slug, snapshot_id) DO UPDATE SET
      tarball_path  = EXCLUDED.tarball_path,
      bytes         = EXCLUDED.bytes,
      content_hash  = EXCLUDED.content_hash,
      created_at_ms = EXCLUDED.created_at_ms,
      name          = EXCLUDED.name,
      description   = EXCLUDED.description,
      license       = EXCLUDED.license,
      manifest      = EXCLUDED.manifest,
      published     = EXCLUDED.published,
      indexed_at    = now()
  `;
}

/** List a workspace's snapshots (optionally one harness), newest first. */
export async function listSnapshotIndex(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug?: string },
): Promise<SnapshotIndexRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT workspace_id, harness_slug, snapshot_id, tarball_path, bytes, content_hash,
           created_at_ms, name, description, license, manifest, published
      FROM harness_shared.snapshot_index
     WHERE workspace_id = ${opts.workspaceId}
       ${opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``}
     ORDER BY created_at_ms DESC, snapshot_id DESC
  `;
  return rows.map(rowFromDb);
}

/** Fetch one index row, or null. */
export async function getSnapshotIndexRow(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug: string; snapshotId: string },
): Promise<SnapshotIndexRow | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT workspace_id, harness_slug, snapshot_id, tarball_path, bytes, content_hash,
           created_at_ms, name, description, license, manifest, published
      FROM harness_shared.snapshot_index
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
       AND snapshot_id  = ${opts.snapshotId}
     LIMIT 1
  `;
  return rows[0] ? rowFromDb(rows[0]) : null;
}

/** Remove a snapshot's index row (e.g. on retract/delete of the tarball). */
export async function deleteSnapshotIndexRow(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug: string; snapshotId: string },
): Promise<void> {
  await sql`
    DELETE FROM harness_shared.snapshot_index
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
       AND snapshot_id  = ${opts.snapshotId}
  `;
}
