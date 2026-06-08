/**
 * Tests for LinkBackedTaggable — tags as `object →tagged→ {kind:'topic'}` edges,
 * over the InMemoryLinkStore test double.
 * Run with: npx vitest run libs/generic/linkable-edges/src/taggable.test.ts
 */
import { describe, expect, it } from 'vitest';
import { LinkBackedTaggable } from './taggable';
import { InMemoryLinkStore } from './memory-store';
import { objectKey, TAG_REL, type ObjectRef } from './types';

const A: ObjectRef = { kind: 'feature', ref: 'F-1' };
const B: ObjectRef = { kind: 'issue', ref: 'I-9' };
const make = () => {
  const store = new InMemoryLinkStore();
  return { store, tag: new LinkBackedTaggable(store) };
};
const at = (n: number) => ({ created_ts: `2026-01-01T00:00:0${n}.000Z` });

describe('addTag / listTags / removeTag', () => {
  it('lists tags oldest-first by created_ts', async () => {
    const { tag } = make();
    await tag.addTag(A, 'security', at(1));
    await tag.addTag(A, 'perf', at(2));
    expect(await tag.listTags(A)).toEqual(['security', 'perf']);
  });

  it('removeTag drops a single tag (idempotently)', async () => {
    const { tag } = make();
    await tag.addTag(A, 'security', at(1));
    await tag.addTag(A, 'perf', at(2));
    await tag.removeTag(A, 'security');
    await tag.removeTag(A, 'security'); // idempotent
    expect(await tag.listTags(A)).toEqual(['perf']);
  });

  it('listTags ignores non-topic edges that share the tagged relation', async () => {
    const { store, tag } = make();
    await tag.addTag(A, 'security', at(1));
    // A non-topic edge on the same rel — must be filtered out of tag listing.
    await store.link(A, { kind: 'feature', ref: 'F-2' }, TAG_REL, at(2));
    expect(await tag.listTags(A)).toEqual(['security']);
  });
});

describe('listTagged (reverse lookup)', () => {
  it('returns every object tagged with a topic', async () => {
    const { tag } = make();
    await tag.addTag(A, 'security', at(1));
    await tag.addTag(B, 'security', at(2));
    await tag.addTag(A, 'perf', at(3));
    expect(await tag.listTagged('security')).toEqual([A, B]);
    expect(await tag.listTagged('none')).toEqual([]);
  });
});

describe('listTagsForMany (batch)', () => {
  it('groups tags by objectKey in one round-trip', async () => {
    const { tag } = make();
    await tag.addTag(A, 'security', at(1));
    await tag.addTag(A, 'perf', at(2));
    await tag.addTag(B, 'infra', at(3));
    const map = await tag.listTagsForMany([A, B]);
    expect(map.get(objectKey(A))).toEqual(['security', 'perf']);
    expect(map.get(objectKey(B))).toEqual(['infra']);
  });

  it('omits objects with no tags and returns an empty map for no objects', async () => {
    const { tag } = make();
    await tag.addTag(A, 'x', at(1));
    const map = await tag.listTagsForMany([A, B]);
    expect(map.has(objectKey(B))).toBe(false);
    expect(await tag.listTagsForMany([])).toEqual(new Map());
  });
});
