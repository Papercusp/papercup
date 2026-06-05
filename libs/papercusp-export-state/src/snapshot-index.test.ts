import { describe, expect, it } from 'vitest';
import { buildSnapshotIndexRow, type SnapshotPublishRecord } from './snapshot-index';
import type { SnapshotManifest } from './manifest';

function fakeManifest(overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    schemaVersion: 2,
    kind: 'snapshot',
    id: 'snap_abc123',
    name: 'My Snapshot',
    description: 'a test snapshot',
    harnessSlug: 'sheets',
    substrateVersion: '0.0.1',
    schemaVersion_db: 0,
    minSubstrateVersion: '0.0.1',
    template: { name: 'sheets-clone', version: '0.0.0' },
    createdAt: 1778132964000,
    files: [],
    excluded: [],
    plugins: [],
    partial: false,
    license: 'MIT',
    redactions: { blockedSecretsTier: 'none', verifiedHits: 0, highRecallHits: 0 },
    ...overrides,
  } as SnapshotManifest;
}

describe('buildSnapshotIndexRow', () => {
  it('maps manifest + blob facts onto the index row', () => {
    const m = fakeManifest();
    const row = buildSnapshotIndexRow(m, {
      workspaceId: 'default',
      tarballPath: '/x/.papercusp/snapshots/snap_abc123.tar.gz',
      bytes: 4096,
      contentHash: 'deadbeef',
    });
    expect(row).toMatchObject({
      workspaceId: 'default',
      harnessSlug: 'sheets',
      snapshotId: 'snap_abc123',
      tarballPath: '/x/.papercusp/snapshots/snap_abc123.tar.gz',
      bytes: 4096,
      contentHash: 'deadbeef',
      createdAtMs: 1778132964000,
      name: 'My Snapshot',
      description: 'a test snapshot',
      license: 'MIT',
    });
    expect(row.manifest).toBe(m); // full manifest preserved for rich discovery
    expect(row.published).toEqual([]);
  });

  it('defaults contentHash→null, absent description→null, published→[]', () => {
    const row = buildSnapshotIndexRow(fakeManifest({ description: undefined }), {
      workspaceId: 'w',
      tarballPath: '/t.tgz',
      bytes: 0,
    });
    expect(row.contentHash).toBeNull();
    expect(row.description).toBeNull();
    expect(row.published).toEqual([]);
  });

  it('passes publish records through unchanged', () => {
    const pub: SnapshotPublishRecord[] = [
      { slug: 'sheets', version: '1.0.0', browseUrl: 'https://cupboard.papercusp.com/x', publishedAtMs: 123 },
    ];
    const row = buildSnapshotIndexRow(fakeManifest(), { workspaceId: 'w', tarballPath: '/t.tgz', bytes: 1, published: pub });
    expect(row.published).toBe(pub);
  });

  it('stores the tarball path opaquely (survives the .harness→.papercusp rename)', () => {
    const legacy = buildSnapshotIndexRow(fakeManifest(), {
      workspaceId: 'w',
      tarballPath: '/p/.harness/snapshots/snap_x.tar.gz',
      bytes: 1,
    });
    const renamed = buildSnapshotIndexRow(fakeManifest(), {
      workspaceId: 'w',
      tarballPath: '/p/.papercusp/snapshots/snap_x.tar.gz',
      bytes: 1,
    });
    expect(legacy.tarballPath).toContain('.harness/snapshots');
    expect(renamed.tarballPath).toContain('.papercusp/snapshots');
  });
});
