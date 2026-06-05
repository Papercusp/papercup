import { describe, it, expect, vi } from 'vitest';
import { ProjectionIndex } from './projection-index';
import { InMemoryProjectionStore } from './in-memory-store';
import type { Contribution, ProjectionStore } from './types';

// ---------------------------------------------------------------------------
// The keystone scenario: a topic-keyed projection over plans+decisions, exactly
// the shape docs-and-memory-as-projections-2026-06-05 D-003 needs — query a
// subsystem-topic, get its decisions, kept fresh as plans change. The lib is
// generic; this is one worked mapping.
// ---------------------------------------------------------------------------

interface Plan {
  topics: string[];
  decisions: Array<{ id: string; title: string }>;
}

type Entry =
  | { kind: 'plan'; planId: string }
  | { kind: 'decision'; planId: string; decisionId: string; title: string };

/** Project a plan into: the plan itself under each topic, + each decision under each topic. */
function projectPlan(planId: string) {
  return (plan: Plan): Contribution<Entry>[] => {
    const out: Contribution<Entry>[] = [];
    for (const topic of plan.topics) {
      out.push({ key: topic, entryId: 'plan', entry: { kind: 'plan', planId }, kind: 'plan' });
      for (const d of plan.decisions) {
        out.push({
          key: topic,
          entryId: `decision:${d.id}`,
          sortKey: d.id,
          kind: 'decision',
          entry: { kind: 'decision', planId, decisionId: d.id, title: d.title },
        });
      }
    }
    return out;
  };
}

/** A ProjectionIndex whose projector is fixed to one plan id (the source id). */
function planIndex(store: ProjectionStore<Entry>, planId: string) {
  return new ProjectionIndex<Plan, Entry>({ projector: projectPlan(planId), store });
}

function decisionIds(rows: Array<{ entry: Entry }>): string[] {
  return rows
    .map((r) => r.entry)
    .filter((e): e is Extract<Entry, { kind: 'decision' }> => e.kind === 'decision')
    .map((e) => e.decisionId);
}

describe('ProjectionIndex — topics over plans (keystone)', () => {
  it('indexes a plan and queries decisions by topic', async () => {
    const store = new InMemoryProjectionStore<Entry>();
    const p1 = planIndex(store, 'p1');
    await p1.index('p1', { topics: ['coord', 'fleet'], decisions: [{ id: 'D-001', title: 'a' }, { id: 'D-002', title: 'b' }] });

    expect(decisionIds(await p1.query('coord', { kinds: ['decision'] }))).toEqual(['D-001', 'D-002']);
    expect(decisionIds(await p1.query('fleet', { kinds: ['decision'] }))).toEqual(['D-001', 'D-002']);
    // the plan entry aggregates under each topic too
    expect((await p1.query('coord', { kinds: ['plan'] })).map((r) => r.entry)).toEqual([
      { kind: 'plan', planId: 'p1' },
    ]);
  });

  it('aggregates multiple sources (plans) under one topic', async () => {
    const store = new InMemoryProjectionStore<Entry>();
    await planIndex(store, 'p1').index('p1', { topics: ['coord'], decisions: [{ id: 'D-001', title: 'a' }] });
    await planIndex(store, 'p2').index('p2', { topics: ['coord'], decisions: [{ id: 'D-009', title: 'z' }] });

    const rows = await store.byKey('coord', { kinds: ['decision'] });
    expect(decisionIds(rows)).toEqual(['D-001', 'D-009']);
    expect(rows.map((r) => (r.entry as any).planId).sort()).toEqual(['p1', 'p2']);
  });

  it('re-indexing maintains the index: drop, retag, and add in one edit', async () => {
    const store = new InMemoryProjectionStore<Entry>();
    const p1 = planIndex(store, 'p1');
    const p2 = planIndex(store, 'p2');
    await p1.index('p1', { topics: ['coord', 'fleet'], decisions: [{ id: 'D-001', title: 'a' }, { id: 'D-002', title: 'b' }] });
    await p2.index('p2', { topics: ['coord'], decisions: [{ id: 'D-009', title: 'z' }] });

    // Edit p1: drop D-002, retag fleet→infra, add D-003.
    await p1.index('p1', { topics: ['coord', 'infra'], decisions: [{ id: 'D-001', title: 'a' }, { id: 'D-003', title: 'c' }] });

    // coord: p1's decisions are now {D-001,D-003}; p2's D-009 untouched.
    expect(decisionIds(await p1.query('coord', { kinds: ['decision'] }))).toEqual(['D-001', 'D-003', 'D-009']);
    // fleet emptied (retagged away)
    expect(await store.byKey('fleet')).toEqual([]);
    // infra picked up p1
    expect(decisionIds(await store.byKey('infra', { kinds: ['decision'] }))).toEqual(['D-001', 'D-003']);
    // D-002 gone everywhere
    expect(store.keys()).not.toContain('fleet');
  });

  it('remove() drops only the removed source', async () => {
    const store = new InMemoryProjectionStore<Entry>();
    const p1 = planIndex(store, 'p1');
    await p1.index('p1', { topics: ['coord'], decisions: [{ id: 'D-001', title: 'a' }] });
    await planIndex(store, 'p2').index('p2', { topics: ['coord'], decisions: [{ id: 'D-009', title: 'z' }] });

    await p1.remove('p1');
    expect(decisionIds(await store.byKey('coord', { kinds: ['decision'] }))).toEqual(['D-009']);
  });

  it('applyChange routes upsert/delete events (the event-maintenance entry point)', async () => {
    const store = new InMemoryProjectionStore<Entry>();
    const p1 = planIndex(store, 'p1');
    await p1.applyChange({ op: 'upsert', sourceId: 'p1', record: { topics: ['coord'], decisions: [{ id: 'D-001', title: 'a' }] } });
    expect(decisionIds(await p1.query('coord', { kinds: ['decision'] }))).toEqual(['D-001']);
    await p1.applyChange({ op: 'delete', sourceId: 'p1' });
    expect(await p1.query('coord')).toEqual([]);
  });
});

