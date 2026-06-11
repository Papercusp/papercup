/**
 * Coverage for harness-paths: harnessPackageDir (PAPERCUSP_HARNESS_DIR override
 * vs ~/autonomous-harness default), harnessPath join, and the symlink-safe
 * orchestratorRunBin / invokeOnceBin (sibling-package bin resolution). tsxBin
 * (needs tsx module resolution) is out of scope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessPackageDir, harnessPath, orchestratorRunBin, invokeOnceBin } from './harness-paths';

afterEach(() => vi.unstubAllEnvs());

describe('harnessPackageDir', () => {
  it('honors PAPERCUSP_HARNESS_DIR', () => {
    vi.stubEnv('PAPERCUSP_HARNESS_DIR', '/custom/harness');
    expect(harnessPackageDir()).toBe('/custom/harness');
  });
  it('falls back to ~/autonomous-harness, or the in-repo package when the symlink is absent', () => {
    // Dev boxes carry the ~/autonomous-harness symlink; fresh clones (CI
    // runners) don't and resolve the harness package inside this repo
    // (WI-123). Either result is the documented contract.
    vi.stubEnv('PAPERCUSP_HARNESS_DIR', '');
    const dir = harnessPackageDir();
    expect(
      dir.endsWith('/autonomous-harness') || dir.endsWith('/libs/papercusp/packages/harness'),
    ).toBe(true);
  });
});

describe('harnessPath', () => {
  it('joins segments under the package dir', () => {
    vi.stubEnv('PAPERCUSP_HARNESS_DIR', '/custom/harness');
    expect(harnessPath('prompts', 'worker.md')).toBe('/custom/harness/prompts/worker.md');
  });
});

describe('orchestrator bins (symlink-safe sibling resolution)', () => {
  it('resolve to <pkgs>/orchestrator/bin/{run,invoke-once}.ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-')); // real dir → realpathSync succeeds
    try {
      vi.stubEnv('PAPERCUSP_HARNESS_DIR', dir);
      expect(orchestratorRunBin().endsWith('/orchestrator/bin/run.ts')).toBe(true);
      expect(invokeOnceBin().endsWith('/orchestrator/bin/invoke-once.ts')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
