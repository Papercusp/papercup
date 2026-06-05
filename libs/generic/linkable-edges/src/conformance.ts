/**
 * linkable-edges/conformance.ts — the ONE contract suite for LinkableStore, so
 * every backend (the in-memory double + any persistent store) proves
 * swappability against the SAME assertions. Imports vitest, so it lives behind
 * the dedicated `@papercusp/linkable-edges/conformance` subpath, NOT the package
 * barrel.
 *
 * Cases mint unique ids per run (a `runPrefix`) so the suite is safe against a
 * SHARED live table without a cleanup hook — every query filters by an id that
 * no other run uses.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { type LinkableStore, type ObjectRef } from './types';

function prefix(tag: string): { runPrefix: string; uid: () => string } {
  const runPrefix = `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let n = 0;
  return { runPrefix, uid: () => `${runPrefix}-${n++}` };
}

export function describeLinkableStoreConformance(
  name: string,
  makeStore: () => LinkableStore,
  opts: { ready?: () => Promise<boolean> } = {},
): void {
  describe(`LinkableStore conformance — ${name}`, () => {
    let skip = false;
    const { uid } = prefix('linkconf');
    beforeAll(async () => {
      if (opts.ready) skip = !(await opts.ready());
    });

    it('link is idempotent; listOut + listIn find the edge; rel filter works', async () => {
      if (skip) return;
      const store = makeStore();
      const src: ObjectRef = { kind: 'issue', ref: uid() };
      const dst: ObjectRef = { kind: 'plan', ref: uid() };
      await store.link(src, dst, 'blocks', { created_by: 'me', created_ts: '2026-01-01T00:00:00.000Z' });
      await store.link(src, dst, 'blocks', { created_ts: '2026-01-02T00:00:00.000Z' }); // dup → no-op
      const out = await store.listOut(src);
      expect(out).toHaveLength(1);
      expect(out[0].dst).toEqual(dst);
      expect(out[0].rel).toBe('blocks');
      expect(await store.listIn(dst)).toHaveLength(1);
      expect(await store.listOut(src, { rel: 'relates' })).toEqual([]);
      expect(await store.listOut(src, { rel: 'blocks' })).toHaveLength(1);
    });

    it('unlink removes the edge (idempotent)', async () => {
      if (skip) return;
      const store = makeStore();
      const src: ObjectRef = { kind: 'feature', ref: uid() };
      const dst: ObjectRef = { kind: 'topic', ref: uid() };
      await store.link(src, dst, 'tagged', { created_ts: '2026-01-01T00:00:00.000Z' });
      await store.unlink(src, dst, 'tagged');
      await store.unlink(src, dst, 'tagged'); // idempotent
      expect(await store.listOut(src)).toEqual([]);
    });
  });
}
