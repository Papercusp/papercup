import { describe, it, expect } from 'vitest';
import { composeOrient } from './orient';
import type { InnerCall } from '../../_compound-dispatch';

function fakeCall(handlers: Record<string, (args: Record<string, unknown>) => unknown>): {
  call: InnerCall;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call: InnerCall = async (name, args) => {
    calls.push({ name, args: args as Record<string, unknown> });
    const h = handlers[name];
    if (!h) throw new Error(`unexpected sub-call: ${name}`);
    return h(args as Record<string, unknown>);
  };
  return { call, calls };
}

describe('composeOrient (B-CX-1B compound: assignments + list + inbox)', () => {
  it('folds my assignments + claimable backlog + inbox summary into one result (3 round-trips → one)', async () => {
    const { call, calls } = fakeCall({
      'fleet:assignments': () => ({ ok: true, summary: { agents: 1 }, agents: [{ ownerId: 'me' }] }),
      'work_items:list': () => [{ id: 'WI-1', state: 'todo' }, { id: 'WI-2', state: 'todo' }],
      'coord:inbox': () => ({ summary: { total: 3 }, entries: [{ msg_id: 'm1' }] }),
    });
    const r = await composeOrient({ harness: 'h' }, call, 'me');
    expect(r.ok).toBe(true);
    expect((r.me as { agents: Array<{ ownerId: string }> }).agents[0].ownerId).toBe('me');
    expect(r.claimable).toHaveLength(2);
    expect((r.inbox.summary as { total: number }).total).toBe(3);
    expect(r.inbox.recent).toEqual([{ msg_id: 'm1' }]);
    // sequential order (never Promise.all on one ctx) + arg forwarding
    expect(calls.map((c) => c.name)).toEqual(['fleet:assignments', 'work_items:list', 'coord:inbox']);
    expect(calls[0].args).toMatchObject({ agent: 'me', harness: 'h' });
    expect(calls[1].args).toMatchObject({ harness: 'h', state: 'todo', limit: 20 });
    expect(calls[2].args).toMatchObject({ limit: 10, max_body_chars: 300 });
  });

  it('omits the agent filter when no ownerId resolved (fleet-wide assignments)', async () => {
    const { call, calls } = fakeCall({
      'fleet:assignments': () => ({ ok: true }),
      'work_items:list': () => [],
      'coord:inbox': () => ({ summary: {}, entries: [] }),
    });
    await composeOrient({}, call, undefined);
    expect(calls[0].args.agent).toBeUndefined();
  });

  it('normalizes a { data: [...] } list shape into claimable[]', async () => {
    const { call } = fakeCall({
      'fleet:assignments': () => ({}),
      'work_items:list': () => ({ data: [{ id: 'WI-9' }] }),
      'coord:inbox': () => ({ summary: {}, entries: [] }),
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.claimable).toEqual([{ id: 'WI-9' }]);
  });

  it('honors claimableState / claimableLimit / inboxLimit overrides', async () => {
    const { call, calls } = fakeCall({
      'fleet:assignments': () => ({}),
      'work_items:list': () => [],
      'coord:inbox': () => ({ summary: {}, entries: [] }),
    });
    await composeOrient({ claimableState: 'wip', claimableLimit: 5, inboxLimit: 3 }, call, 'me');
    expect(calls[1].args).toMatchObject({ state: 'wip', limit: 5 });
    expect(calls[2].args).toMatchObject({ limit: 3 });
  });
});
