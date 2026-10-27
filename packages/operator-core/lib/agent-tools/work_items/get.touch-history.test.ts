import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shapeWorkItemsGet } from './get-shape';

const h = vi.hoisted(() => ({ read: vi.fn(), item: vi.fn() }));
vi.mock('../../work-item-touch-history', () => ({ readWorkItemTouchHistory: h.read }));
vi.mock('../../work-items', () => ({
  getWorkItem: h.item, getWorkItemsByIds: vi.fn(), getWorkItemDetail: h.item,
  getWorkItemThreadWindow: vi.fn(), SETTLED_WORK_ITEM_STATES: ['done'],
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'test-workspace',
}));
import get from './get';

const history = { status: 'available', totalFiles: 1, truncated: false, files: [
  { file: 'src/a.ts', symbols: ['run'], symbolsIncomplete: false, symbolsTruncated: false },
] };
beforeEach(() => {
  h.item.mockReset().mockResolvedValue({ id: 'WI-1', harness: 'canonical', state: 'open' });
  h.read.mockReset().mockResolvedValue(history);
});

async function call(pick: string[], ids = { id: 'WI-1' }) {
  return await get.handler({ ...ids, harness: 'request-alias' } as never, {
    workspaceId: 'test-workspace', sourceProjection: { pick },
  } as never) as { data: { results: Array<Record<string, unknown>> } };
}

describe('work_items:get touch history', () => {
  it('returns the ledger history on an ordinary read, scoped to the resolved item', async () => {
    const result = await call(['results[].id', 'results[].touchHistory']);
    expect(result.data.results[0].touchHistory).toEqual(history);
    expect(h.read).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'test-workspace', harness: 'canonical', workItemId: 'WI-1',
    }));
  });

  it('does not read the ledger for unrelated source projections or absent items', async () => {
    await call(['results[].workItem.state']);
    expect(h.read).not.toHaveBeenCalled();
    h.item.mockResolvedValue(null);
    await call(['results[].touchHistory']);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('preserves an unavailable ledger without failing or inventing an empty list', async () => {
    h.read.mockResolvedValue({ status: 'unavailable', reason: 'ledger-read-failed' });
    const result = await call(['results[].touchHistory']);
    expect(result.data.results[0]).toMatchObject({ ok: true, touchHistory: { status: 'unavailable', reason: 'ledger-read-failed' } });
  });

  it.each(['standard', 'trimmed'] as const)('keeps small touch histories in the %s result tier', (tier) => {
    const result = shapeWorkItemsGet({ ok: true, counts: { ok: 1, failed: 0 }, results: [
      { ok: true, id: 'WI-1', workItem: { id: 'WI-1' }, touchHistory: history },
    ] }, tier) as { results: Array<Record<string, unknown>> };
    expect(result.results[0].touchHistory).toEqual(history);
  });
});
