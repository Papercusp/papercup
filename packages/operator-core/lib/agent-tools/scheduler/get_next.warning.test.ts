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

import getNextTool from './get_next';

type ToolDef = {
  handler: (args: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

async function callGetNext(args: Record<string, unknown> = { harness: 'papercusp' }) {
  const res = await (getNextTool as unknown as ToolDef).handler(args, {});
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe('scheduler:get_next default-spec warning (EI-8579)', () => {
  beforeEach(() => {
    mocks.getFlag.mockResolvedValue(true);
    mocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-no-spec', workspaceId: 'ws-test' });
    mocks.resolveClaimSpecWorkspace.mockReturnValue('ws-test');
    mocks.getNextForBee.mockReset();
  });

  it('warns when a self-puller falls back to DEFAULT_CLAIM_SPEC', async () => {
    mocks.getNextForBee.mockResolvedValue({
      workItem: { id: 'EI-8489', state: 'open' },
      claimedUnder: { specId: 'default-fixed-ordering', revision: 0 },
      specSource: 'default',
    });

    const out = await callGetNext();

    expect(out.ok).toBe(true);
    expect(out.warning).toContain('DEFAULT_CLAIM_SPEC');
    expect(out.warning).toContain('scheduler:set_claim_spec');
  });

  it('does not warn when the claim came from a bee or inherited fleet spec', async () => {
    for (const specSource of ['cup', 'fleet']) {
      mocks.getNextForBee.mockResolvedValueOnce({
        workItem: { id: `WI-${specSource}`, state: 'todo' },
        claimedUnder: { specId: `${specSource}-spec`, revision: 1 },
        specSource,
      });

      const out = await callGetNext();

      expect(out.ok).toBe(true);
      expect(out.warning).toBeUndefined();
    }
  });
});
