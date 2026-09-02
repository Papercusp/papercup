/**
 * file-lock-authority-wiring — the requesting-side resolver snapshot (fed-reanchor P-060
 * cutover 2). Proves the domain→slug / slug→hive mapping AND the load-bearing N=1 safety
 * contract: an UNMANAGED / unknown coordination domain resolves to `null`, so
 * routeFileLockOp runs the op locally (the single-box passthrough the cutover must
 * preserve). The authority-side adapter is exercised by file-lock-authority-ops.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws1' }));

import { loadHarnessRegistry } from '../../../harness-registry';
import { getDomainToHarnessSlug, getHarnessToPotSlug } from '../../../authority/file-lock-routing';
import { _testing } from '../file-lock-authority-wiring';

beforeEach(() => {
  _testing.reset();
  (loadHarnessRegistry as Mock).mockReset();
});
afterEach(() => vi.clearAllMocks());

// Non-existent paths: realpathOrSelf falls back to the raw string on BOTH the cache build
// and the lookup, so the mapping stays consistent without a real filesystem.
const REGISTRY = {
  projects: [
    { slug: 'papercup', path: '/fake/papercup' }, // not a Hive member
    { slug: 'sheets', path: '/fake/sheets', hive_slug: 'org-hive' }, // member → org-hive
    { slug: 'org-hive', path: '/fake/org', harness_kind: 'hive' }, // its own Hive home
  ],
};

describe('file-lock-authority-wiring resolver snapshot', () => {
  it('maps domain→slug from the registry; an unknown/unmanaged domain → null (N=1 passthrough)', async () => {
    (loadHarnessRegistry as Mock).mockResolvedValue(REGISTRY);
    await _testing.refreshResolverSnapshot();

    const domainResolver = getDomainToHarnessSlug();
    expect(domainResolver('/fake/sheets')).toBe('sheets');
    expect(domainResolver('/fake/papercup')).toBe('papercup');
    // The safety contract: a checkout that is NOT a registered managed harness resolves to
    // null → routeFileLockOp runs locally. This is what keeps the live SU fleet's edits on
    // the unchanged local path.
    expect(domainResolver('/some/unmanaged/checkout')).toBeNull();
  });

  it('maps slug→home-Hive: a member points to its Hive, a Hive home points to itself, a non-member is null', async () => {
    (loadHarnessRegistry as Mock).mockResolvedValue(REGISTRY);
    await _testing.refreshResolverSnapshot();

    const hiveResolver = getHarnessToPotSlug();
    expect(hiveResolver('sheets')).toBe('org-hive'); // member → home Hive
    expect(hiveResolver('org-hive')).toBe('org-hive'); // kind:'hive' → itself
    expect(hiveResolver('papercup')).toBeNull(); // non-member → harness-scoped (no Hive)
    expect(hiveResolver('unknown')).toBeNull();
  });

  it('a registry-load failure leaves the maps empty → everything resolves local (fail-safe)', async () => {
    (loadHarnessRegistry as Mock).mockRejectedValue(new Error('PG down'));
    // refreshResolverSnapshot rejects; the boot caller swallows it. The maps stay empty.
    await expect(_testing.refreshResolverSnapshot()).rejects.toThrow('PG down');
    expect(getDomainToHarnessSlug()('/fake/sheets')).toBeNull();
    expect(getHarnessToPotSlug()('sheets')).toBeNull();
  });
});
