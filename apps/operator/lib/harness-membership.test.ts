import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessRegistry, ProjectEntry } from './harness-registry';

// In-memory per-workspace registries the mocked load/save operate on.
let registries: Record<string, ProjectEntry[]>;
const saveCalls: Array<{ ws: string; slugs: string[]; allowEmpty: boolean }> = [];

vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async (ws?: string): Promise<HarnessRegistry> => ({
    projects: [...(registries[ws ?? 'default'] ?? [])],
  })),
  saveHarnessRegistry: vi.fn(
    async (reg: HarnessRegistry, ws?: string, opts?: { allowEmpty?: boolean }) => {
      const id = ws ?? 'default';
      if (reg.projects.length === 0 && (registries[id]?.length ?? 0) > 0 && !opts?.allowEmpty) {
        throw new Error('saveHarnessRegistry refused: emptying without allowEmpty');
      }
      registries[id] = [...reg.projects];
      saveCalls.push({ ws: id, slugs: reg.projects.map((p) => p.slug), allowEmpty: !!opts?.allowEmpty });
    },
  ),
}));

vi.mock('./workspace-registry', () => ({
  readRegistry: vi.fn(() => ({
    current: 'default',
    workspaces: [{ id: 'default' }, { id: 'papercusp-workspace' }, { id: 'scratch' }],
  })),
}));

import {
  addHarnessToWorkspace,
  removeHarnessFromWorkspace,
  moveHarness,
  workspacesForHarness,
} from './harness-membership';

const entry = (slug: string, path: string): ProjectEntry => ({ slug, path, harness_kind: 'coding' });

beforeEach(() => {
  registries = {
    default: [entry('sheets', '/home/u/sheets'), entry('restart', '/home/u/Restart')],
    'papercusp-workspace': [entry('papercup', '/home/u/papercup')],
    scratch: [],
  };
  saveCalls.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe('workspacesForHarness', () => {
  it('lists every workspace whose registry carries the slug', async () => {
    expect(await workspacesForHarness('restart')).toEqual(['default']);
    expect(await workspacesForHarness('papercup')).toEqual(['papercusp-workspace']);
    expect(await workspacesForHarness('nope')).toEqual([]);
  });

  it('reports a slug present in multiple workspaces', async () => {
    registries['papercusp-workspace'].push(entry('restart', '/home/u/Restart'));
    expect(await workspacesForHarness('restart')).toEqual(['default', 'papercusp-workspace']);
  });
});

describe('addHarnessToWorkspace', () => {
  it('adds a new entry and reports changed', async () => {
    const r = await addHarnessToWorkspace('papercusp-workspace', entry('restart', '/home/u/Restart'));
    expect(r).toEqual({ workspaceId: 'papercusp-workspace', slug: 'restart', changed: true });
    expect(registries['papercusp-workspace'].map((p) => p.slug)).toContain('restart');
  });

  it('is a no-op when the slug is already present', async () => {
    const r = await addHarnessToWorkspace('default', entry('restart', '/elsewhere'));
    expect(r.changed).toBe(false);
    // path is NOT overwritten on a no-op add
    expect(registries.default.find((p) => p.slug === 'restart')?.path).toBe('/home/u/Restart');
  });

  it('adds the first harness to an empty workspace', async () => {
    const r = await addHarnessToWorkspace('scratch', entry('x', '/home/u/x'));
    expect(r.changed).toBe(true);
    expect(registries.scratch.map((p) => p.slug)).toEqual(['x']);
  });
});

describe('removeHarnessFromWorkspace', () => {
  it('removes an entry and reports changed', async () => {
    const r = await removeHarnessFromWorkspace('default', 'restart');
    expect(r.changed).toBe(true);
    expect(registries.default.map((p) => p.slug)).toEqual(['sheets']);
  });

  it('is a no-op when the slug is absent', async () => {
    const r = await removeHarnessFromWorkspace('default', 'nope');
    expect(r.changed).toBe(false);
    expect(saveCalls).toHaveLength(0);
  });

  it('allows removing the last harness (passes allowEmpty)', async () => {
    await removeHarnessFromWorkspace('papercusp-workspace', 'papercup');
    expect(registries['papercusp-workspace']).toEqual([]);
    expect(saveCalls.at(-1)?.allowEmpty).toBe(true);
  });
});

describe('moveHarness', () => {
  it('carries the entry to the destination and removes it from the source', async () => {
    const { from, to } = await moveHarness('restart', 'default', 'papercusp-workspace');
    expect(to.changed).toBe(true);
    expect(from.changed).toBe(true);
    expect(registries.default.map((p) => p.slug)).toEqual(['sheets']);
    const moved = registries['papercusp-workspace'].find((p) => p.slug === 'restart');
    expect(moved?.path).toBe('/home/u/Restart'); // same path = link preserved
  });

  it('adds to destination BEFORE removing from source (crash-safe ordering)', async () => {
    await moveHarness('restart', 'default', 'papercusp-workspace');
    const addIdx = saveCalls.findIndex((c) => c.ws === 'papercusp-workspace');
    const removeIdx = saveCalls.findIndex((c) => c.ws === 'default');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeLessThan(removeIdx);
  });

  it('throws if the harness is not in the source workspace', async () => {
    await expect(moveHarness('papercup', 'default', 'scratch')).rejects.toThrow(/not registered/);
  });

  it('throws if source and destination are the same', async () => {
    await expect(moveHarness('restart', 'default', 'default')).rejects.toThrow(/same/);
  });
});
