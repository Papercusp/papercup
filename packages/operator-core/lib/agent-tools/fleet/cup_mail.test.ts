/**
 * cup_mail.test.ts — the fleet:cup_mail HANDLER (readInbox/readOutbox mocked). The
 * readers return ASCENDING by (ts, msg_id); the handler's own logic is the TAIL — keep
 * the most-recent `limit` entries (slice from the END), and report total vs returned per
 * side. A regression that keeps the OLDEST limit (slice(0,limit)) instead of the newest
 * is the exact bug this pins. Also: since_ts is forwarded to both readers.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/fleet/cup_mail.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/messages', () => ({
  readInboxWindow: vi.fn(),
  readOutboxWindow: vi.fn(),
}));

import { readInboxWindow, readOutboxWindow } from '../coordination/messages';
const inboxM = vi.mocked(readInboxWindow);
const outboxM = vi.mocked(readOutboxWindow);
const tool = (await import('./cup_mail')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ owner_id: 'bee-1', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

/** A CoordWindowResult whose window reached the end of history. */
const win = (entries: unknown[], exhausted = true) =>
  ({ entries, exhausted, rowsScanned: entries.length, pages: 1 }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  inboxM.mockResolvedValue(win([]));
  outboxM.mockResolvedValue(win([]));
});

describe('fleet:cup_mail handler', () => {
  it('returns everything when under the limit', async () => {
    inboxM.mockResolvedValue(win([{ id: 'a' }, { id: 'b' }]));
    outboxM.mockResolvedValue(win([{ id: 'c' }]));
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, owner_id: 'bee-1' });
    expect(b.inbox).toMatchObject({ total: 2, returned: 2, exhausted: true });
    expect(b.outbox).toMatchObject({ total: 1, returned: 1, exhausted: true });
  });

  it('keeps the MOST RECENT `limit` entries (tail, not head) per side', async () => {
    const ascending = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    inboxM.mockResolvedValue(win(ascending));
    const b = body(await call({ limit: 3 }));
    expect(b.inbox.total).toBe(10);
    expect(b.inbox.returned).toBe(3);
    expect(b.inbox.entries).toEqual([{ id: 8 }, { id: 9 }, { id: 10 }]); // newest 3, not 1..3
  });

  it('forwards since_ts to both readers', async () => {
    await call({ since_ts: '2026-01-01T00:00:00Z' });
    expect(inboxM).toHaveBeenCalledWith(
      'bee-1',
      { since_ts: '2026-01-01T00:00:00Z' },
      expect.any(Function),
    );
    expect(outboxM).toHaveBeenCalledWith(
      'bee-1',
      { since_ts: '2026-01-01T00:00:00Z' },
      expect.any(Function),
    );
  });

  // EI-19340198432470691. The window makes `total` a count OVER THE WINDOW, so
  // `exhausted` is the only thing that says whether it is the real total. A
  // handler that dropped it would report a floor as a census — silently.
  it('surfaces each side`s window boundary independently', async () => {
    inboxM.mockResolvedValue(win([{ id: 'i' }], false));
    outboxM.mockResolvedValue(win([{ id: 'o' }], true));
    const b = body(await call());
    expect(b.inbox.exhausted).toBe(false); // older inbox mail exists beyond the window
    expect(b.outbox.exhausted).toBe(true); // this sender's history WAS fully read
  });

  // The stopping rule is what bounds the read; passing one that never fires
  // would silently restore the unbounded scan this item removed.
  it('passes a stopping rule satisfied by exactly `limit` visible entries', async () => {
    await call({ limit: 4 });
    for (const m of [inboxM, outboxM]) {
      const enough = m.mock.calls[0]![2] as unknown as (e: unknown[]) => boolean;
      expect(enough(new Array(3))).toBe(false);
      expect(enough(new Array(4))).toBe(true);
    }
  });

  it('defaults the stopping rule to the default limit', async () => {
    await call();
    const enough = inboxM.mock.calls[0]![2] as unknown as (e: unknown[]) => boolean;
    expect(enough(new Array(49))).toBe(false);
    expect(enough(new Array(50))).toBe(true);
  });
});
