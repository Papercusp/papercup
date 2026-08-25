/**
 * The Figma-overlay clause: an optional review aid may never become a gate
 * dependency.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * P-008 requires that "optional Figma overlay UX, if selected, cannot become a
 * gate dependency". Today no such UX exists — the only Figma-shaped things in
 * the system are the `figma-export` reference CLASS and a free-text `sourceRef`
 * on a ratification. So there is nothing to remove, and the clause is really a
 * question about the FUTURE: when someone adds an overlay, what stops it
 * quietly becoming load-bearing?
 *
 * A comment does not stop it. What stops it is a test that fails the moment the
 * verdict path acquires a dependency on overlay or live-Figma machinery. That
 * is what this file is: a standing guard on a seam that is currently clean,
 * written now precisely BECAUSE it is currently clean — the cheapest moment to
 * pin a boundary is before anything is pressing on it.
 *
 * Two independent properties are checked, because either alone is escapable:
 *   1. DATA — the verdict is a function of counts and policy. `overlayImage`
 *      exists in `ComparisonArtifacts` and no verdict reads it.
 *   2. DEPENDENCY — no module on the gate path imports an overlay/Figma-live
 *      module, transitively.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { computeVerdict, type ThresholdPolicy } from './contract';

const HERE = __dirname;

/**
 * The modules a verdict actually travels through, from raw counts to a
 * completion refusal. Listed rather than discovered: the point is to state what
 * the gate path IS, so that adding a module to it is a deliberate edit here.
 */
const GATE_PATH_MODULES = [
  'contract.ts',
  'policy.ts',
  'policy-shape.ts',
  'gate.ts',
  'feature-gate.ts',
] as const;

/**
 * Things that would make an overlay load-bearing. `figma-export` is excluded on
 * purpose: it is a reference CLASS — a description of how an already-ratified
 * image was produced — not a live dependency on Figma.
 */
const FORBIDDEN_ON_GATE_PATH = [
  /\boverlay\b(?!Image)/i,
  /figma[-.]?(api|client|live|sdk|plugin|fetch)/i,
  /from ['"][^'"]*figma[^'"]*['"]/i,
];

function sourceOf(moduleName: string): string {
  return readFileSync(path.join(HERE, moduleName), 'utf8');
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1] as string);
}

describe('an overlay cannot become a gate dependency', () => {
  it('lists gate-path modules that all exist, so no scan below passes vacuously', () => {
    for (const moduleName of GATE_PATH_MODULES) {
      expect(() => sourceOf(moduleName), `${moduleName} is missing`).not.toThrow();
    }
  });

  describe.each(GATE_PATH_MODULES)('%s', (moduleName) => {
    it('imports no overlay or live-Figma module', () => {
      const source = sourceOf(moduleName);
      for (const relativeImport of importsOf(source)) {
        expect(
          /overlay|figma/i.test(relativeImport),
          `${moduleName} imports '${relativeImport}' on the gate path`,
        ).toBe(false);
      }
    });

    it('names nothing overlay-shaped in its executable code', () => {
      // Comments are stripped first: this file and the modules it scans discuss
      // overlays deliberately, and a guard that cannot survive its own
      // documentation is a guard people delete.
      const executable = sourceOf(moduleName)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      for (const pattern of FORBIDDEN_ON_GATE_PATH) {
        expect(pattern.test(executable), `${moduleName} references ${pattern} in code`).toBe(false);
      }
    });
  });

  it('reaches a verdict from counts and policy alone', () => {
    // The data-side property. If a verdict ever needed an overlay, it could not
    // be computed from this input — there is nowhere to put one.
    const policy: ThresholdPolicy = {
      policyVersion: 'test',
      referenceClass: 'artifact-capture',
      eligibility: 'gateable',
      maxDiffRatio: 0.001,
      derivedFrom: 'test',
    };
    expect(computeVerdict({ counts: { pixelDifference: 0, pixelsTotal: 1000 }, policy }).verdict)
      .toBe('pass');
    expect(computeVerdict({ counts: { pixelDifference: 500, pixelsTotal: 1000 }, policy }).verdict)
      .toBe('fail');
  });

  it('keeps overlayImage optional, so evidence without one is complete evidence', () => {
    // If `overlayImage` were required on ComparisonArtifacts, every producer
    // would have to make one, and an optional review aid would have become a
    // precondition for recording evidence at all — the exact dependency this
    // clause forbids, arriving through the type system rather than through an
    // import.
    const contract = sourceOf('contract.ts');
    expect(contract).toMatch(/readonly overlayImage\?:/);
  });
});
