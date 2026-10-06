import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FAIR_ARM_IDS, workspaceDirs } from './fair-comparison-cli';

// P-017 (D-011..D-016): each arm's tree gets node_modules/<name> links built from the
// root `workspaces`. workspaceDirs is the expansion; a pattern it cannot expand would
// silently drop links and make cross-package answers look like engine misses.

const root = mkdtempSync(join(tmpdir(), 'p017-ws-'));
const pkg = (dir: string, name = dir.replace(/\//g, '-')) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name }));
};
pkg('apps/operator');
pkg('packages/a');
pkg('packages/b');
mkdirSync(join(root, 'packages/no-manifest'), { recursive: true });
writeFileSync(join(root, 'packages/README.md'), 'not a package');
pkg('libs/exact');
mkdirSync(join(root, 'libs/exact-missing-manifest'), { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('workspaceDirs', () => {
  it('expands a trailing /* to the child dirs that hold a package.json', async () => {
    expect((await workspaceDirs(root, ['packages/*'])).sort()).toEqual(['packages/a', 'packages/b']);
  });

  it('keeps an exact dir only when it holds a package.json', async () => {
    expect(await workspaceDirs(root, ['libs/exact', 'libs/exact-missing-manifest', 'apps/operator'])).toEqual(['libs/exact', 'apps/operator']);
  });

  it('treats a missing /* parent as empty rather than throwing', async () => {
    expect(await workspaceDirs(root, ['nowhere/*', 'packages/a'])).toEqual(['packages/a']);
  });

  it('expands every pattern in the real root workspaces to at least one package', async () => {
    const repo = resolve(__dirname, '../../../..');
    const { workspaces = [] } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { workspaces?: string[] };
    expect(workspaces.length).toBeGreaterThan(0);
    // Only exact dirs and one trailing /* are supported; any other glob shape would expand to nothing.
    const unsupported = workspaces.filter((p) => /[*?{[]/.test(p.endsWith('/*') ? p.slice(0, -2) : p));
    expect(unsupported).toEqual([]);
    for (const p of workspaces) {
      expect(await workspaceDirs(repo, [p]), p).not.toEqual([]);
    }
  });
});

describe('FAIR_ARM_IDS', () => {
  it('names the eight arms the preregistration froze', () => {
    expect([...FAIR_ARM_IDS].sort()).toEqual(['codebase-memory', 'codegraph', 'codegraphcontext', 'gitnexus', 'lsp-query', 'no-third-party', 'rg', 'trace-mcp']);
  });
});
