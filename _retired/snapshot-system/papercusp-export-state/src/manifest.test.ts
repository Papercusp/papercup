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

/* ───── bundled-plugin filter (rev3 plan G+5 / A10) ────────────────── */

import { isBundledPlugin } from './manifest';

describe('isBundledPlugin', () => {
  it('returns true for bundled: true', () => {
    expect(isBundledPlugin({ bundled: true })).toBe(true);
  });

  it('returns false for bundled: false', () => {
    expect(isBundledPlugin({ bundled: false })).toBe(false);
  });

  it('returns false when bundled is absent', () => {
    expect(isBundledPlugin({})).toBe(false);
  });

  it('returns false for non-boolean values (defensive — e.g. author wrote a string)', () => {
    // We DO NOT trust truthy non-booleans. bundled:"true" is treated
    // as not-bundled so a confused author can't accidentally smuggle.
    // (Real defense is the lint rule rejecting the field at publish.)
    expect(isBundledPlugin({ bundled: 'true' })).toBe(false);
    expect(isBundledPlugin({ bundled: 1 })).toBe(false);
    expect(isBundledPlugin({ bundled: {} })).toBe(false);
  });
});

/* ───── plugin work-dir snapshot.include rules (rev3 plan G+4) ─────── */

import { readSnapshotIncludeRules } from './manifest';

describe('readSnapshotIncludeRules', () => {
  it('returns empty when manifest has no snapshot field', () => {
    expect(readSnapshotIncludeRules({})).toEqual([]);
  });

  it('returns empty when snapshot.include is missing', () => {
    expect(readSnapshotIncludeRules({ snapshot: {} })).toEqual([]);
  });

  it('returns empty when snapshot is not an object (defensive)', () => {
    expect(readSnapshotIncludeRules({ snapshot: 'whoops' })).toEqual([]);
    expect(readSnapshotIncludeRules({ snapshot: null })).toEqual([]);
  });

  it('parses well-formed include rules', () => {
    expect(
      readSnapshotIncludeRules({
        snapshot: {
          include: [
            { path: 'state.db' },
            { path: 'cache/**', redact: 'strip' },
          ],
        },
      }),
    ).toEqual([{ path: 'state.db' }, { path: 'cache/**', redact: 'strip' }]);
  });

  it('skips entries with missing or empty path', () => {
    expect(
      readSnapshotIncludeRules({
        snapshot: {
          include: [
            { path: 'kept' },
            { path: '' }, // skipped
            { redact: 'strip' }, // skipped (no path)
            { path: 'also-kept' },
          ],
        },
      }),
    ).toEqual([{ path: 'kept' }, { path: 'also-kept' }]);
  });

  it("ignores unknown redact values (not 'strip')", () => {
    const rules = readSnapshotIncludeRules({
      snapshot: { include: [{ path: 'x', redact: 'mysterious' }] },
    });
    expect(rules).toEqual([{ path: 'x' }]); // redact field omitted
  });

  it('ignores non-object entries in include array', () => {
    expect(
      readSnapshotIncludeRules({
        snapshot: { include: ['stringy', null, 42, { path: 'real' }] },
      }),
    ).toEqual([{ path: 'real' }]);
  });
});

/* ───── _jco/ denylist entry (rev3 plan G+4 defensive) ─────────────── */

import { DEFAULT_DENY } from './denylist';

describe('DEFAULT_DENY includes _jco/', () => {
  it('matches WASM transpile cache as re-derivable', () => {
    const entry = DEFAULT_DENY.find((d) => d.pattern === '_jco/');
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe('denylist:re-derivable');
  });
});

/* ───── readCapturePluginExtras (capture-side write helper) ────────── */

import { readCapturePluginExtras } from './manifest';

