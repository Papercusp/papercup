import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODES } from '../../modes/registry';

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  liveness: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: mocks.identity }));
vi.mock('../../modes/liveness', () => ({ getModesWithLiveness: mocks.liveness }));
vi.mock('../../agent-identities/source', () => ({ getSelectedModeCatalog: mocks.catalog }));

import listTool from './list';

const run = async () => (await listTool.handler({} as never, {} as never)) as unknown as {
  data: { ok: boolean; error?: string; catalogRevision?: string;
    modes?: Array<Record<string, unknown>> };
};

describe('mode:list selected catalog', () => {
  beforeEach(() => {
    mocks.identity.mockReset().mockReturnValue({ ownerId: 'su-1', workspaceId: 'ws-1' });
    mocks.liveness.mockReset().mockResolvedValue({
      modes: [{ mode: 'goal' }], sessionState: 'live', live: true,
    });
    mocks.catalog.mockReset().mockResolvedValue({
      revision: 'catalog-r2',
      entries: MODES.filter((mode) => mode.id !== 'cold-auto').map((mode) => ({
        id: mode.id, title: mode.id === 'goal' ? 'SELECTED GOAL TITLE' : mode.title,
        oneLiner: mode.id === 'goal' ? 'Selected goal summary' : mode.oneLiner,
        sourceHash: 'source-' + mode.id,
      })),
    });
  });

  it('shows selected content and revision while keeping the host axis and active state', async () => {
    const result = await run();
    const goal = result.data.modes!.find((mode) => mode.mode === 'goal');
    expect(result.data.catalogRevision).toBe('catalog-r2');
    expect(goal).toMatchObject({
      mode: 'goal', title: 'SELECTED GOAL TITLE', oneLiner: 'Selected goal summary',
      axis: 'overlay', active: true, sourceRevision: 'source-goal',
    });
    expect(mocks.catalog).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale selected catalog instead of showing built-in content as selected', async () => {
    mocks.catalog.mockRejectedValueOnce(new Error('approval stale'));
    const result = await run();
    expect(result.data).toMatchObject({
      ok: false, error: 'selected-mode-catalog-unavailable', detail: 'approval stale',
    });
    expect(result.data).not.toHaveProperty('modes');
  });
});
