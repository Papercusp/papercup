/**
 * git-sync-events.test.ts — the git-sync commit signal, pure (injected emit)
 * (event-await-discoverability-and-coverage-2026-07-03 P-102).
 */
import { describe, expect, it, vi } from 'vitest';
import { emitGitSyncCommittedEvent } from './git-sync-events';

type EmitOpts = { key: string; summary?: string; payload?: unknown; to?: string[]; source?: string };
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null }));

const SHA = 'abcdef1234567890fedcba';

describe('emitGitSyncCommittedEvent (P-102)', () => {
  it('fires BOTH the global git-sync:committed and the per-sha key, with payload.sha', async () => {
    const emit = typedEmit();
    emitGitSyncCommittedEvent(SHA, { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(2);
    const keys = emit.mock.calls.map((c) => c[0].key);
    expect(keys).toContain('git-sync:committed');
    expect(keys).toContain(`git-sync:committed:${SHA}`);
    for (const call of emit.mock.calls) {
      expect(call[0]).toMatchObject({
        source: 'git-sync',
        payload: expect.objectContaining({ sha: SHA }),
      });
      // short-sha (12) appears in the human summary
      expect(call[0].summary).toContain(SHA.slice(0, 12));
    }
  });

  it('is an awaiter-only signal — no `to` push (audience is whoever awaited)', async () => {
    const emit = typedEmit();
    emitGitSyncCommittedEvent(SHA, { emit });
    await new Promise((r) => setTimeout(r, 0));
    for (const call of emit.mock.calls) expect(call[0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns; a sync must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitGitSyncCommittedEvent(SHA, { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('committed-event'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' });
    });
    expect(() => emitGitSyncCommittedEvent(SHA, { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
