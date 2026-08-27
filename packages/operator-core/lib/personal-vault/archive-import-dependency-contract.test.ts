import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(packageRoot, '../..');

describe('personal-vault archive import dependency contract', () => {
  it('declares the streaming parser packages at the operator-core import boundary', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.['stream-chain']).toBeTruthy();
    expect(manifest.dependencies?.['stream-json']).toBeTruthy();
  });

  it('checks operator-core dependencies before the expensive sidecar bundle step', () => {
    const buildScript = readFileSync(
      resolve(repoRoot, 'papercusp-desktop/bin/build-desktop-sidecar.sh'),
      'utf8',
    );
    const dependencyCheck = buildScript.slice(
      buildScript.indexOf('const pkgs = ['),
      buildScript.indexOf('for (const rel of pkgs)'),
    );

    expect(dependencyCheck).toContain('packages/operator-core/package.json');
  });
});
