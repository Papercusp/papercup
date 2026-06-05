/**
 * End-to-end projection maintenance: rationaleProjector + ProjectionIndex +
 * InMemoryProjectionStore, plus the service read path (queryTopic) over an injected
 * in-memory index. Proves the index converges on add / edit / retag / remove WITHOUT
 * the caller ever computing a diff — the D-003 invariant.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectionIndex, InMemoryProjectionStore } from '@papercusp/projection-index';
import { rationaleProjector } from './projector';
import { sourceIdOf, type RationaleEntry, type RationaleSource } from './types';
import { queryTopic, __setRationaleIndexForTests } from './service';

function freshIndex() {
  return new ProjectionIndex<RationaleSource, RationaleEntry>({
    projector: rationaleProjector,
    store: new InMemoryProjectionStore<RationaleEntry>(),
  });
}

const planV1: RationaleSource = {
  kind: 'plan',
  slug: 'p',
  topics: ['coordination-substrate'],
  decisions: [{ id: 'D-001', title: 'First', body: 'Body one.', date: '2026-06-01' }],
};

describe('ProjectionIndex + rationaleProjector', () => {
  it('indexes a plan and queries its decisions by topic', async () => {
    const idx = freshIndex();
    await idx.index(sourceIdOf(planV1), planV1);
    const rows = await idx.query('coordination-substrate');
    expect(rows.map((r) => r.entryId)).toEqual(['D-001']);
    expect(rows[0]!.entry.ref).toBe('D-001 @ p');
  });

  it('adding a decision adds an entry; the prior one is untouched', async () => {
    const idx = freshIndex();
    await idx.index(sourceIdOf(planV1), planV1);
    const planV2: RationaleSource = {
      ...planV1,
      decisions: [
        ...planV1.decisions,
        { id: 'D-002', title: 'Second', body: 'Body two.', date: '2026-06-02' },
      ],
    } as RationaleSource;
    await idx.index(sourceIdOf(planV2), planV2);
    const rows = await idx.query('coordination-substrate', { order: 'asc' });
    expect(rows.map((r) => r.entryId)).toEqual(['D-001', 'D-002']);
  });

  it('retagging a plan to a new topic moves its decisions; the old topic empties', async () => {
    const idx = freshIndex();
    await idx.index(sourceIdOf(planV1), planV1);
    const retagged: RationaleSource = { ...planV1, topics: ['db-tooling'] } as RationaleSource;
    await idx.index(sourceIdOf(retagged), retagged);
    expect(await idx.query('coordination-substrate')).toEqual([]);
    expect((await idx.query('db-tooling')).map((r) => r.entryId)).toEqual(['D-001']);
  });

  it('removing a source drops all its entries', async () => {
    const idx = freshIndex();
    await idx.index(sourceIdOf(planV1), planV1);
    await idx.remove(sourceIdOf(planV1));
    expect(await idx.query('coordination-substrate')).toEqual([]);
  });

  it('aggregates decisions + work-items + insights under one topic', async () => {
    const idx = freshIndex();
    const wi: RationaleSource = {
      kind: 'work_item',
      id: 'WI-9',
      title: 'wi',
      summary: 's',
      state: 'open',
      topics: ['coordination-substrate'],
      createdAt: '2026-06-03',
    };
    const insight: RationaleSource = {
      kind: 'insight',
      slug: 'i',
      title: 'ins',
      description: 'd',
      tags: ['coordination-substrate'],
    };
    await idx.index(sourceIdOf(planV1), planV1);
    await idx.index(sourceIdOf(wi), wi);
    await idx.index(sourceIdOf(insight), insight);
    const kinds = (await idx.query('coordination-substrate')).map((r) => r.kind).sort();
    expect(kinds).toEqual(['decision', 'insight', 'work_item']);
  });

  it('kinds filter + limit narrow a topic feed', async () => {
    const idx = freshIndex();
    const wi: RationaleSource = {
      kind: 'work_item', id: 'WI-9', title: 'wi', summary: 's', state: 'open',
      topics: ['coordination-substrate'], createdAt: '2026-06-03',
    };
    await idx.index(sourceIdOf(planV1), planV1);
    await idx.index(sourceIdOf(wi), wi);
    const onlyWork = await idx.query('coordination-substrate', { kinds: ['work_item'] });
    expect(onlyWork.map((r) => r.entryId)).toEqual(['WI-9']);
    const capped = await idx.query('coordination-substrate', { limit: 1 });
    expect(capped).toHaveLength(1);
  });
});

describe('service.queryTopic over an injected in-memory index', () => {
  beforeEach(() => __setRationaleIndexForTests(freshIndex()));
  afterEach(() => __setRationaleIndexForTests(null));

  it('reads through the service read path', async () => {
    const { getRationaleIndex } = await import('./service');
    await getRationaleIndex().index(sourceIdOf(planV1), planV1);
    const rows = await queryTopic('coordination-substrate');
    expect(rows.map((r) => r.entry.ref)).toEqual(['D-001 @ p']);
  });
});
