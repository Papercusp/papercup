import { describe, it, expect } from 'vitest';
import {
  ompGatewayModelsConfig,
  ompProviderForAccountProvider,
  OMP_MODELS_REL_PATH,
  OMP_GATEWAY_PROVIDER_ID,
  OMP_GATEWAY_PLACEHOLDER_KEY,
} from './omp-models-config';

describe('ompGatewayModelsConfig', () => {
  it('returns null when no account is pinned (fail-soft, direct egress)', () => {
    expect(ompGatewayModelsConfig({ provider: 'anthropic' })).toBeNull();
    expect(ompGatewayModelsConfig({ provider: 'anthropic', accountId: '   ' })).toBeNull();
  });

  it('emits a DEDICATED anthropic-wire gateway provider pinned to the account', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'anthropic', accountId: 'acct-7', port: 8788 })!;
    expect(cfg.relPath).toBe(OMP_MODELS_REL_PATH);
    expect(cfg.providerId).toBe(OMP_GATEWAY_PROVIDER_ID);
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8788');
    expect(cfg.headers['x-papercusp-account']).toBe('acct-7');
    expect(cfg.models).toEqual(['claude-sonnet-4']);
    expect(cfg.modelSelector).toBe('papercusp-gateway/claude-sonnet-4');
    // dedicated provider block, NOT a bare `anthropic` override (D-006)
    expect(cfg.content).toContain('# BEGIN PAPERCUSP_OMP_GATEWAY');
    expect(cfg.content).toContain('  papercusp-gateway:');
    expect(cfg.content).not.toMatch(/^\s{2}anthropic:/m);
    expect(cfg.content).toContain('baseUrl: "http://127.0.0.1:8788"');
    expect(cfg.content).toContain(`apiKey: "${OMP_GATEWAY_PLACEHOLDER_KEY}"`);
    expect(cfg.content).toContain('api: anthropic-messages');
    expect(cfg.content).toContain('auth: apiKey');
    expect(cfg.content).toContain('"x-papercusp-account": "acct-7"');
    expect(cfg.content).toContain('- id: "claude-sonnet-4"');
  });

  it('routes the openai wire through the /v1 path with the responses api', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'openai', accountId: 'oa-1', port: 8788 })!;
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8788/v1');
    expect(cfg.content).toContain('api: openai-responses');
  });

  it('exposes caller-supplied models and selects the first', () => {
    const cfg = ompGatewayModelsConfig({
      provider: 'anthropic',
      accountId: 'a',
      models: ['claude-opus-4', 'claude-sonnet-4'],
      port: 8788,
    })!;
    expect(cfg.models).toEqual(['claude-opus-4', 'claude-sonnet-4']);
    expect(cfg.modelSelector).toBe('papercusp-gateway/claude-opus-4');
    expect(cfg.content).toContain('- id: "claude-opus-4"');
    expect(cfg.content).toContain('- id: "claude-sonnet-4"');
  });

  it('includes owner + priority headers only when provided', () => {
    const withAll = ompGatewayModelsConfig({
      provider: 'anthropic',
      accountId: 'a',
      ownerId: 'spawn-9',
      priority: 'queen',
      port: 8788,
    })!;
    expect(withAll.headers['x-papercusp-owner']).toBe('spawn-9');
    expect(withAll.content).toContain('"x-papercusp-owner": "spawn-9"');
    expect(withAll.content).toContain('"x-papercusp-priority": "queen"');

    const minimal = ompGatewayModelsConfig({ provider: 'anthropic', accountId: 'a', port: 8788 })!;
    expect(minimal.headers['x-papercusp-owner']).toBeUndefined();
    expect(minimal.content).not.toContain('x-papercusp-owner');
    expect(minimal.content).not.toContain('x-papercusp-priority');
  });

  it('escapes YAML-significant characters in header values', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'anthropic', accountId: 'a"b\\c', port: 8788 })!;
    expect(cfg.content).toContain('"x-papercusp-account": "a\\"b\\\\c"');
  });

  it('maps pool account provider → pi wire', () => {
    expect(ompProviderForAccountProvider('claude')).toBe('anthropic');
    expect(ompProviderForAccountProvider('codex')).toBe('openai');
  });
});
