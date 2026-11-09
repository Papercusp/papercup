/** Owned OMP profiles: share native extraction only, never settings or sessions. */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createOmpNativeHomes() {
  // Vitest also imports suites while listing tests; that path runs no teardown.
  let root: string | undefined;
  let disposed = false;
  return {
    get root() { return root; },
    allocate() {
      if (disposed) throw new Error('OMP native homes already disposed');
      if (!root) {
        root = mkdtempSync(join(tmpdir(), 'omp-native-homes-'));
        mkdirSync(join(root, 'natives'));
      }
      const home = mkdtempSync(join(root, 'profile-'));
      mkdirSync(join(home, '.omp'));
      symlinkSync(join(root, 'natives'), join(home, '.omp', 'natives'), 'dir');
      return home;
    },
    nativeFiles() {
      return root ? readdirSync(join(root, 'natives'), { recursive: true }).map(String).sort() : [];
    },
    dispose() {
      if (root) rmSync(root, { recursive: true, force: true });
      disposed = true;
    },
  };
}
