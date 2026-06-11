/**
 * watch.test.ts — the unified `watch` primitive's routing (unify-watch-primitive P-007).
 * Deps mocked; asserts wake:false → inject/subscribe path, wake:true → the await registration
 * with the right cardinality + floor defaults.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'operator', 'documenter', 'curator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-watcher', ownerLabel: 'w', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 }, note: 'resumable' })),
}));
vi.mock('../../events/await/store', () => ({ registerAwait: vi.fn(async (i: Record<string, unknown>) => ({ id: 1, eventKey: i.eventKey, once: i.once, minSleepSec: i.minSleepSec, urgency: i.urgency, expiresTs: null, timeoutBehavior: i.timeoutBehavior })) }));
vi.mock('../../events/await/engine', () => ({ startAwaitSweeper: vi.fn() }));
vi.mock('../coordination/topics', () => ({ subscribeTopic: vi.fn(async (_id: unknown, slug: string, opts: Record<string, unknown>) => ({ target_ref: slug, delivery_mode: opts.mode ?? 'full', expires_ts: null })) }));

import watch from './watch';
import { registerAwait } from '../../events/await/store';
import { subscribeTopic } from '../coordination/topics';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof watch.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await watch.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => vi.clearAllMocks());

describe('watch routing', () => {
  it('wake:false (default) → inject path: a standing topic subscription, no await', async () => {
    const out = await call({ pattern: 'locks', mode: 'digest', timeout_sec: 99 });
    expect(subscribeTopic).toHaveBeenCalledWith(expect.anything(), 'locks', { mode: 'digest', ttl_sec: 99 });
    expect(registerAwait).not.toHaveBeenCalled();
    expect(out.watch).toMatchObject({ wake: false, once: false, mode: 'digest' });
  });

  it('wake:true (default once) → a one-shot wake grant, no floor', async () => {
    const out = await call({ pattern: 'lock:grant:t1', wake: true });
    expect(subscribeTopic).not.toHaveBeenCalled();
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ eventKey: 'lock:grant:t1', policy: 'wake', once: true, minSleepSec: 0 });
    expect(out.watch).toMatchObject({ wake: true, once: true, min_sleep_sec: 0 });
  });

  it('wake:true once:false → a STANDING wake watch defaulting to the floor', async () => {
    await call({ pattern: 'feature:settled', wake: true, once: false });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ once: false, minSleepSec: 60 }); // standing floor default
    expect(arg.timeoutSec).toBeNull(); // standing watches have no default deadline
  });

  it('min_sleep_sec + urgency are honored on a standing wake watch', async () => {
    await call({ pattern: 'hot:key', wake: true, once: false, min_sleep_sec: 120, urgency: true });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ minSleepSec: 120, urgency: true });
  });
});
