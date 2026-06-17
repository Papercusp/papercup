import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_TIERS, type ModelTier } from '../agent-config-constants';
import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

const H = vi.hoisted(() => ({
  readAgentConfig: vi.fn(),
}));

vi.mock('../agent-config', () => ({
  readAgentConfig: H.readAgentConfig,
}));

describe('agentConfig.modelTiersBaseline resolver', () => {
  beforeEach(() => {
    H.readAgentConfig.mockReset();
    H.readAgentConfig.mockResolvedValue({ tiers: [] });
  });

  it('is registered in the v2 named-query resolver', () => {
    expect(knownQueryNamesV2()).toContain('agentConfig.modelTiersBaseline');
  });

  it('returns the workspace tier menu when configured', async () => {
    const tiers: ModelTier[] = [{ name: 'fast', spec: 'haiku' }];
    H.readAgentConfig.mockResolvedValue({ tiers });

    await expect(resolveNamedQueryV2('agentConfig.modelTiersBaseline', {})).resolves.toEqual(tiers);
  });

  it('falls back to the committed default tier menu', async () => {
    await expect(resolveNamedQueryV2('agentConfig.modelTiersBaseline', {})).resolves.toEqual(DEFAULT_MODEL_TIERS);
  });
});
