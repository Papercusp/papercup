/**
 * heartbeat_resource.test.ts — the locks:heartbeat_resource HANDLER (tryHeartbeatResource
 * mocked; txn wrapper runs the callback). Pins that ok mirrors `extended` (a successful
 * extension is ok:true with the new ISO expiry; a lapsed/owner-mismatch no-op is ok:false
 * with expires_ts:null). A regression that reports a no-op heartbeat as success — so a
 * caller believes its lease is alive when it lapsed — is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/heartbeat_resource.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ readIdentity: vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({ tryHeartbeatResource: vi.fn() }));

import { tryHeartbeatResource } from './su-lock-store';
const hbM = vi.mocked(tryHeartbeatResource);
const tool = (await import('./heartbeat_resource')).default;

type Out = { data?: any; content?: { text: string }[] };
const call = (args: Record<string, unknown> = { lock_id: '33333333-3333-3333-3333-333333333333' }) =>
  tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data ?? JSON.parse(o.content![0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('locks:heartbeat_resource handler', () => {
  it('extends and returns the new ISO expiry', async () => {
    hbM.mockResolvedValue({ extended: true, expires_ts: new Date('2026-02-01T00:00:00Z') } as never);
    const b = body(await call());
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        {
          ok: true,
          lock_id: '33333333-3333-3333-3333-333333333333',
          extended: true,
          expires_ts: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('a no-op (lapsed / not owner) is ok:false with null expiry — never a false-alive', async () => {
    hbM.mockResolvedValue({ extended: false, expires_ts: null } as never);
    const b = body(await call());
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 0, failed: 1 },
      results: [
        {
          ok: false,
          lock_id: '33333333-3333-3333-3333-333333333333',
          extended: false,
          expires_ts: null,
          error: 'not_found_or_not_yours_or_expired',
        },
      ],
    });
  });

  it('heartbeats selected lock_ids as one keyed batch', async () => {
    hbM.mockResolvedValue({ extended: true, expires_ts: new Date('2026-02-01T00:00:00Z') } as never);
    const b = body(await call({
      lock_ids: [
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
      ],
    }));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: any) => r.lock_id)).toEqual([
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ]);
    expect(hbM).toHaveBeenCalledTimes(2);
  });
});
