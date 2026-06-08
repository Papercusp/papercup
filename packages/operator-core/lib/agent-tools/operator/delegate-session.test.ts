/**
 * Tests for resolveDelegateSession — new vs resumed agent-session resolution
 * for operator:delegate (shared by the route + the tool handler).
 * Run with: cd packages/operator-core && npx vitest run lib/agent-tools/operator/delegate-session.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const findMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../delegated-tasks', () => ({ findOpenDelegatedTask: findMock.fn }));

import { resolveDelegateSession } from './delegate-session';

const UUID = /^[0-9a-f-]{36}$/i;
afterEach(() => findMock.fn.mockReset());

describe('resolveDelegateSession', () => {
  it('mints a fresh session when forceNew is set', async () => {
    const r = await resolveDelegateSession('ws', 'existing-id', true);
    expect(r.sessionCreated).toBe(true);
    expect(r.agentSessionId).toMatch(UUID);
    expect(findMock.fn).not.toHaveBeenCalled();
  });

  it('mints a fresh session when no session id is requested', async () => {
    const r = await resolveDelegateSession('ws', undefined, false);
    expect(r.sessionCreated).toBe(true);
    expect(r.agentSessionId).toMatch(UUID);
  });

  it('resumes when an OPEN delegated task still carries the requested id', async () => {
    findMock.fn.mockResolvedValue({ id: 'task-1' });
    const r = await resolveDelegateSession('ws', 'sess-123', false);
    expect(r).toEqual({ agentSessionId: 'sess-123', sessionCreated: false });
  });

  it('mints a fresh session when the requested id has no open task', async () => {
    findMock.fn.mockResolvedValue(null);
    const r = await resolveDelegateSession('ws', 'sess-123', false);
    expect(r.sessionCreated).toBe(true);
    expect(r.agentSessionId).not.toBe('sess-123');
    expect(r.agentSessionId).toMatch(UUID);
  });

  it('treats a lookup failure as no-session (mints fresh, never throws)', async () => {
    findMock.fn.mockRejectedValue(new Error('db down'));
    const r = await resolveDelegateSession('ws', 'sess-123', false);
    expect(r.sessionCreated).toBe(true);
    expect(r.agentSessionId).toMatch(UUID);
  });
});
