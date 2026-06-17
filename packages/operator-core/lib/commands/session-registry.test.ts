/**
 * Unit coverage for the command session registry (session-registry.ts) — the
 * in-memory workspace→leader-tab map that routes `browser:'required'` commands.
 *
 * Behaviors under test: register/replace (newer leader wins), heartbeat +
 * sessionId-match guard (a stale tab can't keep/evict a newer leader's entry),
 * heartbeat-timeout expiry, deliver → push → resolveRequest correlation, and
 * the command-timeout fallback. Timers + Date are faked so expiry/timeout are
 * deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deliver,
  getSession,
  heartbeatSession,
  listSessions,
  registerSession,
  resolveRequest,
  unregisterSession,
} from './session-registry';
import type { CommandResult } from './types';

const OK: CommandResult = { ok: true } as CommandResult;
const cmd = { id: 'ui:dispatch', args: { x: 1 } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  // Drain the module-global registry so tests don't bleed into each other.
  for (const s of listSessions()) unregisterSession(s.workspace, s.sessionId);
  vi.useRealTimers();
});

describe('register / get / heartbeat / unregister', () => {
  it('registers a session and getSession returns it', () => {
    registerSession({ workspace: 'w1', sessionId: 's1', push: () => {} });
    expect(getSession('w1')?.sessionId).toBe('s1');
    expect(listSessions().map((s) => s.workspace)).toContain('w1');
  });

  it('a newer registration for the same workspace replaces the old leader', () => {
    registerSession({ workspace: 'w1', sessionId: 's1', push: () => {} });
    registerSession({ workspace: 'w1', sessionId: 's2', push: () => {} });
    expect(getSession('w1')?.sessionId).toBe('s2');
    expect(listSessions().filter((s) => s.workspace === 'w1')).toHaveLength(1);
  });

  it('heartbeat refreshes lastSeen only for the matching sessionId', () => {
    registerSession({ workspace: 'w1', sessionId: 's1', push: () => {} });
    expect(heartbeatSession('w1', 's1')).toBe(true);
    // Wrong sessionId (a stale tab) must NOT heartbeat the current leader.
    expect(heartbeatSession('w1', 'stale')).toBe(false);
    expect(heartbeatSession('nope', 's1')).toBe(false);
  });

  it('unregister is a no-op when the sessionId does not match (a stale tab cannot evict the new leader)', () => {
    registerSession({ workspace: 'w1', sessionId: 's2', push: () => {} });
    unregisterSession('w1', 's1-old'); // stale tab tries to clean up
    expect(getSession('w1')?.sessionId).toBe('s2'); // new leader survives
    unregisterSession('w1', 's2');
    expect(getSession('w1')).toBeUndefined();
  });

  it('getSession expires an entry past the 15s heartbeat timeout and drops it', () => {
    registerSession({ workspace: 'w1', sessionId: 's1', push: () => {} });
    vi.setSystemTime(14_000);
    expect(getSession('w1')?.sessionId).toBe('s1'); // still live at 14s
    vi.setSystemTime(15_001);
    expect(getSession('w1')).toBeUndefined(); // expired
    expect(listSessions()).toHaveLength(0); // and removed
  });

  it('a heartbeat within the window keeps the session alive past the original timeout', () => {
    registerSession({ workspace: 'w1', sessionId: 's1', push: () => {} });
    vi.setSystemTime(14_000);
    expect(heartbeatSession('w1', 's1')).toBe(true); // lastSeen → 14s
    vi.setSystemTime(28_000); // 14s after the heartbeat — still inside the window
    expect(getSession('w1')?.sessionId).toBe('s1');
  });
});

describe('deliver', () => {
  it('returns no-active-session (retryable) when no live tab is registered', async () => {
    const res = await deliver('ghost', cmd);
    expect(res).toMatchObject({ ok: false, error: { code: 'no-active-session', retryable: true } });
  });

  it('pushes the request to the tab and resolves when the tab POSTs its result back', async () => {
    let pushedId = '';
    registerSession({
      workspace: 'w1',
      sessionId: 's1',
      push: (req) => { pushedId = req.requestId; },
    });
    const p = deliver('w1', cmd);
    expect(pushedId).not.toBe(''); // the request reached the tab synchronously
    const done = resolveRequest(pushedId, OK);
    expect(done).toBe(true);
    expect(await p).toEqual(OK);
  });

  it('times out with tab-timeout (retryable) when the tab never responds', async () => {
    registerSession({ workspace: 'w1', sessionId: 's1', push: () => {} });
    const p = deliver('w1', cmd);
    vi.advanceTimersByTime(10_000); // COMMAND_TIMEOUT_MS
    expect(await p).toMatchObject({ ok: false, error: { code: 'tab-timeout', retryable: true } });
  });

  it('resolveRequest returns false for an unknown/already-resolved requestId', () => {
    expect(resolveRequest('never-issued', OK)).toBe(false);
    let pushedId = '';
    registerSession({ workspace: 'w1', sessionId: 's1', push: (req) => { pushedId = req.requestId; } });
    void deliver('w1', cmd);
    expect(resolveRequest(pushedId, OK)).toBe(true);
    expect(resolveRequest(pushedId, OK)).toBe(false); // second resolve is a no-op
  });
});
