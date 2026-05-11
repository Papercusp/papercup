import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface LoadedPlugin {
  plugin: {
    name: string;
    hooks?: { contributeOperatorSuggestions?: (ctx: unknown) => Promise<unknown[]> | unknown[] };
  };
}

const loaded: LoadedPlugin[] = [];

vi.mock('./plugin-host-runtime', () => ({
  getPluginHost: async () => ({ loaded }),
  buildPapercuspContext: () => ({ stub: true }),
}));
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...parts: string[]) => `/tmp/${parts.join('/')}`,
}));

import { gatherPluginSuggestions } from './operator-plugin-suggestions';

const originalWarn = console.warn;
beforeEach(() => {
  loaded.length = 0;
  // Several tests intentionally trigger logged warnings (broken hook,
  // invalid suggestion). Suppress so vitest-fail-on-console doesn't trip.
  console.warn = () => {};
});
afterEach(() => {
  loaded.length = 0;
  console.warn = originalWarn;
});

const validSuggestion = {
  id: 'p1',
  action: 'inform' as const,
  capability: null,
  title: 'plugin says',
  why: 'plugin reasons',
  reason: 'long-enough plugin reason here',
  tier: 'low' as const,
  body: 'plugin body',
};

describe('gatherPluginSuggestions', () => {
  it('returns empty when no plugins are loaded', async () => {
    const r = await gatherPluginSuggestions();
    expect(r).toEqual([]);
  });

  it('skips plugins without the hook', async () => {
    loaded.push({ plugin: { name: 'no-hook', hooks: {} } });
    const r = await gatherPluginSuggestions();
    expect(r).toEqual([]);
  });

  it('returns suggestions from a plugin that does implement the hook', async () => {
    loaded.push({
      plugin: {
        name: 'good-plugin',
        hooks: { contributeOperatorSuggestions: async () => [validSuggestion] },
      },
    });
    const r = await gatherPluginSuggestions();
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('p1');
  });

  it('isolates errors per-plugin (one throw does not break the rest)', async () => {
    loaded.push({
      plugin: {
        name: 'broken',
        hooks: { contributeOperatorSuggestions: async () => { throw new Error('boom'); } },
      },
    });
    loaded.push({
      plugin: {
        name: 'fine',
        hooks: { contributeOperatorSuggestions: async () => [validSuggestion] },
      },
    });
    const r = await gatherPluginSuggestions();
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('p1');
  });

  it('drops invalid suggestions (Zod rejection) but keeps the rest', async () => {
    loaded.push({
      plugin: {
        name: 'mixed',
        hooks: {
          contributeOperatorSuggestions: async () => [
            { not: 'a valid suggestion' },
            validSuggestion,
          ],
        },
      },
    });
    const r = await gatherPluginSuggestions();
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('p1');
  });

  it('treats a hook that returns null as empty', async () => {
    loaded.push({
      plugin: {
        name: 'returns-null',
        hooks: { contributeOperatorSuggestions: async () => null as unknown as unknown[] },
      },
    });
    const r = await gatherPluginSuggestions();
    expect(r).toEqual([]);
  });
});
