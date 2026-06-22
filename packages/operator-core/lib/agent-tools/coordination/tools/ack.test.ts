/**
 * ack.test.ts — the coord:ack HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). readThread/appendAck mocked. Pins:
 *   • single { msg_id } → one ok result self-describing its msg_id + ack ref;
 *   • msg_ids:[…] acks many;
 *   • an unknown msg_id fails only that item (error:'unknown_msg_id') — top-level
 *     ok stays true.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/ack.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../messages', () => ({ appendAck: vi.fn(), readThread: vi.fn() }));

import { appendAck, readThread } from '../messages';
const appendM = vi.mocked(appendAck);
const readM = vi.mocked(readThread);
const tool = (await import('./ack')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

let n = 0;
beforeEach(() => {
  vi.clearAllMocks();
  n = 0;
  // the original message exists, sent by 'peer'
  readM.mockImplementation(async (id: string) => [{ msg_id: id, from: 'peer' }] as never);
  appendM.mockImplementation(async () => ({ msg_id: `ack${++n}` }) as never);
});

describe('coord:ack handler (bulk keyed-array)', () => {
  it('single { msg_id } → one ok result self-describing its msg_id + ack ref', async () => {
    const b = await body({ msg_id: 'M-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'M-1', ack_msg_id: 'ack1', acked: 'M-1', acked_from: 'peer' });
    expect(appendM).toHaveBeenCalledWith({ ownerId: 'me' }, 'M-1', 'peer');
  });

  it('msg_ids:[…] acks many', async () => {
    const b = await body({ msg_ids: ['M-1', 'M-2'] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(appendM).toHaveBeenCalledTimes(2);
  });

  it('one ok + one unknown msg_id: only the missing item fails, top-level ok stays true', async () => {
    readM.mockImplementation(async (id: string) => (id === 'M-404' ? [] : ([{ msg_id: id, from: 'peer' }] as never)));
    const b = await body({ msg_ids: ['M-1', 'M-404'] });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'M-1' });
    expect(b.results[1]).toMatchObject({ ok: false, msg_id: 'M-404', error: 'unknown_msg_id' });
    // the unknown one was NOT acked
    expect(appendM).toHaveBeenCalledTimes(1);
  });
});
