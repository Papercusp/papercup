import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// WI-6410: the scanner moved to a shared module so the CLIENT half of this
// guard can ask the same question ("which resolvers can report unavailable?")
// with the same answer. Assertions below are unchanged.
import {
  collectCatchReturns,
  isDegradedReturn,
  isFlatArrayReturn,
  isObjectSnapshotReturn,
} from './learning-degraded-provenance.scan';

/**
 * WI-6382 structural guard: no `learning.*` resolver may return a BARE empty
 * snapshot from a catch block.
 *
 * ## Why this is a source scan and not a behavioural test
 *
 * The defect is not that any single resolver misbehaves — each one "works".
 * The defect is a CONVENTION that 16 resolvers independently violated, which is
 * precisely the shape a per-resolver behavioural test cannot hold: it passes for
 * the resolver you wrote it against and says nothing about the seventeenth one
 * added next month. The rule needs an enforcement mechanism, and a comment is
 * not one — proven twice in this very directory, where a comment in
 * learning-scout-read.ts explicitly ordered callers to reuse an inline pot
 * filter, predicted the exact failure of not doing so, and was then violated
 * twice anyway (WI-6385). So the rule is executable here.
 *
 * ## The rule
 *
 * Inside a `learning.*` resolver's `catch`, a returned OBJECT snapshot must be
 * wrapped in `degraded(...)` / `degradedBecause(...)`. Returning `[{ … }]`
 * bare makes a broken substrate byte-identical to a healthy idle one, which is
 * how the whole Learning tab came to render a data-layer failure as a confident
 * "nothing has happened yet".
 *
 * A catch returning a bare `[]` is exempt — a FLAT ARRAY has nowhere to carry a
 * flag. That exemption is verified structurally below rather than trusted, so
 * it cannot become a place to hide an object-shaped violation.
 */

const INDEX = join(__dirname, 'index.ts');

const SRC = readFileSync(INDEX, 'utf8');
const CATCH_RETURNS = collectCatchReturns(SRC);

