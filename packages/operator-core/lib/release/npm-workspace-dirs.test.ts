/**
 * WI-10002500: the npm-workspace name→dir map must be DERIVED from package.json, because the
 * obvious shortcut — infer the directory from the package name's last segment — is measurably
 * wrong in this repo. These assertions run against the REAL checkout on purpose: the claim being
 * pinned is about this tree's layout, so a fixture would only restate the assumption.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetNpmWorkspaceDirsCache, npmWorkspaceDirsByName } from './npm-workspace-dirs';

/** Walk up to the directory whose package.json declares `workspaces` — the npm root. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
        if (pkg.workspaces) return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

describe('npm workspace name → directory map', () => {
  beforeEach(() => {
    __resetNpmWorkspaceDirsCache();
  });

  it('maps declared workspaces, and resolves this very package', () => {
    const map = npmWorkspaceDirsByName(repoRoot());
    expect(Object.keys(map).length).toBeGreaterThan(20);
    expect(map['@papercusp/operator-core']).toBe('packages/operator-core');
  });

  it('POSITIVE CONTROL for the whole module: at least one workspace directory is NOT its package name', () => {
    // If this ever reports zero, the basename shortcut would have become safe — and THAT is the
    // moment to re-read this module, not a moment to weaken the assertion. Measured 2026-09-22:
    // 7 of 105, including `@papercusp/web` → `apps/operator`, a live green-checkpoint leg.
    const map = npmWorkspaceDirsByName(repoRoot());
    const divergent = Object.entries(map).filter(
      ([name, dir]) => (name.includes('/') ? name.split('/').pop() : name) !== basename(dir),
    );
    expect(divergent.length).toBeGreaterThan(0);
  });

  it('an unreadable root yields an empty map rather than throwing — callers degrade, never crash', () => {
    expect(npmWorkspaceDirsByName(join(repoRoot(), 'no-such-directory-for-this-test'))).toEqual({});
  });
});
