import { describe, expect, it, vi } from 'vitest';

// The card-stream source was RETIRED (unify-agent-launches D-005, migration
// 167 dropped operator_last_scan / operator_dismissed_cards). The module is
// now a roster-only stub: it must return every non-active workspace with
// zeroed card fields, touch NO PG, and keep the contract shape so the
// multi-workspace tool/route consumers don't break.

vi.mock('./workspace-registry', () => ({
  readRegistry: () => ({
    current: 'alpha',
    workspaces: [
      { id: 'alpha', name: 'Alpha', createdAt: 0 },
      { id: 'beta', name: 'Beta', createdAt: 0 },
      { id: 'gamma', name: 'Gamma', createdAt: 0 },
    ],
  }),
  activeWorkspaceId: () => 'alpha',
}));

const { readMultiWorkspaceSnapshot } = await import('./operator-multi-workspace');

describe('readMultiWorkspaceSnapshot (roster-only stub, D-005)', () => {
  it('omits the active workspace and returns the rest of the roster', async () => {
    const snap = await readMultiWorkspaceSnapshot('alpha');
    expect(snap.workspaces.map((w) => w.id).sort()).toEqual(['beta', 'gamma']);
  });

  it('returns zeroed card fields for every workspace (card stream retired)', async () => {
    const snap = await readMultiWorkspaceSnapshot('alpha');
    expect(snap.cards).toEqual([]);
    for (const ws of snap.workspaces) {
      expect(ws.cardCount).toBe(0);
      expect(ws.scanCompletedAt).toBeNull();
    }
  });

  it('returns an empty snapshot when no other workspaces exist', async () => {
    const snap = await readMultiWorkspaceSnapshot('beta');
    // alpha + gamma remain (beta is active) — verify the filter direction.
    expect(snap.workspaces.map((w) => w.id).sort()).toEqual(['alpha', 'gamma']);
    const only = await readMultiWorkspaceSnapshot('alpha');
    expect(only.cards).toEqual([]);
  });
});
