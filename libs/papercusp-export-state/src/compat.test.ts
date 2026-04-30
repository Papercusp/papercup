import { describe, expect, it } from 'vitest';
import { checkCompat, compareSemver, formatCompatReport } from './compat';
import type { SnapshotManifest } from './manifest';

const baseManifest = (): SnapshotManifest => ({
  schemaVersion: 1,
  kind: 'snapshot',
  id: 'snap_abcabcabcabc',
  name: 'sheets',
  harnessSlug: 'sheets',
  substrateVersion: '0.7.1',
  schemaVersion_db: 23,
  minSubstrateVersion: '0.7.0',
  template: { name: 'papercup-coding', version: '0.1.0' },
  createdAt: 1714267200000,
  files: [],
  excluded: [],
  plugins: [],
  partial: false,
  license: 'MIT',
  redactions: { blockedSecretsTier: 'none', verifiedHits: 0, highRecallHits: 0 },
});

describe('compareSemver', () => {
  it('orders correctly across major/minor/patch', () => {
    expect(compareSemver('0.7.1', '0.7.0')).toBe(1);
    expect(compareSemver('0.7.0', '0.7.1')).toBe(-1);
    expect(compareSemver('0.7.1', '0.7.1')).toBe(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
  });
  it('strips leading v', () => {
    expect(compareSemver('v0.7.0', '0.7.0')).toBe(0);
  });
  it('throws on invalid input', () => {
    expect(() => compareSemver('not-a-version', '0.0.0')).toThrow();
  });
});

describe('checkCompat', () => {
  it('marks compatible when current ≥ min', () => {
    const c = checkCompat(baseManifest(), { version: '0.7.1', schemaVersion: 25 });
    expect(c.compatible).toBe(true);
  });

  it('marks incompatible when current < min', () => {
    const c = checkCompat(baseManifest(), { version: '0.6.9', schemaVersion: 25 });
    expect(c.compatible).toBe(false);
    expect(c.reason).toContain('requires substrate ≥ 0.7.0');
  });

  it('formatCompatReport renders compatible state', () => {
    const c = checkCompat(baseManifest(), { version: '0.7.1', schemaVersion: 25 });
    const out = formatCompatReport(c);
    expect(out).toContain('COMPATIBLE');
    expect(out).toContain('Schema migration: v23 → v25');
  });

  it('formatCompatReport renders incompatible state with action hint', () => {
    const c = checkCompat(baseManifest(), { version: '0.6.9', schemaVersion: 25 });
    const out = formatCompatReport(c);
    expect(out).toContain('INCOMPATIBLE');
    expect(out).toContain('papercusp upgrade');
  });
});
