/**
 * read.test.ts — coord:read (EI-9942): a thin wrapper over the existing,
 * already-tested `getMessageById` (WI-3832). Mocks `../messages` so this stays
 * a pure handler-contract test; `getMessageById`'s own PG-fast-path/fallback
 * behavior is proven in messages-get-by-id.test.ts and is not re-tested here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../messages', () => ({ getMessageById: vi.fn() }));

import { getMessageById } from '../messages';
const getM = vi.mocked(getMessageById);
const tool = (await import('./read')).default;

async function run(args: unknown) {
  const res = (await tool.handler(args as never, {} as never)) as { content: { text: string }[] };
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('coord:read', () => {
  it('found: returns the FULL envelope untruncated, keyed by the requested msg_id', async () => {
    const full = {
      msg_id: 'mrh4rf15',
      from: 'su-l1',
      to: ['su-leader'],
      kind: 'note',
      ts: '2026-07-12T00:00:00Z',
      summary: 'root-cause report',
      body: 'x'.repeat(2615), // the exact oversize scenario EI-9942 reports
    };
    getM.mockResolvedValueOnce(full as never);

    const out = await run({ msg_id: 'mrh4rf15' });

    expect(getM).toHaveBeenCalledWith('mrh4rf15');
    expect(out).toMatchObject({ ok: true, found: true, msg_id: 'mrh4rf15' });
    expect(out.message.body).toHaveLength(2615); // no truncation applied anywhere in this path
  });

  it('not found: found:false, message:null — never throws on an unknown/expired msg_id', async () => {
    getM.mockResolvedValueOnce(null);
    const out = await run({ msg_id: 'nope' });
    expect(out).toMatchObject({ ok: true, found: false, msg_id: 'nope', message: null });
  });
});
