/**
 * mcp-base-url.test.ts — resolveAgentMcpBaseUrl (WI-573). The opt-in proxy redirect:
 * env set → proxy base (deploy-restart-resilient); env unset → operator base unchanged
 * (so a no-proxy env can never break). Run: npx vitest run mcp-base-url
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAgentMcpBaseUrl, resolveInheritedOperatorBaseUrl } from './mcp-base-url';

const KEY = 'PAPERCUSP_MCP_PROXY_BASE';
afterEach(() => {
  delete process.env[KEY];
});

describe('resolveAgentMcpBaseUrl', () => {
  it('env UNSET → operator base unchanged (trailing slash trimmed)', () => {
    delete process.env[KEY];
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://localhost:3070');
    expect(resolveAgentMcpBaseUrl('http://localhost:3070/')).toBe('http://localhost:3070');
  });

  it('env SET → proxy base wins (deploy-restart-resilient)', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://127.0.0.1:9071');
  });

  it('env set to whitespace/empty → falls back to operator base (no accidental break)', () => {
    process.env[KEY] = '   ';
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://localhost:3070');
  });

  it('proxy base trailing slash is trimmed', () => {
    process.env[KEY] = 'http://127.0.0.1:9071/';
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://127.0.0.1:9071');
  });
});

describe('resolveInheritedOperatorBaseUrl', () => {
  it('undefined/empty input passes through unchanged', () => {
    expect(resolveInheritedOperatorBaseUrl(undefined)).toBe(undefined);
    expect(resolveInheritedOperatorBaseUrl('')).toBe('');
    expect(resolveInheritedOperatorBaseUrl('   ')).toBe('   ');
  });

  it('bare origin, no proxy configured → unchanged', () => {
    delete process.env[KEY];
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070')).toBe('http://localhost:3070');
  });

  it('/api/mcp-suffixed origin is stripped back to bare (the doubled-path bug)', () => {
    delete process.env[KEY];
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070/api/mcp')).toBe('http://localhost:3070');
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070/api/mcp/')).toBe('http://localhost:3070');
  });

  it('suffixed origin + proxy configured → stripped AND routed through the proxy', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070/api/mcp')).toBe('http://127.0.0.1:9071');
  });
});
