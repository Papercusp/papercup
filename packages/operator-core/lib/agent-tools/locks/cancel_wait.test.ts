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

type Out = { content: { text: string }[] };
const call = () => tool.handler({ ticket_id: '22222222-2222-2222-2222-222222222222' } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('locks:cancel_wait handler', () => {
  it('surfaces cancelled=true for a clean cancel', async () => {
    cancelM.mockResolvedValue({ cancelled: true } as never);
    expect(body(await call())).toMatchObject({ ok: true, cancelled: true });
  });

  it('surfaces cancelled=false when a grant raced the cancel', async () => {
    cancelM.mockResolvedValue({ cancelled: false } as never);
    expect(body(await call())).toMatchObject({ ok: true, cancelled: false });
  });
});
