import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  boundedOrgTxn: vi.fn(),
  rawSql: vi.fn(),
  tx: Object.assign(vi.fn(), { array: vi.fn() }),
}));

vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.rawSql }),
}));

const { cancelAwaitsForSubscribersOnKeys, findAnnouncementsForKey } = await import('./store');

const boundedOptions = {
  acquireTimeoutMs: 5_000,
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 5_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.boundedOrgTxn.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(h.tx));
  h.tx.array.mockImplementation((values: unknown[]) => values);
  h.tx.mockImplementation(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    return query.includes('SELECT *') ? [] : [{ id: 1 }];
  });
});

describe('events:await pre-registration store guards', () => {
  it('bounds announcement lookup before an await can be registered', async () => {
    await expect(findAnnouncementsForKey('gate:test')).resolves.toEqual([]);

    expect(h.boundedOrgTxn).toHaveBeenCalledWith(expect.any(Function), boundedOptions);
    expect(h.tx).toHaveBeenCalledTimes(1);
    expect(h.rawSql).not.toHaveBeenCalled();
  });

  it('bounds supersede cancellation before an await can be registered', async () => {
    await expect(cancelAwaitsForSubscribersOnKeys(['sub-a'], ['gate:test'])).resolves.toBe(1);

    expect(h.boundedOrgTxn).toHaveBeenCalledWith(expect.any(Function), boundedOptions);
    expect(h.tx).toHaveBeenCalledTimes(2);
    expect(h.rawSql).not.toHaveBeenCalled();
  });
});
