/**
 * work_items:get — checkpoint surfacing (EI-7252) + checkpoint recency (EI-8885).
 *
 * A work-item's in-flight CHECKPOINT (work_items:checkpoint → carry-note scope
 * `workitem:<harness>:<id>`) was previously invisible to work_items:get — an
 * investigator (or a compacted successor) reading the item had no way to know a
 * checkpoint existed and could wrongly conclude state was lost. Pins: the field
 * is always present (null when none was ever written), it reflects the resolved
 * work-item's OWN harness (not the request arg), a lookup failure degrades to
 * null rather than failing the whole read, and a harness-NULL item still reads its
 * checkpoint (EI-8805 — the store canonicalizes the null harness to the wildcard
 * namespace it was written under, instead of skipping the lookup and losing it).
 *
 * EI-8885: a checkpoint with no age signal reads as CURRENT even when it's several
 * wakes stale — checkpointAgeMs/checkpointUpdatedAtMs surface the write recency
 * alongside the content so a reader can downgrade trust on an old checkpoint
 * instead of discovering staleness only after acting on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
const getWorkItemDetail = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  getWorkItemDetail: (...a: unknown[]) => getWorkItemDetail(...a),
}));

const getWorkItemCheckpointWithMeta = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...a: unknown[]) => getWorkItemCheckpointWithMeta(...a),
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
  getWorkItemCheckpointWithMeta.mockReset();
});

describe('work_items:get — checkpoint field', () => {
  it('surfaces an existing checkpoint + its age, keyed by the resolved work-item harness/id', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    const updatedAtMs = Date.now() - 5000;
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'did step 1; next: step 2', updatedAtMs });
    const r = await one({ id: 'WI-7' });
    expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledWith({ harness: 'papercup', workItemId: 'WI-7' });
    expect(r).toMatchObject({ ok: true, id: 'WI-7', checkpoint: 'did step 1; next: step 2', checkpointUpdatedAtMs: updatedAtMs });
    expect(r.checkpointAgeMs).toBeGreaterThanOrEqual(5000);
  });

  it('is null (not omitted) when no checkpoint was ever written — age is also null', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-8', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    const r = await one({ id: 'WI-8' });
    expect(r).toMatchObject({ ok: true, id: 'WI-8', checkpoint: null, checkpointAgeMs: null, checkpointUpdatedAtMs: null });
  });

  it('degrades to null (does not fail the read) when the checkpoint lookup throws', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-9', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpointWithMeta.mockRejectedValue(new Error('pg down'));
    const r = await one({ id: 'WI-9' });
    expect(r).toMatchObject({ ok: true, id: 'WI-9', checkpoint: null, checkpointAgeMs: null, checkpointUpdatedAtMs: null });
  });

  it('reads the checkpoint for a harness-null item (EI-8805 — no longer skipped)', async () => {
    // A harness-null item (an EI filed from an unscoped session) previously skipped the
    // checkpoint lookup entirely and always read null, silently losing a written
    // checkpoint. Now the lookup runs (the store canonicalizes the null harness to the
    // wildcard namespace it was written under) so the checkpoint round-trips.
    getWorkItem.mockResolvedValue({ id: 'EI-10', harness: null, kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'harness-null continuity state', updatedAtMs: Date.now() });
    const r = await one({ id: 'EI-10' });
    expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledWith({ harness: null, workItemId: 'EI-10' });
    expect(r).toMatchObject({ ok: true, id: 'EI-10', checkpoint: 'harness-null continuity state' });
  });

  it('also surfaces on the detail path (args.detail:true)', async () => {
    getWorkItemDetail.mockResolvedValue({ id: 'WI-11', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', topics: [], posts: [], links: [] });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'detail-path checkpoint', updatedAtMs: Date.now() });
    const r = await one({ id: 'WI-11', detail: true });
    expect(getWorkItemDetail).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, id: 'WI-11', checkpoint: 'detail-path checkpoint' });
  });

  it('never calls the checkpoint store for a not-found item', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404' });
    expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, id: 'WI-404' });
  });
});
