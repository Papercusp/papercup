/**
 * apply-on-grant.test.ts — EI-9033 apply-on-grant lock-queue edits.
 *
 * Two layers, both pure via injected seams (no DB / no real fs):
 *   • applyExactEdit — the Edit-tool exact-single-match contract over an
 *     in-memory FileIo (apply-success, no-match, non-unique, path-escape).
 *   • applyPendingEditOnGrant — the orchestration: claim latch → apply →
 *     audit + release + notify (apply-success / audit-row / notify-delivery),
 *     mismatch/non-unique/guardrail → fallback, and the exactly-once latch
 *     dispositions (in-flight / applied / none / fallback).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/__tests__/apply-on-grant.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyExactEdit,
  applyPendingEditOnGrant,
  type ApplyOnGrantDeps,
  type FileIo,
} from '../apply-on-grant';
import type { GrantedPendingEdit } from '../su-lock-store';
import { preserveReleasedEditGenerations, recordEditAttributionStrict } from '../../../edit-attribution';
import { tryRelease } from '../su-lock-store';

vi.mock('../../../edit-attribution', () => ({
  preserveReleasedEditGenerations: vi.fn(async () => true),
  recordEditAttributionStrict: vi.fn(async () => {}),
}));
vi.mock('../in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_domain, _owner, body) => body({})),
}));
vi.mock('../su-lock-store', () => ({ tryRelease: vi.fn() }));

const memIo = (files: Record<string, string>): FileIo & { files: Record<string, string> } => ({
  files,
  read(p: string) {
    if (!(p in files)) throw new Error(`ENOENT: ${p}`);
    return files[p];
  },
  write(p: string, c: string) {
    files[p] = c;
  },
});

describe('applyExactEdit (exact single-match contract)', () => {
  const ROOT = '/repo';

  it('applies a unique match and writes the replaced content', () => {
    const io = memIo({ '/repo/boot.ts': 'a\nOLD\nb\n' });
    const res = applyExactEdit(ROOT, { file: 'boot.ts', old_string: 'OLD', new_string: 'NEW' }, io);
    expect(res.applied).toBe(true);
    expect(io.files['/repo/boot.ts']).toBe('a\nNEW\nb\n');
  });

  it('no match → not applied, file untouched', () => {
    const io = memIo({ '/repo/boot.ts': 'a\nb\n' });
    const res = applyExactEdit(ROOT, { file: 'boot.ts', old_string: 'ABSENT', new_string: 'X' }, io);
    expect(res).toEqual({ applied: false, reason: 'no-match' });
    expect(io.files['/repo/boot.ts']).toBe('a\nb\n');
  });

  it('non-unique match → not applied (the region is ambiguous)', () => {
    const io = memIo({ '/repo/boot.ts': 'DUP\nx\nDUP\n' });
    const res = applyExactEdit(ROOT, { file: 'boot.ts', old_string: 'DUP', new_string: 'X' }, io);
    expect(res).toEqual({ applied: false, reason: 'non-unique' });
    expect(io.files['/repo/boot.ts']).toBe('DUP\nx\nDUP\n');
  });

  it('empty old_string → no-match (never applies)', () => {
    const io = memIo({ '/repo/boot.ts': 'x' });
    const res = applyExactEdit(ROOT, { file: 'boot.ts', old_string: '', new_string: 'X' }, io);
    expect(res).toEqual({ applied: false, reason: 'no-match' });
  });

  it('path escaping the repo root → path-escape, never reads', () => {
    const io = memIo({ '/etc/passwd': 'secret' });
    const readSpy = vi.spyOn(io, 'read');
    const res = applyExactEdit(ROOT, { file: '../etc/passwd', old_string: 'secret', new_string: 'X' }, io);
    expect(res).toEqual({ applied: false, reason: 'path-escape' });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('read error → read-error, no write', () => {
    const io = memIo({});
    const res = applyExactEdit(ROOT, { file: 'missing.ts', old_string: 'x', new_string: 'y' }, io);
    expect(res).toEqual({ applied: false, reason: 'read-error' });
  });
});

// ── orchestration ────────────────────────────────────────────────────────────

const grant = (over: Partial<GrantedPendingEdit> = {}): GrantedPendingEdit => ({
  ticket_id: 't-1',
  pending_edit: { file: 'boot.ts', old_string: 'OLD', new_string: 'NEW', goal_ref: 'WI-queue-time' },
  granted_lock_id: 'lock-1',
  coordination_domain: '/repo',
  owner: 'su-queuer',
  owner_label: 'queuer',
  intent: 'wire the new tool',
  paths: ['boot.ts'],
  ...over,
});

/** A deps bundle whose side effects are all recorded, defaulting to a clean apply. */
const spyDeps = (over: Partial<ApplyOnGrantDeps> = {}) => {
  const calls = {
    recordAttribution: vi.fn(async () => {}),
    releaseLock: vi.fn<NonNullable<ApplyOnGrantDeps['releaseLock']>>(async (g, beforeRelease) => {
      await beforeRelease(g.paths.map(path => ({ path, lock_id: g.granted_lock_id,
        intent: g.intent, goal_ref: g.pending_edit.goal_ref ?? null, acquired_ts: new Date() })));
    }),
    setOutcome: vi.fn(async () => {}),
    cancelWakeAwaits: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
  };
  const deps: ApplyOnGrantDeps = {
    claim: async () => grant(),
    readDisposition: async () => 'none',
    applyEdit: () => ({ applied: true }),
    ...calls,
    ...over,
  };
  return { deps, calls };
};

