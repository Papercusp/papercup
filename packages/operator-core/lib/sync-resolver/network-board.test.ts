// network.board sync-resolver entry (hive-network-surface-2026-06-11 B-08 / C-3,
// P-006): the named query that backs the dock Network pane. Verifies it is
// registered, that it projects buildNetworkBoard as a FLAT row array (the
// useSyncQuery contract — each row IS a NetworkBoardRow, no envelope), and that
// the workspace arg threads through. The composition itself is mocked at its
// module boundary so no PG/fleet/directory IO runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';
import { TABLE_TO_QUERY_NAMES } from './table-to-query-names';

describe('network.board resolver', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  it('is registered in the v2 query registry', () => {
    expect(knownQueryNamesV2()).toContain('network.board');
  });

  it('projects buildNetworkBoard as a flat row array', async () => {
    const rows = [
      { tier: 1, key: 'home', title: 'home', trust: 'local', liveAgents: 2 },
      { tier: 4, key: 'pk', title: 'Peer', trust: 'gossip' },
    ];
    const buildNetworkBoard = vi.fn(async () => rows);
    vi.doMock('../network-board/build-board', () => ({ buildNetworkBoard }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const out = await r('network.board', {});
    expect(out).toEqual(rows); // flat, not wrapped
    expect(buildNetworkBoard).toHaveBeenCalledTimes(1);
    vi.doUnmock('../network-board/build-board');
  });

  it('threads the workspace arg through to the composition', async () => {
    const buildNetworkBoard = vi.fn(async () => []);
    vi.doMock('../network-board/build-board', () => ({ buildNetworkBoard }));
    const { resolveNamedQueryV2: r } = await import('./index');

    await r('network.board', { workspace: 'ws-77' });
    expect(buildNetworkBoard).toHaveBeenCalledWith({ workspaceId: 'ws-77' });
    vi.doUnmock('../network-board/build-board');
  });

  it('is bridged for SSE invalidation off the live substrate tables', () => {
    // A presence/claim/registry write must refresh the board's tier 1–3 counts.
    expect(TABLE_TO_QUERY_NAMES['harness_shared.coord_presence']).toContain('network.board');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.feature_claims']).toContain('network.board');
    expect(TABLE_TO_QUERY_NAMES['harness_shared.harness_registry']).toContain('network.board');
  });
});
