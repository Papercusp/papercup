// @vitest-environment node
/**
 * snapshot-index.integration.test.ts — the PG round-trip for the hybrid FS+PG
 * snapshot home (harness-blueprint-distribution-2026-06-03 P-006 / D-010).
 *
 * The pure row-builder is covered in snapshot-index.test.ts; this exercises the
 * real SQL against a testcontainer PG: the `::text::jsonb` binding (the form
 * that works under both the operator runtime client AND a fresh pool — see the
 * upsert comment), the ON CONFLICT upsert (re-index updates in place, no dup),
 * the bigint round-trip (bytes / created_at_ms come back as JS numbers), the
 * newest-first ordering, workspace scoping, and delete.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';
import {
  buildSnapshotIndexRow,
  upsertSnapshotIndexRow,
  listSnapshotIndex,
  getSnapshotIndexRow,
  deleteSnapshotIndexRow,
} from './snapshot-index';
import type { SnapshotManifest } from './manifest';

let adminUri: string;
let dbName: string;
let sql: import('postgres').Sql;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `snapidx_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 4, onnotice: () => {} });
  // Mirror of migration 134's table shape (RLS/grants omitted — the test connects
  // as the DB owner, and the helpers scope by an explicit `workspace_id` WHERE).
  // Keep in sync with libs/papercusp/libs/db/sql/134-snapshot-index.sql.
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.snapshot_index (
      workspace_id   text   NOT NULL,
      harness_slug   text   NOT NULL,
      snapshot_id    text   NOT NULL,
      tarball_path   text   NOT NULL,
      bytes          bigint NOT NULL DEFAULT 0,
      content_hash   text,
      created_at_ms  bigint NOT NULL DEFAULT 0,
      name           text,
      description    text,
      license        text,
      manifest       jsonb  NOT NULL DEFAULT '{}'::jsonb,
      published      jsonb  NOT NULL DEFAULT '[]'::jsonb,
      indexed_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, snapshot_id)
    )`);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  const a = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await a.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* a lingering connection may hold it briefly */
  } finally {
    await a.end({ timeout: 5 });
  }
});

function manifest(id: string, createdAt: number): SnapshotManifest {
  return {
    schemaVersion: 2,
    kind: 'snapshot',
    id,
    name: `snap ${id}`,
    harnessSlug: 'sheets',
    substrateVersion: '0.0.1',
    schemaVersion_db: 0,
    minSubstrateVersion: '0.0.1',
    template: { name: 't', version: '0' },
    createdAt,
    files: [],
    excluded: [],
    plugins: [],
    partial: false,
    license: 'MIT',
    redactions: { blockedSecretsTier: 'none', verifiedHits: 0, highRecallHits: 0 },
  } as SnapshotManifest;
}

describe('snapshot_index PG helpers (real round-trip)', () => {
  it('upserts, lists newest-first, gets (jsonb + bigint), conflict-updates, scopes by workspace, deletes', async () => {
    const r1 = buildSnapshotIndexRow(manifest('snap_a', 1000), {
      workspaceId: 'default',
      tarballPath: '/p/.papercusp/snapshots/snap_a.tar.gz',
      bytes: 4096,
      contentHash: 'aa',
      published: [{ slug: 'sheets', version: '1.0.0', browseUrl: 'https://cupboard.papercusp.com/x', publishedAtMs: 5 }],
    });
    const r2 = buildSnapshotIndexRow(manifest('snap_b', 2000), {
      workspaceId: 'default',
      tarballPath: '/p/.papercusp/snapshots/snap_b.tar.gz',
      bytes: 8192,
    });
    await upsertSnapshotIndexRow(sql, r1);
    await upsertSnapshotIndexRow(sql, r2);

    // newest (created_at_ms DESC) first
    const list = await listSnapshotIndex(sql, { workspaceId: 'default', harnessSlug: 'sheets' });
    expect(list.map((r) => r.snapshotId)).toEqual(['snap_b', 'snap_a']);

    // get: bigint→number, jsonb manifest + published array round-trip
    const got = await getSnapshotIndexRow(sql, { workspaceId: 'default', harnessSlug: 'sheets', snapshotId: 'snap_a' });
    expect(got?.bytes).toBe(4096);
    expect(got?.createdAtMs).toBe(1000);
    expect(got?.contentHash).toBe('aa');
    expect(got?.manifest).toMatchObject({ id: 'snap_a', name: 'snap snap_a', harnessSlug: 'sheets' });
    expect(got?.published).toEqual([
      { slug: 'sheets', version: '1.0.0', browseUrl: 'https://cupboard.papercusp.com/x', publishedAtMs: 5 },
    ]);

    // ON CONFLICT upserts in place (no duplicate row)
    await upsertSnapshotIndexRow(sql, { ...r1, bytes: 9999, name: 'renamed' });
    expect((await listSnapshotIndex(sql, { workspaceId: 'default' })).length).toBe(2);
    const a2 = await getSnapshotIndexRow(sql, { workspaceId: 'default', harnessSlug: 'sheets', snapshotId: 'snap_a' });
    expect(a2?.bytes).toBe(9999);
    expect(a2?.name).toBe('renamed');

    // workspace scoping in the query
    expect((await listSnapshotIndex(sql, { workspaceId: 'other' })).length).toBe(0);

    // delete removes just that row
    await deleteSnapshotIndexRow(sql, { workspaceId: 'default', harnessSlug: 'sheets', snapshotId: 'snap_a' });
    expect((await listSnapshotIndex(sql, { workspaceId: 'default' })).map((r) => r.snapshotId)).toEqual(['snap_b']);
  });
});
