import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// In-memory stand-in for the PG override store, keyed "ws|slug|role".
let store: Map<string, string>;
const k = (w: string, s: string, r: string) => `${w}|${s}|${r}`;

vi.mock('./harness-prompt-overrides', () => ({
  getPromptOverride: vi.fn(async (w: string, s: string, r: string) => store.get(k(w, s, r)) ?? null),
  setPromptOverride: vi.fn(async (w: string, s: string, r: string, md: string) => { store.set(k(w, s, r), md); }),
  deletePromptOverride: vi.fn(async (w: string, s: string, r: string) => {
    const had = store.has(k(w, s, r));
    store.delete(k(w, s, r));
    return had;
  }),
  listPromptOverrides: vi.fn(async (w: string, s: string) =>
    [...store.entries()]
      .filter(([key]) => key.startsWith(`${w}|${s}|`))
      .map(([key, promptMd]) => ({ role: key.split('|')[2], promptMd, updatedAt: 0 })),
  ),
}));

import {
  resolveHarnessPromptOverride,
  seedPromptOverridesFromRepo,
  resetPromptOverrideToDefault,
  resetAllPromptOverridesToDefault,
  listSeedRoles,
  readSeedPrompt,
} from './harness-prompt-resolve';

const WS = 'ws1';
const SLUG = 'sheets';
let harnessPath: string;
const roots: string[] = [];

function makeHarness(seeds: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hpr-'));
  roots.push(root);
  if (Object.keys(seeds).length > 0) {
    const pdir = join(root, '.harness', 'prompts');
    mkdirSync(pdir, { recursive: true });
    for (const [role, md] of Object.entries(seeds)) writeFileSync(join(pdir, `${role}.md`), md);
  }
  return root;
}

beforeEach(() => { store = new Map(); });
afterEach(() => vi.clearAllMocks());
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe('seed file helpers', () => {
  it('lists only roles with a .md seed, sorted', () => {
    harnessPath = makeHarness({ worker: '# w', scoper: '# s' });
    expect(listSeedRoles(harnessPath)).toEqual(['scoper', 'worker']);
  });
  it('returns null when the harness ships no prompts dir', () => {
    harnessPath = makeHarness({});
    expect(listSeedRoles(harnessPath)).toEqual([]);
    expect(readSeedPrompt(harnessPath, 'worker')).toBeNull();
  });
});

describe('resolveHarnessPromptOverride (3-tier override layer)', () => {
  it('prefers the PG store value', async () => {
    harnessPath = makeHarness({ worker: '# repo seed' });
    store.set(k(WS, SLUG, 'worker'), '# workspace edit');
    expect(await resolveHarnessPromptOverride(WS, SLUG, 'worker', harnessPath)).toBe('# workspace edit');
  });
  it('falls back to the repo seed when the store is empty (regression-safe)', async () => {
    harnessPath = makeHarness({ worker: '# repo seed' });
    expect(await resolveHarnessPromptOverride(WS, SLUG, 'worker', harnessPath)).toBe('# repo seed');
  });
  it('returns null when neither store nor seed has it', async () => {
    harnessPath = makeHarness({});
    expect(await resolveHarnessPromptOverride(WS, SLUG, 'validator', harnessPath)).toBeNull();
  });
});

describe('seedPromptOverridesFromRepo (D-6 seed on install)', () => {
  it('imports all repo seeds into the store', async () => {
    harnessPath = makeHarness({ worker: '# w', scoper: '# s' });
    const r = await seedPromptOverridesFromRepo(WS, SLUG, harnessPath);
    expect(r.seeded.sort()).toEqual(['scoper', 'worker']);
    expect(store.get(k(WS, SLUG, 'worker'))).toBe('# w');
  });
  it('skips roles that already have a workspace override (no clobber)', async () => {
    harnessPath = makeHarness({ worker: '# repo', scoper: '# s' });
    store.set(k(WS, SLUG, 'worker'), '# my edit');
    const r = await seedPromptOverridesFromRepo(WS, SLUG, harnessPath);
    expect(r.seeded).toEqual(['scoper']);
    expect(r.skipped).toEqual(['worker']);
    expect(store.get(k(WS, SLUG, 'worker'))).toBe('# my edit'); // preserved
  });
  it('overwrites when forced', async () => {
    harnessPath = makeHarness({ worker: '# repo' });
    store.set(k(WS, SLUG, 'worker'), '# my edit');
    await seedPromptOverridesFromRepo(WS, SLUG, harnessPath, { overwrite: true });
    expect(store.get(k(WS, SLUG, 'worker'))).toBe('# repo');
  });
});

describe('reset-to-default (D-6 reset buttons)', () => {
  it('restores one role from the repo seed', async () => {
    harnessPath = makeHarness({ worker: '# repo default' });
    store.set(k(WS, SLUG, 'worker'), '# edited');
    const r = await resetPromptOverrideToDefault(WS, SLUG, 'worker', harnessPath);
    expect(r).toMatchObject({ restoredFromSeed: true });
    expect(store.get(k(WS, SLUG, 'worker'))).toBe('# repo default');
  });
  it('clears the override when the harness ships no seed for the role', async () => {
    harnessPath = makeHarness({});
    store.set(k(WS, SLUG, 'worker'), '# orphan edit');
    const r = await resetPromptOverrideToDefault(WS, SLUG, 'worker', harnessPath);
    expect(r).toMatchObject({ restoredFromSeed: false, cleared: true });
    expect(store.has(k(WS, SLUG, 'worker'))).toBe(false);
  });
  it('reset-all covers the union of seeded + overridden roles', async () => {
    harnessPath = makeHarness({ worker: '# w', scoper: '# s' });
    store.set(k(WS, SLUG, 'validator'), '# stray'); // overridden but no seed
    const r = await resetAllPromptOverridesToDefault(WS, SLUG, harnessPath);
    expect(r.reset).toEqual(['scoper', 'validator', 'worker']);
    expect(store.get(k(WS, SLUG, 'worker'))).toBe('# w');
    expect(store.get(k(WS, SLUG, 'scoper'))).toBe('# s');
    expect(store.has(k(WS, SLUG, 'validator'))).toBe(false); // cleared (no seed)
  });
});
