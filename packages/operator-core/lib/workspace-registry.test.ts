import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRegistry,
  activeWorkspaceId,
  backgroundWorkspaceIds,
  workspaceById,
  isKnownWorkspace,
  DEFAULT_WORKSPACE_ID,
  setCompanyId,
  companyIdFor,
  workspacesRoot,
  __resetWorkspaceFallbackWarnings,
} from './workspace-registry';
import { runWithWorkspace, runInRequestScope } from './workspace-als';

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

  it('isKnownWorkspace: true for the default id + any registered id, false otherwise', () => {
    expect(isKnownWorkspace(DEFAULT_WORKSPACE_ID)).toBe(true);
    const registered = readRegistry().workspaces[0];
    if (registered) expect(isKnownWorkspace(registered.id)).toBe(true);
    expect(isKnownWorkspace('definitely-not-a-workspace-' + Date.now())).toBe(false);
    expect(isKnownWorkspace('')).toBe(false);
  });

  it('isKnownWorkspace: honors the PAPERCUSP_WORKSPACE_ID pin (EI-212 — a pinned process knows its own workspace)', () => {
    const prev = process.env.PAPERCUSP_WORKSPACE_ID;
    try {
      process.env.PAPERCUSP_WORKSPACE_ID = 'pinned-hermetic-ws';
      expect(isKnownWorkspace('pinned-hermetic-ws')).toBe(true);
      expect(isKnownWorkspace('some-other-unregistered-ws')).toBe(false);
      delete process.env.PAPERCUSP_WORKSPACE_ID;
      expect(isKnownWorkspace('pinned-hermetic-ws')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = prev;
    }
  });

  it('setCompanyId / companyIdFor round-trip', () => {
    const id = activeWorkspaceId();
    // On a box with no registry (fresh clone / CI runner — WI-123) the
    // active id falls back to 'default', which is unregistered and makes
    // setCompanyId throw "unknown workspace". Register it ourselves so the
    // round-trip is hermetic; afterEach's backup-restore undoes this on dev
    // boxes, and a registry created from nothing is removed below.
    const hadRegistry = existsSync(REGISTRY_PATH);
    const reg = readRegistry();
    if (!reg.workspaces.some((w) => w.id === id)) {
      mkdirSync(REGISTRY_DIR, { recursive: true });
      writeFileSync(
        REGISTRY_PATH,
        JSON.stringify({ ...reg, workspaces: [...reg.workspaces, { id, name: id, createdAt: Date.now() }] }, null, 2),
      );
    }
    const tag = 'test-co-' + Date.now();
    try {
      setCompanyId(id, tag);
      expect(companyIdFor(id)).toBe(tag);
      setCompanyId(id, null);
      expect(companyIdFor(id)).toBeNull();
    } finally {
      // best-effort cleanup; afterEach restores backup
      if (!hadRegistry) rmSync(REGISTRY_PATH, { force: true });
    }
  });

  it('setCompanyId throws on unknown workspace', () => {
    expect(() => setCompanyId('unknown-workspace-xxx', 'foo')).toThrow(/unknown workspace/);
  });
});

describe('activeWorkspaceId — request-scoped precedence (per-window-workspace-context P-012)', () => {
  const PIN = 'PAPERCUSP_WORKSPACE_ID';
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[PIN];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[PIN];
    else process.env[PIN] = prev;
  });

  it('returns the request-scoped workspace inside runWithWorkspace, beating the process pin', () => {
    process.env[PIN] = 'pinned-ws';
    const inside = runWithWorkspace('request-ws', () => activeWorkspaceId());
    expect(inside).toBe('request-ws');
  });

  it('falls back to the PAPERCUSP_WORKSPACE_ID process pin outside any request', () => {
    process.env[PIN] = 'pinned-ws';
    expect(activeWorkspaceId()).toBe('pinned-ws');
  });
});

describe('activeWorkspaceId — P-021 in-request global-fallback diagnostic', () => {
  const PIN = 'PAPERCUSP_WORKSPACE_ID';
  let prevPin: string | undefined;
  beforeEach(() => {
    prevPin = process.env[PIN];
    delete process.env[PIN]; // force the global-fallback branch
    vi.stubEnv('NODE_ENV', 'development'); // enable the dev-only diagnostic
    __resetWorkspaceFallbackWarnings();
  });
  afterEach(() => {
    if (prevPin === undefined) delete process.env[PIN];
    else process.env[PIN] = prevPin;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('warns when activeWorkspaceId falls to the global INSIDE a request scope', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = runInRequestScope(() => activeWorkspaceId());
    expect(id).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('INSIDE a');
  });

  it('does NOT warn outside any request scope (background / CLI)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    activeWorkspaceId();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when the request scope carries a workspace', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runWithWorkspace('ws-present', () => activeWorkspaceId());
    expect(warn).not.toHaveBeenCalled();
  });

  it('dedupes repeat fall-throughs from the same call site', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const call = () => runInRequestScope(() => activeWorkspaceId());
    call();
    call();
    call();
    expect(warn).toHaveBeenCalledTimes(1);
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

describe('backgroundWorkspaceIds — which workspaces a background job covers (P-020)', () => {
  // Isolate the registry in a temp root so these cases never touch the real
  // ~/.papercusp-workspaces (workspacesRoot honors PAPERCUSP_WORKSPACES_ROOT).
  const ENV_KEYS = ['PAPERCUSP_WORKSPACES_ROOT', 'PAPERCUSP_WORKSPACE_ID', 'PAPERCUSP_SHARED_OPERATOR'] as const;
  let saved: Record<string, string | undefined>;
  let root: string;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    root = mkdtempSync(join(tmpdir(), 'bg-ws-ids-'));
    process.env.PAPERCUSP_WORKSPACES_ROOT = root;
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ current: 'ws-a', workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }, { id: 'ws-c' }] }),
    );
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('PAPERCUSP_WORKSPACE_ID pin wins — a dedicated single-workspace process, even under shared-operator', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = 'pinned-ws';
    process.env.PAPERCUSP_SHARED_OPERATOR = '1';
    expect(backgroundWorkspaceIds()).toEqual(['pinned-ws']);
  });

  it('shared-operator model, no pin → EVERY registered workspace', () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_SHARED_OPERATOR = '1';
    expect(backgroundWorkspaceIds()).toEqual(['ws-a', 'ws-b', 'ws-c']);
  });

  it('dev / legacy (no shared-operator flag) → just the global active workspace', () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    delete process.env.PAPERCUSP_SHARED_OPERATOR;
    expect(backgroundWorkspaceIds()).toEqual(['ws-a']);
  });

  it('shared-operator with an EMPTY registry degrades to the global active workspace', () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_SHARED_OPERATOR = '1';
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ workspaces: [] }));
    expect(backgroundWorkspaceIds()).toEqual([DEFAULT_WORKSPACE_ID]);
  });
});
