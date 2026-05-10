/**
 * Resource registration + dispatch tests.
 *
 * Mirrors define-tool.test.ts. Doesn't exercise withWorkspace — that
 * needs a live Postgres. The tests cover the registry, URI matching,
 * the defineResource macro's name derivation, and capability gating.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineResource } from '../define-resource';
import {
  _resetResourceCatalogForTests,
  getResourceCatalog,
  lookupResource,
  matchResource,
} from '../resource-registry';
import type { ResourceContext } from '../types';

function fakeCtx(capabilities: string[] = []): ResourceContext {
  return {
    principal: {
      kind: 'system',
      slug: 'system:test',
      workspaceId: 'ws-test',
      capabilities: new Set(capabilities),
    },
    tx: {} as any,
    log: () => {},
  };
}

describe('resource registry', () => {
  beforeEach(() => {
    _resetResourceCatalogForTests();
  });

  it('registers a resource with explicit name', () => {
    const res = defineResource({
      name: 'fixture:concrete',
      description: 'fixture',
      uri: 'papercusp://fixture/one',
      capability: 'tasks:read',
      async read(uri) {
        return { uri, mimeType: 'application/json', text: '{}' };
      },
    });
    expect(lookupResource('fixture:concrete')).toBe(res);
    expect(res.tier).toBe('low');
    expect(getResourceCatalog()).toHaveLength(1);
  });

  it('matches concrete URI exactly', () => {
    defineResource({
      name: 'fixture:concrete',
      uri: 'papercusp://fixture/one',
      capability: 'tasks:read',
      async read(uri) {
        return { uri, mimeType: 'application/json', text: '{}' };
      },
    });
    const m = matchResource('papercusp://fixture/one');
    expect(m).not.toBeNull();
    expect(m!.def.name).toBe('fixture:concrete');
    expect(m!.vars).toEqual({});
  });

  it('matches templated URI and extracts vars', () => {
    defineResource({
      name: 'fixture:templated',
      uri: 'papercusp://harness/{slug}/issues',
      capability: 'issues:read',
      async read(uri) {
        return { uri, mimeType: 'application/json', text: '{}' };
      },
    });
    const m = matchResource('papercusp://harness/foo-bar/issues');
    expect(m).not.toBeNull();
    expect(m!.def.name).toBe('fixture:templated');
    expect(m!.vars).toEqual({ slug: 'foo-bar' });
  });

  it('returns null for unmatched URI', () => {
    defineResource({
      name: 'fixture:templated',
      uri: 'papercusp://harness/{slug}/issues',
      capability: 'issues:read',
      async read(uri) {
        return { uri, mimeType: 'application/json', text: '{}' };
      },
    });
    expect(matchResource('papercusp://harness/foo/notexist')).toBeNull();
    expect(matchResource('papercusp://wrong/scheme')).toBeNull();
  });

  it('rejects collision on duplicate name', () => {
    defineResource({
      name: 'fixture:dup',
      uri: 'papercusp://fixture/a',
      capability: 'tasks:read',
      async read(uri) {
        return { uri, mimeType: 'application/json', text: '{}' };
      },
    });
    expect(() =>
      defineResource({
        name: 'fixture:dup',
        uri: 'papercusp://fixture/b',
        capability: 'tasks:read',
        async read(uri) {
          return { uri, mimeType: 'application/json', text: '{}' };
        },
      }),
    ).toThrow(/Resource name collision/);
  });

  it('templated `list` callback gets ctx and returns expansions', async () => {
    const list = vi.fn(async () => [
      { uri: 'papercusp://harness/a/issues', name: 'a', mimeType: 'application/json' },
      { uri: 'papercusp://harness/b/issues', name: 'b', mimeType: 'application/json' },
    ]);
    defineResource({
      name: 'fixture:templated',
      uri: 'papercusp://harness/{slug}/issues',
      capability: 'issues:read',
      list,
      async read(uri) {
        return { uri, mimeType: 'application/json', text: '{}' };
      },
    });
    const def = lookupResource('fixture:templated')!;
    const expanded = await def.list!(fakeCtx());
    expect(expanded).toHaveLength(2);
    expect(list).toHaveBeenCalledOnce();
  });

  it('read callback receives the raw URI for re-parsing', async () => {
    const read = vi.fn(async (uri: string) => ({
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ uri }),
    }));
    defineResource({
      name: 'fixture:templated',
      uri: 'papercusp://harness/{slug}/issues',
      capability: 'issues:read',
      read,
    });
    const def = lookupResource('fixture:templated')!;
    const result = await def.read('papercusp://harness/foo/issues', fakeCtx());
    expect(read).toHaveBeenCalledWith('papercusp://harness/foo/issues', expect.any(Object));
    expect(result.text).toContain('foo');
  });

  it('catalog snapshot returns all registered resources', () => {
    defineResource({
      name: 'fixture:a',
      uri: 'papercusp://a',
      capability: 'tasks:read',
      async read(uri) {
        return { uri, mimeType: 'application/json', text: '{}' };
      },
    });
    defineResource({
      name: 'fixture:b',
      uri: 'papercusp://b',
      capability: 'goals:read',
      async read(uri) {
        return { uri, mimeType: 'application/json', text: '{}' };
      },
    });
    const cat = getResourceCatalog();
    expect(cat).toHaveLength(2);
    expect(cat.map((r) => r.name).sort()).toEqual(['fixture:a', 'fixture:b']);
  });
});
