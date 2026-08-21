/**
 * validate-durability-settings — the boot-time visibility guard for EI-19298078028509573.
 *
 * Proves: a relaxed synchronous_commit setting is WARNED loudly (naming the exact value +
 * the crash-loss consequence) so a post-crash investigation doesn't have to rediscover it
 * from first principles; a durable setting logs quietly; and a DB read failure never fails
 * the check (fail-soft, like every startup/ sibling).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<{ synchronous_commit: string; fsync: string; full_page_writes: string }>,
  throwOnQuery: false,
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: async () => {
      if (h.throwOnQuery) throw new Error('connection refused');
      return h.rows;
    },
  }),
}));

const { checkDurabilitySettings } = await import('./validate-durability-settings');

beforeEach(() => {
  h.rows = [];
  h.throwOnQuery = false;
});

describe('checkDurabilitySettings', () => {
  it('WARNS when synchronous_commit is off — names the value and the crash-loss consequence', async () => {
    h.rows = [{ synchronous_commit: 'off', fsync: 'on', full_page_writes: 'on' }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await checkDurabilitySettings();

    expect(r.ok).toBe(true);
    expect(r.relaxedDurability).toBe(true);
    expect(r.settings).toEqual({ synchronousCommit: 'off', fsync: 'on', fullPageWrites: 'on' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("synchronous_commit='off'"));
    warn.mockRestore();
  });

  it('logs quietly (no warn) when synchronous_commit is on', async () => {
    h.rows = [{ synchronous_commit: 'on', fsync: 'on', full_page_writes: 'on' }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const r = await checkDurabilitySettings();

    expect(r.relaxedDurability).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it('fail-soft: a DB read failure never throws and reports unknown', async () => {
    h.throwOnQuery = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await checkDurabilitySettings();

    expect(r.ok).toBe(true);
    expect(r.settings).toBeNull();
    expect(r.relaxedDurability).toBe(false);
    warn.mockRestore();
  });
});
