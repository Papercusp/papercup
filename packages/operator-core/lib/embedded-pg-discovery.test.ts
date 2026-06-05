/**
 * Coverage for embedded-pg-discovery — the operator's wiring over the generic
 * resolvePgUrl: it relabels the generic 'fallback' source to the historical
 * 'native-fallback', passes other sources through, and caches the resolution
 * (one resolve until reset). The generic resolver is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolvePgUrl = vi.fn();
vi.mock('@papercusp/embedded-pg-discovery', () => ({
  resolvePgUrl: (...a: unknown[]) => resolvePgUrl(...a),
}));

import {
  getHarnessAdminUrl,
  getHarnessAdminUrlWithSource,
  _resetHarnessAdminUrlCacheForTests,
} from './embedded-pg-discovery';

beforeEach(() => {
  _resetHarnessAdminUrlCacheForTests();
  resolvePgUrl.mockReset();
});

describe('getHarnessAdminUrlWithSource', () => {
  it('passes through a non-fallback source', () => {
    resolvePgUrl.mockReturnValue({ url: 'postgres://env/db', source: 'env' });
    expect(getHarnessAdminUrlWithSource()).toEqual({ url: 'postgres://env/db', source: 'env' });
    expect(getHarnessAdminUrl()).toBe('postgres://env/db');
  });

  it("relabels the generic 'fallback' to 'native-fallback'", () => {
    resolvePgUrl.mockReturnValue({ url: 'postgres://localhost:5432/papercusp', source: 'fallback' });
    expect(getHarnessAdminUrlWithSource().source).toBe('native-fallback');
  });

  it('caches the resolution (resolves once until reset)', () => {
    resolvePgUrl.mockReturnValue({ url: 'postgres://x', source: 'env' });
    getHarnessAdminUrl();
    getHarnessAdminUrl();
    expect(resolvePgUrl).toHaveBeenCalledTimes(1);
    _resetHarnessAdminUrlCacheForTests();
    getHarnessAdminUrl();
    expect(resolvePgUrl).toHaveBeenCalledTimes(2);
  });

  it('forwards the env-var precedence list + discovery file config', () => {
    resolvePgUrl.mockReturnValue({ url: 'u', source: 'env' });
    getHarnessAdminUrl();
    expect(resolvePgUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'],
      }),
    );
  });
});
