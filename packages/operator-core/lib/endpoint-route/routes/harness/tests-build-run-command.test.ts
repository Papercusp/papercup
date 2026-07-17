/**
 * EI-299 — .papercusp/tests.json TestItem.framework lacks cargo/shell.
 *
 * Unit coverage for buildRunCommand's per-framework (bin, args, cwd)
 * resolution, including the two new variants: 'cargo' (file = crate dir,
 * cargo test runs FROM that dir) and 'shell' (file = script path, run via
 * bash from the worktree root).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { buildRunCommand, type TestItem } from './tests';

function item(framework: TestItem['framework'], file: string): TestItem {
  return {
    id: 't1',
    summary: 'x',
    file,
    framework,
    coversVALs: [],
    status: 'not_run',
    lastRunTs: 0,
    durationMs: 0,
    phase: 'staging' as TestItem['phase'],
  };
}

const WT = '/wt/root';

describe('buildRunCommand', () => {
  it('playwright: npx playwright test <file>, cwd = worktree root', () => {
    expect(buildRunCommand(item('playwright', 'e2e/foo.spec.ts'), WT)).toEqual({
      bin: 'npx',
      args: ['playwright', 'test', 'e2e/foo.spec.ts'],
      cwd: WT,
    });
  });

  it('vitest: npx vitest run <file>, cwd = worktree root', () => {
    expect(buildRunCommand(item('vitest', 'lib/foo.test.ts'), WT)).toEqual({
      bin: 'npx',
      args: ['vitest', 'run', 'lib/foo.test.ts'],
      cwd: WT,
    });
  });

  it('pytest: pytest <file>, cwd = worktree root', () => {
    expect(buildRunCommand(item('pytest', 'tests/test_foo.py'), WT)).toEqual({
      bin: 'pytest',
      args: ['tests/test_foo.py'],
      cwd: WT,
    });
  });

  it('cargo: `cargo test` run FROM the crate dir named by `file` (no per-file arg)', () => {
    expect(buildRunCommand(item('cargo', 'papercusp-desktop/src-tauri'), WT)).toEqual({
      bin: 'cargo',
      args: ['test'],
      cwd: join(WT, 'papercusp-desktop/src-tauri'),
    });
  });

  it('shell: bash <file>, cwd = worktree root', () => {
    expect(buildRunCommand(item('shell', 'bin/smoke-test.sh'), WT)).toEqual({
      bin: 'bash',
      args: [join(WT, 'bin/smoke-test.sh')],
      cwd: WT,
    });
  });
});
