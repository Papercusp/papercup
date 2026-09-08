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
      'work_items:get': () => ({ ok: true, results: [{ ok: true, id: 'WI-1', workItem: { id: 'WI-1', kind: 'task', title: 'T' } }] }),
      'work_items:claim': () => ({ ok: true, results: [{ ok: true, id: 'WI-1', workItem: { id: 'WI-1', assignee: 'me' } }], counts: { ok: 1, failed: 0 } }),
      'coord:declare-intent': () => ({
        ok: true, presence: { intent: 'doing WI-1' },
        claims: { claimed: ['P-001'], alreadyHeld: [], conflicts: [] },
      }),
    });
    const r = await composePickup({ id: 'WI-1', intent: 'doing WI-1', plan: 'p', items: ['P-001'] }, call);
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(true);
    expect(r.intentDeclared).toBe(true);
    expect(r.laneClaimed).toBe(true);
    expect((r.item as { assignee?: string }).assignee).toBe('me'); // claim's refreshed item wins
    expect(calls.map((c) => c.name)).toEqual(['work_items:get', 'work_items:claim', 'coord:declare-intent']);
    expect(calls[0].args).toMatchObject({ id: 'WI-1', detail: true });
    expect(calls[2].args).toMatchObject({ intent: 'doing WI-1', current_plan_slug: 'p', items: ['P-001'] });
  });

  it('skips declare-intent when no intent is given (2 round-trips → one)', async () => {
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: true, results: [{ ok: true, id: 'WI-2', workItem: { id: 'WI-2' } }] }),
      'work_items:claim': () => ({ ok: true, results: [{ ok: true, id: 'WI-2', workItem: { id: 'WI-2' } }], counts: { ok: 1, failed: 0 } }),
    });
    const r = await composePickup({ id: 'WI-2' }, call);
    expect(r.ok).toBe(true);
    expect(r.intentDeclared).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['work_items:get', 'work_items:claim']);
  });

  it('short-circuits step=get when the item is not found (claim never attempted)', async () => {
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: true, results: [{ ok: false, id: 'WI-X', error: "work_item 'WI-X' not found" }] }),
    });
    const r = await composePickup({ id: 'WI-X' }, call);
    expect(r.ok).toBe(false);
    expect(r.step).toBe('get');
    expect(calls.map((c) => c.name)).toEqual(['work_items:get']);
  });

  it('short-circuits step=claim (returning the fetched item) when claim fails; never declares', async () => {
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: true, results: [{ ok: true, id: 'WI-3', workItem: { id: 'WI-3', title: 'taken' } }] }),
      'work_items:claim': () => ({ ok: true, results: [{ ok: false, id: 'WI-3', error: 'already claimed by peer' }], counts: { ok: 0, failed: 1 } }),
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
      'work_items:get': () => ({ ok: true, results: [{ ok: true, id: 'WI-4', workItem: { id: 'WI-4' } }] }),
      'work_items:claim': () => ({ ok: true, results: [{ ok: true, id: 'WI-4', workItem: { id: 'WI-4' } }], counts: { ok: 1, failed: 0 } }),
      'coord:declare-intent': () => ({ ok: true, presence: {} }),
    });
    await composePickup({ id: 'WI-4', intent: 'x', items: ['P-001'] }, call); // no plan
    const di = calls.find((c) => c.name === 'coord:declare-intent')!;
    expect(di.args.items).toBeUndefined();
    expect(di.args.current_plan_slug).toBeUndefined();
  });

  const item = { id: 'WI-5', assignee: 'me' };
  const args = { id: item.id, intent: 'review existing task', plan: 'p', items: ['P-001'] };
  function claimedCall(declare: () => unknown) {
    return fakeCall({
      'work_items:get': () => ({ ok: true, results: [{ ok: true, workItem: item }] }),
      'work_items:claim': () => ({ ok: true, results: [{ ok: true, workItem: item }] }),
      'coord:declare-intent': declare,
    });
  }

  it.each([
    ['business failure', { ok: false, error: 'scope denied' }],
    ['absent result', undefined],
    ['null result', null],
    ['empty result', {}],
    ['non-boolean success', { ok: 'true' }],
    ['unparsed result', 'ok:true'],
  ])('preserves the completed claim on declaration %s', async (_label, declaration) => {
    const { call, calls } = claimedCall(() => declaration);
    expect(await composePickup(args, call)).toMatchObject({
      ok: false, step: 'declare-intent', item, claimed: true,
      intentDeclared: false, laneClaimed: false,
    });
    expect(calls.map(({ name }) => name)).toEqual([
      'work_items:get', 'work_items:claim', 'coord:declare-intent',
    ]);
  });

  it('reports a thrown declaration gate failure without hiding the completed claim', async () => {
    const { call } = claimedCall(() => { throw new Error('capability revoked'); });
    expect(await composePickup(args, call)).toMatchObject({
      ok: false, step: 'declare-intent', error: 'capability revoked',
      item, claimed: true, intentDeclared: false, laneClaimed: false,
    });
  });

  it.each([
    ['conflict', { claimed: [], alreadyHeld: [], conflicts: [{ itemId: 'P-001', owner: 'peer' }] }],
    ['unknown id', { claimed: [], alreadyHeld: [], conflicts: [], unknown: ['P-001'] }],
    ['no positive receipt', { claimed: [], alreadyHeld: [], conflicts: [] }],
    ['wrong receipt', { claimed: ['P-002'], alreadyHeld: [], conflicts: [] }],
    ['missing claims', undefined],
    ['malformed claims', { claimed: 'P-001', alreadyHeld: [], conflicts: [] }],
    ['malformed conflicts', { claimed: ['P-001'], alreadyHeld: [], conflicts: null }],
    ['malformed unknowns', { claimed: ['P-001'], alreadyHeld: [], conflicts: [], unknown: 'P-002' }],
  ])('separates declared presence from a lane %s', async (_label, claims) => {
    const declaration = { ok: true, presence: { intent: args.intent }, claims };
    const { call } = claimedCall(() => declaration);
    expect(await composePickup(args, call)).toMatchObject({
      ok: false, step: 'lane', claimed: true, intentDeclared: true,
      laneClaimed: false, presence: declaration,
    });
  });

  it('accepts an already-held lane receipt on an authorized same-ID retry', async () => {
    let attempt = 0;
    const { call, calls } = claimedCall(() => ++attempt === 1
      ? { ok: false, error: 'screening still pending' }
      : { ok: true, claims: { claimed: [], alreadyHeld: ['P-001'], conflicts: [] } });
    expect(await composePickup(args, call)).toMatchObject({ ok: false, claimed: true });
    expect(await composePickup(args, call)).toMatchObject({
      ok: true, claimed: true, intentDeclared: true, laneClaimed: true,
    });
    expect(calls.map(({ name }) => name)).toEqual([
      'work_items:get', 'work_items:claim', 'coord:declare-intent',
      'work_items:get', 'work_items:claim', 'coord:declare-intent',
    ]);
    expect(calls.filter(({ name }) => name === 'work_items:claim')
      .map(({ args: claimArgs }) => claimArgs)).toEqual([{ id: item.id }, { id: item.id }]);
  });

  it('does not use a prior successful claim to bypass revoked authority on retry', async () => {
    let allowed = true;
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: true, results: [{ ok: true, workItem: item }] }),
      'work_items:claim': () => ({
        ok: true, results: [allowed
          ? { ok: true, workItem: item }
          : { ok: false, error: 'fleet_scope_violation' }],
      }),
      'coord:declare-intent': () => ({ ok: false, error: 'declaration interrupted' }),
    });
    expect(await composePickup(args, call)).toMatchObject({ ok: false, claimed: true });
    allowed = false;
    expect(await composePickup(args, call)).toMatchObject({
      ok: false, claimed: false, step: 'claim', error: 'fleet_scope_violation',
    });
    expect(calls.map(({ name }) => name)).toEqual([
      'work_items:get', 'work_items:claim', 'coord:declare-intent',
      'work_items:get', 'work_items:claim',
    ]);
  });

  it('does not convert a thrown claim authorization failure into a retry success', async () => {
    const { call, calls } = fakeCall({
      'work_items:get': () => ({ ok: true, results: [{ ok: true, workItem: item }] }),
      'work_items:claim': () => { throw new Error('authorization revoked'); },
    });
    await expect(composePickup(args, call)).rejects.toThrow('authorization revoked');
    expect(calls.map(({ name }) => name)).toEqual(['work_items:get', 'work_items:claim']);
  });

  it('requires all requested lane ids, including when some were already held', async () => {
    const { call } = claimedCall(() => ({
      ok: true, claims: { claimed: ['P-001'], alreadyHeld: ['P-002'], conflicts: [] },
    }));
    expect(await composePickup({ ...args, items: ['P-001', 'P-002'] }, call))
      .toMatchObject({ ok: true, laneClaimed: true });
    expect(await composePickup({ ...args, items: ['P-001', 'P-002', 'P-003'] }, call))
      .toMatchObject({ ok: false, claimed: true, intentDeclared: true, laneClaimed: false });
  });
});