describe('applyPendingEditOnGrant (orchestration)', () => {
  it('apply-success: applies, audits, releases the lock, cancels the wake, notifies — returns applied', async () => {
    const { deps, calls } = spyDeps();
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('applied');
    // audit-row: attributed to the queuing agent, its file + intent
    expect(calls.recordAttribution).toHaveBeenCalledWith({
      repoRoot: '/repo',
      file: 'boot.ts',
      owner: 'su-queuer',
      workspaceId: 'ws',
      intent: 'wire the new tool',
      goalRef: 'WI-queue-time',
    });
    // The edit and preservation run inside the selected release callback.
    expect(calls.releaseLock).toHaveBeenCalledOnce();
    // wake suppressed, then passive notify
    expect(calls.cancelWakeAwaits).toHaveBeenCalledWith('t-1', 'su-queuer');
    // notify-delivery: passive inbox note to the queuing agent
    expect(calls.notify).toHaveBeenCalledWith({
      owner: 'su-queuer',
      workspaceId: 'ws',
      file: 'boot.ts',
      lockId: 'lock-1',
    });
    expect(calls.setOutcome).toHaveBeenCalledWith('t-1', 'applied');
  });

  it('preserves the applied generation and agent session inside the selected release fence', async () => {
    const { deps } = spyDeps();
    const { recordAttribution: _audit, releaseLock: _release, ...defaults } = deps;
    const rows = [{ path: 'boot.ts', lock_id: 'lock-1', intent: 'edit', goal_ref: 'WI-queue-time', acquired_ts: new Date() }];
    vi.mocked(preserveReleasedEditGenerations).mockClear();
    vi.mocked(recordEditAttributionStrict).mockClear();
    vi.mocked(tryRelease).mockImplementationOnce(async (_tx, params) => {
      expect(deps.notify).not.toHaveBeenCalled();
      await params.beforeRelease?.(rows);
      expect(preserveReleasedEditGenerations).toHaveBeenCalledWith({
        repoRoot: '/repo', rows, agentId: 'su-queuer', workspaceId: 'ws', sessionId: 'su-queuer',
      });
      return { released: ['boot.ts'], heldBefore: 1 };
    });
    expect(await applyPendingEditOnGrant('t-1', 'ws', defaults)).toBe('applied');
    expect(recordEditAttributionStrict).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledOnce();
  });

  it('falls back without announcing a successful handoff when custody fails', async () => {
    const { deps, calls } = spyDeps();
    const { recordAttribution: _audit, releaseLock: _release, ...defaults } = deps;
    vi.mocked(preserveReleasedEditGenerations).mockRejectedValueOnce(new Error('custody unavailable'));
    vi.mocked(tryRelease).mockImplementationOnce(async (_tx, params) => {
      await params.beforeRelease?.([{ path: 'boot.ts', lock_id: 'lock-1', intent: 'edit', goal_ref: null, acquired_ts: new Date() }]);
      throw new Error('must not release after failed preservation');
    });
    expect(await applyPendingEditOnGrant('t-1', 'ws', defaults)).toBe('fallback');
    expect(calls.setOutcome).toHaveBeenCalledWith('t-1', 'fallback');
    expect(calls.cancelWakeAwaits).not.toHaveBeenCalled();
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it('refuses to announce a handoff after the selected lease expired', async () => {
    const applyEdit = vi.fn(() => ({ applied: true }));
    const { deps, calls } = spyDeps({ applyEdit });
    const { recordAttribution: _audit, releaseLock: _release, ...defaults } = deps;
    vi.mocked(tryRelease).mockResolvedValueOnce({ released: [], heldBefore: 0 });
    expect(await applyPendingEditOnGrant('t-1', 'ws', defaults)).toBe('fallback');
    expect(applyEdit).not.toHaveBeenCalled();
    expect(calls.setOutcome).toHaveBeenCalledWith('t-1', 'fallback');
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it('mismatch-fallback: old_string no longer matches → fallback, NO apply side effects', async () => {
    const { deps, calls } = spyDeps({ applyEdit: () => ({ applied: false, reason: 'no-match' }) });
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('fallback');
    expect(calls.setOutcome).toHaveBeenCalledWith('t-1', 'fallback');
    expect(calls.recordAttribution).not.toHaveBeenCalled();
    // The selected fence was entered, but the callback refused before deletion.
    expect(calls.releaseLock).toHaveBeenCalledOnce();
    expect(calls.notify).not.toHaveBeenCalled();
    expect(calls.cancelWakeAwaits).not.toHaveBeenCalled();
  });

  it('non-unique-fallback: the region became ambiguous → fallback', async () => {
    const { deps, calls } = spyDeps({ applyEdit: () => ({ applied: false, reason: 'non-unique' }) });
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('fallback');
    expect(calls.setOutcome).toHaveBeenCalledWith('t-1', 'fallback');
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it('guardrail: a multi-file or file≠path ticket never applies → fallback (applyEdit not called)', async () => {
    const applyEdit = vi.fn(() => ({ applied: true }));
    const { deps } = spyDeps({ claim: async () => grant({ paths: ['boot.ts', 'other.ts'] }), applyEdit });
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('fallback');
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('exactly-once: a reconcile that loses the claim latch reads the disposition instead of applying', async () => {
    // claim returns null (a peer won the latch); disposition drives the result.
    for (const [disp, expected] of [
      ['claiming', 'in-flight'],
      ['applied', 'applied'],
      ['fallback', 'fallback'],
      ['none', 'none'],
    ] as const) {
      const applyEdit = vi.fn(() => ({ applied: true }));
      const { deps } = spyDeps({ claim: async () => null, readDisposition: async () => disp, applyEdit });
      const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
      expect(out).toBe(expected);
      expect(applyEdit).not.toHaveBeenCalled(); // never double-applies
    }
  });

  it('best-effort: a failed notification after durable release still returns applied', async () => {
    const { deps } = spyDeps({
      notify: vi.fn(async () => {
        throw new Error('coord down');
      }),
    });
    const out = await applyPendingEditOnGrant('t-1', 'ws', deps);
    expect(out).toBe('applied');
  });
});
