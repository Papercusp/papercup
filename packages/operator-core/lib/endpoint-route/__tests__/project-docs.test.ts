/**
 * resolveDocsRoot (D-004c, pui-completion-and-polish-2026-06-05): a harness
 * re-points its docs root via its own contract surface `.papercusp/docs.json`
 * (papercup → its real Starlight corpus instead of the stray top-level docs/).
 * Invalid/missing declarations fall back to `<project>/docs`, and a declared
 * root can never escape the project (traversal-guarded).
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDocsRoot } from '../routes/harness/project-docs';

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'project-docs-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  return root;
}

function declare(projectRoot: string, body: string): void {
  mkdirSync(join(projectRoot, '.papercusp'), { recursive: true });
  writeFileSync(join(projectRoot, '.papercusp', 'docs.json'), body);
}

describe('resolveDocsRoot', () => {
  it('defaults to <project>/docs without a declaration', async () => {
    const p = makeProject();
    expect(await resolveDocsRoot(p)).toBe(join(p, 'docs'));
  });

  it('honors a declared root that exists inside the project', async () => {
    const p = makeProject();
    mkdirSync(join(p, 'apps/operator-docs/src/content/docs'), { recursive: true });
    declare(p, JSON.stringify({ root: 'apps/operator-docs/src/content/docs' }));
    expect(await resolveDocsRoot(p)).toBe(join(p, 'apps/operator-docs/src/content/docs'));
  });

  it('falls back when the declared root is missing on disk', async () => {
    const p = makeProject();
    declare(p, JSON.stringify({ root: 'not/there' }));
    expect(await resolveDocsRoot(p)).toBe(join(p, 'docs'));
  });

  it('rejects traversal outside the project', async () => {
    const p = makeProject();
    declare(p, JSON.stringify({ root: '../../etc' }));
    expect(await resolveDocsRoot(p)).toBe(join(p, 'docs'));
  });

  it('falls back on malformed json or a non-string root', async () => {
    const a = makeProject();
    declare(a, '{not json');
    expect(await resolveDocsRoot(a)).toBe(join(a, 'docs'));
    const b = makeProject();
    declare(b, JSON.stringify({ root: 42 }));
    expect(await resolveDocsRoot(b)).toBe(join(b, 'docs'));
  });
});
