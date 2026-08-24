/**
 * ack.test.ts — the coord:ack HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). getMessageById/appendAck mocked. Pins:
 *   • single { msg_id } → one ok result self-describing its msg_id + ack ref;
 *   • msg_ids:[…] acks many;
 *   • an unknown msg_id fails only that item (error:'unknown_msg_id') — top-level
 *     ok stays true.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/ack.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COORD_ACK_ACCEPTED_KEYS } from './ack-keys';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../messages', () => ({ appendAck: vi.fn(), getMessageById: vi.fn() }));

import { appendAck, getMessageById } from '../messages';
const appendM = vi.mocked(appendAck);
const getByIdM = vi.mocked(getMessageById);
const tool = (await import('./ack')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

let n = 0;
beforeEach(() => {
  vi.clearAllMocks();
  n = 0;
  // the original message exists, sent by 'peer'
  getByIdM.mockImplementation(async (id: string) => ({ msg_id: id, from: 'peer' }) as never);
  appendM.mockImplementation(async () => ({ msg_id: `ack${++n}` }) as never);
});

describe('coord:ack handler (bulk keyed-array)', () => {
  it('single { msg_id } → one ok result self-describing its msg_id + ack ref', async () => {
    const b = await body({ msg_id: 'M-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'M-1', ack_msg_id: 'ack1', acked: 'M-1', acked_from: 'peer' });
    expect(getByIdM).toHaveBeenCalledWith('M-1');
    expect(appendM).toHaveBeenCalledWith({ ownerId: 'me' }, 'M-1', 'peer');
  });

  it('msg_ids:[…] acks many', async () => {
    const b = await body({ msg_ids: ['M-1', 'M-2'] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(appendM).toHaveBeenCalledTimes(2);
  });

  it('one ok + one unknown msg_id: only the missing item fails, top-level ok stays true', async () => {
    getByIdM.mockImplementation(async (id: string) => (id === 'M-404' ? null : ({ msg_id: id, from: 'peer' } as never)));
    const b = await body({ msg_ids: ['M-1', 'M-404'] });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'M-1' });
    expect(b.results[1]).toMatchObject({ ok: false, msg_id: 'M-404', error: 'unknown_msg_id' });
    // the unknown one was NOT acked
    expect(appendM).toHaveBeenCalledTimes(1);
  });
});

/**
 * EI-21329316352681219 — half 1 of the two-hop pin. COORD_ACK_ACCEPTED_KEYS is what
 * control-core.test.ts checks generated cue text against; if it could drift from the
 * real schema, that guard would police a stale list. So pin it to the tool itself here,
 * where the real tool is already imported.
 */
describe('coord:ack accepted-key pin (EI-21329316352681219)', () => {
  const argShapeKeys = (schema: unknown): string[] => {
    const s = schema as {
      shape?: Record<string, unknown>;
      _def?: {
        shape?: Record<string, unknown>;
        schema?: { shape?: Record<string, unknown> };
        innerType?: { shape?: Record<string, unknown> };
      };
    };
    const shape = s?.shape ?? s?._def?.shape ?? s?._def?.schema?.shape ?? s?._def?.innerType?.shape;
    return shape ? Object.keys(shape) : [];
  };

  it('the constant equals the tool\'s real arg schema keys', () => {
    const keys = argShapeKeys(tool.args);
    // POSITIVE CONTROL: a reflection that stops working must FAIL here rather than
    // silently pass with [], which would make every downstream subset check vacuous.
    expect(keys.length).toBeGreaterThan(0);
    expect([...keys].sort()).toEqual([...COORD_ACK_ACCEPTED_KEYS].sort());
  });

  it('carries no free-text field — the arg the wind-down cue used to promise', () => {
    const keys = argShapeKeys(tool.args);
    expect(keys).not.toContain('summary');
    expect(keys).not.toContain('note');
    expect(keys).not.toContain('disposition');
  });
});
