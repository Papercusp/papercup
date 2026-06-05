/**
 * Release-path isolation check — the plan's #1 risk is that a runtime read still
 * hits the churning integration tree, so the operator would run `ready` code with
 * HEAD config. `verifyReleasePaths` is the guard: every runtime read must resolve
 * UNDER the release root. The resolvers all key off process.cwd(), so we build a
 * fake release tree, chdir into <release>/apps/operator (where the deploy runs the
 * verifier), and assert under-release ⇒ ok / a different root ⇒ the OUTSIDE
 * failure. Pure FS, no network/git.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReleasePaths } from './verify-release-paths';

let release: string;
let opCwd: string;
let origCwd: string;

/**
 * Lay out, under `root`, every subtree the verifier's resolvers look for when
 * cwd === <root>/apps/operator:
 *   resolveSqlDir       → <root>/libs/papercusp/libs/db/sql
 *   operatorPrompts     → <root>/apps/operator/prompts
 *   scannerPrompt       → <root>/libs/papercusp/packages/harness/prompts/scanner.md
 *   internalDocs        → <root>/apps/operator/public/internal/docs
 */
function buildReleaseTree(root: string): void {
  mkdirSync(join(root, 'libs/papercusp/libs/db/sql'), { recursive: true });
  writeFileSync(join(root, 'libs/papercusp/libs/db/sql', '107-x.sql'), 'SELECT 1;');
  mkdirSync(join(root, 'apps/operator/prompts'), { recursive: true });
  writeFileSync(join(root, 'apps/operator/prompts', 'operator.md'), '# prompt');
  mkdirSync(join(root, 'libs/papercusp/packages/harness/prompts'), { recursive: true });
  writeFileSync(join(root, 'libs/papercusp/packages/harness/prompts', 'scanner.md'), '# scanner');
  mkdirSync(join(root, 'apps/operator/public/internal/docs'), { recursive: true });
}

beforeEach(() => {
  origCwd = process.cwd();
  release = mkdtempSync(join(tmpdir(), 'rel-verify-'));
  buildReleaseTree(release);
  opCwd = join(release, 'apps/operator');
  // PAPERCUSP_DOCS_ROOT would short-circuit docsRootResolved → keep it unset.
  delete process.env.PAPERCUSP_DOCS_ROOT;
  process.chdir(opCwd);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(release, { recursive: true, force: true });
});

describe('verifyReleasePaths', () => {
  it('reports ok:true when every runtime read resolves under the release root', () => {
    const r = verifyReleasePaths(release);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    // every check resolved under-release
    expect(r.checks.every((c) => c.underRelease)).toBe(true);
    // the must-exist runtime reads were found on disk
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    expect(byName.sqlMigrations.exists).toBe(true);
    expect(byName.operatorPrompts.exists).toBe(true);
    expect(byName.scannerPrompt.exists).toBe(true);
  });

  it('reports ok:false with an OUTSIDE-release-root failure when a read resolves outside the passed root', () => {
    // cwd still resolves into `release`, but we declare a *different* (empty)
    // directory as the release root — so every real read is now OUTSIDE it.
    const otherRoot = mkdtempSync(join(tmpdir(), 'rel-other-'));
    try {
      const r = verifyReleasePaths(otherRoot);
      expect(r.ok).toBe(false);
      expect(r.failures.length).toBeGreaterThan(0);
      // the failure names the OUTSIDE-release-root condition
      expect(r.failures.some((f) => /resolved OUTSIDE release root/.test(f))).toBe(true);
      // and specifically the sql-migrations read (a real must-exist resolver) is flagged
      expect(r.failures.some((f) => /sqlMigrations: resolved OUTSIDE release root/.test(f))).toBe(true);
      // none of the resolved checks count as under-release
      expect(r.checks.every((c) => !c.underRelease)).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
