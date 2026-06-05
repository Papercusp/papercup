/**
 * E3 / P-006 — hybrid FS+PG snapshot home (harness-blueprint-distribution-2026-06-03,
 * D-010). Exercises the operator-side wiring on top of the export-state
 * `snapshot_index` PG ops (migration 134):
 *   - indexSnapshot writes a row; the jsonb columns round-trip as real objects
 *     (the `::text::jsonb` binding — NOT `sql.json()`, which throws under the
 *     operator's getOrgPg client; see agent-insights/postgres-js-jsonb-binding);
 *   - get + remove round-trip;
 *   - discovery serves listings from PG (not by re-tar-ing the blob);
 *   - the FS-reconcile sweep back-fills a row for an orphan tarball;
 *   - the sweep prunes an index row whose tarball is gone.
 *
 * Only `@papercusp/db-org` is mocked (getOrgPg → the testcontainer client). The
 * active workspace is set via PAPERCUSP_WORKSPACE_ID and the harness registry is
 * SEEDED in the test DB, so workspace-registry + harness-registry run for real.
 *
 * NB: per the jsonb-binding insight, the testcontainer client binds jsonb
 * differently from production for the OLD forms — but `::text::jsonb` (what the
 * upsert uses) stores a real jsonb object under BOTH, so this test is faithful.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getTestPg } from '@papercusp/test-config';
import { tarGzipStaging, type SnapshotManifest } from '@papercusp/export-state';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

// Imported AFTER the mock is declared (vi.mock is hoisted above all imports).
import {
  indexSnapshot,
  listIndexedSnapshots,
  getIndexedSnapshot,
  removeIndexedSnapshot,
} from '@papercusp/operator-core/lib/snapshot-index';
import { listAllSnapshots } from '@papercusp/operator-core/lib/snapshot-discovery';

const WS = 'ws-snap-test';
let adminUri: string;
let dbName: string;
let sql: postgres.Sql;
let tmpRoot: string;
let projDir: string;
let snapDir: string;
let prevWs: string | undefined;

function resetListCache(): void {
  // The discovery module holds a FIXED reference to this object (bound at module
  // load), so we must MUTATE its fields — replacing the global key would leave the
  // module pointing at the stale object and the 5 s TTL would serve cross-test results.
  const c = (globalThis as unknown as Record<symbol, { expires: number; inflight: unknown; value: unknown } | undefined>)[
    Symbol.for('papercusp.snapshotListCache')
  ];
  if (c) {
    c.expires = 0;
    c.inflight = null;
    c.value = null;
  }
}

function fixtureManifest(id: string, over: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    schemaVersion: 2,
    kind: 'snapshot',
    id,
    name: `snap ${id}`,
    harnessSlug: 'demo',
    substrateVersion: '0.0.1',
    schemaVersion_db: 0,
    minSubstrateVersion: '0.0.1',
    template: { name: 'demo', version: '0.0.0' },
    createdAt: 1_700_000_000_000,
    files: [],
    excluded: [],
    plugins: [],
    partial: false,
    license: 'MIT',
    redactions: { blockedSecretsTier: 'none', verifiedHits: 0, highRecallHits: 0 },
    ...over,
  };
}

/** Build a faithful snapshot tarball (manifest.json inside) + its .sha256 sidecar. */
async function makeTarball(manifest: SnapshotManifest, sha = `sha-${manifest.id}`): Promise<string> {
  const stage = await fs.mkdtemp(join(tmpdir(), 'snapstage-'));
  await fs.writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest));
  const out = join(snapDir, `${manifest.id}.tar.gz`);
  await tarGzipStaging({ stagingDir: stage, outputPath: out });
  await fs.writeFile(`${out}.sha256`, `${sha}  ${manifest.id}.tar.gz\n`);
  await fs.rm(stage, { recursive: true, force: true });
  return out;
}

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
  h.sql = sql;

  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  // migration 134 (table only — RLS/grants need roles absent in the testcontainer).
  await sql.unsafe(`
    CREATE TABLE harness_shared.snapshot_index (
      snapshot_id   text NOT NULL,
      workspace_id  text NOT NULL,
      harness_slug  text NOT NULL,
      tarball_path  text NOT NULL,
      bytes         bigint NOT NULL,
      content_hash  text,
      created_at_ms bigint NOT NULL,
      name          text,
      description   text,
      license       text,
      manifest      jsonb NOT NULL,
      published     jsonb NOT NULL DEFAULT '[]'::jsonb,
      indexed_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, snapshot_id)
    );
  `);
  // harness_registry (migration 025 shape) so loadHarnessRegistry runs for real.
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_registry (
      workspace_id text PRIMARY KEY,
      payload      jsonb NOT NULL,
      updated_at   bigint
    );
  `);

  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'snapidx-root-'));
  projDir = join(tmpRoot, 'demo');
  snapDir = join(projDir, '.papercusp', 'snapshots');
  await fs.mkdir(snapDir, { recursive: true });

  await sql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload, updated_at)
    VALUES (${WS}, ${JSON.stringify({ projects: [{ slug: 'demo', path: projDir }] })}::text::jsonb, ${Date.now()})
  `;

  prevWs = process.env.PAPERCUSP_WORKSPACE_ID;
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
}, 90_000);