describe('readCapturePluginExtras', () => {
  it('empty manifest → defaults to semver + legacy false', () => {
    expect(readCapturePluginExtras({})).toEqual({
      versionPin: { mode: 'semver' },
      pluginVersionPinned: false,
    });
  });

  it('v1 pluginVersionPinned: true → versionPin.mode=exact + legacy true', () => {
    expect(readCapturePluginExtras({ pluginVersionPinned: true })).toEqual({
      versionPin: { mode: 'exact' },
      pluginVersionPinned: true,
    });
  });

  it('v1 pluginVersionPinned: false → versionPin.mode=semver + legacy false', () => {
    expect(readCapturePluginExtras({ pluginVersionPinned: false })).toEqual({
      versionPin: { mode: 'semver' },
      pluginVersionPinned: false,
    });
  });

  it('v2 versionPin wins over legacy field when both present', () => {
    const r = readCapturePluginExtras({
      versionPin: { mode: 'hash', allowOverride: 'never' },
      pluginVersionPinned: true,
    });
    expect(r.versionPin).toEqual({ mode: 'hash', allowOverride: 'never' });
    // Legacy boolean derived from v2: hash → false
    expect(r.pluginVersionPinned).toBe(false);
  });

  it("v2 versionPin.mode='exact' derives legacy true", () => {
    const r = readCapturePluginExtras({ versionPin: { mode: 'exact' } });
    expect(r.pluginVersionPinned).toBe(true);
  });

  it('v2 versionPin without allowOverride omits the field (cleaner output)', () => {
    const r = readCapturePluginExtras({ versionPin: { mode: 'semver' } });
    expect(r.versionPin).toEqual({ mode: 'semver' });
  });

  it('v2 versionPin with bogus mode falls through to default', () => {
    const r = readCapturePluginExtras({
      versionPin: { mode: 'mysterious' },
    });
    expect(r.versionPin).toEqual({ mode: 'semver' });
    expect(r.pluginVersionPinned).toBe(false);
  });

  it("runtime: 'wasm' is passed through", () => {
    const r = readCapturePluginExtras({ runtime: 'wasm' });
    expect(r.runtime).toBe('wasm');
  });

  it('runtime omitted when not declared in manifest', () => {
    const r = readCapturePluginExtras({});
    expect(r).not.toHaveProperty('runtime');
  });

  it('runtime with bogus value (not in enum) is dropped', () => {
    const r = readCapturePluginExtras({ runtime: 'not-a-real-runtime' });
    expect(r).not.toHaveProperty('runtime');
  });

  it('all three runtimes round-trip', () => {
    expect(readCapturePluginExtras({ runtime: 'js' }).runtime).toBe('js');
    expect(readCapturePluginExtras({ runtime: 'wasm' }).runtime).toBe('wasm');
    expect(readCapturePluginExtras({ runtime: 'daemon' }).runtime).toBe('daemon');
  });

  it("object form: runtime { kind: 'wasm', wasmPath } extracts kind only", () => {
    const r = readCapturePluginExtras({
      runtime: { kind: 'wasm', wasmPath: 'pkg/plugin.wasm', memoryBudgetMb: 128 },
    });
    expect(r.runtime).toBe('wasm');
  });

  it("object form: runtime { kind: 'daemon', daemonCommand } extracts kind", () => {
    const r = readCapturePluginExtras({
      runtime: { kind: 'daemon', daemonCommand: ['/usr/bin/my-daemon', '--stdio'] },
    });
    expect(r.runtime).toBe('daemon');
  });

  it('object form: invalid kind is dropped (no fallback to string)', () => {
    const r = readCapturePluginExtras({
      runtime: { kind: 'rust-native', wasmPath: 'pkg/plugin.wasm' },
    });
    expect(r).not.toHaveProperty('runtime');
  });

  it('object form: missing kind is dropped', () => {
    const r = readCapturePluginExtras({
      runtime: { wasmPath: 'pkg/plugin.wasm' },
    });
    expect(r).not.toHaveProperty('runtime');
  });

  it('string and object forms produce identical captured value', () => {
    const a = readCapturePluginExtras({ runtime: 'wasm' });
    const b = readCapturePluginExtras({ runtime: { kind: 'wasm', wasmPath: 'x.wasm' } });
    expect(a.runtime).toBe(b.runtime);
  });
});

/* ───── reconcileMigrations (rev3 plan G+6 / A4 fix) ───────────────── */

import { reconcileMigrations } from './manifest';
import type { SnapshotMigrationEntry } from './manifest';

const m = (filename: string, sha: string): SnapshotMigrationEntry => ({
  filename,
  sha256: sha.repeat(64).slice(0, 64),
});

