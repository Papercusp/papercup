import { describe, expect, it, vi } from 'vitest';
import { reconcileInterestEventAwaits, type InterestAutoArmDeps } from './interest-auto-arm';

function deps(active: any[] = []): InterestAutoArmDeps {
  return {
    captureHandle: vi.fn(async () => ({ handle: { kind: 'psu-socket' } as any, note: 'reachable' })),
    listActive: vi.fn(async () => active),
    register: vi.fn(async (input: any) => ({ ...input, id: 40 + Math.random() })) as any,
    cancel: vi.fn(async () => true),
  };
}

describe('reconcileInterestEventAwaits', () => {
  it('is idempotent and returns an events:cancel handle for the exact lifecycle edges', async () => {
    const d = deps([
      { id: 7, eventKey: 'claim:released:WI-1', policy: 'wake', once: true, wakeHandle: {}, boundTo: { kind: 'work-item-claim', ref: 'WI-1' } },
    ]);
    const out = await reconcileInterestEventAwaits(
      { ownerId: 'agent-1', eventKeys: ['claim:released:WI-1', 'claim:released:WI-1'], boundTo: { kind: 'work-item-claim', ref: 'WI-1' }, note: 'claim holder' },
      d,
    );
    expect(out).toMatchObject({ event_keys: ['claim:released:WI-1'], await_ids: [7], cancel: { tool: 'events:cancel', args: { await_ids: [7] } } });
    expect(d.register).not.toHaveBeenCalled();
  });

  it('cancels stale bound keys and registers missing one-shot wakes', async () => {
    const d = deps([
      { id: 8, eventKey: 'work-item:done:old', policy: 'wake', once: true, wakeHandle: {}, boundTo: { kind: 'work-item-blocked', ref: 'WI-2' } },
    ]);
    const out = await reconcileInterestEventAwaits(
      { ownerId: 'agent-2', eventKeys: ['work-item:done:new'], boundTo: { kind: 'work-item-blocked', ref: 'WI-2' }, note: 'blocked holder' },
      d,
    );
    expect(d.cancel).toHaveBeenCalledWith({ awaitId: 8, subscriberId: 'agent-2' });
    expect(d.register).toHaveBeenCalledWith(expect.objectContaining({ eventKey: 'work-item:done:new', once: true, boundTo: { kind: 'work-item-blocked', ref: 'WI-2' } }));
    expect(out.cancel?.args.await_ids).toHaveLength(1);
  });
});
