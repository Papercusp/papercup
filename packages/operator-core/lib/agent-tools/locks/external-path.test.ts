import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  externalHomePathToLockKey,
  externalPathToLockKey,
  EXTERNAL_RUNTIME_LOCK_PREFIX,
  resolveExternalPathLockIdentity,
} from './external-path';

describe('externalHomePathToLockKey', () => {
  it('maps a home config file to the hook-compatible reserved key', () => {
    expect(externalHomePathToLockKey('/home/jdoe/.config/mimeapps.list', '/home/jdoe')).toBe(
      '@external/home/.config/mimeapps.list',
    );
  });

  it('rejects relative, outside-home, and home-root paths', () => {
    expect(() => externalHomePathToLockKey('.config/x', '/home/jdoe')).toThrow(/absolute/);
    expect(() => externalHomePathToLockKey('/etc/hosts', '/home/jdoe')).toThrow(/below/);
    expect(() => externalHomePathToLockKey('/home/jdoe', '/home/jdoe')).toThrow(/below/);
  });

  it('maps current-user XDG runtime credential files to a distinct reserved key', () => {
    expect(
      externalPathToLockKey(
        '/run/user/1000/papercusp-p029-acceptance.9aTT9e/storage-state.json',
        { home: '/home/jdoe', runtimeDir: '/run/user/1000' },
      ),
    ).toBe(`${EXTERNAL_RUNTIME_LOCK_PREFIX}/papercusp-p029-acceptance.9aTT9e/storage-state.json`);
  });

  it('rejects the runtime root itself and paths under another runtime root', () => {
    const roots = { home: '/home/jdoe', runtimeDir: '/run/user/1000' };
    expect(() => externalPathToLockKey('/run/user/1000', roots)).toThrow(/below/);
    expect(() => externalPathToLockKey('/run/user/1001/state.json', roots)).toThrow(/below/);
  });
});

describe('resolveExternalPathLockIdentity', () => {
  const previousWorkspacesRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  const previousCanonicalTree = process.env.PAPERCUSP_CANONICAL_TREE;
  const cleanup: string[] = [];

  afterEach(() => {
    if (previousWorkspacesRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
    else process.env.PAPERCUSP_WORKSPACES_ROOT = previousWorkspacesRoot;
    if (previousCanonicalTree === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
    else process.env.PAPERCUSP_CANONICAL_TREE = previousCanonicalTree;
    while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  it('maps a managed suite-app absolute path to the hook-compatible repository identity', () => {
    const workspaces = mkdtempSync(join(tmpdir(), 'lock-external-workspaces-'));
    cleanup.push(workspaces);
    process.env.PAPERCUSP_WORKSPACES_ROOT = workspaces;
    // Keep the canonical-tree candidate hermetic so this fixture is classified
    // solely by the managed suite-app shape.
    process.env.PAPERCUSP_CANONICAL_TREE = join(workspaces, 'missing-canonical-tree');

    const portal = join(workspaces, 'papercusp-workspace', '.papercusp', 'apps', 'portal');
    const target = join(portal, 'packages', 'contracts', 'src', 'index.ts');
    mkdirSync(join(portal, '.git'), { recursive: true });
    writeFileSync(join(portal, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'export {};\n');

    expect(resolveExternalPathLockIdentity(target)).toEqual({
      coordinationDomain: realpathSync(portal),
      path: 'packages/contracts/src/index.ts',
    });
  });

  it('keeps an ordinary home configuration file in the reserved external namespace', () => {
    expect(resolveExternalPathLockIdentity('/home/jdoe/.config/mimeapps.list', {
      home: '/home/jdoe',
      runtimeDir: null,
    })).toEqual({ path: '@external/home/.config/mimeapps.list' });
  });
});
