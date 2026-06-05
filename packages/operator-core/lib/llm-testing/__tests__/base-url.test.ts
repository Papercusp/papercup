/**
 * llmTestBaseUrl — the env-collision guard (memory-backend-benchmark
 * P-009): the fleet-wide PAPERCUSP_OPERATOR_URL means the MCP *endpoint*
 * (…/api/mcp); the llm-testing targets need the HTTP *origin*. A
 * path-bearing value must be reduced to its origin or every scenario
 * 404s.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { llmTestBaseUrl } from '../targets/base-url';

const SPECIFIC = 'PAPERCUSP_LLM_TEST_OPERATOR_URL';
const FLEET = 'PAPERCUSP_OPERATOR_URL';

const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

describe('llmTestBaseUrl', () => {
  it('returns undefined when neither var is set', () => {
    setEnv(SPECIFIC, undefined);
    setEnv(FLEET, undefined);
    expect(llmTestBaseUrl()).toBeUndefined();
  });

  it('prefers the llm-test-specific var verbatim (sans trailing slash)', () => {
    setEnv(SPECIFIC, 'http://127.0.0.1:3170/');
    setEnv(FLEET, 'http://localhost:3070/api/mcp');
    expect(llmTestBaseUrl()).toBe('http://127.0.0.1:3170');
  });

  it('reduces a path-bearing fleet var to its origin (the /api/mcp case)', () => {
    setEnv(SPECIFIC, undefined);
    setEnv(FLEET, 'http://localhost:3070/api/mcp');
    expect(llmTestBaseUrl()).toBe('http://localhost:3070');
  });

  it('passes through an origin-only fleet var', () => {
    setEnv(SPECIFIC, undefined);
    setEnv(FLEET, 'http://127.0.0.1:3070');
    expect(llmTestBaseUrl()).toBe('http://127.0.0.1:3070');
  });

  it('falls back to a trimmed raw value when the fleet var is not a URL', () => {
    setEnv(SPECIFIC, undefined);
    setEnv(FLEET, 'not-a-url/');
    expect(llmTestBaseUrl()).toBe('not-a-url');
  });
});
