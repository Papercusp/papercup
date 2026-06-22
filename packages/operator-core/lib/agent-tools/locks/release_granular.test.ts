/**
 * release_granular.test.ts — the locks:release_granular HANDLER (releaseGranular mocked;
 * txn wrapper runs the callback). Pins that the handler releases the lock-set by lock_id
 * (owner-scoped via readIdentity) and returns the freed set. A regression that drops the
 * owner scoping or the released list is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/release_granular.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ readIdentity: vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({ releaseGranular: vi.fn() }));

import { releaseGranular } from './su-lock-store';
const relM = vi.mocked(releaseGranular);
const tool = (await import('./release_granular')).default;

type Out = { data: any };
const body = (o: Out) => (o.data);

beforeEach(() => vi.clearAllMocks());

describe('locks:release_granular handler', () => {
  it('wraps a single lock_id release through the keyed bulk envelope (n=1)', async () => {
    relM.mockResolvedValue({ released: ['', 'src', 'src/a.ts'] } as never);
    const out = (await tool.handler({ lock_id: '44444444-4444-4444-4444-444444444444' } as never, {} as never)) as Out;
    expect(relM).toHaveBeenCalledWith({}, 'dom', 'me', '44444444-4444-4444-4444-444444444444');
    expect(body(out)).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        { ok: true, lock_id: '44444444-4444-4444-4444-444444444444', released: ['', 'src', 'src/a.ts'] },
      ],
    });
  });

  it('releases selected lock_ids as a keyed bulk envelope', async () => {
    relM.mockImplementation(async (_tx, _dom, _owner, lockId) => ({ released: [`released:${lockId}`] }) as never);
    const out = (await tool.handler({
      lock_ids: [
        '44444444-4444-4444-4444-444444444444',
        '55555555-5555-5555-5555-555555555555',
      ],
    } as never, {} as never)) as Out;
    expect(body(out)).toMatchObject({
      ok: true,
      counts: { ok: 2, failed: 0 },
      results: [
        { ok: true, lock_id: '44444444-4444-4444-4444-444444444444', released: ['released:44444444-4444-4444-4444-444444444444'] },
        { ok: true, lock_id: '55555555-5555-5555-5555-555555555555', released: ['released:55555555-5555-5555-5555-555555555555'] },
      ],
    });
  });
});
