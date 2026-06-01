/**
 * papercuspRoot must resolve the operator's workspace substrate against the
 * REQUEST workspace (activeWorkspaceId → ALS), not the process-global registry
 * `current` — otherwise a request on workspace B reads A's ~/.papercusp under
 * the shared-operator model (per-window-workspace-context-2026-05-31, P-052).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithWorkspace } from './workspace-als';
import {
  papercuspRoot,
  papercuspRootForWorkspace,
  _resetPapercuspRootForTests,
} from './papercusp-root';

let root: string;
let prevRoot: string | undefined;
let prevHome: string | undefined;

beforeAll(() => {
  prevRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  prevHome = process.env.PAPERCUSP_HOME;
  delete process.env.PAPERCUSP_HOME;
  root = mkdtempSync(join(tmpdir(), 'pcroot-'));
  for (const id of ['ws-a', 'ws-b', 'default']) {
    mkdirSync(join(root, id, '.papercusp'), { recursive: true });
  }
  writeFileSync(
    join(root, 'registry.json'),
    JSON.stringify({
      current: 'ws-a',
      workspaces: [
        { id: 'ws-a', name: 'a', createdAt: 1 },
        { id: 'ws-b', name: 'b', createdAt: 2 },
      ],
    }),
  );
  process.env.PAPERCUSP_WORKSPACES_ROOT = root;
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
  else process.env.PAPERCUSP_WORKSPACES_ROOT = prevRoot;
  if (prevHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = prevHome;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => _resetPapercuspRootForTests());

describe('papercuspRoot — request-scoped (P-052)', () => {
  it('resolves the global active workspace outside any request', () => {
    expect(papercuspRoot()).toBe(join(root, 'ws-a', '.papercusp'));
  });

  it('resolves the REQUEST workspace inside runWithWorkspace', () => {
    const p = runWithWorkspace('ws-b', () => papercuspRoot());
    expect(p).toBe(join(root, 'ws-b', '.papercusp'));
  });

  it('does not leak one request workspace into another (cache keyed by workspace)', () => {
    const a = runWithWorkspace('ws-a', () => papercuspRoot());
    const b = runWithWorkspace('ws-b', () => papercuspRoot());
    expect(a).toBe(join(root, 'ws-a', '.papercusp'));
    expect(b).toBe(join(root, 'ws-b', '.papercusp'));
  });

  it('PAPERCUSP_HOME env still wins', () => {
    process.env.PAPERCUSP_HOME = '/custom/papercusp/home';
    try {
      expect(papercuspRoot()).toBe('/custom/papercusp/home');
    } finally {
      delete process.env.PAPERCUSP_HOME;
    }
  });
});

describe('papercuspRootForWorkspace — targets a SPECIFIC workspace', () => {
  it('resolves the named workspace, NOT the active one', () => {
    // active workspace is ws-a (registry.current); ask for ws-b explicitly.
    expect(papercuspRootForWorkspace('ws-b')).toBe(
      join(root, 'ws-b', '.papercusp'),
    );
    expect(papercuspRootForWorkspace('ws-a')).toBe(
      join(root, 'ws-a', '.papercusp'),
    );
  });

  it('does not follow a different REQUEST workspace (it is explicit)', () => {
    // Even inside a ws-a request, asking for ws-b returns ws-b.
    const p = runWithWorkspace('ws-a', () => papercuspRootForWorkspace('ws-b'));
    expect(p).toBe(join(root, 'ws-b', '.papercusp'));
  });

  it('falls back to papercuspRoot() for an unprovisioned/empty workspace', () => {
    // no such dir → fall back to the active root (ws-a) rather than a
    // non-existent path. This is what prevents the "PAPERCUSP_HOME=<active>"
    // mismatch from becoming a broken HOME for a not-yet-created workspace.
    expect(papercuspRootForWorkspace('never-created')).toBe(papercuspRoot());
    expect(papercuspRootForWorkspace('')).toBe(papercuspRoot());
  });
});
