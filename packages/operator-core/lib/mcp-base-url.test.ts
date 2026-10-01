/**
 * mcp-base-url.test.ts — resolveAgentMcpBaseUrl (WI-573). The opt-in proxy redirect:
 * env set → proxy base (deploy-restart-resilient); env unset → operator base unchanged
 * (so a no-proxy env can never break). Run: npx vitest run mcp-base-url
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveAgentMcpBaseUrl,
  resolveInheritedOperatorBaseUrl,
  resolveLongLivedSessionMcpBaseUrl,
  resolveSpawnHostOperatorBaseUrl,
} from './mcp-base-url';

const KEY = 'PAPERCUSP_MCP_PROXY_BASE';
const STAGING_PROXY_PORT_KEY = 'PAPERCUSP_MCP_STAGING_PROXY_PORT';
afterEach(() => {
  delete process.env[KEY];
  delete process.env[STAGING_PROXY_PORT_KEY];
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

  it('every explicit non-live operator port stays direct when the :3070 proxy is configured', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    expect(resolveAgentMcpBaseUrl('http://localhost:3170')).toBe('http://localhost:3170');
    expect(resolveAgentMcpBaseUrl('http://127.0.0.1:3170/')).toBe('http://127.0.0.1:3170');
    expect(resolveAgentMcpBaseUrl('http://localhost:3271')).toBe('http://localhost:3271');
    expect(resolveAgentMcpBaseUrl('http://127.0.0.1:3295/')).toBe('http://127.0.0.1:3295');
  });

  it('routes only a local staging operator through its configured same-vintage proxy', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    process.env[STAGING_PROXY_PORT_KEY] = '9171';
    expect(resolveAgentMcpBaseUrl('http://localhost:3170')).toBe('http://127.0.0.1:9171');
    expect(resolveAgentMcpBaseUrl('http://127.0.0.1:3170/')).toBe('http://127.0.0.1:9171');
    expect(resolveAgentMcpBaseUrl('http://localhost:3271')).toBe('http://localhost:3271');
    expect(resolveAgentMcpBaseUrl('http://example.com:3170')).toBe('http://example.com:3170');
    expect(resolveAgentMcpBaseUrl('https://localhost:3170')).toBe('https://localhost:3170');
  });

  it('keeps local staging direct when the staging proxy port is invalid', () => {
    for (const port of ['0', '3170', '65536', '91/../../']) {
      process.env[STAGING_PROXY_PORT_KEY] = port;
      expect(resolveAgentMcpBaseUrl('http://localhost:3170')).toBe('http://localhost:3170');
    }
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

  it('staging/current-build inherited URL stays direct when the live proxy is configured', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3170/api/mcp')).toBe('http://localhost:3170');
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3271/api/mcp')).toBe('http://localhost:3271');
  });
});

describe('resolveSpawnHostOperatorBaseUrl (WI-6154)', () => {
  it('uses the desktop sidecar dev port over an inherited staging Hono port', () => {
    expect(resolveSpawnHostOperatorBaseUrl({
      OPERATOR_DEV_PORT: '33700', PAPERCUSP_HONO_PORT: '3170',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
    })).toBe('http://localhost:33700');
  });

  it('HONO_PORT set (this process IS an operator host) → own identity wins, even with a stale inherited OPERATOR_URL', () => {
    // Reproduces the staging-host leak: .env.local sets PAPERCUSP_OPERATOR_URL to
    // the LIVE :3070 operator, and the staging service ADDITIONALLY exports its
    // own PAPERCUSP_HONO_PORT=3170 on top — a spawn from staging must pin :3170.
    expect(
      resolveSpawnHostOperatorBaseUrl({
        PAPERCUSP_HONO_PORT: '3170',
        PAPERCUSP_OPERATOR_URL: 'http://localhost:3070/api/mcp',
      }),
    ).toBe('http://localhost:3170');
  });

  it('HONO_PORT unset (a plain client/agent session, not itself an operator host) → falls back to the inherited OPERATOR_URL', () => {
    expect(
      resolveSpawnHostOperatorBaseUrl({
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      }),
    ).toBe('http://127.0.0.1:9071');
  });

  it('inherited OPERATOR_URL /api/mcp suffix is stripped back to the bare origin', () => {
    expect(
      resolveSpawnHostOperatorBaseUrl({
        PAPERCUSP_OPERATOR_URL: 'http://localhost:3070/api/mcp',
      }),
    ).toBe('http://localhost:3070');
  });

  it('neither var set → defaults to the live operator origin', () => {
    expect(resolveSpawnHostOperatorBaseUrl({})).toBe('http://localhost:3070');
  });

  it('HONO_PORT set, no inherited OPERATOR_URL at all → still pins to own identity', () => {
    expect(resolveSpawnHostOperatorBaseUrl({ PAPERCUSP_HONO_PORT: '4100' })).toBe('http://localhost:4100');
  });
});

describe('resolveLongLivedSessionMcpBaseUrl', () => {
  it('uses the stable proxy fallback instead of inheriting a staging host port', () => {
    expect(
      resolveLongLivedSessionMcpBaseUrl({
        PAPERCUSP_HONO_PORT: '3170',
        PAPERCUSP_OPERATOR_URL: 'http://localhost:3170',
      }),
    ).toBe('http://127.0.0.1:9071');
  });

  it('prefers the configured stable proxy and trims trailing slashes', () => {
    expect(
      resolveLongLivedSessionMcpBaseUrl({
        PAPERCUSP_HONO_PORT: '3170',
        PAPERCUSP_OPERATOR_URL: 'http://localhost:3170',
        PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9171/',
      }),
    ).toBe('http://127.0.0.1:9171');
  });
});
