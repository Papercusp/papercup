import { afterEach, describe, expect, it, vi } from 'vitest';

// Fake `tx` tagged-template client: records every call and answers the one shape the store
// module actually issues (an INSERT ... RETURNING id, and two UPDATE forms) — enough to assert
// against without a real PG connection.
const calls: Array<{ sql: string; values: unknown[] }> = [];
function fakeTx(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
  const sql = strings.join('?');
  calls.push({ sql, values });
  if (/INSERT INTO/i.test(sql)) return Promise.resolve([{ id: 42 }]);
  return Promise.resolve([]);
}

// `fakeTx` is a hoisted function DECLARATION (unlike `calls`, a `const`), so the reference
// inside this factory resolves fine even though vi.hoisted's callback runs above it in the
// emitted module — it is only ever invoked later, at test time, once `calls` is initialized.
const { withWorkspace } = vi.hoisted(() => ({
  withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) => fn(fakeTx)),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), withWorkspace }));

import {
  recordAttentionNotifyIntent,
  recordAttentionNotifyOutcome,
} from './attention-notify-store';

afterEach(() => {
  calls.length = 0;
  withWorkspace.mockClear();
  withWorkspace.mockImplementation(async (_ws: string, fn: (tx: unknown) => unknown) => fn(fakeTx));
});

describe('recordAttentionNotifyIntent (WI-36644)', () => {
  it('inserts a row scoped to the given workspace and returns its id', async () => {
    const id = await recordAttentionNotifyIntent({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      kind: 'needs-human',
      title: 'T',
      body: 'B',
      importance: 'high',
      data: { a: 1 },
    });
    expect(id).toBe(42);
    expect(withWorkspace).toHaveBeenCalledWith('ws-1', expect.any(Function));
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/INSERT INTO harness_shared\.attention_notifications/);
    expect(calls[0].values).toEqual(['ws-1', 'papercusp', 'needs-human', 'T', 'B', 'high', JSON.stringify({ a: 1 })]);
  });

  it('returns null (never throws) when the insert fails — the audit write is best-effort', async () => {
    withWorkspace.mockImplementationOnce(async () => {
      throw new Error('pg unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await recordAttentionNotifyIntent({ workspaceId: 'ws-1', kind: 'intervention', title: 'T', body: 'B' });
    expect(id).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('recordAttentionNotifyOutcome (WI-36644)', () => {
  it('is a no-op when id is null (the intent insert itself already failed)', async () => {
    await recordAttentionNotifyOutcome(null, 'ws-1', 'mobile', { attempted: true, succeeded: true });
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('updates the mobile columns for the given row id', async () => {
    await recordAttentionNotifyOutcome(42, 'ws-1', 'mobile', { attempted: true, succeeded: false, error: 'boom' });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/UPDATE harness_shared\.attention_notifications/);
    expect(calls[0].sql).toMatch(/mobile_attempted/);
    expect(calls[0].values).toEqual([true, false, 'boom', 42]);
  });

  it('updates the desktop columns for the given row id', async () => {
    await recordAttentionNotifyOutcome(42, 'ws-1', 'desktop', { attempted: true, succeeded: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/desktop_attempted/);
    expect(calls[0].values).toEqual([true, true, null, 42]);
  });

  it('never throws when the update fails — the audit write is best-effort, matching the two delivery channels it records', async () => {
    withWorkspace.mockImplementationOnce(async () => {
      throw new Error('pg unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordAttentionNotifyOutcome(42, 'ws-1', 'mobile', { attempted: true, succeeded: true }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
