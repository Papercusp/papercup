import { describe, expect, it } from 'vitest';
import { gatewayProviderStatuses, makeGatewayProviderAdapters, providerForGatewayPath, providerForGatewayRequest, type GatewayProviderId } from './provider-adapters';
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
    // OMP reuses the Anthropic adapter (Claude-account pinning) — diagnostics row, not a routing target.
    expect(adapters.omp).toMatchObject({ id: 'omp', protocol: 'anthropic', upstreamBase: 'https://anthropic.test' });
    expect(adapters.omp.unavailableMessage).toBeNull();
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

  it('routes /v1/models to Codex only when the request is pinned to a Codex account', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(providerForGatewayRequest('/v1/models', { 'x-papercusp-account': 'codex-a' }, adapters)).toBe(adapters.codex);
    expect(providerForGatewayRequest('/v1/models?limit=1', { 'x-papercusp-account': 'claude-a' }, adapters)).toBe(adapters.claude);
    expect(providerForGatewayRequest('/v1/models', {}, adapters)).toBe(adapters.claude);
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
      expect.objectContaining({ id: 'omp', configured: true, protocol: 'anthropic' }),
    ]);
  });

  it('reports codex configured:true (with its openai upstreamBase) once a Codex pool is present', () => {
    // The existing diagnostics test only covers codex WITHOUT a pool (configured:false); pin the
    // true-branch so a working codex provider is reported routeable.
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });
    const codex = gatewayProviderStatuses(adapters).find((s) => s.id === 'codex')!;
    expect(codex.configured).toBe(true);
    expect(codex.upstreamBase).toBe('https://openai.test');
  });

  it('counts codex CLI-bridge accounts toward configured when the bearer pool is absent (WI-3068)', () => {
    // ChatGPT-subscription codex accounts have NO API bearer, so the bearer codexPool is
    // empty BY DESIGN — the diagnostics must not report a working all-CLI deployment as
    // "not configured" with the misleading unavailableMessage.
    let cli = 1;
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexCliAccountCount: () => cli,
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });
    expect(adapters.codex.pool).toBeNull();
    const codex = () => gatewayProviderStatuses(adapters).find((s) => s.id === 'codex')!;
    expect(codex()).toMatchObject({ configured: true, cliAccountCount: 1, unavailableMessage: null });
    // the count is a live GETTER: a hot-reload that removes the last CLI account flips the
    // status back to unconfigured (+ the fallback message) on the very next diagnostics read
    cli = 0;
    expect(codex()).toMatchObject({ configured: false, cliAccountCount: 0, unavailableMessage: expect.stringMatching(/no Codex account pool/i) });
  });

  it('providerForGatewayPath returns the actual adapter object and matches by PREFIX, not substring', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });
    // Exact adapter identity (not just id) so the caller gets the right pool + upstreamBase.
    expect(providerForGatewayPath('/v1/responses', adapters)).toBe(adapters.codex);
    expect(providerForGatewayPath('/v1/messages', adapters)).toBe(adapters.claude);
    // A path that only CONTAINS 'responses' but does not START with /v1/responses stays on Claude.
    expect(providerForGatewayPath('/v1/messages/responses', adapters).id).toBe('claude');
    expect(providerForGatewayPath('/responses', adapters).id).toBe('claude');
  });
});
