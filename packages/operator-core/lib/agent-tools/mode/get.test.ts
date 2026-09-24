import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  liveness: vi.fn(),
  selected: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: mocks.identity }));
vi.mock('../../modes/liveness', () => ({ getModesWithLiveness: mocks.liveness }));
vi.mock('../../agent-identities/source', () => ({ getSelectedModeDefinitions: mocks.selected }));

import getTool from './get';

const mode = { mode: 'goal', axisKey: 'goal', reason: 'owns goal', setBy: 'owner',
  ownerDirected: true, setAt: '2026-09-24T14:00:00.000Z' };
const run = async (contracts: boolean) => (await getTool.handler(
  { contracts } as never, {} as never,
)) as unknown as { data: { ok: boolean; modes: Array<Record<string, unknown>>;
  error?: string; detail?: string } };

describe('mode:get selected definition', () => {
  beforeEach(() => {
    mocks.identity.mockReset().mockReturnValue({ ownerId: 'su-1', workspaceId: 'ws-1' });
    mocks.liveness.mockReset().mockResolvedValue({
      modes: [mode], sessionState: 'live', live: true,
    });
    mocks.selected.mockReset().mockResolvedValue(new Map([
      ['goal', { contract: 'SELECTED GOAL DEFINITION', contractRevision: 'contract-r1',
        sourceRevision: 'source-r1' }],
    ]));
  });

  it('keeps the lightweight read free of definition resolution', async () => {
    const result = await run(false);
    expect(result.data.modes[0]).not.toHaveProperty('contract');
    expect(mocks.selected).not.toHaveBeenCalled();
  });

  it('reads the selected definition once and returns its exact provenance', async () => {
    const result = await run(true);
    expect(mocks.selected).toHaveBeenCalledExactlyOnceWith(['goal']);
    expect(result.data.modes[0]).toMatchObject({
      contract: 'SELECTED GOAL DEFINITION',
      definitionRevision: 'contract-r1',
      sourceRevision: 'source-r1',
    });
  });

  it('refuses a stale selected source rather than returning a built-in contract', async () => {
    mocks.selected.mockRejectedValueOnce(new Error('selected source changed'));
    const result = await run(true);
    expect(result.data).toMatchObject({
      ok: false, error: 'selected-mode-definition-unavailable', detail: 'selected source changed',
    });
    expect(result.data).not.toHaveProperty('modes');
  });
});
