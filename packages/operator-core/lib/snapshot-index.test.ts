/**
 * Unit tests for the OPERATOR-CORE copy of snapshot-index.ts
 * (harness-blueprint-distribution-2026-06-03 E3 / P-006 / D-010). The PG ops are
 * exercised against a real testcontainer in
 * `apps/operator/test/snapshot-index.integration.test.ts`; this file covers the
 * FS-side facts the operator wrapper folds in — the part that needs no DB:
 *
 *   - readPublishesSidecar: parses a `<id>.published.json` array, filtering out
 *     malformed records; tolerates a missing/garbage file (→ []);
 *   - readTarballSha: reads the `<tarball>.sha256` sidecar's first token;
 *   - reconcileTarballIntoIndex: the publish→index round-trip — a publish writes
 *     `<id>.published.json`, and reconcile reads it back INTO the index row's
 *     `published` (the seam between publish.ts's recordPublish and discovery's
 *     PG row). buildSnapshotIndexRow runs FOR REAL; only the DB upsert + the
 *     tarball manifest read are stubbed (no subprocess, no PG).
 *
 * Temp dirs; getOrgPg + activeWorkspaceId + readManifestFromTarball mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SnapshotManifest, SnapshotIndexRow } from '@papercusp/export-state';

// Capture every upserted row. getOrgPg returns a throwing sql proxy so a real
// query would blow up — but upsertSnapshotIndexRow is mocked to NOT touch it.
const upsertCalls: SnapshotIndexRow[] = [];

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: new Proxy({}, { get() { throw new Error('sql should not be called in unit test'); } }) }),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-unit' }));

// Mock ONLY the DB-touching op + the subprocess tarball read; keep the pure
// buildSnapshotIndexRow real so the folded-in `published` actually flows through.
vi.mock('@papercusp/export-state', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    upsertSnapshotIndexRow: vi.fn(async (_sql: unknown, row: SnapshotIndexRow) => {
      upsertCalls.push(row);
    }),
    readManifestFromTarball: vi.fn(),
  };
});

import { readManifestFromTarball } from '@papercusp/export-state';
import {
  readPublishesSidecar,
  readTarballSha,
  reconcileTarballIntoIndex,
} from './snapshot-index';

function manifest(over: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    schemaVersion: 2,
    kind: 'snapshot',
    id: 'snap_unit',
    name: 'unit snap',
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
  } as SnapshotManifest;
}

let dir: string;

beforeEach(async () => {
  upsertCalls.length = 0;
  vi.clearAllMocks();
  dir = await fs.mkdtemp(join(tmpdir(), 'snapidx-unit-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('readPublishesSidecar', () => {
  it('reads + filters a `<id>.published.json` array', async () => {
    const tarball = join(dir, 'snap_a.tar.gz');
    const sidecar = join(dir, 'snap_a.published.json');
    await fs.writeFile(
      sidecar,
      JSON.stringify([
        { slug: 'snap_a', version: 'L1', browseUrl: 'papercusp://cupboard/L1', publishedAtMs: 5 },
        // malformed records get dropped by the shape filter:
        { slug: 'snap_a' }, // missing fields
        { version: 'x', browseUrl: 'y', publishedAtMs: 'not-a-number' },
        'a bare string',
      ]),
    );
    const recs = await readPublishesSidecar(tarball);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toEqual({ slug: 'snap_a', version: 'L1', browseUrl: 'papercusp://cupboard/L1', publishedAtMs: 5 });
  });

  it('returns [] for a missing sidecar', async () => {
    expect(await readPublishesSidecar(join(dir, 'nope.tar.gz'))).toEqual([]);
  });

  it('returns [] for a non-array / garbage sidecar', async () => {
    const tarball = join(dir, 'snap_g.tar.gz');
    await fs.writeFile(join(dir, 'snap_g.published.json'), '{ not valid json');
    expect(await readPublishesSidecar(tarball)).toEqual([]);
    await fs.writeFile(join(dir, 'snap_g.published.json'), JSON.stringify({ not: 'an array' }));
    expect(await readPublishesSidecar(tarball)).toEqual([]);
  });
});

describe('readTarballSha', () => {
  it('reads the first token of the `<tarball>.sha256` sidecar', async () => {
    const tarball = join(dir, 'snap_s.tar.gz');
    await fs.writeFile(`${tarball}.sha256`, 'deadbeefcafe  snap_s.tar.gz\n');
    expect(await readTarballSha(tarball)).toBe('deadbeefcafe');
  });

  it('returns null when the sidecar is absent (pre-sidecar tarball)', async () => {
    expect(await readTarballSha(join(dir, 'snap_nosha.tar.gz'))).toBeNull();
  });
});

describe('reconcileTarballIntoIndex — publish→index round-trip for `published`', () => {
  it('reads the publish sidecar back into the upserted index row', async () => {
    const tarball = join(dir, 'snap_rt.tar.gz');
    // a real tarball on disk (stat must succeed); contents don't matter (manifest
    // read is stubbed below).
    await fs.writeFile(tarball, Buffer.from('fake tarball bytes'));
    await fs.writeFile(`${tarball}.sha256`, 'abc123  snap_rt.tar.gz\n');

    // SIMULATE a publish having written the publish-history sidecar (publish.ts
    // recordPublish writes exactly this shape).
    const publishRec = {
      slug: 'snap_rt',
      version: 'listing-xyz',
      browseUrl: 'papercusp://cupboard/listing-xyz',
      publishedAtMs: 1_700_000_111_000,
    };
    await fs.writeFile(join(dir, 'snap_rt.published.json'), JSON.stringify([publishRec]));

    (readManifestFromTarball as Mock).mockResolvedValue(manifest({ id: 'snap_rt', harnessSlug: 'demo', name: 'rt' }));

    const row = await reconcileTarballIntoIndex(tarball);

    // The row built + upserted carries the publish record from the sidecar.
    expect(row).not.toBeNull();
    expect(row!.snapshotId).toBe('snap_rt');
    expect(row!.workspaceId).toBe('ws-unit');
    expect(row!.contentHash).toBe('abc123'); // from the .sha256 sidecar
    expect(row!.bytes).toBe(Buffer.from('fake tarball bytes').byteLength);
    expect(row!.published).toEqual([publishRec]); // ← read back from .published.json

    // and it actually upserted (the DB seam), with the same published array.
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].published).toEqual([publishRec]);
    expect(upsertCalls[0].snapshotId).toBe('snap_rt');
  });

  it('an empty publish sidecar yields published:[] on the row', async () => {
    const tarball = join(dir, 'snap_np.tar.gz');
    await fs.writeFile(tarball, Buffer.from('x'));
    (readManifestFromTarball as Mock).mockResolvedValue(manifest({ id: 'snap_np', harnessSlug: 'demo' }));

    const row = await reconcileTarballIntoIndex(tarball);
    expect(row!.published).toEqual([]);
    expect(row!.contentHash).toBeNull(); // no .sha256 sidecar
  });

  it('returns null (best-effort) when the tarball cannot be read', async () => {
    // stat throws → reconcile swallows it and returns null so a bad tarball can't
    // break the caller's listing/publish flow.
    const row = await reconcileTarballIntoIndex(join(dir, 'does-not-exist.tar.gz'));
    expect(row).toBeNull();
    expect(upsertCalls).toHaveLength(0);
  });
});
