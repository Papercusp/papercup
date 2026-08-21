/**
 * git-sync-events.test.ts — the git-sync commit signal, pure (injected emit)
 * (event-await-discoverability-and-coverage-2026-07-03 P-102).
 */
import { describe, expect, it, vi } from 'vitest';
import { emitGitSyncCommittedEvent, emitGitSyncEgressedEvent } from './git-sync-events';
import { payloadMatchesFilter } from '../../events/await/pattern';

type EmitOpts = { key: string; summary?: string; payload?: unknown; to?: string[]; source?: string };
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null, waiters: 0 }));

const SHA = 'abcdef1234567890fedcba';
const SCOPE_A = { installSlug: 'harness-a', workspaceId: 'workspace-a' };
const SCOPE_B = { installSlug: 'harness-b', workspaceId: 'workspace-a' };

describe('emitGitSyncCommittedEvent (P-102)', () => {
  it('fires BOTH the global git-sync:committed and the per-sha key, with payload.sha', async () => {
    const emit = typedEmit();
    emitGitSyncCommittedEvent(SHA, { emit, scope: SCOPE_A });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(2);
    const keys = emit.mock.calls.map((c) => c[0].key);
    expect(keys).toContain('git-sync:committed');
    expect(keys).toContain(`git-sync:committed:${SHA}`);
    for (const call of emit.mock.calls) {
      expect(call[0]).toMatchObject({
        source: 'git-sync',
        payload: expect.objectContaining({ sha: SHA, ...SCOPE_A }),
      });
      // short-sha (12) appears in the human summary
      expect(call[0].summary).toContain(SHA.slice(0, 12));
      expect(call[0].summary).toContain('local harness checkout');
      expect(call[0].summary).not.toContain('origin/staging');
    }
  });

  it('is an awaiter-only signal — no `to` push (audience is whoever awaited)', async () => {
    const emit = typedEmit();
    emitGitSyncCommittedEvent(SHA, { emit, scope: SCOPE_A });
    await new Promise((r) => setTimeout(r, 0));
    for (const call of emit.mock.calls) expect(call[0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns; a sync must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitGitSyncCommittedEvent(SHA, { emit: emit as never, scope: SCOPE_A })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('committed-event'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' });
    });
    expect(() => emitGitSyncCommittedEvent(SHA, { emit: emit as never, scope: SCOPE_A })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('scopes a global wake to its harness and workspace (two-harness regression)', async () => {
    const emit = typedEmit();
    emitGitSyncCommittedEvent(SHA, { emit, scope: SCOPE_A });
    await new Promise((r) => setTimeout(r, 0));

    const globalPayload = emit.mock.calls.find((call) => call[0].key === 'git-sync:committed')?.[0].payload;
    expect(globalPayload).toEqual({ sha: SHA, ...SCOPE_A });
    expect(payloadMatchesFilter(SCOPE_A, globalPayload)).toBe(true);
    expect(payloadMatchesFilter(SCOPE_B, globalPayload)).toBe(false);
  });
});

describe('emitGitSyncEgressedEvent (EI-20331175777179195)', () => {
  it('fires BOTH remote-egress keys with payload.sha and an explicit origin/staging summary', async () => {
    const emit = typedEmit();
    emitGitSyncEgressedEvent(SHA, { emit, scope: SCOPE_A });
    await new Promise((r) => setTimeout(r, 0));

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map((c) => c[0].key)).toEqual([
      'git-sync:egressed',
      `git-sync:egressed:${SHA}`,
    ]);
    for (const call of emit.mock.calls) {
      expect(call[0]).toMatchObject({
        source: 'git-sync',
        payload: { sha: SHA, ...SCOPE_A },
      });
      expect(call[0].summary).toContain('origin/staging');
      expect(call[0].summary).toContain(SHA.slice(0, 12));
    }
  });

  it('never rejects on an emit failure (a bridge tick must remain best-effort)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitGitSyncEgressedEvent(SHA, { emit: emit as never, scope: SCOPE_A })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('egressed-event'));
    warn.mockRestore();
  });

  it('emits precise keys for commits included by a later egress head', async () => {
    const emit = typedEmit();
    const ancestor = '1234567890abcdef1234567890abcdef12345678';
    emitGitSyncEgressedEvent(SHA, { emit, scope: SCOPE_A }, { includedShas: [SHA, ancestor, ancestor] });
    await new Promise((r) => setTimeout(r, 0));

    expect(emit.mock.calls.map((c) => c[0].key)).toEqual([
      'git-sync:egressed',
      `git-sync:egressed:${SHA}`,
      `git-sync:egressed:${ancestor}`,
    ]);
    const ancestorCall = emit.mock.calls.find((call) => call[0].key === `git-sync:egressed:${ancestor}`)?.[0];
    expect(ancestorCall).toMatchObject({
      source: 'git-sync',
      payload: { sha: ancestor, egressHead: SHA, ...SCOPE_A },
    });
    expect(ancestorCall?.summary).toContain(`includes ancestor ${ancestor.slice(0, 12)}`);
  });
});
