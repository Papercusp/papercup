import { describe, it, expect } from 'vitest';
// bumpPatch moved from page.tsx to the client component during the snapshots refactor.
import { bumpPatch } from './InstalledSnapshotsClient';

describe('bumpPatch', () => {
  it('bumps a plain semver patch', () => {
    expect(bumpPatch('1.0.0')).toBe('1.0.1');
    expect(bumpPatch('0.0.0')).toBe('0.0.1');
    expect(bumpPatch('1.2.3')).toBe('1.2.4');
    expect(bumpPatch('10.20.30')).toBe('10.20.31');
  });

  it('strips prerelease/build metadata and bumps the base patch', () => {
    expect(bumpPatch('1.0.0-ts1762541200000')).toBe('1.0.1');
    expect(bumpPatch('2.5.0-alpha.3')).toBe('2.5.1');
    expect(bumpPatch('1.0.0+build.1')).toBe('1.0.1');
  });

  it('falls back to -r2 / -r3 suffix when the input is not semver', () => {
    expect(bumpPatch('weird-string')).toBe('weird-string-r2');
    expect(bumpPatch('weird-string-r2')).toBe('weird-string-r3');
    expect(bumpPatch('weird-string-r99')).toBe('weird-string-r100');
  });

  it('idempotent on the bumped output (republish repeatedly)', () => {
    let v = '1.0.0';
    for (let i = 0; i < 5; i++) v = bumpPatch(v);
    expect(v).toBe('1.0.5');
  });
});
