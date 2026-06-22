/**
 * conversations-promote.test.ts — the conversations:promote HANDLER shaping, bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21;
 * promoteConversation, which mints the issue + re-parents the thread, is mocked).
 * Pins the store-error → per-item { ok:false, error } mapping and the success
 * shaping: the minted issue, thread_carried flag, the hint that interpolates the
 * new issue id into the issues:comment follow-up (keyed by id), and that ids:[…]
 * fans the same severity across many.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-promote.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ promoteConversation: vi.fn() }));

import { promoteConversation } from '../conversations';
const promoteM = vi.mocked(promoteConversation);
const tool = (await import('./conversations-promote')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => vi.clearAllMocks());

describe('conversations:promote handler (bulk keyed-array)', () => {
  it('maps a store error to a per-item { ok:false, error }', async () => {
    promoteM.mockResolvedValue({ error: 'not_found' } as never);
    const b = await body({ id: 'c1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'c1', error: 'not_found' });
  });

  it('on success surfaces the issue, thread_carried, and an issues:comment hint (keyed by id)', async () => {
    promoteM.mockResolvedValue({
      conversation: { id: 'c1', state: 'promoted' },
      issue: { id: 'EI-9' },
      thread_reparented: true,
      delivered: 3,
    } as never);
    const b = await body({ id: 'c1', severity: 'major' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    const r = b.results[0];
    expect(r).toMatchObject({
      ok: true, id: 'c1', state: 'promoted', issue: { id: 'EI-9' }, thread_carried: true, notified_subscribers: 3,
    });
    expect(String(r.hint)).toContain('EI-9');
    // severity passed through to the store
    expect(promoteM.mock.calls[0]![1]).toMatchObject({ conversation_id: 'c1', severity: 'major' });
  });

  it('ids:[…] fans the same severity across many; one bad item never fails the rest', async () => {
    promoteM.mockImplementation(async (_id, opts: { conversation_id: string }) =>
      opts.conversation_id === 'c2'
        ? ({ error: 'not_found' } as never)
        : ({ conversation: { id: opts.conversation_id, state: 'promoted' }, issue: { id: 'EI-1' }, thread_reparented: true, delivered: 1 } as never),
    );
    const b = await body({ ids: ['c1', 'c2'], severity: 'minor' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c1', issue: { id: 'EI-1' } });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'c2', error: 'not_found' });
    expect(promoteM.mock.calls[1]![1]).toMatchObject({ conversation_id: 'c2', severity: 'minor' });
  });
});
