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
