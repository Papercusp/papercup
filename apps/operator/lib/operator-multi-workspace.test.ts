import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the PG layer at the boundary so we exercise only the merge logic
// in `readMultiWorkspaceSnapshot`. The implementation queries
// harness_shared.operator_last_scan and operator_dismissed_cards via
// `getOrgPg().sql`. Each test seeds those two query result sets and
// checks the aggregation.

interface ScanRow { workspace_id: string; payload: { scanCompletedAt?: string; cards?: Array<Record<string, unknown> | null | undefined> } }
interface DismissedRow { workspace_id: string; card_id: string }

const scanRowsMock = vi.fn<() => ScanRow[]>();
const dismissedRowsMock = vi.fn<() => DismissedRow[]>();

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    // The implementation calls `sql<...>` with two distinct queries.
    // Distinguish them by the first interpolated literal in the
    // template: the FROM-clause table name appears in `strings`.
    sql: (strings: TemplateStringsArray) => {
      const text = strings.join('');
      if (text.includes('operator_last_scan')) return Promise.resolve(scanRowsMock());
      if (text.includes('operator_dismissed_cards')) return Promise.resolve(dismissedRowsMock());
      return Promise.resolve([]);
    },
  }),
}));

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

beforeEach(() => {
  scanRowsMock.mockReset();
  dismissedRowsMock.mockReset();
  // Default: no rows.
  scanRowsMock.mockReturnValue([]);
  dismissedRowsMock.mockReturnValue([]);
});

afterEach(() => {
  scanRowsMock.mockReset();
  dismissedRowsMock.mockReset();
});

describe('readMultiWorkspaceSnapshot', () => {
  it('omits the active workspace from the aggregation', async () => {
    scanRowsMock.mockReturnValue([
      // alpha row would be filtered server-side by the WHERE; not seeded
      { workspace_id: 'beta', payload: { cards: [{ id: '2', title: 'B1' }] } },
    ]);
    const snap = await readMultiWorkspaceSnapshot('alpha');
    expect(snap.workspaces.map((w) => w.id).sort()).toEqual(['beta', 'gamma']);
    expect(snap.cards.find((c) => c.workspaceId === 'alpha')).toBeUndefined();
  });

  it('flags dismissed cards', async () => {
    scanRowsMock.mockReturnValue([
      {
        workspace_id: 'beta',
        payload: { cards: [{ id: '1', title: 'kept' }, { id: '2', title: 'dismissed' }] },
      },
    ]);
    dismissedRowsMock.mockReturnValue([{ workspace_id: 'beta', card_id: '2' }]);
    const snap = await readMultiWorkspaceSnapshot('alpha');
    const beta = snap.cards.filter((c) => c.workspaceId === 'beta');
    expect(beta).toHaveLength(2);
    expect(beta.find((c) => c.card.id === '1')?.dismissed).toBe(false);
    expect(beta.find((c) => c.card.id === '2')?.dismissed).toBe(true);
  });

  it('returns empty card list when a workspace has no scan yet', async () => {
    // No scan rows at all — both PG queries return [].
    const snap = await readMultiWorkspaceSnapshot('alpha');
    const beta = snap.workspaces.find((w) => w.id === 'beta');
    expect(beta?.cardCount).toBe(0);
    expect(beta?.scanCompletedAt).toBeNull();
  });

  it('drops non-object card entries silently', async () => {
    scanRowsMock.mockReturnValue([
      {
        workspace_id: 'beta',
        payload: { cards: [null, 5 as unknown as Record<string, unknown>, 'x' as unknown as Record<string, unknown>, { id: 'good', title: 'G' }] },
      },
    ]);
    const snap = await readMultiWorkspaceSnapshot('alpha');
    const beta = snap.cards.filter((c) => c.workspaceId === 'beta');
    expect(beta).toHaveLength(1);
    expect(beta[0].card.id).toBe('good');
  });

  it('returns an empty snapshot when no other workspaces exist', async () => {
    // Override registry mock so only the current workspace is registered.
    const mod = await import('./workspace-registry');
    vi.spyOn(mod, 'readRegistry').mockReturnValueOnce({
      current: 'alpha',
      workspaces: [{ id: 'alpha', name: 'Alpha', createdAt: 0 }],
    } as unknown as ReturnType<typeof mod.readRegistry>);
    const snap = await readMultiWorkspaceSnapshot('alpha');
    expect(snap.cards).toEqual([]);
    expect(snap.workspaces).toEqual([]);
    // Verify no PG queries were issued.
    expect(scanRowsMock).not.toHaveBeenCalled();
    expect(dismissedRowsMock).not.toHaveBeenCalled();
  });
});
