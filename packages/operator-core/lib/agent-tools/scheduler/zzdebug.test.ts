import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getNextForBee: vi.fn(),
  resolveAgentIdentity: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn(),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: mocks.getFlag,
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: mocks.resolveAgentIdentity,
}));

vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: mocks.getNextForBee,
  resolveClaimSpecWorkspace: mocks.resolveClaimSpecWorkspace,
}));

import getNextTool from '../../packages/operator-core/lib/agent-tools/scheduler/get_next';

type ToolDef = {
  handler: (args: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

describe('debug', () => {
  beforeEach(() => {
    mocks.getFlag.mockResolvedValue(true);
    mocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-no-spec', workspaceId: 'ws-test' });
    mocks.resolveClaimSpecWorkspace.mockReturnValue('ws-test');
    mocks.getNextForBee.mockReset();
  });

  it('debug print', async () => {
    mocks.getNextForBee.mockResolvedValue({
      workItem: { id: 'EI-8489', state: 'open' },
      claimedUnder: { specId: 'default-fixed-ordering', revision: 0 },
      specSource: 'default',
    });
    const res = await (getNextTool as unknown as ToolDef).handler({ harness: 'papercusp' }, {});
    console.log('RAW:', res.content[0].text);
    expect(true).toBe(true);
  });
});
