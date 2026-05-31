/**
 * Coverage for omp-config: parseOmpConfigList (sections + the per-line
 * key = value (type) grammar, with type-aware value parsing for
 * boolean/number/array/enum/unset/string) and the key-shape validation that
 * setOmpConfig/unsetOmpConfig enforce before ever spawning omp.
 */
import { describe, expect, it } from 'vitest';
import { parseOmpConfigList, setOmpConfig, unsetOmpConfig } from './omp-config';

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
