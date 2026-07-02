import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let tmpHome = '';
let fakeOmp = '';
let realPath = '';

beforeEach(() => {
  vi.resetModules();
  tmpHome = mkdtempSync(join(tmpdir(), 'ensure-omp-su-'));
  fakeOmp = join(tmpHome, 'bin', 'omp');
  mkdirSync(dirname(fakeOmp), { recursive: true });
  // P-080: binaries resolve via a pure-Node PATH scan now (no shell).
  // Pin PATH to ONLY the fake bin dir so the test never sees the host's
  // real omp / leftover omp-su.
  writeFileSync(fakeOmp, '#!/usr/bin/env bash\n');
  realPath = process.env.PATH ?? '';
  process.env.PATH = dirname(fakeOmp);

  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: () => tmpHome };
  });

  vi.doMock('node:child_process', async () => ({
    execFileSync: () => undefined,
  }));

  // Partial mock: stub only the fs-writing installer; keep the REAL pure
  // resolveInstallPaths so claude-integration.ts (which imports it at module
  // load) doesn't fail-soft-skip its whole branch on a missing-export throw.
  vi.doMock('./desktop-install/papercusp-files', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./desktop-install/papercusp-files')>();
    return {
      ...actual,
      installPapercuspFiles: vi.fn(async () => ({ playbookWritten: true, extensionWritten: true })),
    };
  });

  vi.doMock('./desktop-install/omp-integration', () => ({
    installOmpIntegration: vi.fn(async () => ({ changed: false, actions: [] })),
  }));
});

afterEach(() => {
  process.env.PATH = realPath;
  vi.doUnmock('node:os');
  vi.doUnmock('node:child_process');
  vi.doUnmock('./desktop-install/papercusp-files');
  vi.doUnmock('./desktop-install/omp-integration');
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensure-omp-su', () => {
  it('reports bootstrap state + does NOT write/refresh the omp-su wrapper (P-050 retired)', async () => {
    const playbook = join(tmpHome, '.papercusp', 'engineer-collaborator.md');
    const coord = join(tmpHome, '.papercusp', 'papercusp-coord.ts');
    const wrapper = join(dirname(fakeOmp), 'omp-su');
    mkdirSync(dirname(playbook), { recursive: true });
    writeFileSync(playbook, '# playbook\n');
    writeFileSync(coord, '// coord\n');
    writeFileSync(wrapper, '#!/usr/bin/env bash\necho stale\n');

    const mod = await import('./ensure-omp-su');
    const before = mod.readEngineerOmpBootstrapState(tmpHome);
    expect(before.playbookPresent).toBe(true);
    expect(before.coordPresent).toBe(true);
    // A leftover (stale) wrapper is detectable for cleanup, but no longer managed.
    expect(before.wrapperPresent).toBe(true);

    await mod.ensureOmpSuInstalled();

    // The wrapper is retired — ensure must NOT (re)write or refresh it.
    expect(readFileSync(wrapper, 'utf8')).toBe('#!/usr/bin/env bash\necho stale\n');
  });

  it('falls back to ~/.local/bin for the wrapper dir when omp is not on PATH (P-080 non-shell scan)', async () => {
    rmSync(fakeOmp); // no omp anywhere on the pinned PATH
    const mod = await import('./ensure-omp-su');
    const state = mod.readEngineerOmpBootstrapState(tmpHome);
    expect(state.wrapperPath).toBe(join(tmpHome, '.local', 'bin', 'omp-su'));
  });
});
