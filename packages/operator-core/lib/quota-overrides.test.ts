/**
 * quota-overrides.test.ts — live-configurability-audit-2026-06-20 P-018.
 *
 * The runtime per-(tool,role) quota override: the sync cache (quotaOverrideFor), the merge over the
 * baked rolesQuota (mergeRoleQuota), malformed-row sanitation, and the set/clear round-trip — all
 * PG-free via a mocked operator-state IO seam.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let storedRow: Record<string, unknown> = {};
vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => storedRow),
  writeOperatorState: vi.fn(async (_t: string, p: Record<string, unknown>) => {
    storedRow = p;
  }),
}));
// Keep the import pure in the test: no real flag bus / timer side effects.
vi.mock('@papercusp/flags/server', () => ({ onFlagChange: () => {} }));

import {
  quotaOverrideFor,
  mergeRoleQuota,
  quotaOverrideKey,
  refreshQuotaOverrides,
  setToolQuotaOverride,
  readQuotaOverrides,
} from './quota-overrides';

beforeEach(async () => {
  storedRow = {};
  await refreshQuotaOverrides();
});

describe('quotaOverrideKey', () => {
  it('joins tool + role with a pipe', () => {
    expect(quotaOverrideKey('search:fulltext', 'worker')).toBe('search:fulltext|worker');
  });
});

describe('empty / no override (byte-identical)', () => {
  it('quotaOverrideFor returns undefined and mergeRoleQuota passes the baked quota through', () => {
    expect(quotaOverrideFor('search:fulltext', 'worker')).toBeUndefined();
    const baked = { perRun: 5 };
    expect(mergeRoleQuota(baked, 'search:fulltext', 'worker')).toBe(baked);
    expect(mergeRoleQuota(undefined, 'search:fulltext', 'worker')).toBeUndefined();
  });

  it('returns undefined for a missing role', () => {
    expect(quotaOverrideFor('search:fulltext', undefined)).toBeUndefined();
    expect(mergeRoleQuota({ perRun: 5 }, 'search:fulltext', undefined)).toEqual({ perRun: 5 });
  });
});

describe('set / merge / clear round-trip', () => {
  it('an override wins over the baked field and keeps absent baked fields', async () => {
    await setToolQuotaOverride('search:fulltext', 'worker', { perRun: 50 });
    expect(quotaOverrideFor('search:fulltext', 'worker')).toEqual({ perRun: 50 });
    // override.perRun wins; baked.perChunk survives (absent in override).
    expect(mergeRoleQuota({ perRun: 5, perChunk: 2 }, 'search:fulltext', 'worker')).toEqual({
      perRun: 50,
      perChunk: 2,
    });
    // a different (tool,role) is untouched.
    expect(quotaOverrideFor('search:fulltext', 'operator')).toBeUndefined();
  });

  it('clears back to the baked cap', async () => {
    await setToolQuotaOverride('search:fulltext', 'worker', { perRun: 50 });
    await setToolQuotaOverride('search:fulltext', 'worker', null);
    expect(quotaOverrideFor('search:fulltext', 'worker')).toBeUndefined();
    const o = await readQuotaOverrides();
    expect(o.overrides?.['search:fulltext|worker']).toBeUndefined();
  });

  it('rejects an override with no finite ≥ 0 field', async () => {
    await expect(setToolQuotaOverride('t', 'worker', { perRun: -1 })).rejects.toThrow(/finite/);
  });
});

describe('sanitation of a malformed stored row', () => {
  it('drops non-finite / negative fields on refresh, keeping the valid one', async () => {
    storedRow = {
      overrides: {
        'a:b|worker': { perRun: 10, perChunk: -3, perDay: Number.NaN },
        'c:d|operator': { perRun: -1 }, // wholly invalid → dropped entirely
      },
    };
    await refreshQuotaOverrides();
    expect(quotaOverrideFor('a:b', 'worker')).toEqual({ perRun: 10 });
    expect(quotaOverrideFor('c:d', 'operator')).toBeUndefined();
  });
});
