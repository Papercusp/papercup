/** Owned OMP profiles: share native extraction only, never settings or sessions. */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createOmpNativeHomes() {
  const root = mkdtempSync(join(tmpdir(), 'omp-native-homes-'));
  const cache = join(root, 'natives');
  mkdirSync(cache);
  let disposed = false;
  return {
    root,
    allocate() {
      if (disposed) throw new Error('OMP native homes already disposed');
      const home = mkdtempSync(join(root, 'profile-'));
      mkdirSync(join(home, '.omp'));
      symlinkSync(cache, join(home, '.omp', 'natives'), 'dir');
      return home;
    },
    nativeFiles() {
      return readdirSync(cache, { recursive: true }).map(String).sort();
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
      disposed = true;
    },
  };
}
