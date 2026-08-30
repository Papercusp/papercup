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
    // Two optional SQL fragments (`once` + note scope) are composed through
    // the same tagged-template seam before the UPDATE itself executes, then the
    // queued-delivery settle runs through that SAME seam as a fourth call — it is
    // threaded `{ client: tx }` so it stays inside these bounds. That fourth call
    // is the point of the assertion, not an incidental count: before WI-1215582 the
    // settle omitted the client and fell through to the UNBOUNDED `getOrgPg().sql`,
    // which is what `h.rawSql` below catches. Read the two together — a drop back to
    // 3 here means the settle left the transaction, not that it stopped running.
    expect(h.tx).toHaveBeenCalledTimes(4);
    expect(h.rawSql).not.toHaveBeenCalled();
  });
});
