import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let tmpHome = '';
let fakeOmp = '';

beforeEach(() => {
  vi.resetModules();
  tmpHome = mkdtempSync(join(tmpdir(), 'ensure-omp-su-'));
  fakeOmp = join(tmpHome, 'bin', 'omp');
  mkdirSync(dirname(fakeOmp), { recursive: true });

  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: () => tmpHome };
  });

  vi.doMock('node:child_process', async () => ({
    execSync: (command: string, opts?: { encoding?: string }) => {
      if (command === 'command -v omp') return opts?.encoding ? `${fakeOmp}\n` : Buffer.from(`${fakeOmp}\n`);
      if (command === 'command -v omp-su') return opts?.encoding ? `${join(dirname(fakeOmp), 'omp-su')}\n` : Buffer.from(`${join(dirname(fakeOmp), 'omp-su')}\n`);
      throw new Error(`unexpected command: ${command}`);
    },
    execFileSync: () => undefined,
  }));

  vi.doMock('./desktop-install/papercusp-files', () => ({
    installPapercuspFiles: vi.fn(async () => ({ playbookWritten: true, extensionWritten: true })),
  }));

  vi.doMock('./desktop-install/omp-integration', () => ({
    installOmpIntegration: vi.fn(async () => ({ changed: false, actions: [] })),
  }));
});

afterEach(() => {
  vi.doUnmock('node:os');
  vi.doUnmock('node:child_process');
  vi.doUnmock('./desktop-install/papercusp-files');
  vi.doUnmock('./desktop-install/omp-integration');
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensure-omp-su', () => {
  it('reports stale wrapper state and refreshes the wrapper on ensure', async () => {
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
    expect(before.wrapperPresent).toBe(true);
    expect(before.wrapperCurrent).toBe(false);

    await mod.ensureOmpSuInstalled();

    const after = mod.readEngineerOmpBootstrapState(tmpHome);
    expect(after.wrapperCurrent).toBe(true);
    const content = readFileSync(wrapper, 'utf8');
    expect(content).toContain('--append-system-prompt "${HOME}/.papercusp/engineer-collaborator.md"');
    expect(content).toContain('-e "${HOME}/.papercusp/papercusp-coord.ts"');
    expect(content).not.toContain('echo stale');
  });
});
