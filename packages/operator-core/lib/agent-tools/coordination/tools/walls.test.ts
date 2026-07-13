/**
 * coord:walls handler regression for WI-4557.
 *
 * getOrgPg() returns a wrapper object; only wrapper.sql is callable as a
 * postgres tagged template. Exercising the real handler with that shape makes
 * `const sql = await getOrgPg()` fail loudly instead of shipping again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: vi.fn(() => ({ sql: h.sql })),
}));

const tool = (await import('./walls')).default;

type Out = { content: Array<{ text: string }>; isError?: boolean };

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

    expect(out.isError).not.toBe(true);
    expect(h.sql).toHaveBeenCalledTimes(3);
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({
      ok: true,
      count: 0,
      waiting: 0,
      stranded: 0,
      walls: [],
    });
  });
});
