/**
 * conversations-join.test.ts — the conversations:join HANDLER branch + shaping,
 * bulk keyed-array contract (bulk-endpoint-standardization-2026-06-21;
 * join/leaveConversation mocked). Pins the leave-vs-join branch (leave:true routes
 * to leaveConversation and does NOT join), the store-error → per-item
 * { ok:false, error } mapping, the success shaping (echoes the resolved delivery
 * mode, keyed by id), and that ids:[…] fans the same mode across many.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-join.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ joinConversation: vi.fn(), leaveConversation: vi.fn() }));

import { joinConversation, leaveConversation } from '../conversations';
const joinM = vi.mocked(joinConversation);
const leaveM = vi.mocked(leaveConversation);
const tool = (await import('./conversations-join')).default;

type Out = { content: { text: string }[] };
const body = async (args: unknown) => JSON.parse(((await tool.handler(args as never, {} as never)) as Out).content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('conversations:join handler (bulk keyed-array)', () => {
  it('leave:true routes to leaveConversation and does not join', async () => {
    const b = await body({ id: 'c1', leave: true });
    expect(leaveM).toHaveBeenCalledWith({ ownerId: 'me' }, 'c1');
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c1', left: 'c1' });
    expect(joinM).not.toHaveBeenCalled();
  });

  it('maps a join store error to a per-item { ok:false, error }', async () => {
    joinM.mockResolvedValue({ error: 'not_found' } as never);
    const b = await body({ id: 'c1', mode: 'full' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'c1', error: 'not_found' });
  });

  it('on success echoes the resolved delivery mode, keyed by id', async () => {
    joinM.mockResolvedValue({ mode: 'digest' } as never);
    const b = await body({ id: 'c1', mode: 'digest' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c1', mode: 'digest' });
  });

  it('ids:[…] fans the same mode across many', async () => {
    joinM.mockResolvedValue({ mode: 'full' } as never);
    const b = await body({ ids: ['c1', 'c2'], mode: 'full' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(joinM).toHaveBeenCalledTimes(2);
    expect(joinM).toHaveBeenCalledWith({ ownerId: 'me' }, expect.objectContaining({ conversation_id: 'c2', mode: 'full' }));
  });
});
