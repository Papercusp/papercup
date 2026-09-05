import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_MD_CLAUSE_MARKERS,
  ROOT_PRESCRIBED_SCRIPTS,
  judgeNpmScriptResolution,
  type CoveringPackage,
} from './npm-script-cwd-resolution';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');
const OPERATOR_CORE = join(REPO_ROOT, 'packages/operator-core');

function scriptsOf(packageDir: string): string[] {
  const parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, unknown>;
  };
  return Object.keys(parsed.scripts ?? {});
}

function nameOf(packageDir: string): string | undefined {
  const parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    name?: unknown;
  };
  return typeof parsed.name === 'string' ? parsed.name : undefined;
}

describe('npm script cwd-resolution doc claim', () => {
  // ── Fixture controls: the judge must be able to answer BOTH ways ──────────────
  // Permanent controls rather than a tree mutation (the mutation-probe tier for an
  // imported module). Without the resolving control, a judge hardcoded to report
  // "missing" would satisfy every real-tree assertion below.
  describe('fixture controls', () => {
    const ROOT: CoveringPackage = {
      dir: '/repo',
      name: '@x/root',
      scripts: ['test:affected', 'lint:tsc'],
    };
    const WORKSPACE: CoveringPackage = {
      dir: '/repo/packages/thing',
      name: '@x/thing',
      scripts: ['lint:tsc'],
    };

    it('resolves a root script when the cwd IS the root', () => {
      const v = judgeNpmScriptResolution({
        cwd: '/repo',
        packages: [ROOT, WORKSPACE],
        script: 'test:affected',
      });
      expect(v.resolves).toBe(true);
      expect(v.failure).toBeNull();
      expect(v.governingDir).toBe('/repo');
      expect(v.shadowedByNearerPackage).toBe(false);
    });

    it('reports Missing script — naming the WORKSPACE — from a workspace subdir', () => {
      const v = judgeNpmScriptResolution({
        cwd: '/repo/packages/thing/lib/deep',
        packages: [ROOT, WORKSPACE],
        script: 'test:affected',
      });
      expect(v.resolves).toBe(false);
      expect(v.failure).toBe('missing-script');
      expect(v.governingDir).toBe('/repo/packages/thing');
      expect(v.governingName).toBe('@x/thing');
      // The whole point of the doc clause: the script is real and runnable, just not
      // from here — so "it does not exist" is the wrong reading.
      expect(v.shadowedByNearerPackage).toBe(true);
    });

    it('does not cry shadowing when the script exists nowhere', () => {
      const v = judgeNpmScriptResolution({
        cwd: '/repo/packages/thing',
        packages: [ROOT, WORKSPACE],
        script: 'no-such-script',
      });
      expect(v.failure).toBe('missing-script');
      expect(v.shadowedByNearerPackage).toBe(false);
    });

    it('resolves against the nearer package when IT declares the script', () => {
      const v = judgeNpmScriptResolution({
        cwd: '/repo/packages/thing/lib',
        packages: [ROOT, WORKSPACE],
        script: 'lint:tsc',
      });
      expect(v.resolves).toBe(true);
      expect(v.governingDir).toBe('/repo/packages/thing');
    });

    it('is not fooled by a sibling directory sharing a name prefix', () => {
      const sibling: CoveringPackage = { dir: '/repo/packages/thing-extra', scripts: [] };
      const v = judgeNpmScriptResolution({
        cwd: '/repo/packages/thing/lib',
        packages: [ROOT, WORKSPACE, sibling],
        script: 'lint:tsc',
      });
      expect(v.governingDir).toBe('/repo/packages/thing');
    });

    it('reports no-package when nothing covers the cwd', () => {
      const v = judgeNpmScriptResolution({ cwd: '/tmp/x', packages: [ROOT], script: 'x' });
      expect(v.failure).toBe('no-package');
      expect(v.governingDir).toBeNull();
    });
  });

  // ── The real tree: is the documented trap still live? ─────────────────────────
  describe('the claim against this repo', () => {
    it('the root declares every script CLAUDE.md prescribes by name', () => {
      const rootScripts = scriptsOf(REPO_ROOT);
      for (const script of ROOT_PRESCRIBED_SCRIPTS) {
        expect(rootScripts, `root package.json should declare ${script}`).toContain(script);
      }
    });

    it('none of them resolve from a packages/operator-core subdir', () => {
      const packages: CoveringPackage[] = [
        { dir: REPO_ROOT, name: nameOf(REPO_ROOT), scripts: scriptsOf(REPO_ROOT) },
        { dir: OPERATOR_CORE, name: nameOf(OPERATOR_CORE), scripts: scriptsOf(OPERATOR_CORE) },
      ];

      for (const script of ROOT_PRESCRIBED_SCRIPTS) {
        const v = judgeNpmScriptResolution({
          cwd: join(OPERATOR_CORE, 'lib/agent-tools/plans'),
          packages,
          script,
        });
        // If this ever fails, the trap is gone for that script and the CLAUDE.md clause
        // — including its named examples — must be revisited rather than left asserting
        // something that is no longer true.
        expect(v.resolves, `${script} unexpectedly resolves from an operator-core subdir`).toBe(
          false,
        );
        expect(v.shadowedByNearerPackage).toBe(true);
        expect(v.governingDir).toBe(OPERATOR_CORE);
      }
    });

    it('most root scripts are absent from operator-core, so the redirect is the common case', () => {
      const rootScripts = scriptsOf(REPO_ROOT);
      const workspaceScripts = new Set(scriptsOf(OPERATOR_CORE));
      const absent = rootScripts.filter((s) => !workspaceScripts.has(s));
      // Direction, not digits: the prose carries a dated measurement, this pins the
      // characterisation the clause rests on ("the root commands … die").
      expect(absent.length).toBeGreaterThan(rootScripts.length / 2);
    });

    it('CLAUDE.md still carries the clause', () => {
      expect(existsSync(CLAUDE_MD)).toBe(true);
      const text = readFileSync(CLAUDE_MD, 'utf8');
      for (const marker of CLAUDE_MD_CLAUSE_MARKERS) {
        expect(text, `CLAUDE.md should still state: ${marker}`).toContain(marker);
      }
    });
  });
});
