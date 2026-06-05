/**
 * linkable.test.ts — runs the LinkableStore conformance suite against the
 * in-memory double (the swappability proof; a persistent backend runs the SAME
 * suite via the `./conformance` subpath), plus the Taggable-rides-Linkable
 * behaviour over the in-memory store.
 */

import { describe, expect, it } from 'vitest';
import { describeLinkableStoreConformance } from './conformance';
import { InMemoryLinkStore, InMemoryTaggableStore } from './memory-store';
import type { ObjectRef } from './types';

describeLinkableStoreConformance('InMemoryLinkStore', () => new InMemoryLinkStore());

describe('LinkBackedTaggable over InMemoryLinkStore', () => {
  const ts = '2026-01-01T00:00:00.000Z';

  it('addTag/listTags/listTagged round-trip; tags ride the link store as object→topic edges', async () => {
    const links = new InMemoryLinkStore();
    const tags = new InMemoryTaggableStore(links);
    const obj: ObjectRef = { kind: 'issue', ref: 'i1' };

    await tags.addTag(obj, 'alpha', { created_ts: ts });
    await tags.addTag(obj, 'alpha', { created_ts: ts }); // idempotent
    await tags.addTag(obj, 'beta', { created_ts: ts });

    expect(await tags.listTags(obj)).toEqual(['alpha', 'beta']);
    expect(await tags.listTagged('alpha')).toEqual([obj]);

    // A tag is literally a `tagged` edge to a {kind:'topic'} node.
    const out = await links.listOut(obj, { rel: 'tagged' });
    expect(out.map((l) => l.dst)).toEqual([
      { kind: 'topic', ref: 'alpha' },
      { kind: 'topic', ref: 'beta' },
    ]);
  });

  it('removeTag deletes only that tag', async () => {
    const links = new InMemoryLinkStore();
    const tags = new InMemoryTaggableStore(links);
    const obj: ObjectRef = { kind: 'feature', ref: 'f1' };

    await tags.addTag(obj, 'alpha', { created_ts: ts });
    await tags.addTag(obj, 'beta', { created_ts: ts });
    await tags.removeTag(obj, 'alpha');

    expect(await tags.listTags(obj)).toEqual(['beta']);
  });

  it('listTags ignores non-topic out-edges', async () => {
    const links = new InMemoryLinkStore();
    const tags = new InMemoryTaggableStore(links);
    const obj: ObjectRef = { kind: 'issue', ref: 'i2' };

    await tags.addTag(obj, 'alpha', { created_ts: ts });
    // A non-tag edge to a non-topic node must not show up as a tag.
    await links.link(obj, { kind: 'plan', ref: 'p1' }, 'blocks', { created_ts: ts });

    expect(await tags.listTags(obj)).toEqual(['alpha']);
  });
});
