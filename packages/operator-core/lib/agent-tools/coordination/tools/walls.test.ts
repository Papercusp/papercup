/**
 * coord:walls handler regression for WI-4557.
 *
 * getOrgPg() returns a wrapper object; only wrapper.sql is callable as a
 * postgres tagged template. Exercising the real handler with that shape makes
 * `const sql = await getOrgPg()` fail loudly instead of shipping again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: h.sql })),
}));

const tool = (await import('./walls')).default;

type Out = {
  data: { ok: boolean; count: number; waiting: number; stranded: number; walls: unknown[] };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.sql
    .mockResolvedValueOnce([]) // coord_presence
    .mockResolvedValueOnce([]) // carry_notes
    .mockResolvedValueOnce([]); // needs-human work_items
});

describe('coord:walls handler', () => {
  it('calls getOrgPg().sql as the tagged-template function and returns an empty wall set', async () => {
    const out = (await tool.handler({}, { workspaceId: 'ws-test' } as never)) as Out;

    expect(h.sql).toHaveBeenCalledTimes(3);
    expect(out.data).toMatchObject({
      ok: true,
      count: 0,
      waiting: 0,
      stranded: 0,
      walls: [],
    });
  });
});
