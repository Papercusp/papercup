import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CJS_TOP_LEVEL_AWAIT_ERROR,
  judgeScratchProbeDocClaim,
  judgeScratchProbeFormat,
  type CoveringPackageJson,
} from './scratch-probe-module-format';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRATCH_DIR = join(REPO_ROOT, '.papercusp/scratch');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');

/** Every real package.json from `dir` up to the filesystem root. */
function collectRealCoveringPackageJsons(dir: string): CoveringPackageJson[] {
  const found: CoveringPackageJson[] = [];
  let current = dir;
  for (;;) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) {
      let type: string | undefined;
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { type?: unknown };
        type = typeof parsed.type === 'string' ? parsed.type : undefined;
      } catch {
        type = undefined;
      }
      found.push({ dir: current, ...(type === undefined ? {} : { type }) });
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

describe('scratch-probe module format doc claim', () => {
  // ── Fixture controls: the detector must be able to FAIL, in BOTH directions ──
  // Kept permanently rather than mutating the tree, per the mutation-probe tier for an
  // imported module. Without the ESM control, a judge hardcoded to return 'cjs' would
  // pass every other assertion in this file.
  describe('fixture controls', () => {
    it('reports CJS when no package.json governs the probe path', () => {
      const v = judgeScratchProbeFormat({ probeDir: '/tmp', packageJsons: [] });
      expect(v.moduleFormat).toBe('cjs');
      expect(v.requiredExtension).toBe('.mts');
      expect(v.topLevelAwaitWorksInBareTs).toBe(false);
      expect(v.governingPackageJsonDir).toBeNull();
    });

    it('reports ESM when a governing package.json declares type: module', () => {
      const v = judgeScratchProbeFormat({
        probeDir: '/repo/packages/thing/lib',
        packageJsons: [{ dir: '/repo/packages/thing', type: 'module' }],
      });
      expect(v.moduleFormat).toBe('esm');
      expect(v.requiredExtension).toBe('.ts');
      expect(v.topLevelAwaitWorksInBareTs).toBe(true);
    });

    it('reports CJS when the governing package.json omits type (the repo-root case)', () => {
      const v = judgeScratchProbeFormat({
        probeDir: '/repo/.papercusp/scratch',
        packageJsons: [{ dir: '/repo' }],
      });
      expect(v.moduleFormat).toBe('cjs');
      expect(v.requiredExtension).toBe('.mts');
      expect(v.governingPackageJsonDir).toBe('/repo');
    });

    it('lets the NEAREST package.json win, so a nearer CJS one overrides an ESM ancestor', () => {
      const v = judgeScratchProbeFormat({
        probeDir: '/repo/.papercusp/scratch',
        packageJsons: [
          { dir: '/repo', type: 'module' },
          { dir: '/repo/.papercusp/scratch' },
        ],
      });
      expect(v.moduleFormat).toBe('cjs');
      expect(v.governingPackageJsonDir).toBe('/repo/.papercusp/scratch');
    });

    it('does not treat a sibling directory as a governing ancestor', () => {
      const v = judgeScratchProbeFormat({
        probeDir: '/repo/.papercusp/scratch-other',
        packageJsons: [{ dir: '/repo/.papercusp/scratch', type: 'module' }],
      });
      expect(v.moduleFormat).toBe('cjs');
      expect(v.governingPackageJsonDir).toBeNull();
    });

    it('flags a doc that reproduces the error but never names the .mts fix', () => {
      const v = judgeScratchProbeDocClaim({
        docText: `Probes live in .papercusp/scratch/. You may see: ${CJS_TOP_LEVEL_AWAIT_ERROR}`,
      });
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toContain('.mts');
    });

    it('accepts a doc that carries the location, the error, and the fix', () => {
      const v = judgeScratchProbeDocClaim({
        docText: `Name it .mts under .papercusp/scratch/ or you get: ${CJS_TOP_LEVEL_AWAIT_ERROR}`,
      });
      expect(v.ok).toBe(true);
      expect(v.problems).toEqual([]);
    });
  });

  // ── Live legs: these are what make this a PIN rather than a restatement ──
  describe('live tree', () => {
    it('the scratch tree is still CJS, so the documented .mts fix is still the right advice', () => {
      const v = judgeScratchProbeFormat({
        probeDir: SCRATCH_DIR,
        packageJsons: collectRealCoveringPackageJsons(SCRATCH_DIR),
      });
      // If this flips to 'esm' somebody dropped a `"type": "module"` package.json over the
      // scratch tree — a genuine fix that makes a bare `.ts` probe work. That is GOOD news,
      // but it makes the CLAUDE.md guidance wrong: update the doc, then this assertion.
      expect(v.moduleFormat).toBe('cjs');
      expect(v.requiredExtension).toBe('.mts');
    });

    it('CLAUDE.md carries the location, the misleading error, and the fix', () => {
      const v = judgeScratchProbeDocClaim({ docText: readFileSync(CLAUDE_MD, 'utf8') });
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
    });
  });
});
