import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { operatorApiBase } from './operator-api-base';

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
});
