/**
 * Unit tests for work_items:complete (coord-lifecycle-automation-2026-06-04 D-004),
 * dual-arity keyed-array contract (bulk-endpoint-standardization-2026-06-21). The
 * engine (getWorkItem/setWorkItemState) is mocked — this exercises the tool's
 * contract: existence check, optional terminal transition, the structured completion
 * record the lifecycle emits-rule reads, and per-item fan-out for items:[…].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
const setWorkItemState = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  setWorkItemState: (...a: unknown[]) => setWorkItemState(...a),
  workItemObjectRef: (x: { id: string }) => `wi:${x.id}`,
}));

import complete from './complete';

const ctx = { uiClientId: 'su-tester', isSuperuser: true, workspaceId: 'default' } as never;
const parse = (x: unknown) => (complete.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
/** Full envelope. */
const env = async (x: unknown) => {
  const res = (await complete.handler(parse(x) as never, ctx)) as Out;
  return (res.data);
};
/** The single (n=1) result item — the dual-arity verb wraps it in the bulk envelope. */
const one = async (x: unknown) => (await env(x)).results[0];

const item = { id: 'F-12', kind: 'feature', family: 'feature', state: 'in_progress', harness: 'papercup' };

beforeEach(() => {
  getWorkItem.mockReset();
  setWorkItemState.mockReset();
});

describe('work_items:complete (keyed-array)', () => {
  it('errors cleanly per item when the work-item does not exist', async () => {
    getWorkItem.mockResolvedValue(null);
    const out = await env({ id: 'F-404', completion: { workItem: 'F-404', summary: 'x' } });
    expect(out).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(out.results[0]).toEqual({ ok: false, id: 'F-404', error: "work_item 'F-404' not found" });
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('records + returns the completion WITHOUT changing state when `state` omitted', async () => {
    getWorkItem.mockResolvedValue(item);
    const r = await one({
      id: 'F-12',
      completion: {
        workItem: 'F-12',
        summary: 'all phases done',
        tests: '40 green',
        migrations: ['137 add cols'],
        deferred: ['live smoke pending'],
      },
    });
    expect(setWorkItemState).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.id).toBe('F-12');
    expect(r.workItem).toMatchObject({ id: 'F-12' });
    expect(r.completion.summary).toBe('all phases done');
    expect(r.completion.deferred).toEqual(['live smoke pending']);
    expect(r.completion.status).toBe('done'); // defaulted
    expect(r.completion.agent).toBeTruthy(); // filled from identity
  });

  it('transitions to the terminal state when `state` provided', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemState.mockResolvedValue({ ...item, state: 'passed' });
    const r = await one({ id: 'F-12', state: 'passed', completion: { workItem: 'F-12', summary: 'shipped' } });
    expect(setWorkItemState).toHaveBeenCalledWith('F-12', 'passed', expect.objectContaining({ by: expect.any(String) }));
    expect(r.workItem.state).toBe('passed');
    expect(r.ok).toBe(true);
  });

  it('fills completion.workItem from the id when the caller omits it (DRY)', async () => {
    getWorkItem.mockResolvedValue(item);
    const r = await one({ id: 'F-12', completion: { summary: 's' } });
    expect(r.completion.workItem).toBe('F-12');
  });

  it('returns the completion-boundary reflect step (self-learning P-001/B)', async () => {
    getWorkItem.mockResolvedValue(item); // harness: 'papercup' → pipeline markers shown
    const r = await one({ id: 'F-12', completion: { summary: 'done' } });
    expect(typeof r.reflect).toBe('string');
    expect(r.reflect).toMatch(/improvements:capture/);
    expect(r.reflect).toMatch(/workaround/);
    expect(r.reflect).toMatch(/validator|reviewer/i);
  });

  it('reflect step omits the harness-pipeline markers for a harness-free unit of work', async () => {
    getWorkItem.mockResolvedValue({ ...item, harness: null });
    const r = await one({ id: 'F-12', completion: { summary: 'done' } });
    expect(r.reflect).toMatch(/workaround/);
    expect(r.reflect).not.toMatch(/validator|reviewer/i);
  });

  it('a FAILED state write never loses the completion (EI-24): ok + completion + stateError', async () => {
    getWorkItem.mockResolvedValue({ ...item, id: 'WI-8', kind: 'task', family: 'issue' });
    setWorkItemState.mockRejectedValue(
      new Error("work_item 'WI-8' (kind=task) cannot take state 'bogus' — valid: open, resolved, closed, done, dropped, todo"),
    );
    const r = await one({ id: 'WI-8', state: 'bogus', completion: { summary: 'work landed; state vocab wrong' } });
    expect(r.ok).toBe(true);
    expect(r.completion.summary).toBe('work landed; state vocab wrong');
    expect(r.stateError).toMatch(/valid: open, resolved, closed/);
    expect(r.workItem.id).toBe('WI-8'); // falls back to the pre-transition item
  });

  it('completes MANY via items:[…] — one self-describing result per item; a not-found never fails the rest', async () => {
    getWorkItem.mockImplementation(async (id: string) => (id === 'F-404' ? null : { ...item, id }));
    const out = await env({
      items: [
        { id: 'F-1', completion: { summary: 'a' } },
        { id: 'F-404', completion: { summary: 'b' } },
        { id: 'F-3', completion: { summary: 'c' } },
      ],
    });
    expect(out.counts).toEqual({ ok: 2, failed: 1 });
    expect(out.results.map((r: { id: string }) => r.id)).toEqual(['F-1', 'F-404', 'F-3']);
    expect(out.results[1]).toMatchObject({ ok: false, id: 'F-404' });
    expect(out.results[0]).toMatchObject({ ok: true, id: 'F-1', completion: { summary: 'a' } });
  });
});
