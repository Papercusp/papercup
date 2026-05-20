/**
 * Per-OS runtime-dir resolution — D-010.
 *
 * `runtimeRoot()` is the only piece of OS-specific code in the plugin;
 * if it mis-resolves the platform, the session-scratch profile gets
 * written somewhere the OS doesn't auto-clean, leaking creds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as os from 'node:os';

const originalPlatform = process.platform;
const originalXDG = process.env.XDG_RUNTIME_DIR;
const originalLA = process.env.LOCALAPPDATA;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  setPlatform(originalPlatform);
  process.env.XDG_RUNTIME_DIR = originalXDG;
  process.env.LOCALAPPDATA = originalLA;
  vi.restoreAllMocks();
});

async function loadRuntimeDir() {
  return await import('../src/runtime-dir.js');
}

describe('runtimeRoot', () => {
  it('linux + XDG_RUNTIME_DIR → joins under XDG with /papercusp-omp', async () => {
    setPlatform('linux');
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const m = await loadRuntimeDir();
    expect(m.runtimeRoot()).toBe('/run/user/1000/papercusp-omp');
  });

  it('linux without XDG_RUNTIME_DIR → falls back to OS tmpdir', async () => {
    setPlatform('linux');
    delete process.env.XDG_RUNTIME_DIR;
    const m = await loadRuntimeDir();
    expect(m.runtimeRoot()).toBe(join(os.tmpdir(), 'papercusp-omp'));
  });

  it('darwin → ~/Library/Application Support/Papercusp/runtime', async () => {
    setPlatform('darwin');
    process.env.XDG_RUNTIME_DIR = '/should-be-ignored';
    const m = await loadRuntimeDir();
    expect(m.runtimeRoot()).toBe(
      join(os.homedir(), 'Library', 'Application Support', 'Papercusp', 'runtime'),
    );
  });

  it('win32 + LOCALAPPDATA → joins under it', async () => {
    setPlatform('win32');
    process.env.LOCALAPPDATA = 'C:\\Users\\Avi\\AppData\\Local';
    const m = await loadRuntimeDir();
    expect(m.runtimeRoot()).toBe(
      join('C:\\Users\\Avi\\AppData\\Local', 'Papercusp', 'runtime'),
    );
  });

  it('win32 without LOCALAPPDATA → derives from homedir', async () => {
    setPlatform('win32');
    delete process.env.LOCALAPPDATA;
    const m = await loadRuntimeDir();
    expect(m.runtimeRoot()).toBe(
      join(os.homedir(), 'AppData', 'Local', 'Papercusp', 'runtime'),
    );
  });

  it('unknown platform (freebsd) → OS tmpdir', async () => {
    setPlatform('freebsd');
    const m = await loadRuntimeDir();
    expect(m.runtimeRoot()).toBe(join(os.tmpdir(), 'papercusp-omp'));
  });
});

describe('sessionScratchDir', () => {
  it('appends a well-formed auth_session_id verbatim', async () => {
    setPlatform('linux');
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const m = await loadRuntimeDir();
    expect(m.sessionScratchDir('pus-abc123')).toBe('/run/user/1000/papercusp-omp/pus-abc123');
  });

  it('sanitises filesystem-unsafe characters from a malformed id', async () => {
    setPlatform('linux');
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const m = await loadRuntimeDir();
    // Prevents path traversal via a tampered id.
    expect(m.sessionScratchDir('../etc/passwd')).toBe(
      '/run/user/1000/papercusp-omp/.._etc_passwd',
    );
    expect(m.sessionScratchDir('pus-foo;rm -rf /')).toBe(
      '/run/user/1000/papercusp-omp/pus-foo_rm_-rf__',
    );
  });
});
