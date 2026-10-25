import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { candidateDirectory, prepareCandidate } from '../../desktop-portal-candidate';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function root() {
  const path = mkdtempSync(resolve(tmpdir(), 'desktop-candidate-'));
  directories.push(path);
  return path;
}

describe('private desktop candidate publication boundary', () => {
  it('accepts a new private output without creating it and refuses ordinary or previously written outputs', () => {
    const repo = root();
    const output = resolve(repo, '.papercusp/private-desktop-candidates/one');
    expect(candidateDirectory(repo, output)).toBe(output);
    expect(existsSync(output)).toBe(false);
    expect(() => candidateDirectory(repo, resolve(repo, 'apps/operator-vite/dist'))).toThrow('private-desktop-candidates');
    expect(() => candidateDirectory(repo, '.papercusp/private-desktop-candidates/one')).toThrow('absolute');
    mkdirSync(output, { recursive: true });
    expect(() => candidateDirectory(repo, output)).toThrow('already exists');
  });

  it('refuses symlinked private parents before any build or write', () => {
    const repo = root();
    const outside = root();
    mkdirSync(resolve(repo, '.papercusp'));
    symlinkSync(outside, resolve(repo, '.papercusp/private-desktop-candidates'));
    expect(() => candidateDirectory(repo, resolve(repo, '.papercusp/private-desktop-candidates/one'))).toThrow('symlinks');
    expect(existsSync(resolve(outside, 'one'))).toBe(false);
  });

  it('refuses an unspecified output before loading or compiling the maintained portal', async () => {
    await expect(prepareCandidate([])).rejects.toThrow('--output');
  });
});
