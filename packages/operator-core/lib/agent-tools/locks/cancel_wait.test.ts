/**
 * cancel_wait.test.ts — the locks:cancel_wait HANDLER (tryCancelWait mocked; txn wrapper
 * runs the callback). Thin but the `cancelled` flag is semantically load-bearing:
 * cancelled=true means the wait was abandoned cleanly; cancelled=false means a grant
 * RACED the cancel (the caller now holds a lock it didn't want and must release). This
 * pins that the handler surfaces that flag verbatim.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/cancel_wait.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ readIdentity: vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({ tryCancelWait: vi.fn() }));

import { tryCancelWait } from './su-lock-store';
const cancelM = vi.mocked(tryCancelWait);
const tool = (await import('./cancel_wait')).default;

type Out = { data?: any; content?: { text: string }[] };
const call = (args: Record<string, unknown> = { ticket_id: '22222222-2222-2222-2222-222222222222' }) =>
  tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data ?? JSON.parse(o.content![0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('locks:cancel_wait handler', () => {
  it('surfaces cancelled=true for a clean cancel', async () => {
    cancelM.mockResolvedValue({ cancelled: true } as never);
    expect(body(await call())).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [{ ok: true, ticket_id: '22222222-2222-2222-2222-222222222222', cancelled: true }],
    });
  });

  it('surfaces cancelled=false when a grant raced the cancel', async () => {
    cancelM.mockResolvedValue({ cancelled: false } as never);
    expect(body(await call())).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [{ ok: true, ticket_id: '22222222-2222-2222-2222-222222222222', cancelled: false }],
    });
  });

  it('cancels selected ticket_ids as one keyed batch', async () => {
    cancelM.mockResolvedValue({ cancelled: true } as never);
    const b = body(await call({
      ticket_ids: [
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
      ],
    }));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: any) => r.ticket_id)).toEqual([
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ]);
  });
});
