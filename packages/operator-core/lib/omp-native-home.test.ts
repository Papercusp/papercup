import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOmpNativeHomes } from '../test/omp-native-home';

describe('owned OMP native profiles', () => {
  it('allocates nothing when a suite is only collected', () => {
    const homes = createOmpNativeHomes();
    try { expect(homes.root).toBeUndefined(); }
    finally { homes.dispose(); }
  });

  it('reuses extracted libraries across disposable homes while isolating settings and sessions', () => {
    const homes = createOmpNativeHomes();
    try {
      const first = homes.allocate();
      const native = join(first, '.omp', 'natives', '18.0.3');
      mkdirSync(native);
      writeFileSync(join(native, 'fixture.node'), 'owned native artifact');
      mkdirSync(join(first, '.omp', 'agent', 'sessions'), { recursive: true });
      writeFileSync(join(first, '.omp', 'agent', 'auth.json'), 'private fixture credential');
      writeFileSync(join(first, '.omp', 'agent', 'sessions', 'first.jsonl'), 'first session');
      const second = homes.allocate();
      expect(realpathSync(join(first, '.omp', 'natives')))
        .toBe(realpathSync(join(second, '.omp', 'natives')));
      expect(existsSync(join(second, '.omp', 'agent'))).toBe(false);
      rmSync(first, { recursive: true, force: true });
      expect(readFileSync(join(second, '.omp', 'natives', '18.0.3', 'fixture.node'), 'utf8'))
        .toBe('owned native artifact');
      expect(homes.nativeFiles()).toContain('18.0.3/fixture.node');
    } finally { homes.dispose(); }
    expect(existsSync(homes.root!)).toBe(false);
  });

  it('removes its native cache at teardown and refuses later allocation', () => {
    const homes = createOmpNativeHomes();
    const home = homes.allocate();
    const cache = realpathSync(join(home, '.omp', 'natives'));
    homes.dispose();
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(() => homes.allocate()).toThrow('already disposed');
    homes.dispose();
  });
});