describe('reconcileMigrations', () => {
  it("returns 'identical' when both lists are empty", () => {
    expect(reconcileMigrations([], [])).toEqual({ kind: 'identical' });
  });

  it("returns 'identical' when both lists match exactly", () => {
    const xs = [m('0001-init.sql', 'a'), m('0002-add.sql', 'b')];
    expect(reconcileMigrations(xs, [...xs])).toEqual({ kind: 'identical' });
  });

  it("returns 'extends' when installed has trailing entries snapshot lacks", () => {
    const snapshot = [m('0001-init.sql', 'a')];
    const installed = [m('0001-init.sql', 'a'), m('0002-add.sql', 'b'), m('0003-idx.sql', 'c')];
    const result = reconcileMigrations(snapshot, installed);
    expect(result.kind).toBe('extends');
    if (result.kind === 'extends') {
      expect(result.toRun.map((x) => x.filename)).toEqual([
        '0002-add.sql',
        '0003-idx.sql',
      ]);
    }
  });

  it("returns 'diverged' when same filename has different sha256", () => {
    const snapshot = [m('0001-init.sql', 'a'), m('0002-add.sql', 'b')];
    const installed = [m('0001-init.sql', 'a'), m('0002-add.sql', 'X')]; // rewritten
    const result = reconcileMigrations(snapshot, installed);
    expect(result.kind).toBe('diverged');
    if (result.kind === 'diverged') {
      expect(result.conflictingFiles).toEqual(['0002-add.sql']);
    }
  });

  it("'diverged' wins over 'snapshot-ahead' when both apply", () => {
    // Snapshot has file X (rewritten) AND a missing file. Conflict
    // is the more serious failure (data integrity); report it first.
    const snapshot = [m('0001.sql', 'a'), m('0002.sql', 'b'), m('0003.sql', 'c')];
    const installed = [m('0001.sql', 'a'), m('0002.sql', 'X')]; // 0002 differs, 0003 missing
    const result = reconcileMigrations(snapshot, installed);
    expect(result.kind).toBe('diverged');
  });

  it("returns 'snapshot-ahead' when snapshot references files installed lacks", () => {
    const snapshot = [m('0001.sql', 'a'), m('0002.sql', 'b'), m('0003.sql', 'c')];
    const installed = [m('0001.sql', 'a')];
    const result = reconcileMigrations(snapshot, installed);
    expect(result.kind).toBe('snapshot-ahead');
    if (result.kind === 'snapshot-ahead') {
      expect(result.missing).toEqual(['0002.sql', '0003.sql']);
    }
  });

  it("conflictingFiles list is sorted for stable output", () => {
    const snapshot = [m('z.sql', 'a'), m('a.sql', 'b'), m('m.sql', 'c')];
    const installed = [m('z.sql', 'X'), m('a.sql', 'Y'), m('m.sql', 'Z')];
    const result = reconcileMigrations(snapshot, installed);
    expect(result.kind).toBe('diverged');
    if (result.kind === 'diverged') {
      expect(result.conflictingFiles).toEqual(['a.sql', 'm.sql', 'z.sql']);
    }
  });

  it("'extends' preserves installed order in toRun", () => {
    const snapshot = [m('0001.sql', 'a')];
    // Order intentionally weird — installed's order is preserved.
    const installed = [
      m('0001.sql', 'a'),
      m('zzz-late.sql', 'z'),
      m('aaa-also-late.sql', 'b'),
    ];
    const result = reconcileMigrations(snapshot, installed);
    if (result.kind !== 'extends') throw new Error('expected extends');
    expect(result.toRun.map((x) => x.filename)).toEqual([
      'zzz-late.sql',
      'aaa-also-late.sql',
    ]);
  });

  it('snapshot containing a duplicate filename does not crash (defensive)', () => {
    // Snapshots shouldn't have duplicate migration filenames, but if
    // they do (corrupt data, bad capture), the function must NOT
    // crash. Behavior: dedup via Map collapse leaves one entry per
    // name. With unequal lengths, falls through to 'extends' with
    // empty toRun (no trailing migrations to apply since installed
    // is a subset of unique-snapshot-names). This isn't a meaningful
    // restore decision — caller should reject the snapshot upstream.
    const snapshot = [m('0001.sql', 'a'), m('0001.sql', 'b')]; // dup
    const installed = [m('0001.sql', 'b')];
    const result = reconcileMigrations(snapshot, installed);
    expect(['identical', 'extends']).toContain(result.kind);
  });
});
