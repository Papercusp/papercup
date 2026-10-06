import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOneAutoloopCycle } from '../autoloop-cycle';
import { findFreeBasePort } from '../../deployment/p2p-perf-tier3/free-port-base';
import { getFlag } from '@papercusp/flags/server';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

// These are setup boundaries, not a fake cycle implementation. A missing native
// limit must return before any of them can run or touch the shared environment.
vi.mock('../../deployment/p2p-perf-tier3/free-port-base', () => ({ findFreeBasePort: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@testcontainers/postgresql', () => ({ PostgreSqlContainer: vi.fn() }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('native Gym proposer output admission before setup', () => {
  it.each([undefined, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses absent or invalid bound %s without ports, flags, containers or env mutation', async proposerMaxTokens => {
      vi.stubEnv('PAPERCUSP_ANTHROPIC_URL', 'PRIVATE_UNCHANGED_ROUTE');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'PRIVATE_UNCHANGED_BASE');
      const outcome = await runOneAutoloopCycle('PRIVATE_HARNESS', { fake: false, proposerMaxTokens });
      expect(outcome).toMatchObject({ ok: false, result: null,
        report: { costUsd: 0, error: expect.stringContaining('proposer requires its configured output token limit') } });
      expect(findFreeBasePort).not.toHaveBeenCalled();
      expect(getFlag).not.toHaveBeenCalled();
      expect(PostgreSqlContainer).not.toHaveBeenCalled();
      expect(process.env.PAPERCUSP_ANTHROPIC_URL).toBe('PRIVATE_UNCHANGED_ROUTE');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('PRIVATE_UNCHANGED_BASE');
    });
});
