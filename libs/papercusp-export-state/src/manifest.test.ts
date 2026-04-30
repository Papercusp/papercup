import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_SCHEMA_VERSION,
  newForkSlugSuffix,
  newSnapshotId,
  validateSnapshotManifest,
} from './manifest';

const valid = () => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  kind: 'snapshot' as const,
  id: 'snap_abc123def456',
  name: 'sheets-clone with formula engine v2',
  description: 'mid-mission',
  harnessSlug: 'sheets',
  substrateVersion: '0.7.1',
  schemaVersion_db: 25,
  minSubstrateVersion: '0.7.0',
  template: { name: 'papercup-coding', version: '0.1.0' },
  createdAt: 1714267200000,
  files: [{ path: 'manifest.json', sha256: 'a'.repeat(64), bytes: 100 }],
  excluded: [],
  plugins: [],
  partial: false,
  license: 'MIT',
  redactions: { blockedSecretsTier: 'none' as const, verifiedHits: 0, highRecallHits: 0 },
});

describe('snapshot manifest', () => {
  it('newSnapshotId returns snap_<base32>', () => {
    const id = newSnapshotId();
    expect(id).toMatch(/^snap_[a-z2-7]{12}$/);
  });

  it('newForkSlugSuffix returns 6 base32 chars', () => {
    expect(newForkSlugSuffix()).toMatch(/^[a-z2-7]{6}$/);
  });

  it('validates a complete manifest', () => {
    expect(() => validateSnapshotManifest(valid())).not.toThrow();
  });

  it('rejects missing required string fields', () => {
    const m = valid();
    delete (m as Record<string, unknown>).id;
    expect(() => validateSnapshotManifest(m)).toThrow(/id/);
  });

  it('rejects wrong schemaVersion', () => {
    const m = { ...valid(), schemaVersion: 999 };
    expect(() => validateSnapshotManifest(m)).toThrow(/schemaVersion/);
  });

  it('rejects non-array files / excluded / plugins', () => {
    const m = valid();
    (m as Record<string, unknown>).files = 'not an array';
    expect(() => validateSnapshotManifest(m)).toThrow(/files/);
  });

  it('rejects missing template fields', () => {
    const m = valid();
    (m as Record<string, unknown>).template = { name: 'x' };
    expect(() => validateSnapshotManifest(m)).toThrow(/template/);
  });

  it('rejects missing redactions counts', () => {
    const m = valid();
    (m as Record<string, unknown>).redactions = { blockedSecretsTier: 'none' };
    expect(() => validateSnapshotManifest(m)).toThrow(/redactions/);
  });
});
