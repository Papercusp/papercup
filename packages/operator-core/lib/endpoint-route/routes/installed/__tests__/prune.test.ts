/**
 * Tests for the registry-prune logic. The 2026-04-30 snapshot E2E test
 * surfaced 11 fork entries in the harness registry but only 2 dirs on disk
 * — registry doesn't get pruned when an operator deletes a forked project.
 *
 * We test the pure `pruneRegistry` helper with an injected exists-check, so
 * the test doesn't depend on the real filesystem or env. The route's
 * fs/network glue is one thin layer of read-prune-write on top.
 */
import { describe, it, expect } from 'vitest';
import { pruneRegistry } from '../prune';

const reg = (...slugs: string[]) => ({
  projects: slugs.map((s) => ({ slug: s, path: `/fake/${s}` })),
});

const existsOnly = (...alive: string[]) => (path: string): boolean =>
  alive.some((s) => path.endsWith(`/${s}`));

describe('pruneRegistry', () => {
  it('removes entries whose path does not exist; keeps the others', () => {
    const r = pruneRegistry(
      reg('real', 'gone1', 'gone2'),
      {},
      existsOnly('real'),
    );
    expect(r.removed.sort()).toEqual(['gone1', 'gone2']);
    expect(r.kept.map((p) => p.slug)).toEqual(['real']);
  });

  it('all-stale registry → all removed', () => {
    const r = pruneRegistry(reg('a', 'b', 'c'), {}, () => false);
    expect(r.removed.sort()).toEqual(['a', 'b', 'c']);
    expect(r.kept).toEqual([]);
  });

  it('all-alive registry → no-op', () => {
    const r = pruneRegistry(reg('a', 'b'), {}, () => true);
    expect(r.removed).toEqual([]);
    expect(r.kept.map((p) => p.slug)).toEqual(['a', 'b']);
  });

  it('with slugs[]: only the named stale slugs are removed', () => {
    const r = pruneRegistry(
      reg('gone1', 'gone2', 'gone3'),
      { slugs: ['gone1', 'gone3'] },
      () => false,
    );
    expect(r.removed.sort()).toEqual(['gone1', 'gone3']);
    expect(r.kept.map((p) => p.slug)).toEqual(['gone2']);
  });

  it('with slugs[]: alive entries in the slug list are NOT removed', () => {
    // User says "prune real and gone" — but real exists, so it stays.
    const r = pruneRegistry(
      reg('real', 'gone'),
      { slugs: ['real', 'gone'] },
      existsOnly('real'),
    );
    expect(r.removed).toEqual(['gone']);
    expect(r.kept.map((p) => p.slug)).toEqual(['real']);
  });

  it('with empty slugs[]: treated as "no restriction" (prunes all stale)', () => {
    const r = pruneRegistry(
      reg('a', 'b'),
      { slugs: [] },
      () => false,
    );
    expect(r.removed.sort()).toEqual(['a', 'b']);
  });

  it('preserves project metadata (harnessKind, addedAt) on kept entries', () => {
    const input = {
      projects: [
        { slug: 'a', path: '/fake/a', harnessKind: 'coding', addedAt: '2026-04-30' },
        { slug: 'gone', path: '/fake/gone' },
      ],
    };
    const r = pruneRegistry(input, {}, existsOnly('a'));
    expect(r.kept).toEqual([
      { slug: 'a', path: '/fake/a', harnessKind: 'coding', addedAt: '2026-04-30' },
    ]);
  });

  it('empty registry → empty result', () => {
    const r = pruneRegistry({ projects: [] }, {}, () => true);
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual([]);
  });

  it('idempotent: running twice on a kept-only registry stays a no-op', () => {
    const first = pruneRegistry(reg('a'), {}, () => true);
    const second = pruneRegistry({ projects: first.kept }, {}, () => true);
    expect(second.removed).toEqual([]);
    expect(second.kept.map((p) => p.slug)).toEqual(['a']);
  });
});
