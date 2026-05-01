import { describe, expect, it } from 'vitest';
import {
  checkPinnedVersionAdvisories,
  filterAdvisoriesAtOrAbove,
  type CatalogClient,
} from './security-advisories';

describe('filterAdvisoriesAtOrAbove', () => {
  it('returns empty for no advisories', () => {
    expect(filterAdvisoriesAtOrAbove(undefined)).toEqual([]);
    expect(filterAdvisoriesAtOrAbove([])).toEqual([]);
  });

  it('respects the moderate threshold by default', () => {
    const r = filterAdvisoriesAtOrAbove([
      { severity: 'low', summary: 'minor' },
      { severity: 'moderate', summary: 'mid' },
      { severity: 'high', summary: 'big' },
    ]);
    expect(r.map((a) => a.severity)).toEqual(['moderate', 'high']);
  });

  it('respects an explicit minSeverity', () => {
    const r = filterAdvisoriesAtOrAbove(
      [
        { severity: 'low', summary: 'a' },
        { severity: 'moderate', summary: 'b' },
        { severity: 'critical', summary: 'c' },
      ],
      'high',
    );
    expect(r.map((a) => a.severity)).toEqual(['critical']);
  });
});

describe('checkPinnedVersionAdvisories', () => {
  const cleanClient: CatalogClient = {
    async getEntry() {
      return { pluginSlug: 'p', version: '1.0.0', publisher: 'pub' };
    },
  };
  const flaggedClient: CatalogClient = {
    async getEntry() {
      return {
        pluginSlug: 'p',
        version: '1.0.0',
        publisher: 'pub',
        securityAdvisories: [
          { severity: 'high', summary: 'RCE', cve: 'CVE-2026-12345', fixedIn: '1.0.1' },
          { severity: 'low', summary: 'tiny', fixedIn: '1.0.1' },
        ],
      };
    },
    async getLatestSafe() {
      return '1.0.1';
    },
  };
  const errorClient: CatalogClient = {
    async getEntry() {
      throw new Error('marketplace down');
    },
  };

  it('returns clean when no advisories', async () => {
    const r = await checkPinnedVersionAdvisories(cleanClient, 'p', '1.0.0');
    expect(r.state).toBe('clean');
  });

  it('flags moderate-or-higher advisories with latest-safe version', async () => {
    const r = await checkPinnedVersionAdvisories(flaggedClient, 'p', '1.0.0');
    expect(r.state).toBe('flagged');
    if (r.state === 'flagged') {
      expect(r.advisories).toHaveLength(1);
      expect(r.advisories[0].severity).toBe('high');
      expect(r.latestSafeVersion).toBe('1.0.1');
    }
  });

  it('returns unknown when catalog throws', async () => {
    const r = await checkPinnedVersionAdvisories(errorClient, 'p', '1.0.0');
    expect(r.state).toBe('unknown');
    if (r.state === 'unknown') {
      expect(r.reason).toBe('marketplace down');
    }
  });

  it('returns clean when entry is not in catalog', async () => {
    const empty: CatalogClient = { async getEntry() { return null; } };
    const r = await checkPinnedVersionAdvisories(empty, 'p', '1.0.0');
    expect(r.state).toBe('clean');
  });
});
