import { describe, expect, it, vi } from 'vitest';
import {
  ProjectionIndex,
  InMemoryProjectionStore,
  type Contribution,
} from '@papercusp/projection-index';
import { GuardedProjectionIndex } from './guarded-projection-index';

interface Doc {
  id: string;
  topic: string;
  text: string;
}

/** A projector that throws on a poison record (id starts with 'BAD'). */
const projector = (d: Doc): Contribution<string>[] => {
  if (d.id.startsWith('BAD')) throw new Error(`poison record ${d.id}`);
  return [{ key: d.topic, entryId: d.id, entry: d.text, sortKey: d.id }];
};

function build(): { guarded: GuardedProjectionIndex<Doc, string>; store: InMemoryProjectionStore<string>; errs: { sourceId: string; op: string }[] } {
  const store = new InMemoryProjectionStore<string>();
  const inner = new ProjectionIndex<Doc, string>({ projector, store });
  const errs: { sourceId: string; op: string }[] = [];
  const guarded = new GuardedProjectionIndex(inner, {
    onError: (_e, ctx) => errs.push(ctx),
  });
  return { guarded, store, errs };
}

describe('GuardedProjectionIndex — fail-soft over a poison record', () => {
  it('a throwing projector is caught, reported, and skipped (loop survives)', async () => {
    const { guarded, store, errs } = build();
    expect(await guarded.applyChange({ op: 'upsert', sourceId: 'good1', record: { id: 'good1', topic: 'T', text: 'a' } })).toBe(true);
    // poison: projector throws — guarded swallows + reports, returns false
    expect(await guarded.applyChange({ op: 'upsert', sourceId: 'BAD1', record: { id: 'BAD1', topic: 'T', text: 'x' } })).toBe(false);
    // the loop survives: a subsequent good record still indexes
    expect(await guarded.applyChange({ op: 'upsert', sourceId: 'good2', record: { id: 'good2', topic: 'T', text: 'b' } })).toBe(true);

    expect(errs).toEqual([{ sourceId: 'BAD1', op: 'applyChange' }]);
    const entries = await store.byKey('T');
    expect(entries.map((e) => e.entryId).sort()).toEqual(['good1', 'good2']); // poison absent
  });

  it('guards a store error during index too', async () => {
    const store = new InMemoryProjectionStore<string>();
    vi.spyOn(store, 'applyDelta').mockRejectedValueOnce(new Error('store down'));
    const inner = new ProjectionIndex<Doc, string>({ projector, store });
    const errs: string[] = [];
    const guarded = new GuardedProjectionIndex(inner, { onError: (_e, c) => errs.push(c.op) });
    expect(await guarded.index('s1', { id: 's1', topic: 'T', text: 'v' })).toBe(false);
    expect(errs).toEqual(['index']);
  });

  it('uses console.error by default but does not rethrow', async () => {
    const store = new InMemoryProjectionStore<string>();
    const inner = new ProjectionIndex<Doc, string>({ projector, store });
    const guarded = new GuardedProjectionIndex(inner);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await guarded.applyChange({ op: 'upsert', sourceId: 'BADx', record: { id: 'BADx', topic: 'T', text: 'x' } });
    expect(ok).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('query passes straight through (reads need no guard)', async () => {
    const { guarded } = build();
    await guarded.applyChange({ op: 'upsert', sourceId: 'q1', record: { id: 'q1', topic: 'Q', text: 'hi' } });
    const res = await guarded.query('Q');
    expect(res.map((e) => e.entry)).toEqual(['hi']);
  });

  it('remove is guarded and returns true on success', async () => {
    const { guarded, store } = build();
    await guarded.applyChange({ op: 'upsert', sourceId: 'r1', record: { id: 'r1', topic: 'R', text: 'v' } });
    expect(await guarded.remove('r1')).toBe(true);
    expect(await store.byKey('R')).toEqual([]);
  });
});
