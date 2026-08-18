/**
 * The recurrence guard for WI-39849's CLASS — a variable-arity read fan-out
 * added to a function that establishes no deadline.
 *
 * WHY THE CONTROLS ARE PERMANENT
 *
 * This suite's headline assertion is an ABSENCE ("no unbounded variable-arity
 * fan-out survives in the sync-resolver tree"), and an absence claim is exactly
 * the kind that passes for the wrong reason: a glob that matches nothing, a
 * predicate that flags nothing, an analyzer that silently returns []. Each of
 * those reads identically to a clean tree.
 *
 * So the controls below are not scaffolding to delete once it goes green — they
 * are the positive controls that make the green mean something, and they live
 * here for good. Per the repo's mutation-probe guidance, they are deliberately
 * wrong INPUTS held in this file, never a mutation of the shared tree.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BOUNDING_SEAMS,
  FANOUT_EXEMPTIONS,
  describeFanOut,
  findVariableArityFanOuts,
  unboundedFanOuts,
} from './fanout-bound-audit';

const RESOLVER_DIR = fileURLToPath(new URL('.', import.meta.url));

/** CONTROL — the exact defect WI-39849 fixed, held here so the guard can prove it fires. */
const CONTROL_UNBOUNDED = `
export const SYNC_QUERIES = {
  'hive.example': {
    resolve: async () => {
      const hives = await listPots(ws).catch(() => []);
      return Promise.all(
        hives.map(async (hv) => ({
          slug: hv.slug,
          steering: await getOwnerSteering(ws, hv.slug).catch(() => null),
        })),
      );
    },
  },
};
`;

/** CALIBRATION — the same read, bounded. The guard must go quiet on exactly this change. */
const CALIBRATION_BOUNDED = CONTROL_UNBOUNDED.replace(
  'const hives = await listPots(ws).catch(() => []);',
  [
    'const withinBudget = createReadDeadline(6_000);',
    '      const hives = await withinBudget(listPots(ws), "listPots").catch(() => []);',
  ].join('\n      '),
);

/** CONTROL — a FIXED-arity fan-out. Out of this predicate's scope by design. */
const CONTROL_FIXED_ARITY = `
export const SYNC_QUERIES = {
  'hive.fixed': {
    resolve: async () => {
      const [a, b] = await Promise.all([readA(), readB()]);
      return [{ a, b }];
    },
  },
};
`;

function auditedFiles(): string[] {
  return readdirSync(RESOLVER_DIR)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && f !== 'fanout-bound-audit.ts')
    .sort();
}

describe('fanout-bound-audit — the analyzer itself (controls, permanent)', () => {
  it('CONTROL: FLAGS an unbounded variable-arity fan-out', () => {
    const sites = findVariableArityFanOuts(CONTROL_UNBOUNDED, 'control.ts');
    expect(sites).toHaveLength(1);
    expect(sites[0]!.resolverKey).toBe('hive.example');
    expect(sites[0]!.boundedBy).toBeNull();
    expect(unboundedFanOuts(sites)).toHaveLength(1);
  });

  it('CALIBRATION: the SAME read goes quiet once a deadline bounds it', () => {
    // Guards against a control that "passes" because the analyzer flags everything.
    expect(CALIBRATION_BOUNDED).not.toBe(CONTROL_UNBOUNDED);
    const sites = findVariableArityFanOuts(CALIBRATION_BOUNDED, 'calibration.ts');
    expect(sites).toHaveLength(1);
    expect(sites[0]!.boundedBy).toBe('createReadDeadline');
    expect(unboundedFanOuts(sites)).toHaveLength(0);
  });

  it('CONTROL: a FIXED-arity Promise.all is NOT this predicate (scope is variable arity)', () => {
    expect(findVariableArityFanOuts(CONTROL_FIXED_ARITY, 'fixed.ts')).toHaveLength(0);
  });

  it('an injected withinBudget counts as bounded (the extracted *-read.ts seam)', () => {
    const injected = CONTROL_UNBOUNDED.replace(
      'resolve: async () => {',
      'resolve: async ({ withinBudget }) => {',
    );
    expect(unboundedFanOuts(findVariableArityFanOuts(injected, 'injected.ts'))).toHaveLength(0);
  });

  it('every declared seam is one the analyzer actually honours', () => {
    for (const seam of BOUNDING_SEAMS) {
      const bounded = CONTROL_UNBOUNDED.replace(
        'const hives =',
        `const _seam = ${seam};\n      const hives =`,
      );
      expect(
        unboundedFanOuts(findVariableArityFanOuts(bounded, `${seam}.ts`)),
        `seam ${seam} is declared but does not silence the finding`,
      ).toHaveLength(0);
    }
  });
});

describe('fanout-bound-audit — the live sync-resolver tree', () => {
  const sites = auditedFiles().flatMap((f) =>
    findVariableArityFanOuts(readFileSync(path.join(RESOLVER_DIR, f), 'utf8'), f),
  );

  it('the audited population is NON-TRIVIAL (a zero here would be a broken instrument)', () => {
    // The absence assertion below is only meaningful if the analyzer is actually
    // reading files. A refactor that moves or renames the resolver tree must fail
    // HERE — loudly — rather than turn the guard into a silent no-op.
    expect(auditedFiles().length).toBeGreaterThan(10);
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it('NO variable-arity fan-out is unbounded', () => {
    const unbounded = unboundedFanOuts(sites);
    expect(
      unbounded.map(describeFanOut),
      'A read fan-out whose leg count grows with the workspace has no deadline. Wrap its legs with a shared createReadDeadline(...) (see read-deadline.ts), or — if the legs do no store IO — add a FANOUT_EXEMPTIONS entry saying so.',
    ).toEqual([]);
  });

  it('every exemption names a site that actually exists (it cannot drift ahead of the tree)', () => {
    const identities = new Set(sites.flatMap((s) => [s.resolverKey ?? '', s.file]));
    for (const exemption of FANOUT_EXEMPTIONS) {
      expect(identities.has(exemption.where), `stale exemption: ${exemption.where}`).toBe(true);
      expect(exemption.reason.length).toBeGreaterThan(20);
    }
  });

  it('every exemption is load-bearing — removing it re-exposes a real finding', () => {
    // An exemption that changes nothing is a hole nobody is paying attention to.
    for (const exemption of FANOUT_EXEMPTIONS) {
      const without = FANOUT_EXEMPTIONS.filter((e) => e.where !== exemption.where);
      expect(
        unboundedFanOuts(sites, without).length,
        `exemption ${exemption.where} exempts nothing — delete it`,
      ).toBeGreaterThan(0);
    }
  });
});
