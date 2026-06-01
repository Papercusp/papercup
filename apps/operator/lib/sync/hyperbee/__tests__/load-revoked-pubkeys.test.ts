import { describe, it, expect, vi } from 'vitest';
import { loadRevokedPubkeys } from '../load-revoked-pubkeys';

describe('loadRevokedPubkeys', () => {
  it('unions + dedupes revoked_pubkeys across contributor rows', async () => {
    const runQuery = vi.fn(async (_q: string, _p: unknown[]) => [
      { revoked_pubkeys: ['PUB_A', 'PUB_B'] },
      { revoked_pubkeys: ['PUB_B', 'PUB_C'] },
      { revoked_pubkeys: [] },
    ]);
    const set = await loadRevokedPubkeys({ workspaceId: 'w', harnessSlug: 's', runQuery });
    expect([...set].sort()).toEqual(['PUB_A', 'PUB_B', 'PUB_C']);
    expect(runQuery).toHaveBeenCalledOnce();
    // scoped to the (workspace, harness): assert the params were passed
    expect(runQuery.mock.calls[0][1]).toEqual(['w', 's']);
  });
  it('empty harness → empty set', async () => {
    const set = await loadRevokedPubkeys({ workspaceId: 'w', harnessSlug: 's', runQuery: async () => [] });
    expect(set.size).toBe(0);
  });
  it('tolerates null/missing revoked_pubkeys', async () => {
    const set = await loadRevokedPubkeys({ workspaceId: 'w', harnessSlug: 's',
      runQuery: async () => [{ revoked_pubkeys: null as any }, { revoked_pubkeys: ['X'] }] });
    expect([...set]).toEqual(['X']);
  });
});
