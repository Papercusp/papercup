/**
 * testing-run — the cargo runner's `--manifest-path` support (EI-1610).
 *
 * A standalone first-party crate (apps/tui, apps/pui-companion-proto, …) has no
 * root Cargo.toml workspace, so `cargo test -p <crate>` from the repo root fails
 * with "could not find Cargo.toml". With `manifestPath`, the runner points cargo
 * at the crate's own manifest instead — and falls back to the unchanged `-p`
 * workspace path when omitted.
 */
import { describe, it, expect } from 'vitest';
import { toSpawn, type TestRunner } from './testing-run';

describe('toSpawn — vitest runner (EI-8902 --config resolution)', () => {
  it('threads --config when a real file resolves to a package-level vitest.config.ts', () => {
    // This repo's own apps/operator-vite has a real vitest.config.ts, so a real
    // file inside it exercises the actual resolution against the real fs
    // (matches the false-positive symptom's exact package) rather than a mock.
    const r = toSpawn({ kind: 'vitest', filePath: 'apps/operator-vite/src/components/adv/AdvFramesTab.test.tsx' });
    if ('error' in r) throw new Error(r.error);
    expect(r.command).toBe('npx');
    expect(r.args[0]).toBe('vitest');
    expect(r.args[1]).toBe('run');
    expect(r.args).toContain('--config');
    const configIdx = r.args.indexOf('--config');
    expect(r.args[configIdx + 1]).toMatch(/apps[/\\]operator-vite[/\\]vitest\.config\.(ts|mts|js|mjs|cjs)$/);
    expect(r.args[r.args.length - 1]).toBe('apps/operator-vite/src/components/adv/AdvFramesTab.test.tsx');
  });

  it('vitest-multi resolves --config from the first file', () => {
    const r = toSpawn({
      kind: 'vitest-multi',
      filePaths: [
        'apps/operator-vite/src/components/adv/AdvFramesTab.test.tsx',
        'apps/operator-vite/src/components/adv/LearningTab.test.tsx',
      ],
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.args).toContain('--config');
    expect(r.args).toContain('apps/operator-vite/src/components/adv/AdvFramesTab.test.tsx');
    expect(r.args).toContain('apps/operator-vite/src/components/adv/LearningTab.test.tsx');
  });

  it('omits --config for a path with no vitest.config anywhere up to the workspace root', () => {
    const r = toSpawn({ kind: 'vitest', filePath: 'this/path/does/not/exist.test.ts' });
    if ('error' in r) throw new Error(r.error);
    expect(r.args).not.toContain('--config');
    expect(r.args).toEqual(['vitest', 'run', 'this/path/does/not/exist.test.ts']);
  });
});

describe('toSpawn — cargo runner', () => {
  it('without manifestPath: selects the crate via -p from the repo root (unchanged)', () => {
    const r = toSpawn({ kind: 'cargo', crate: 'pui-companion' });
    if ('error' in r) throw new Error(r.error);
    expect(r.command).toBe('cargo');
    expect(r.args).toEqual(['test', '-p', 'pui-companion', '--message-format=json']);
  });

  it('with manifestPath: targets the crate manifest and omits -p (EI-1610)', () => {
    const r = toSpawn({
      kind: 'cargo',
      crate: 'pui-companion',
      manifestPath: 'apps/pui-companion-proto/Cargo.toml',
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.args).toEqual([
      'test',
      '--manifest-path',
      'apps/pui-companion-proto/Cargo.toml',
      '--message-format=json',
    ]);
    expect(r.args).not.toContain('-p');
  });

  it('threads the test filter alongside manifestPath; label still names the crate', () => {
    const r = toSpawn({ kind: 'cargo', crate: 'c', test: 'my_test', manifestPath: 'x/Cargo.toml' });
    if ('error' in r) throw new Error(r.error);
    expect(r.args).toEqual([
      'test',
      '--manifest-path',
      'x/Cargo.toml',
      'my_test',
      '--message-format=json',
    ]);
    expect(r.label).toBe('cargo c::my_test');
  });

  it('still errors when crate is missing (manifestPath does not bypass the guard)', () => {
    const r = toSpawn({ kind: 'cargo', manifestPath: 'x/Cargo.toml' } as TestRunner);
    expect('error' in r).toBe(true);
  });
});
