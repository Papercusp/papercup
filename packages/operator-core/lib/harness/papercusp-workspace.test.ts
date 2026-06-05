import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'pc-ws-test-'));
  await mkdir(join(tmpHome, '.papercusp-workspaces'), { recursive: true });
  vi.resetModules();
  // Point homedir() at our scratch dir for the module + its dep.
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: () => tmpHome };
  });
});

afterEach(async () => {
  vi.doUnmock('node:os');
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
});

describe('PAPERCUSP_WORKSPACE_ID + isPapercuspWorkspace', () => {
  it('exports the literal id', async () => {
    const mod = await import('./papercusp-workspace');
    expect(mod.PAPERCUSP_WORKSPACE_ID).toBe('papercusp-workspace');
  });

  it('predicate matches exactly', async () => {
    const { isPapercuspWorkspace } = await import('./papercusp-workspace');
    expect(isPapercuspWorkspace('papercusp-workspace')).toBe(true);
    expect(isPapercuspWorkspace('Papercusp-Workspace')).toBe(false);
    expect(isPapercuspWorkspace('')).toBe(false);
    expect(isPapercuspWorkspace(null)).toBe(false);
    expect(isPapercuspWorkspace(undefined)).toBe(false);
    expect(isPapercuspWorkspace('papercusp')).toBe(false);
    expect(isPapercuspWorkspace('default')).toBe(false);
  });
});

describe('ensurePapercuspWorkspace', () => {
  it('creates the sentinel on a fresh registry, sets it as current', async () => {
    const { ensurePapercuspWorkspace } = await import('./papercusp-workspace');
    const e = ensurePapercuspWorkspace();
    expect(e.id).toBe('papercusp-workspace');
    expect(e.name).toBe('papercusp-workspace');
    expect(typeof e.createdAt).toBe('number');

    const reg = JSON.parse(
      readFileSync(join(tmpHome, '.papercusp-workspaces', 'registry.json'), 'utf8'),
    );
    expect(reg.workspaces).toHaveLength(1);
    expect(reg.workspaces[0].id).toBe('papercusp-workspace');
    expect(reg.current).toBe('papercusp-workspace');
  });

  it('is idempotent — second call returns same entry, no duplicates', async () => {
    const { ensurePapercuspWorkspace } = await import('./papercusp-workspace');
    const a = ensurePapercuspWorkspace();
    const b = ensurePapercuspWorkspace();
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(a.createdAt); // same row read back, not re-created
    const reg = JSON.parse(
      readFileSync(join(tmpHome, '.papercusp-workspaces', 'registry.json'), 'utf8'),
    );
    expect(reg.workspaces).toHaveLength(1);
  });

  it('leaves an existing current workspace alone', async () => {
    // Pre-existing registry with a different current workspace.
    const regPath = join(tmpHome, '.papercusp-workspaces', 'registry.json');
    await writeFile(
      regPath,
      JSON.stringify({
        current: 'my-other-workspace',
        workspaces: [{ id: 'my-other-workspace', name: 'Other', createdAt: 100 }],
      }),
    );

    const { ensurePapercuspWorkspace } = await import('./papercusp-workspace');
    ensurePapercuspWorkspace();

    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    expect(reg.current).toBe('my-other-workspace');
    expect(reg.workspaces).toHaveLength(2);
    expect(reg.workspaces.find((w: { id: string }) => w.id === 'papercusp-workspace')).toBeDefined();
    expect(reg.workspaces.find((w: { id: string }) => w.id === 'my-other-workspace')).toBeDefined();
  });

  it('writes registry.json idempotently to disk', async () => {
    const { ensurePapercuspWorkspace } = await import('./papercusp-workspace');
    ensurePapercuspWorkspace();
    expect(existsSync(join(tmpHome, '.papercusp-workspaces', 'registry.json'))).toBe(true);
  });

  it('provisions the workspace directory so switch() can succeed', async () => {
    const { ensurePapercuspWorkspace } = await import('./papercusp-workspace');
    ensurePapercuspWorkspace();
    expect(
      existsSync(join(tmpHome, '.papercusp-workspaces', 'papercusp-workspace')),
    ).toBe(true);
  });

  it('self-heals: entry present in registry but directory missing', async () => {
    // Reproduce the reported bug — a registry entry that was written
    // (e.g. by an older bootstrap) without ever provisioning its dir.
    const regPath = join(tmpHome, '.papercusp-workspaces', 'registry.json');
    await writeFile(
      regPath,
      JSON.stringify({
        current: 'default',
        workspaces: [
          { id: 'default', name: 'Default', createdAt: 1 },
          { id: 'papercusp-workspace', name: 'papercusp-workspace', createdAt: 2 },
        ],
      }),
    );
    const sentinelDir = join(tmpHome, '.papercusp-workspaces', 'papercusp-workspace');
    expect(existsSync(sentinelDir)).toBe(false);

    const { ensurePapercuspWorkspace } = await import('./papercusp-workspace');
    const e = ensurePapercuspWorkspace();

    // Dir now exists; entry untouched; current left alone; no duplicate.
    expect(existsSync(sentinelDir)).toBe(true);
    expect(e.createdAt).toBe(2);
    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    expect(reg.current).toBe('default');
    expect(
      reg.workspaces.filter((w: { id: string }) => w.id === 'papercusp-workspace'),
    ).toHaveLength(1);
  });
});
