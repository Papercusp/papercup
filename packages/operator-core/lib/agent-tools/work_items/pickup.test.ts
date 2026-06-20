import { describe, it, expect } from 'vitest';
import { composePickup } from './pickup';
import type { InnerCall } from '../_compound-dispatch';

/** A fake InnerCall: routes each sub-call to a canned handler and records the calls. */
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

describe('composePickup (B-CX-1B compound: get + claim + declare-intent)', () => {
  it('gets detail, claims, and (with intent) declares — 3 round-trips collapsed into one', async () => {
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: true, workItem: { id: 'WI-1', kind: 'task', title: 'T' } }),
      'work_items:claim': () => ({ ok: true, workItem: { id: 'WI-1', assignee: 'me' } }),
      'coord:declare-intent': () => ({ ok: true, presence: { intent: 'doing WI-1' } }),
    });
    const r = await composePickup({ id: 'WI-1', intent: 'doing WI-1', plan: 'p', items: ['P-001'] }, call);
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(true);
    expect(r.intentDeclared).toBe(true);
    expect((r.item as { assignee?: string }).assignee).toBe('me'); // claim's refreshed item wins
    expect(calls.map((c) => c.name)).toEqual(['work_items:get', 'work_items:claim', 'coord:declare-intent']);
    expect(calls[0].args).toMatchObject({ id: 'WI-1', detail: true });
    expect(calls[2].args).toMatchObject({ intent: 'doing WI-1', current_plan_slug: 'p', items: ['P-001'] });
  });

  it('skips declare-intent when no intent is given (2 round-trips → one)', async () => {
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: true, workItem: { id: 'WI-2' } }),
      'work_items:claim': () => ({ ok: true, workItem: { id: 'WI-2' } }),
    });
    const r = await composePickup({ id: 'WI-2' }, call);
    expect(r.ok).toBe(true);
    expect(r.intentDeclared).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['work_items:get', 'work_items:claim']);
  });

  it('short-circuits step=get when the item is not found (claim never attempted)', async () => {
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: false, error: "work_item 'WI-X' not found" }),
    });
    const r = await composePickup({ id: 'WI-X' }, call);
    expect(r.ok).toBe(false);
    expect(r.step).toBe('get');
    expect(calls.map((c) => c.name)).toEqual(['work_items:get']);
  });

  it('short-circuits step=claim (returning the fetched item) when claim fails; never declares', async () => {
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: true, workItem: { id: 'WI-3', title: 'taken' } }),
      'work_items:claim': () => ({ ok: false, error: 'already claimed by peer' }),
    });
    const r = await composePickup({ id: 'WI-3', intent: 'x', plan: 'p' }, call);
    expect(r.ok).toBe(false);
    expect(r.step).toBe('claim');
    expect(r.claimed).toBe(false);
    expect((r.item as { title?: string }).title).toBe('taken');
    expect(calls.map((c) => c.name)).toEqual(['work_items:get', 'work_items:claim']);
  });

  it('does not forward items without a plan (declare-intent rejects items sans plan)', async () => {
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: true, workItem: { id: 'WI-4' } }),
      'work_items:claim': () => ({ ok: true, workItem: { id: 'WI-4' } }),
      'coord:declare-intent': () => ({ ok: true, presence: {} }),
    });
    await composePickup({ id: 'WI-4', intent: 'x', items: ['P-001'] }, call); // no plan
    const di = calls.find((c) => c.name === 'coord:declare-intent')!;
    expect(di.args.items).toBeUndefined();
    expect(di.args.current_plan_slug).toBeUndefined();
  });
});
