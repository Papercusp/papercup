/**
 * bee_mail.test.ts — the fleet:bee_mail HANDLER (readInbox/readOutbox mocked). The
 * readers return ASCENDING by (ts, msg_id); the handler's own logic is the TAIL — keep
 * the most-recent `limit` entries (slice from the END), and report total vs returned per
 * side. A regression that keeps the OLDEST limit (slice(0,limit)) instead of the newest
 * is the exact bug this pins. Also: since_ts is forwarded to both readers.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/fleet/bee_mail.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/messages', () => ({ readInbox: vi.fn(), readOutbox: vi.fn() }));

import { readInbox, readOutbox } from '../coordination/messages';
const inboxM = vi.mocked(readInbox);
const outboxM = vi.mocked(readOutbox);
const tool = (await import('./bee_mail')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ owner_id: 'bee-1', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  inboxM.mockResolvedValue([] as never);
  outboxM.mockResolvedValue([] as never);
});

describe('fleet:bee_mail handler', () => {
  it('returns everything when under the limit', async () => {
    inboxM.mockResolvedValue([{ id: 'a' }, { id: 'b' }] as never);
    outboxM.mockResolvedValue([{ id: 'c' }] as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, owner_id: 'bee-1' });
    expect(b.inbox).toMatchObject({ total: 2, returned: 2 });
    expect(b.outbox).toMatchObject({ total: 1, returned: 1 });
  });

  it('keeps the MOST RECENT `limit` entries (tail, not head) per side', async () => {
    const ascending = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    inboxM.mockResolvedValue(ascending as never);
    const b = body(await call({ limit: 3 }));
    expect(b.inbox.total).toBe(10);
    expect(b.inbox.returned).toBe(3);
    expect(b.inbox.entries).toEqual([{ id: 8 }, { id: 9 }, { id: 10 }]); // newest 3, not 1..3
  });

  it('forwards since_ts to both readers', async () => {
    await call({ since_ts: '2026-01-01T00:00:00Z' });
    expect(inboxM).toHaveBeenCalledWith('bee-1', { since_ts: '2026-01-01T00:00:00Z' });
    expect(outboxM).toHaveBeenCalledWith('bee-1', { since_ts: '2026-01-01T00:00:00Z' });
  });
});
