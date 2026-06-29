import { describe, it, expect } from 'vitest';
import { readEnvSwitcherPrefs, setEnvEnabled } from './env-switcher-prefs';

/** An in-memory fake of the prefs file for deterministic, fs-free tests. */
function fakeStore(initial?: string) {
  const box = { content: initial };
  const deps = {
    filePath: '/tmp/env-switcher-prefs.json',
    readFile: () => {
      if (box.content == null) throw new Error('ENOENT');
      return box.content;
    },
    writeFile: (_p: string, data: string) => {
      box.content = data;
    },
    ensureDir: () => {},
  };
  return { box, deps };
}

describe('env-switcher-prefs', () => {
  it('returns an empty disabled set when the file is missing or malformed', () => {
    expect(readEnvSwitcherPrefs(fakeStore(undefined).deps)).toEqual({ disabled: [] });
    expect(readEnvSwitcherPrefs(fakeStore('not json').deps)).toEqual({ disabled: [] });
  });

  it('disables then re-enables an env, round-tripping through the file', () => {
    const { deps } = fakeStore();
    expect(setEnvEnabled('staging', false, deps)).toEqual({ disabled: ['staging'] });
    expect(readEnvSwitcherPrefs(deps)).toEqual({ disabled: ['staging'] });
    expect(setEnvEnabled('local', false, deps)).toEqual({ disabled: ['local', 'staging'] });
    expect(setEnvEnabled('staging', true, deps)).toEqual({ disabled: ['local'] });
  });

  it('never disables the release env (the immutable escape hatch)', () => {
    const { deps } = fakeStore();
    expect(setEnvEnabled('release', false, deps)).toEqual({ disabled: [] });
    // and a malformed file listing release as disabled is sanitized away on read
    const { deps: d2 } = fakeStore(JSON.stringify({ disabled: ['release', 'dev'] }));
    expect(readEnvSwitcherPrefs(d2)).toEqual({ disabled: ['dev'] });
  });

  it('is idempotent and de-duplicates', () => {
    const { deps } = fakeStore();
    setEnvEnabled('dev', false, deps);
    expect(setEnvEnabled('dev', false, deps)).toEqual({ disabled: ['dev'] });
  });
});
