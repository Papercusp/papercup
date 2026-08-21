import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const API_ALIAS = 'npm:@typescript/typescript6@6.0.2';
const NATIVE_ALIAS = 'npm:typescript@7.0.2';
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.papercusp',
  '_retired',
  'coverage',
  'dist',
  'node_modules',
]);

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function manifestsDeclaringTypeScript(): Array<{ path: string; manifest: Manifest }> {
  const paths = [join(REPO_ROOT, 'package.json')];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name));
      } else if (entry.name === 'package.json') {
        paths.push(join(directory, entry.name));
      }
    }
  };
  for (const directory of ['apps', 'packages', 'libs', 'tools']) {
    visit(join(REPO_ROOT, directory));
  }

  return paths.flatMap((path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    const declaresTypeScript = DEPENDENCY_SECTIONS.some(
      (section) => manifest[section]?.typescript !== undefined,
    );
    return declaresTypeScript ? [{ path, manifest }] : [];
  });
}

describe('Papercusp TypeScript toolchain contract', () => {
  it('pins every active TypeScript consumer to the native CLI and official API alias', () => {
    const consumers = manifestsDeclaringTypeScript();
    const relativePaths = consumers.map(({ path }) => path.slice(REPO_ROOT.length)).sort();

    expect(relativePaths).toEqual([
      'apps/operator-docs/package.json',
      'apps/operator-public/package.json',
      'apps/operator-vite/package.json',
      'apps/operator/package.json',
      'apps/papercusp-docs/package.json',
      'apps/papercusp-publish/package.json',
      'apps/the-swarm-site/package.json',
      'libs/generic/artifact-registry/package.json',
      'libs/generic/dock-workbench/package.json',
      'libs/generic/resumable-download/package.json',
      'libs/generic/sse/package.json',
      'libs/generic/tooldef/package.json',
      'libs/host-platform/package.json',
      'package.json',
      'tools/perf-test/wdio/package.json',
    ]);

    for (const { path, manifest } of consumers) {
      for (const section of DEPENDENCY_SECTIONS) {
        if (manifest[section]?.typescript === undefined) continue;
        expect(manifest[section]?.typescript, path).toBe(API_ALIAS);
      }
      expect(
        manifest.devDependencies?.['@typescript/native'] ??
          manifest.dependencies?.['@typescript/native'],
        path,
      ).toBe(NATIVE_ALIAS);
    }
  });

  it('resolves tsc to 7.0.2 while preserving the TypeScript 6 compiler API', () => {
    const tsc = join(REPO_ROOT, 'node_modules/.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    expect(execFileSync(tsc, ['--version'], { encoding: 'utf8' }).trim()).toBe(
      'Version 7.0.2',
    );

    const requireFromRoot = createRequire(join(REPO_ROOT, 'package.json'));
    const apiManifest = requireFromRoot('typescript/package.json') as {
      name: string;
      version: string;
    };
    const ts = requireFromRoot('typescript') as {
      version: string;
      createSourceFile?: unknown;
    };
    expect(apiManifest).toMatchObject({
      name: '@typescript/typescript6',
      version: '6.0.2',
    });
    expect(ts.version).toMatch(/^6\.0\./);
    expect(ts.createSourceFile).toBeTypeOf('function');
  });
});
