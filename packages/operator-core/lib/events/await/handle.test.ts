/**
 * handle.test.ts — captureWakeHandleForOwner: the wake-handle stamped at
 * registration + the honest wake-path-quality note (await-event-primitive
 * D-003). Pure: the one DB read (latestAdvSessionByCoordOwner) is mocked.
 *
 * GAP 4 (resumability note): codex was wrongly excluded from `resumable`, so a
 * tracked codex session got the "NOT safely resumable" note even though
 * executeWake resumes it (`codex exec resume <uuid>`). The codex+session case
 * below pins the fix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdvSessionRow } from '../../adv-sessions';

const h = vi.hoisted(() => ({
  latestAdvSessionByCoordOwner: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('../../adv-sessions', () => ({
  latestAdvSessionByCoordOwner: h.latestAdvSessionByCoordOwner,
}));

const { captureWakeHandleForOwner } = await import('./handle');

function advRow(over: Partial<AdvSessionRow> = {}): AdvSessionRow {
  return {
    id: 7,
    workspaceId: 'ws',
    planSlug: null,
    agent: 'claude',
    role: null,
    feature: null,
    mode: 'console',
    terminalBin: null,
    pid: 1234,
    windowId: null,
    ompThreadId: null,
    label: null,
    cwd: '/repo',
    coordOwnerId: 'su-abc',
    sessionId: '11111111-2222-3333-4444-555555555555',
    display: null,
    launchArgv: null,
    launchedAt: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('captureWakeHandleForOwner', () => {
  it('planRunId → a plan-run handle (the plans:resume wake path), no session read', async () => {
    const r = await captureWakeHandleForOwner('su-abc', { planRunId: 99 });
    expect(r.handle).toEqual({ kind: 'plan-run', runId: 99 });
    expect(r.note).toContain('plan-run 99');
    expect(r.note).toContain('plans:resume');
    // The plan-run branch returns BEFORE the adv-session lookup.
    expect(h.latestAdvSessionByCoordOwner).not.toHaveBeenCalled();
  });

  it('no tracked session for the coord id → null handle + the inbox-degrade note', async () => {
    h.latestAdvSessionByCoordOwner.mockResolvedValueOnce(null);
    const r = await captureWakeHandleForOwner('su-nobody');
    expect(r.handle).toBeNull();
    expect(r.note).toContain('no tracked session');
    expect(r.note).toContain('inbox');
  });

  it('claude + native session id → an adv-session handle marked injectable/resumable', async () => {
    h.latestAdvSessionByCoordOwner.mockResolvedValueOnce(advRow({ id: 11, agent: 'claude', sessionId: 'sid-c' }));
    const r = await captureWakeHandleForOwner('su-abc');
    expect(r.handle).toMatchObject({ kind: 'adv-session', advSessionId: 11, agent: 'claude', sessionId: 'sid-c' });
    expect(r.note).toContain('injectable/resumable');
    expect(r.note).not.toContain('NOT safely resumable');
  });

  it('codex + a session id → resumable (GAP 4: executeWake resumes codex via `exec resume <uuid>`)', async () => {
    // The bug: handle.ts computed `resumable` as claude||omp only, so this
    // tracked codex session got the "NOT safely resumable" note even though the
    // wake executor resumes exited codex sessions. The fix includes codex when
    // a session id is stamped → the honest note is injectable/resumable.
    h.latestAdvSessionByCoordOwner.mockResolvedValueOnce(
      advRow({ id: 12, agent: 'codex', sessionId: 'rollout-uuid', ompThreadId: null }),
    );
    const r = await captureWakeHandleForOwner('su-codex');
    expect(r.handle).toMatchObject({ kind: 'adv-session', advSessionId: 12, agent: 'codex', sessionId: 'rollout-uuid' });
    expect(r.note).toContain('injectable/resumable');
    expect(r.note).not.toContain('NOT safely resumable');
  });

  it('omp + a thread id → resumable', async () => {
    h.latestAdvSessionByCoordOwner.mockResolvedValueOnce(
      advRow({ id: 13, agent: 'omp', sessionId: null, ompThreadId: 'th-9' }),
    );
    const r = await captureWakeHandleForOwner('su-omp');
    expect(r.handle).toMatchObject({ kind: 'adv-session', agent: 'omp', ompThreadId: 'th-9' });
    expect(r.note).toContain('injectable/resumable');
  });

  it('claude WITHOUT a native session id → NOT safely resumable (no --continue on a shared cwd)', async () => {
    h.latestAdvSessionByCoordOwner.mockResolvedValueOnce(
      advRow({ id: 14, agent: 'claude', sessionId: null }),
    );
    const r = await captureWakeHandleForOwner('su-abc');
    expect(r.handle).toMatchObject({ kind: 'adv-session', agent: 'claude', sessionId: null });
    expect(r.note).toContain('NOT safely resumable');
  });

  it('codex WITHOUT a session id → NOT safely resumable (no recoverable conversation uuid on the row)', async () => {
    h.latestAdvSessionByCoordOwner.mockResolvedValueOnce(
      advRow({ id: 15, agent: 'codex', sessionId: null, ompThreadId: null }),
    );
    const r = await captureWakeHandleForOwner('su-codex');
    expect(r.note).toContain('NOT safely resumable');
  });
});
