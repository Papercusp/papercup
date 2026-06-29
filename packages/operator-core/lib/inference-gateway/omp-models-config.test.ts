import { describe, it, expect } from 'vitest';
import {
  ompGatewayModelsConfig,
  ompProviderForAccountProvider,
  OMP_MODELS_REL_PATH,
  OMP_GATEWAY_PLACEHOLDER_KEY,
} from './omp-models-config';

describe('ompGatewayModelsConfig', () => {
  it('returns null when no account is pinned (fail-soft, direct egress)', () => {
    expect(ompGatewayModelsConfig({ provider: 'anthropic' })).toBeNull();
    expect(ompGatewayModelsConfig({ provider: 'anthropic', accountId: '   ' })).toBeNull();
  });

  it('routes the anthropic provider through the gateway root with the account pin', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'anthropic', accountId: 'acct-7', port: 8788 });
    expect(cfg).not.toBeNull();
    expect(cfg!.relPath).toBe(OMP_MODELS_REL_PATH);
    expect(cfg!.baseUrl).toBe('http://127.0.0.1:8788');
    expect(cfg!.headers['x-papercusp-account']).toBe('acct-7');
    // managed block + provider override + base url + placeholder key + pin header
    expect(cfg!.content).toContain('# BEGIN PAPERCUSP_OMP_GATEWAY');
    expect(cfg!.content).toContain('# END PAPERCUSP_OMP_GATEWAY');
    expect(cfg!.content).toContain('providers:');
    expect(cfg!.content).toContain('  anthropic:');
    expect(cfg!.content).toContain('baseUrl: "http://127.0.0.1:8788"');
    expect(cfg!.content).toContain(`apiKey: "${OMP_GATEWAY_PLACEHOLDER_KEY}"`);
    expect(cfg!.content).toContain('"x-papercusp-account": "acct-7"');
  });

  it('routes the openai provider through the /v1 path', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'openai', accountId: 'oa-1', port: 8788 });
    expect(cfg!.baseUrl).toBe('http://127.0.0.1:8788/v1');
    expect(cfg!.content).toContain('  openai:');
    expect(cfg!.content).toContain('baseUrl: "http://127.0.0.1:8788/v1"');
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
    expect(withAll.headers['x-papercusp-priority']).toBe('queen');
    expect(withAll.content).toContain('"x-papercusp-owner": "spawn-9"');
    expect(withAll.content).toContain('"x-papercusp-priority": "queen"');

    const minimal = ompGatewayModelsConfig({ provider: 'anthropic', accountId: 'a', port: 8788 })!;
    expect(minimal.headers['x-papercusp-owner']).toBeUndefined();
    expect(minimal.content).not.toContain('x-papercusp-owner');
    expect(minimal.content).not.toContain('x-papercusp-priority');
  });

  it('escapes YAML-significant characters in header values', () => {
    const cfg = ompGatewayModelsConfig({
      provider: 'anthropic',
      accountId: 'a"b\\c',
      port: 8788,
    })!;
    expect(cfg.content).toContain('"x-papercusp-account": "a\\"b\\\\c"');
  });

  it('maps pool account provider → pi built-in provider', () => {
    expect(ompProviderForAccountProvider('claude')).toBe('anthropic');
    expect(ompProviderForAccountProvider('codex')).toBe('openai');
  });
});