afterAll(async () => {
  if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = prevWs;
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  resetListCache();
});

describe('snapshot_index PG ops (the bug guard: jsonb binds without sql.json throwing)', () => {
  it('indexSnapshot writes a row; manifest + published round-trip as real jsonb objects', async () => {
    const m = fixtureManifest('snap_a', { name: 'aaa', description: 'd1', license: 'Apache-2.0' });
    await indexSnapshot(m, {
      tarballPath: '/x/snap_a.tar.gz',
      bytes: 4242,
      contentHash: 'sha-a',
      published: [{ slug: 's', version: '1.0.0', browseUrl: 'http://x', publishedAtMs: 5 }],
    });

    const row = (await listIndexedSnapshots('demo')).find((r) => r.snapshotId === 'snap_a');
    expect(row).toBeTruthy();
    expect(row!.bytes).toBe(4242);
    expect(row!.contentHash).toBe('sha-a');
    expect(row!.name).toBe('aaa');
    expect((row!.manifest as SnapshotManifest).id).toBe('snap_a');
    expect(row!.published[0]?.version).toBe('1.0.0');

    // DB-level: the jsonb columns are real objects/arrays, not double-encoded strings.
    const t = await sql`
      SELECT jsonb_typeof(manifest) AS m, jsonb_typeof(published) AS p
        FROM harness_shared.snapshot_index WHERE snapshot_id = 'snap_a'`;
    expect(t[0].m).toBe('object');
    expect(t[0].p).toBe('array');
  });

  it('getIndexedSnapshot + removeIndexedSnapshot round-trip', async () => {
    const m = fixtureManifest('snap_b');
    await indexSnapshot(m, { tarballPath: '/x/snap_b.tar.gz', bytes: 1, contentHash: null });
    expect(await getIndexedSnapshot('demo', 'snap_b')).toBeTruthy();
    await removeIndexedSnapshot('demo', 'snap_b');
    expect(await getIndexedSnapshot('demo', 'snap_b')).toBeNull();
  });
});

describe('PG-indexed discovery + FS reconcile sweep', () => {
  it('serves listings from PG, not from the tarball', async () => {
    // tarball on disk says name 'from-tar'; the indexed row says 'from-pg'.
    const m = fixtureManifest('snap_c', { name: 'from-tar' });
    await makeTarball(m);
    await indexSnapshot({ ...m, name: 'from-pg' }, {
      tarballPath: join(snapDir, 'snap_c.tar.gz'),
      bytes: 99,
      contentHash: 'h-c',
    });

    const listing = (await listAllSnapshots()).find((s) => s.id === 'snap_c');
    expect(listing).toBeTruthy();
    expect(listing!.manifest.name).toBe('from-pg'); // PG is the source of truth
    expect(listing!.bytes).toBe(99);
    expect(listing!.harnessSlug).toBe('demo');
  });

  it('FS-reconcile back-fills an index row for an orphan tarball (manifest + sha from disk)', async () => {
    const m = fixtureManifest('snap_d', { name: 'orphan' });
    await makeTarball(m, 'orphan-sha-d');
    expect(await getIndexedSnapshot('demo', 'snap_d')).toBeNull(); // not indexed yet

    const listing = (await listAllSnapshots()).find((s) => s.id === 'snap_d');
    expect(listing?.manifest.name).toBe('orphan');

    const row = await getIndexedSnapshot('demo', 'snap_d');
    expect(row).toBeTruthy();
    expect(row!.contentHash).toBe('orphan-sha-d'); // read from the .sha256 sidecar
    expect(row!.tarballPath).toBe(join(snapDir, 'snap_d.tar.gz'));
  });

  it('FS-reconcile prunes an index row whose tarball is gone', async () => {
    const m = fixtureManifest('snap_e');
    await indexSnapshot(m, { tarballPath: '/nonexistent/snap_e.tar.gz', bytes: 1, contentHash: null });
    expect(await getIndexedSnapshot('demo', 'snap_e')).toBeTruthy();

    const all = await listAllSnapshots();
    expect(all.find((s) => s.id === 'snap_e')).toBeUndefined(); // dropped from results
    expect(await getIndexedSnapshot('demo', 'snap_e')).toBeNull(); // and pruned from the index
  });
});