describe('ProjectionIndex — maintenance mechanics', () => {
  it('reindexAll backfills a batch', async () => {
    const store = new InMemoryProjectionStore<Entry>();
    const idx = new ProjectionIndex<Plan, Entry>({ projector: () => [], store });
    // projector ignores the record; use a per-call projector via separate indices instead:
    await planIndex(store, 'a').reindexAll([
      ['a', { topics: ['t'], decisions: [{ id: 'D-1', title: 'x' }] }],
    ]);
    expect(decisionIds(await store.byKey('t', { kinds: ['decision'] }))).toEqual(['D-1']);
    void idx;
  });

  it('a no-op change (record projects to nothing, nothing prior) skips the store write', async () => {
    const store = new InMemoryProjectionStore<Entry>();
    const applyDelta = vi.spyOn(store, 'applyDelta');
    const idx = new ProjectionIndex<Plan, Entry>({ projector: () => [], store });
    await idx.index('empty', { topics: [], decisions: [] });
    expect(applyDelta).not.toHaveBeenCalled();
  });

  it('remove() of an unknown source is a no-op write', async () => {
    const store = new InMemoryProjectionStore<Entry>();
    const applyDelta = vi.spyOn(store, 'applyDelta');
    const idx = new ProjectionIndex<Plan, Entry>({ projector: projectPlan('p'), store });
    await idx.remove('never-indexed');
    expect(applyDelta).not.toHaveBeenCalled();
  });

  it('only uses the injected ProjectionStore seam (contributionsOf/applyDelta/byKey)', async () => {
    // A minimal hand-rolled store proves the index needs nothing beyond the port.
    const rows = new Map<string, any>();
    const calls: string[] = [];
    const store: ProjectionStore<Entry> = {
      async contributionsOf(sourceId) {
        calls.push('contributionsOf');
        return [...rows.values()].filter((r) => r.sourceId === sourceId);
      },
      async applyDelta(_s, delta) {
        calls.push('applyDelta');
        for (const d of delta.delete) rows.delete(`${d.sourceId} ${d.key} ${d.entryId}`);
        for (const p of delta.put) rows.set(`${p.sourceId} ${p.key} ${p.entryId}`, p);
      },
      async byKey(key) {
        calls.push('byKey');
        return [...rows.values()].filter((r) => r.key === key);
      },
    };
    const idx = planIndex(store, 'p1');
    await idx.index('p1', { topics: ['coord'], decisions: [{ id: 'D-001', title: 'a' }] });
    expect(decisionIds(await idx.query('coord'))).toEqual(['D-001']);
    expect(new Set(calls)).toEqual(new Set(['contributionsOf', 'applyDelta', 'byKey']));
  });
});
