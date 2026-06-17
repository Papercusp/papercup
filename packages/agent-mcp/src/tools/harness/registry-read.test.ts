/**
 * readRegistryProjects — direct unit on the JSONB-payload parser (Gap 13).
 *
 * This is the guard that turns the single `harness_shared.harness_registry`
 * JSONB row into a clean `RegistryProject[]`. harness:list / harness:status
 * lean on it, but those tests cover it only incidentally; here we stub a
 * `SqlLike` tag and drive every payload shape directly:
 *   - no row → []
 *   - row with payload:null → []
 *   - payload present but `projects` not an array (corrupt) → []
 *   - a mixed `projects` array → only object entries WITH a string slug
 *     survive; an entry with `path` but no slug, a bare string, null, and a
 *     number are all dropped
 *   - well-formed entries pass through preserving path + harness_kind
 *   - the workspaceId is bound into the query
 */

import { describe, expect, it } from 'vitest';
import { readRegistryProjects, type SqlLike } from './registry-read';

/** A SqlLike stub that returns a fixed row set and records the bound values. */
function stubTx(rows: unknown[]): { tx: SqlLike; values: unknown[] } {
  const values: unknown[] = [];
  const tx = ((_strings: TemplateStringsArray, ...vals: unknown[]) => {
    values.push(...vals);
    return Promise.resolve(rows);
  }) as SqlLike;
  return { tx, values };
}

describe('readRegistryProjects — empty / corrupt payloads (Gap 13)', () => {
  it('no registry row → []', async () => {
    const { tx } = stubTx([]);
    expect(await readRegistryProjects(tx, 'ws-1')).toEqual([]);
  });

  it('row with payload:null → []', async () => {
    const { tx } = stubTx([{ payload: null }]);
    expect(await readRegistryProjects(tx, 'ws-1')).toEqual([]);
  });

  it('payload with a non-array `projects` (corrupt) → []', async () => {
    const { tx } = stubTx([{ payload: { projects: 'corrupt' } }]);
    expect(await readRegistryProjects(tx, 'ws-1')).toEqual([]);
  });

  it('payload that is an object but lacks `projects` → []', async () => {
    const { tx } = stubTx([{ payload: { other: 1 } }]);
    expect(await readRegistryProjects(tx, 'ws-1')).toEqual([]);
  });
});

describe('readRegistryProjects — entry filtering (Gap 13)', () => {
  it('keeps only object entries with a string slug; drops path-only/junk/null/number', async () => {
    const { tx } = stubTx([
      { payload: { projects: [{ slug: 'ok', path: '/ok' }, { path: 'x' }, 'junk', null, 42] } },
    ]);
    const out = await readRegistryProjects(tx, 'ws-1');
    expect(out).toEqual([{ slug: 'ok', path: '/ok' }]);
  });

  it('well-formed entries pass through preserving path + harness_kind', async () => {
    const projects = [
      { slug: 'sheets', path: '/repo/sheets', harness_kind: 'repo' },
      { slug: 'docs', path: '/repo/docs', harness_kind: 'wiki' },
    ];
    const { tx } = stubTx([{ payload: { projects } }]);
    const out = await readRegistryProjects(tx, 'ws-1');
    expect(out).toEqual(projects);
    expect(out[0].harness_kind).toBe('repo');
    expect(out[1].path).toBe('/repo/docs');
  });

  it('an empty projects array → []', async () => {
    const { tx } = stubTx([{ payload: { projects: [] } }]);
    expect(await readRegistryProjects(tx, 'ws-1')).toEqual([]);
  });
});

describe('readRegistryProjects — query binding (Gap 13)', () => {
  it('binds the workspaceId into the registry query', async () => {
    const { tx, values } = stubTx([]);
    await readRegistryProjects(tx, 'workspace-xyz');
    expect(values).toContain('workspace-xyz');
  });
});
