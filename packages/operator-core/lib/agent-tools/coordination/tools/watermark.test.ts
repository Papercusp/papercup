/**
 * watermark.test.ts — coord:watermark handler, EI-2042 read-receipt contract.
 *
 * The read-receipt design: a monotonic per-agent `messages_shown_ts` cursor
 * (advanced in coord:inbox at [coord+N] injection time, see inbox.ts) doubles
 * as a READ-RECEIPT — a sender reads a PEER's cursor via `agent` and, with
 * `sent_ts`, gets a direct `seen` boolean instead of comparing timestamps by
 * hand. Pins:
 *   • no `agent` → reads the CALLER's own watermark (self:true).
 *   • `agent` → reads that PEER's watermark instead (self:false), read-only
 *     (never the caller's own watermark row).
 *   • `agent` + `sent_ts` <= their read_through_ts → seen:true.
 *   • `agent` + `sent_ts` > their read_through_ts (or they have none yet) →
 *     seen:false.
 *   • no `sent_ts` → no `seen` key at all (not even `undefined` noise).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-me' })) }));
vi.mock('../watermarks', () => ({ readWatermark: vi.fn() }));

import { readWatermark } from '../watermarks';
const readWm = vi.mocked(readWatermark);
const tool = (await import('./watermark')).default;

type Out = { data: Record<string, unknown> };
const body = async (args: unknown) =>
  ((await tool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('coord:watermark handler (EI-2042 read-receipt)', () => {
  it('no `agent` → reads the CALLER\'s own watermark', async () => {
    readWm.mockResolvedValueOnce({ messages_shown_ts: '2026-07-18T06:00:00.000Z' } as never);

    const out = await body({});

    expect(readWm).toHaveBeenCalledWith('su-me');
    expect(out).toMatchObject({ owner_id: 'su-me', self: true, read_through_ts: '2026-07-18T06:00:00.000Z' });
    expect(out.seen).toBeUndefined();
  });

  it('`agent` → reads that PEER\'s watermark instead, never the caller\'s own', async () => {
    readWm.mockResolvedValueOnce({ messages_shown_ts: '2026-07-18T05:00:00.000Z' } as never);

    const out = await body({ agent: 'su-peer' });

    expect(readWm).toHaveBeenCalledWith('su-peer');
    expect(readWm).not.toHaveBeenCalledWith('su-me');
    expect(out).toMatchObject({ owner_id: 'su-peer', self: false, read_through_ts: '2026-07-18T05:00:00.000Z' });
  });

  it('seen:true when the peer\'s read_through_ts is AT OR AFTER sent_ts (they saw it)', async () => {
    readWm.mockResolvedValueOnce({ messages_shown_ts: '2026-07-18T06:05:00.000Z' } as never);

    const out = await body({ agent: 'su-peer', sent_ts: '2026-07-18T06:00:00.000Z' });

    expect(out.seen).toBe(true);
  });

  it('seen:false when the peer\'s read_through_ts is BEFORE sent_ts (not yet seen)', async () => {
    readWm.mockResolvedValueOnce({ messages_shown_ts: '2026-07-18T05:00:00.000Z' } as never);

    const out = await body({ agent: 'su-peer', sent_ts: '2026-07-18T06:00:00.000Z' });

    expect(out.seen).toBe(false);
  });

  it('seen:false when the peer has NO read watermark yet at all', async () => {
    readWm.mockResolvedValueOnce({ messages_shown_ts: '' } as never);

    const out = await body({ agent: 'su-peer', sent_ts: '2026-07-18T06:00:00.000Z' });

    expect(out.seen).toBe(false);
  });

  it('no `sent_ts` → no `seen` key at all, even when reading a peer', async () => {
    readWm.mockResolvedValueOnce({ messages_shown_ts: '2026-07-18T06:05:00.000Z' } as never);

    const out = await body({ agent: 'su-peer' });

    expect('seen' in out).toBe(false);
  });
});
