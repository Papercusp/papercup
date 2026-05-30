import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readRegistry,
  activeWorkspaceId,
  workspaceById,
  setCompanyId,
  companyIdFor,
  workspacesRoot,
} from './workspace-registry';

const REGISTRY_DIR = join(homedir(), '.papercusp-workspaces');
const REGISTRY_PATH = join(REGISTRY_DIR, 'registry.json');
const BACKUP_PATH = join(REGISTRY_DIR, 'registry.json.test-backup');

describe('workspace-registry', () => {
  beforeEach(() => {
    if (existsSync(REGISTRY_PATH)) {
      writeFileSync(BACKUP_PATH, readFileSync(REGISTRY_PATH));
    }
  });

  afterEach(() => {
    if (existsSync(BACKUP_PATH)) {
      try {
        writeFileSync(REGISTRY_PATH, readFileSync(BACKUP_PATH));
        rmSync(BACKUP_PATH);
      } catch {
        /* ignore */
      }
    }
  });

  it('readRegistry returns the registry shape', () => {
    const reg = readRegistry();
    expect(reg).toHaveProperty('workspaces');
    expect(Array.isArray(reg.workspaces)).toBe(true);
  });

  it('activeWorkspaceId returns a non-empty string', () => {
    const id = activeWorkspaceId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('workspaceById returns undefined for unknown id', () => {
    const ws = workspaceById('does-not-exist-' + Date.now());
    expect(ws).toBeUndefined();
  });

  it('setCompanyId / companyIdFor round-trip', () => {
    const id = activeWorkspaceId();
    const tag = 'test-co-' + Date.now();
    try {
      setCompanyId(id, tag);
      expect(companyIdFor(id)).toBe(tag);
      setCompanyId(id, null);
      expect(companyIdFor(id)).toBeNull();
    } finally {
      // best-effort cleanup; afterEach restores backup
    }
  });

  it('setCompanyId throws on unknown workspace', () => {
    expect(() => setCompanyId('unknown-workspace-xxx', 'foo')).toThrow(/unknown workspace/);
  });
});

describe('workspacesRoot', () => {
  const KEY = 'PAPERCUSP_WORKSPACES_ROOT';
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it('prefers PAPERCUSP_WORKSPACES_ROOT when set (the desktop-remapped-HOME fix)', () => {
    process.env[KEY] = '/real/home/.papercusp-workspaces';
    expect(workspacesRoot()).toBe('/real/home/.papercusp-workspaces');
  });

  it('falls back to homedir()/.papercusp-workspaces when the env is unset (dev parity)', () => {
    delete process.env[KEY];
    expect(workspacesRoot()).toBe(join(homedir(), '.papercusp-workspaces'));
  });

  it('ignores an empty/whitespace env value', () => {
    process.env[KEY] = '   ';
    expect(workspacesRoot()).toBe(join(homedir(), '.papercusp-workspaces'));
  });
});
