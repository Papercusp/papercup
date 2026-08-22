import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operatorApiBase } from './operator-api-base';
// @ts-expect-error — runtime-neutral .mjs mirror for standalone MCP helpers
import { operatorApiBase as operatorApiBaseMjs } from './operator-api-base.mjs';

describe('operatorApiBase', () => {
  const saved = { base: process.env.PAPERCUSP_OPERATOR_BASE, port: process.env.PAPERCUSP_HONO_PORT };
  beforeEach(() => {
    delete process.env.PAPERCUSP_OPERATOR_BASE;
    delete process.env.PAPERCUSP_HONO_PORT;
  });
  afterEach(() => {
    if (saved.base === undefined) delete process.env.PAPERCUSP_OPERATOR_BASE;
    else process.env.PAPERCUSP_OPERATOR_BASE = saved.base;
    if (saved.port === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = saved.port;
  });

  it('defaults to the Hono host on :3070 (NOT the Vite :3055)', () => {
    expect(operatorApiBase()).toBe('http://localhost:3070');
  });

  it('derives the port from PAPERCUSP_HONO_PORT (e.g. staging :3170)', () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    expect(operatorApiBase()).toBe('http://localhost:3170');
  });

  it('PAPERCUSP_OPERATOR_BASE overrides everything', () => {
    process.env.PAPERCUSP_OPERATOR_BASE = 'http://example.test:9999';
    process.env.PAPERCUSP_HONO_PORT = '3170';
    expect(operatorApiBase()).toBe('http://example.test:9999');
  });

  it('keeps the standalone .mjs mirror aligned with the TypeScript helper', () => {
    expect(operatorApiBaseMjs()).toBe(operatorApiBase());
    process.env.PAPERCUSP_HONO_PORT = '3170';
    expect(operatorApiBaseMjs()).toBe('http://localhost:3170');
    process.env.PAPERCUSP_OPERATOR_BASE = 'http://example.test:9999';
    expect(operatorApiBaseMjs()).toBe('http://example.test:9999');
  });

  it('keeps release-operator callers on the centralized helper', () => {
    const root = import.meta.dirname;
    const callers = [
      'agent-tools-shared.mjs',
      'agent-resources-shared.mjs',
      'agent-tools/oracle/prompts.ts',
      'endpoint-route/routes/desktop/docs-qa.ts',
    ];
    for (const relativePath of callers) {
      const source = readFileSync(join(root, relativePath), 'utf8');
      expect(source, relativePath).toContain('operatorApiBase');
      expect(source, relativePath).not.toMatch(/(?:AGENT_TOOLS_BASE|DELEGATE_BASE|ORACLE_BASE)\s*\?\?/);
      expect(source, relativePath).not.toMatch(/localhost:\$\{process\.env\.(?:PORT|PAPERCUSP_HONO_PORT)/);
    }
  });
});
