/**
 * await.test.ts — events:await wrapper defaults (GAP 16).
 *
 * Mirrors watch.test.ts's tool-mock rig. events:await is the one-shot WAKE sugar
 * — asserts registerAwait is called with policy:'wake', timeoutBehavior:'wake'
 * by default, timeoutSec:14400 (4h) by default, that overrides flow through, and
 * that the response carries await_id/expires_ts/wake_handle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-awaiter', ownerLabel: 'a', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 }, note: 'resumable' })),
}));
vi.mock('../../events/await/store', () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => ({ id: 99, eventKey: i.eventKey, expiresTs: '2030-01-01', timeoutBehavior: i.timeoutBehavior })),
}));
vi.mock('../../events/await/engine', () => ({ startAwaitSweeper: vi.fn() }));

import awaitTool from './await';
import { registerAwait } from '../../events/await/store';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { startAwaitSweeper } from '../../events/await/engine';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof awaitTool.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await awaitTool.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => vi.clearAllMocks());

describe('events:await wrapper defaults', () => {
  it('defaults: policy:wake, timeoutBehavior:wake, timeoutSec:14400 (4h), and the sweeper starts', async () => {
    await call({ event: 'lock:grant:t1' });
    expect(startAwaitSweeper).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({
      subscriberId: 'su-awaiter',
      eventKey: 'lock:grant:t1',
      policy: 'wake',
      timeoutBehavior: 'wake',
      timeoutSec: 4 * 60 * 60,
      note: null,
      workspaceId: 'ws-x',
    });
  });

  it('captures the wake handle NOW and stamps it onto the registration', async () => {
    await call({ event: 'k', plan_run_id: 5 });
    expect(captureWakeHandleForOwner).toHaveBeenCalledWith('su-awaiter', { planRunId: 5 });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg.wakeHandle).toMatchObject({ kind: 'adv-session' });
  });

  it('overrides: on_timeout=expire, timeout_sec, and note flow through', async () => {
    await call({ event: 'k', on_timeout: 'expire', timeout_sec: 30, note: 'why' });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ timeoutBehavior: 'expire', timeoutSec: 30, note: 'why' });
  });

  it('response carries await_id / event / expires_ts / on_timeout / wake_handle', async () => {
    const out = await call({ event: 'plan-run:finished:9' });
    expect(out).toMatchObject({
      ok: true,
      await_id: 99,
      event: 'plan-run:finished:9',
      expires_ts: '2030-01-01',
      on_timeout: 'wake',
      wake_handle: 'resumable',
    });
  });
});
