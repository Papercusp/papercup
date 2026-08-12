import { beforeEach, describe, expect, it, vi } from 'vitest';

const { retractFactM } = vi.hoisted(() => ({ retractFactM: vi.fn() }));
vi.mock('../../agent-facts/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-facts/store')>()),
  retractFact: retractFactM,
  findFactKeyElsewhere: vi.fn().mockResolvedValue([]),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-retractor' }),
}));

import tool from './retract';

describe('facts:retract audit metadata', () => {
  beforeEach(() => retractFactM.mockReset().mockResolvedValue(true));

  it('requires and forwards the retraction reason with the caller identity', async () => {
    const out = await tool.handler(
      { scope: 'workspace', key: 'stale', reason: 'new evidence disproved it' },
      {} as never,
    );
    expect(out).toMatchObject({ data: { ok: true, retracted: true } });
    expect(retractFactM).toHaveBeenCalledWith({
      scope: 'workspace',
      scopeRef: null,
      key: 'stale',
      retractedBy: 'su-retractor',
      reason: 'new evidence disproved it',
    });
  });
});
