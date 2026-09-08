import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { resolveSearchFilters } from './filters';
import { SESSION_READ_REFRESH_TIMEOUT_MS } from '../sessions/_shared';

const resolveSelfSession = vi.fn();
vi.mock('../../search/self-session', () => ({
  resolveSelfSession: (...args: unknown[]) => resolveSelfSession(...args),
}));

const noSql = null as unknown as Sql;

describe('resolveSearchFilters session:self timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('degrades a wedged self-session resolver instead of holding the search tool', async () => {
    vi.useFakeTimers();
    resolveSelfSession.mockReturnValue(new Promise<never>(() => {}));

    const pending = resolveSearchFilters(noSql, { session: 'self' }, 'su-self');
    await vi.advanceTimersByTimeAsync(SESSION_READ_REFRESH_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      filters: { owners: ['su-self'] },
      selfSession: null,
    });
  });
});
