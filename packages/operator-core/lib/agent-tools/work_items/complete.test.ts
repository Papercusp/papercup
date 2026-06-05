/**
 * Unit tests for work_items:complete (coord-lifecycle-automation-2026-06-04 D-004).
 * The engine (getWorkItem/setWorkItemState) is mocked — this exercises the
 * tool's contract: existence check, optional terminal transition, and the
 * structured completion record returned for the lifecycle emits-rule.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
const setWorkItemState = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  setWorkItemState: (...a: unknown[]) => setWorkItemState(...a),
}));

import complete from './complete';

const ctx = { uiClientId: 'su-tester', isSuperuser: true, workspaceId: 'default' } as never;
const parse = (x: unknown) => (complete.args as { parse: (x: unknown) => unknown }).parse(x);
const call = async (x: unknown) => {
  const res = await complete.handler(parse(x) as never, ctx);
  return JSON.parse((res.content[0] as { text: string }).text);
};

const item = { id: 'F-12', kind: 'feature', family: 'feature', state: 'in_progress', harness: 'papercup' };

beforeEach(() => {
  getWorkItem.mockReset();
  setWorkItemState.mockReset();
});

describe('work_items:complete', () => {
  it('errors cleanly when the work-item does not exist', async () => {
    getWorkItem.mockResolvedValue(null);
    const out = await call({ id: 'F-404', completion: { workItem: 'F-404', summary: 'x' } });
    expect(out).toEqual({ ok: false, error: "work_item 'F-404' not found" });
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('records + returns the completion WITHOUT changing state when `state` omitted', async () => {
    getWorkItem.mockResolvedValue(item);
    const out = await call({
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
    expect(out.ok).toBe(true);
    expect(out.workItem).toMatchObject({ id: 'F-12' });
    expect(out.completion.summary).toBe('all phases done');
    expect(out.completion.deferred).toEqual(['live smoke pending']);
    // status defaulted, agent filled from identity
    expect(out.completion.status).toBe('done');
    expect(out.completion.agent).toBeTruthy();
  });

  it('transitions to the terminal state when `state` provided', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemState.mockResolvedValue({ ...item, state: 'passed' });
    const out = await call({
      id: 'F-12',
      state: 'passed',
      completion: { workItem: 'F-12', summary: 'shipped' },
    });
    expect(setWorkItemState).toHaveBeenCalledWith('F-12', 'passed', expect.objectContaining({ by: expect.any(String) }));
    expect(out.workItem.state).toBe('passed');
    expect(out.ok).toBe(true);
  });

  it('fills completion.workItem from the id when the caller omits it (DRY)', async () => {
    getWorkItem.mockResolvedValue(item);
    const out = await call({ id: 'F-12', completion: { summary: 's' } });
    expect(out.completion.workItem).toBe('F-12');
  });

  it('a FAILED state write never loses the completion (EI-24): ok + completion + stateError', async () => {
    getWorkItem.mockResolvedValue({ ...item, id: 'WI-8', kind: 'task', family: 'issue' });
    setWorkItemState.mockRejectedValue(
      new Error("work_item 'WI-8' (kind=task) cannot take state 'bogus' — valid: open, resolved, closed, done, dropped, todo"),
    );
    const out = await call({
      id: 'WI-8',
      state: 'bogus',
      completion: { summary: 'work landed; state vocab wrong' },
    });
    expect(out.ok).toBe(true); // the completion is recorded + emitted regardless
    expect(out.completion.summary).toBe('work landed; state vocab wrong');
    expect(out.stateError).toMatch(/valid: open, resolved, closed/);
    expect(out.workItem.id).toBe('WI-8'); // falls back to the pre-transition item
  });
});
