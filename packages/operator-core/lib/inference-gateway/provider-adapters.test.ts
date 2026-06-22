import { describe, expect, it } from 'vitest';
import { gatewayProviderStatuses, makeGatewayProviderAdapters, providerForGatewayPath, type GatewayProviderId } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './gateway';

const account = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-token` });
const pool = (id: string): AccountPool => {
  const active = account(id);
  return {
    active: () => active,
    onExhausted: () => null,
    select: (accountId) => (accountId === id ? active : null),
  };
};

describe('gateway provider adapters', () => {
  it('declares Claude, Codex, and OMP provider contracts explicitly', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(Object.keys(adapters).sort()).toEqual(['claude', 'codex', 'omp'] satisfies GatewayProviderId[]);
    expect(adapters.claude).toMatchObject({ id: 'claude', protocol: 'anthropic', upstreamBase: 'https://anthropic.test' });
    expect(adapters.codex).toMatchObject({ id: 'codex', protocol: 'openai-compatible', upstreamBase: 'https://openai.test' });
    expect(adapters.omp).toMatchObject({ id: 'omp', protocol: 'unsupported', upstreamBase: null, pool: null });
    expect(adapters.omp.unavailableMessage).toMatch(/not implemented/i);
  });

  it('routes OpenAI-compatible responses to Codex and leaves other /v1 paths on Claude', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(providerForGatewayPath('/v1/responses', adapters).id).toBe('codex');
    expect(providerForGatewayPath('/v1/responses?stream=false', adapters).id).toBe('codex');
    expect(providerForGatewayPath('/v1/messages', adapters).id).toBe('claude');
    expect(providerForGatewayPath('/v1/count_tokens', adapters).id).toBe('claude');
  });

  it('keeps Codex present but unavailable when no Codex account pool is configured', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(adapters.codex.pool).toBeNull();
    expect(adapters.codex.unavailableMessage).toMatch(/no Codex account pool/i);
  });

  it('summarizes provider routeability for gateway diagnostics', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(gatewayProviderStatuses(adapters)).toEqual([
      expect.objectContaining({ id: 'claude', configured: true, protocol: 'anthropic' }),
      expect.objectContaining({ id: 'codex', configured: false, protocol: 'openai-compatible', unavailableMessage: expect.stringMatching(/no Codex account pool/i) }),
      expect.objectContaining({ id: 'omp', configured: false, protocol: 'unsupported', unavailableMessage: expect.stringMatching(/not implemented/i) }),
    ]);
  });
});
