/**
 * work_items:get — checkpoint surfacing (EI-7252).
 *
 * A work-item's in-flight CHECKPOINT (work_items:checkpoint → carry-note scope
 * `workitem:<harness>:<id>`) was previously invisible to work_items:get — an
 * investigator (or a compacted successor) reading the item had no way to know a
 * checkpoint existed and could wrongly conclude state was lost. Pins: the field
 * is always present (null when none was ever written), it reflects the resolved
 * work-item's OWN harness (not the request arg), a lookup failure degrades to
 * null rather than failing the whole read, and a harness-less item never calls
 * the checkpoint store at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
const getWorkItemDetail = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  getWorkItemDetail: (...a: unknown[]) => getWorkItemDetail(...a),
}));

const getWorkItemCheckpoint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpoint: (...a: unknown[]) => getWorkItemCheckpoint(...a),
}));

import get from './get';

const ctx = { uiClientId: 'su-tester', workspaceId: 'default' } as never;
const parse = (x: unknown) => (get.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
const env = async (x: unknown) => {
  const res = (await get.handler(parse(x) as never, ctx)) as Out;
  return res.data;
};
const one = async (x: unknown) => (await env(x)).results[0];

beforeEach(() => {
  getWorkItem.mockReset();
  getWorkItemDetail.mockReset();
  getWorkItemCheckpoint.mockReset();
});

describe('work_items:get — checkpoint field', () => {
  it('surfaces an existing checkpoint, keyed by the resolved work-item harness/id', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const r = await one({ id: 'WI-7' });
    expect(getWorkItemCheckpoint).toHaveBeenCalledWith({ harness: 'papercup', workItemId: 'WI-7' });
    expect(r).toMatchObject({ ok: true, id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
  });

  it('is null (not omitted) when no checkpoint was ever written', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-8', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpoint.mockResolvedValue(null);
    const r = await one({ id: 'WI-8' });
    expect(r).toMatchObject({ ok: true, id: 'WI-8', checkpoint: null });
  });

  it('degrades to null (does not fail the read) when the checkpoint lookup throws', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-9', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpoint.mockRejectedValue(new Error('pg down'));
    const r = await one({ id: 'WI-9' });
    expect(r).toMatchObject({ ok: true, id: 'WI-9', checkpoint: null });
  });

  it('skips the checkpoint lookup entirely for a harness-less item', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-10', harness: null, kind: 'bug', family: 'issue', title: 't', state: 'open' });
    const r = await one({ id: 'WI-10' });
    expect(getWorkItemCheckpoint).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, id: 'WI-10', checkpoint: null });
  });

  it('also surfaces on the detail path (args.detail:true)', async () => {
    getWorkItemDetail.mockResolvedValue({ id: 'WI-11', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', topics: [], posts: [], links: [] });
    getWorkItemCheckpoint.mockResolvedValue('detail-path checkpoint');
    const r = await one({ id: 'WI-11', detail: true });
    expect(getWorkItemDetail).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, id: 'WI-11', checkpoint: 'detail-path checkpoint' });
  });

  it('never calls the checkpoint store for a not-found item', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404' });
    expect(getWorkItemCheckpoint).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, id: 'WI-404' });
  });
});
