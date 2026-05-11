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

/* ───── v1 → v2 reader fallback (rev3 plan G+1/G+2) ─────────────────── */

import {
  SNAPSHOT_READER_MIN_VERSION,
  effectiveMigrationManifest,
  effectiveRuntime,
  effectiveVersionPin,
  type SnapshotPlugin,
} from './manifest';

describe('schema v2 reader back-compat', () => {
  it('accepts v1 manifests', () => {
    const v1 = { ...valid(), schemaVersion: SNAPSHOT_READER_MIN_VERSION };
    expect(() => validateSnapshotManifest(v1)).not.toThrow();
  });

  it('accepts v2 manifests', () => {
    expect(() => validateSnapshotManifest(valid())).not.toThrow();
  });

  it('rejects schemaVersion 0 (below MIN)', () => {
    expect(() => validateSnapshotManifest({ ...valid(), schemaVersion: 0 })).toThrow(
      /unsupported schemaVersion/,
    );
  });

  it('rejects schemaVersion 3 (above current)', () => {
    expect(() => validateSnapshotManifest({ ...valid(), schemaVersion: 3 })).toThrow(
      /unsupported schemaVersion/,
    );
  });

  it('rejects non-numeric schemaVersion', () => {
    expect(() =>
      validateSnapshotManifest({ ...valid(), schemaVersion: '2' as unknown as number }),
    ).toThrow(/unsupported schemaVersion/);
  });
});

describe('effectiveRuntime', () => {
  it("defaults to 'js' for v1 plugins (runtime field absent)", () => {
    const p: SnapshotPlugin = {
      name: 'foo',
      version: '1.0.0',
      capabilities: [],
      configJson: '{}',
    };
    expect(effectiveRuntime(p)).toBe('js');
  });

  it('returns the explicit runtime field when present', () => {
    const p: SnapshotPlugin = {
      name: 'foo',
      version: '1.0.0',
      capabilities: [],
      configJson: '{}',
      runtime: 'wasm',
    };
    expect(effectiveRuntime(p)).toBe('wasm');
  });
});

describe('effectiveVersionPin', () => {
  const base: SnapshotPlugin = {
    name: 'foo',
    version: '1.0.0',
    capabilities: [],
    configJson: '{}',
  };

  it('explicit versionPin field wins', () => {
    const p: SnapshotPlugin = {
      ...base,
      versionPin: { mode: 'hash', allowOverride: 'never' },
      pluginVersionPinned: true, // legacy also set; should be ignored
    };
    expect(effectiveVersionPin(p)).toEqual({ mode: 'hash', allowOverride: 'never' });
  });

  it('versionPin without allowOverride defaults to security-patch', () => {
    const p: SnapshotPlugin = {
      ...base,
      versionPin: { mode: 'semver' },
    };
    expect(effectiveVersionPin(p)).toEqual({
      mode: 'semver',
      allowOverride: 'security-patch',
    });
  });

  it("v1 pluginVersionPinned: true → mode: 'exact'", () => {
    const p: SnapshotPlugin = { ...base, pluginVersionPinned: true };
    expect(effectiveVersionPin(p)).toEqual({
      mode: 'exact',
      allowOverride: 'security-patch',
    });
  });

  it("v1 pluginVersionPinned: false → mode: 'semver'", () => {
    const p: SnapshotPlugin = { ...base, pluginVersionPinned: false };
    expect(effectiveVersionPin(p)).toEqual({
      mode: 'semver',
      allowOverride: 'security-patch',
    });
  });

  it("neither field present → mode: 'semver'", () => {
    expect(effectiveVersionPin(base)).toEqual({
      mode: 'semver',
      allowOverride: 'security-patch',
    });
  });
});

describe('effectiveMigrationManifest', () => {
  it('returns empty array when field is absent (v1 snapshot)', () => {
    const p: SnapshotPlugin = {
      name: 'foo',
      version: '1.0.0',
      capabilities: [],
      configJson: '{}',
    };
    expect(effectiveMigrationManifest(p)).toEqual([]);
  });

  it('returns the captured list when present', () => {
    const entries = [
      { filename: '0001-init.sql', sha256: 'a'.repeat(64) },
      { filename: '0002-add.sql', sha256: 'b'.repeat(64) },
    ];
    const p: SnapshotPlugin = {
      name: 'foo',
      version: '1.0.0',
      capabilities: [],
      configJson: '{}',
      migrationManifest: entries,
    };
    expect(effectiveMigrationManifest(p)).toEqual(entries);
  });
});
