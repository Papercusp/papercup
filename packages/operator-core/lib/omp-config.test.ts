/**
 * Coverage for omp-config: parseOmpConfigList (sections + the per-line
 * key = value (type) grammar, with type-aware value parsing for
 * boolean/number/array/enum/unset/string) and the key-shape validation that
 * setOmpConfig/unsetOmpConfig enforce before ever spawning omp.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createOmpModelCatalogReader,
  parseOmpConfigList,
  parseOmpModelCatalogJson,
  setOmpConfig,
  unsetOmpConfig,
} from './omp-config';

const SAMPLE = `Settings:

[general]
  ui.theme = frost (string)
  ui.enabled = true (boolean)
  ui.count = 42 (number)
  ui.tags = ["a","b"] (array)
  ui.mode = dev (dev|prod|test)
  ui.secret = (not set) (string)

[advanced]
  adv.ratio = 1.5 (number)
`;

describe('parseOmpConfigList', () => {
  const sections = parseOmpConfigList(SAMPLE);
  const general = sections.find((s) => s.name === 'general')!;
  const byKey = (k: string) => general.settings.find((s) => s.key === k)!;

  it('splits into the declared sections', () => {
    expect(sections.map((s) => s.name)).toEqual(['general', 'advanced']);
  });

  it('parses a string scalar', () => {
    expect(byKey('ui.theme')).toMatchObject({ raw: 'frost', parsed: 'frost', type: 'string', isUnset: false });
  });

  it('parses a boolean', () => {
    expect(byKey('ui.enabled')).toMatchObject({ parsed: true, type: 'boolean' });
  });

  it('parses a number', () => {
    expect(byKey('ui.count')).toMatchObject({ parsed: 42, type: 'number' });
    expect(parseOmpConfigList(SAMPLE).find((s) => s.name === 'advanced')!.settings[0].parsed).toBe(1.5);
  });

  it('JSON-parses an array', () => {
    expect(byKey('ui.tags').parsed).toEqual(['a', 'b']);
  });

  it('recognizes an enum type annotation', () => {
    expect(byKey('ui.mode').type).toEqual({ kind: 'enum', choices: ['dev', 'prod', 'test'] });
    expect(byKey('ui.mode').parsed).toBe('dev');
  });

  it('flags (not set) as unset', () => {
    expect(byKey('ui.secret')).toMatchObject({ isUnset: true, parsed: null });
  });

  it('returns no sections for header-only output', () => {
    expect(parseOmpConfigList('Settings:\n\n')).toEqual([]);
  });
});

describe('setOmpConfig / unsetOmpConfig — key validation (pre-spawn)', () => {
  it('rejects a key with shell metacharacters before spawning', async () => {
    await expect(setOmpConfig('bad key; rm -rf', true)).rejects.toThrow(/invalid config key/);
    await expect(setOmpConfig('$(whoami)', 'x')).rejects.toThrow(/invalid config key/);
    await expect(unsetOmpConfig('a b')).rejects.toThrow(/invalid config key/);
  });
});

const MODEL_ROW = {
  provider: 'openai-codex',
  id: 'gpt-5.6-terra',
  selector: 'openai-codex/gpt-5.6-terra',
  name: 'GPT-5.6-Terra',
  contextWindow: 200000,
  maxTokens: 128000,
  reasoning: true,
  thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
  input: ['text', 'image'],
  cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

describe('OMP model catalog', () => {
  it('preserves OMP selector + launch metadata exactly', () => {
    const catalog = parseOmpModelCatalogJson(JSON.stringify({ models: [MODEL_ROW] }));
    expect(catalog.models[0]).toEqual(MODEL_ROW);
  });

  it('rejects a selector that does not match provider/id', () => {
    expect(() => parseOmpModelCatalogJson(JSON.stringify({
      models: [{ ...MODEL_ROW, selector: 'openai-codex/not-the-model' }],
    }))).toThrow(/provider\/id\/selector\/name identity/);
  });

  it('caches per OMP profile environment, deduplicates concurrent reads, and force-refreshes', async () => {
    let now = 100;
    const exec = vi.fn(async (_args: string[], _timeout: number, env: NodeJS.ProcessEnv) => ({
      stdout: JSON.stringify({ models: [{ ...MODEL_ROW, name: env.HOME ?? 'unknown' }] }),
      stderr: '',
      code: 0,
    }));
    const read = createOmpModelCatalogReader({ exec, now: () => now, ttlMs: 50 });

    const [first, concurrent] = await Promise.all([
      read({ env: { HOME: '/u/one', PATH: '/bin' } }),
      read({ env: { HOME: '/u/one', PATH: '/bin' } }),
    ]);
    expect(first).toBe(concurrent);
    expect(exec).toHaveBeenCalledTimes(1);
    expect((await read({ env: { HOME: '/u/two', PATH: '/bin' } })).models[0].name).toBe('/u/two');
    expect(exec).toHaveBeenCalledTimes(2);

    await read({ env: { HOME: '/u/one', PATH: '/bin' }, forceRefresh: true });
    expect(exec).toHaveBeenCalledTimes(3);
    now += 51;
    await read({ env: { HOME: '/u/one', PATH: '/bin' } });
    expect(exec).toHaveBeenCalledTimes(4);
  });
});