describe('WI-6382 guard — learning.* catches must not return a bare empty', () => {
  // ── NON-BLINDNESS ────────────────────────────────────────────────────────
  // The lesson of the lens guard (plan D-005): a green result from a blind
  // instrument is indistinguishable from a green result from a working one.
  // If the scanner silently stops matching — a refactor renames the keys, the
  // brace walk desyncs, the file moves — every assertion below passes over an
  // empty set. So prove the instrument SEES before trusting what it reports.
  it('the scanner is not blind: it finds many learning.* resolvers and their catches', () => {
    const resolverKeys = [...SRC.matchAll(/^\s{2}'(learning\.[A-Za-z.]+)':\s*\{/gm)].map((m) => m[1]);
    expect(resolverKeys.length).toBeGreaterThanOrEqual(20);
    expect(CATCH_RETURNS.length).toBeGreaterThanOrEqual(15);
    // …and it attributes them to real, distinct resolvers.
    const seen = new Set(CATCH_RETURNS.map((r) => r.resolver));
    expect(seen.size).toBeGreaterThanOrEqual(10);
    for (const r of seen) expect(resolverKeys).toContain(r);
  });

  it('the scanner can actually SEE a violation (it is not vacuously green)', () => {
    // Feed it a resolver whose catch returns a bare object snapshot. If the
    // walker cannot flag this synthetic case, its silence on the real file
    // means nothing.
    const synthetic = [
      "  'learning.synthetic': {",
      '    resolve: async () => {',
      '      try {',
      '        return [{ rows: await read() }];',
      '      } catch (err) {',
      '        return [{ rows: [] }];',
      '      }',
      '    },',
      '  },',
    ].join('\n');
    const found = collectCatchReturns(synthetic);
    expect(found).toHaveLength(1);
    expect(found[0].resolver).toBe('learning.synthetic');
    expect(isObjectSnapshotReturn(found[0].text)).toBe(true);
  });

  it('would have RED-ed on the pre-fix file — the fix is what makes it green', () => {
    // The strongest available non-blindness proof, and the one the lens guard
    // taught (D-005): a guard that has never gone red is indistinguishable from
    // a guard that cannot. Reconstruct the PRE-FIX state from this very file by
    // mechanically unwrapping the helper, and assert the guard reports the real
    // violations it was built to catch. Done in memory — the tree is shared and
    // is swept whole by git-sync, so a "temporarily break it" proof would risk
    // committing the broken intermediate.
    const prefix = SRC.replace(/degraded(?:Because)?\(\s*([\s\S]*?),\s*err\s*\)/g, '$1');
    const violations = collectCatchReturns(prefix).filter((r) => isObjectSnapshotReturn(r.text));
    // Every resolver whose catch we wrapped must show up as a violation here.
    expect(violations.length).toBeGreaterThanOrEqual(8);
    const resolvers = new Set(violations.map((r) => r.resolver));
    for (const expected of [
      'learning.hiveThroughput',
      'learning.frontier',
      'learning.ekg',
      'learning.redQueen',
      'learning.soakReport',
    ]) {
      expect([...resolvers]).toContain(expected);
    }
  });

  // ── THE RULE ─────────────────────────────────────────────────────────────
  it('every object-shaped catch return carries degraded provenance', () => {
    const violations = CATCH_RETURNS.filter((r) => isObjectSnapshotReturn(r.text)).map(
      (r) => `${r.resolver} (index.ts:${r.line}): return ${r.text}`,
    );
    expect(violations).toEqual([]);
  });

  // WI-6395 TIGHTENS THIS FROM A COUNT TO A NAMED LIST.
  //
  // The exemption was always honest — a bare `[]` genuinely has nowhere to hang
  // a flag — but "however many there happen to be" is not a rule a future edit
  // can violate. It let a NEW flat-array resolver inherit the exemption silently,
  // which is how an exemption becomes a blanket. Naming the survivors makes the
  // set SHRINK-ONLY: fixing one requires deleting its line here, and adding one
  // requires arguing for it in a diff.
  //
  // Why each survivor is still here (WI-6395 fixed the rest):
  //   learning.hiveList — flat, but its only consumers are three files under
  //     apps/operator/app/**, which is the RETIRED standalone-webapp path
  //     (repo-conventions § retired surfaces). Enveloping it would break
  //     preserved-not-active code for zero live users. Resolve the retired
  //     question first; do not "fix" this one reflexively.
  const FLAT_ARRAY_EXEMPT = new Set(['learning.hiveList']);

  it('the flat-array exemption is a NAMED, shrink-only list — not a blanket', () => {
    const flat = CATCH_RETURNS.filter((r) => isFlatArrayReturn(r.text));
    for (const r of flat) expect(r.text).toMatch(/^\[\s*\]\s*;?$/);
    const unexpected = flat
      .filter((r) => !FLAT_ARRAY_EXEMPT.has(r.resolver))
      .map((r) => `${r.resolver} (index.ts:${r.line})`);
    expect(
      unexpected,
      'a NEW flat-array catch appeared. Give it degraded provenance (envelope it as ' +
        '`[{ items, ...degraded }]`, the shape the other learning.* reads use) — or, if it ' +
        'genuinely cannot carry one, add it to FLAT_ARRAY_EXEMPT above WITH the reason.',
    ).toEqual([]);
    // ...and the list may not carry a name that no longer needs it.
    const stale = [...FLAT_ARRAY_EXEMPT].filter(
      (name) => !flat.some((r) => r.resolver === name),
    );
    expect(stale, 'these no longer return a flat [] — delete them from FLAT_ARRAY_EXEMPT').toEqual([]);
  });

  it('flat-array catch returns are genuinely flat', () => {
    const flat = CATCH_RETURNS.filter((r) => isFlatArrayReturn(r.text));
    for (const r of flat) expect(r.text).toMatch(/^\[\s*\]\s*;?$/);
    // Every catch return is now accounted for by exactly one of the three
    // classes — no unclassified residue quietly slipping past the rule.
    const unclassified = CATCH_RETURNS.filter(
      (r) => !isFlatArrayReturn(r.text) && !isDegradedReturn(r.text) && !isObjectSnapshotReturn(r.text),
    );
    for (const r of unclassified) {
      // Anything left must be a non-snapshot return (a variable, a spread of a
      // real result) — never an inline empty object literal masquerading as one.
      expect(r.text).not.toMatch(/^\[\s*\{\s*\}\s*\]/);
    }
  });

  it('the helper is imported by index.ts (the rule has a live call site)', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bdegraded\b[^}]*\}\s*from\s*'\.\/degraded-snapshot'/);
    expect(CATCH_RETURNS.some((r) => isDegradedReturn(r.text))).toBe(true);
  });
});
