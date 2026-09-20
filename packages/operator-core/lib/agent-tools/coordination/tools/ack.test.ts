/**
 * ack.test.ts — the coord:ack HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). resolveMessageRef/appendAck mocked. Pins:
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
vi.mock('../messages', () => ({ appendAck: vi.fn(), resolveMessageRef: vi.fn() }));

import { appendAck, resolveMessageRef } from '../messages';
const appendM = vi.mocked(appendAck);
const resolveRefM = vi.mocked(resolveMessageRef);
const tool = (await import('./ack')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

let n = 0;
beforeEach(() => {
  vi.clearAllMocks();
  n = 0;
  // the original message exists, sent by 'peer'
  resolveRefM.mockImplementation(async (id: string) => ({
    status: 'found',
    msgId: id,
    message: { msg_id: id, from: 'peer' },
    resolvedFrom: 'exact',
  }) as never);
  appendM.mockImplementation(async () => ({ msg_id: `ack${++n}` }) as never);
});

describe('coord:ack handler (bulk keyed-array)', () => {
  it('single { msg_id } → one ok result self-describing its msg_id + ack ref', async () => {
    const b = await body({ msg_id: 'M-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'M-1', ack_msg_id: 'ack1', acked: 'M-1', acked_from: 'peer' });
    expect(resolveRefM).toHaveBeenCalledWith('M-1');
    expect(appendM).toHaveBeenCalledWith({ ownerId: 'me' }, 'M-1', 'peer', null);
  });

  it('forwards the original message federation scope to appendAck', async () => {
    resolveRefM.mockResolvedValueOnce({
      status: 'found',
      msgId: 'M-fed',
      message: { msg_id: 'M-fed', from: 'peer', harness_slug: 'shared-hive' },
      resolvedFrom: 'exact',
    } as never);
    await body({ msg_id: 'M-fed' });
    expect(appendM).toHaveBeenCalledWith({ ownerId: 'me' }, 'M-fed', 'peer', 'shared-hive');
  });

  it('acks a projection-only escalation and returns the canonical resolved id', async () => {
    const projectionId = 'escalation-0000-abcdef0123456789abcdef0123456789';
    resolveRefM.mockResolvedValueOnce({
      status: 'found',
      msgId: projectionId,
      message: { msg_id: projectionId, from: 'human', kind: 'escalation', harness_slug: 'papercusp' },
      resolvedFrom: 'exact',
    } as never);

    const b = await body({ msg_id: projectionId });

    expect(b.results[0]).toMatchObject({
      ok: true,
      msg_id: projectionId,
      acked: projectionId,
      acked_from: 'human',
    });
    expect(appendM).toHaveBeenCalledWith({ ownerId: 'me' }, projectionId, 'human', 'papercusp');
  });

  it('uses the canonical id for a unique prefix before appending and responding', async () => {
    const requestedId = 'escalation-0000-abcdef';
    const canonicalId = 'escalation-0000-abcdef0123456789abcdef0123456789';
    resolveRefM.mockResolvedValueOnce({
      status: 'found',
      msgId: canonicalId,
      message: { msg_id: canonicalId, from: 'human', kind: 'escalation' },
      resolvedFrom: 'prefix',
    } as never);

    const b = await body({ msg_id: requestedId });

    expect(b.results[0]).toMatchObject({ ok: true, msg_id: canonicalId, acked: canonicalId });
    expect(appendM).toHaveBeenCalledWith({ ownerId: 'me' }, canonicalId, 'human', null);
  });

  it('msg_ids:[…] acks many', async () => {
    const b = await body({ msg_ids: ['M-1', 'M-2'] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(appendM).toHaveBeenCalledTimes(2);
  });

  it('one ok + one unknown msg_id: only the missing item fails, top-level ok stays true', async () => {
    resolveRefM.mockImplementation(async (id: string) =>
      id === 'M-404'
        ? ({ status: 'not-found', msgId: id, looksTruncated: false } as never)
        : ({ status: 'found', msgId: id, message: { msg_id: id, from: 'peer' }, resolvedFrom: 'exact' } as never),
    );
    const b = await body({ msg_ids: ['M-1', 'M-404'] });
    expect(b).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, msg_id: 'M-1' });
    expect(b.results[1]).toMatchObject({ ok: false, msg_id: 'M-404', error: 'unknown_msg_id' });
    // the unknown one was NOT acked
    expect(appendM).toHaveBeenCalledTimes(1);
  });

  it('rejects an ambiguous prefix without acknowledging any candidate', async () => {
    resolveRefM.mockResolvedValueOnce({
      status: 'ambiguous',
      msgId: 'M-',
      candidates: ['M-1', 'M-2'],
    } as never);

    const b = await body({ msg_id: 'M-' });

    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, msg_id: 'M-', error: 'msg_id_ambiguous', candidates: ['M-1', 'M-2'] });
    expect(appendM).not.toHaveBeenCalled();
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
