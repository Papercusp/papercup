import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlSpy } = vi.hoisted(() => ({
  sqlSpy: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlSpy }),
}));

const ROW = {
  msg_id: 'm-1',
  ts: '2026-08-03T00:00:00.000Z',
  harness_slug: 'papercusp',
  body: {
    kind: 'message',
    from: 'su-1a2b3c4d-0000-4a1b-9d2e-77aa10bc0011',
    to: ['su-9f8e7d6c-1111-4a1b-9d2e-77aa10bc0011'],
    summary: 'Needle summary',
    body: 'Needle long body',
    lifecycle: 'finding',
  },
  reply_count: 0,
  last_reply_ts: null,
};

beforeEach(() => {
  sqlSpy.mockReset();
  sqlSpy.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = Array.from(strings).join('');
    if (text.includes('SELECT c.msg_id')) return [ROW];
    if (text.includes('SELECT count(*)')) return [{ n: 1 }];
    // Dynamic sql fragments (the search predicate itself) are also built through
    // this tagged function; their return value is only interpolated by the outer
    // statement and is not consumed by this test double.
    return [];
  });
});

describe('conversations.agentMessageList server-side search (WI-7243)', () => {
  it('adds a Postgres substring predicate and retains body only for searched rows', async () => {
    const { resolveNamedQueryV2 } = await import('./index');
    const rows = (await resolveNamedQueryV2('conversations.agentMessageList', {
      limit: 10,
      q: ' needle ',
    })) as Array<Record<string, unknown>>;

    expect(rows[0]?.body).toBe('Needle long body');
    expect(
      sqlSpy.mock.calls.some(([strings]) =>
        Array.from(strings as TemplateStringsArray)
          .join('')
          .includes('ILIKE'),
      ),
    ).toBe(true);
  });

  it('keeps the default list body-free while preserving the rest of the row', async () => {
    const { resolveNamedQueryV2 } = await import('./index');
    const rows = (await resolveNamedQueryV2('conversations.agentMessageList', { limit: 10 })) as Array<
      Record<string, unknown>
    >;

    expect('body' in (rows[0] ?? {})).toBe(false);
    expect(rows[0]).toMatchObject({
      msg_id: 'm-1',
      summary: 'Needle summary',
      lifecycle: 'finding',
    });
    expect(
      sqlSpy.mock.calls.some(([strings]) =>
        Array.from(strings as TemplateStringsArray)
          .join('')
          .includes('ILIKE'),
      ),
    ).toBe(false);
  });
});
