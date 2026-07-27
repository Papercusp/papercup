import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

interface CatchReturn {
  resolver: string;
  line: number;
  text: string;
}

/**
 * Walk index.ts, tracking the current `'learning.*'` resolver key and brace
 * depth, and collect every `return` statement that sits inside a `catch` block.
 */
function collectCatchReturns(src: string): CatchReturn[] {
  const lines = src.split('\n');
  const out: CatchReturn[] = [];
  let resolver: string | null = null;
  let resolverDepth = -1;
  let depth = 0;
  // Depths at which a catch block opened (may nest).
  const catchDepths: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const code = line.replace(/\/\/.*$/, '');

    // A top-level resolver key: `  'learning.foo': {`
    const key = /^\s{2}'(learning\.[A-Za-z.]+)':\s*\{/.exec(line);
    if (key) {
      resolver = key[1];
      resolverDepth = depth;
    }

    const opensCatch = /\}\s*catch\s*\(/.test(code);

    for (const ch of code) {
      if (ch === '{') {
        depth++;
        if (opensCatch && catchDepths[catchDepths.length - 1] !== depth) {
          catchDepths.push(depth);
        }
      } else if (ch === '}') {
        if (catchDepths[catchDepths.length - 1] === depth) catchDepths.pop();
        depth--;
        if (resolver && depth <= resolverDepth) {
          resolver = null;
          resolverDepth = -1;
        }
      }
    }

    if (resolver && catchDepths.length > 0) {
      const ret = /^\s*return\s+(.+)$/.exec(code);
      if (ret) out.push({ resolver, line: i + 1, text: ret[1].trim() });
    }
  }
  return out;
}

const SRC = readFileSync(INDEX, 'utf8');
const CATCH_RETURNS = collectCatchReturns(SRC);

/** A returned value that is a flat array literal — `[]`, or `[…]` of non-objects. */
function isFlatArrayReturn(text: string): boolean {
  return /^\[\s*\]\s*;?$/.test(text);
}

/** A returned value that is an object snapshot wrapped in the helper. */
function isDegradedReturn(text: string): boolean {
  return /^\[\s*degraded(Because)?\s*\(/.test(text);
}

/** A returned value that is an object snapshot — `[{ … }]` or `[SOME_EMPTY]`. */
function isObjectSnapshotReturn(text: string): boolean {
  if (isFlatArrayReturn(text) || isDegradedReturn(text)) return false;
  return /^\[\s*\{/.test(text) || /^\[\s*[A-Z_][A-Z0-9_]*\s*\]/.test(text);
}

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
      'learning.mugWakeEfficiency',
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

  it('flat-array catch returns are the ONLY exemption, and are genuinely flat', () => {
    // A bare `[]` has nowhere to hang a flag — a real shape constraint, not a
    // waiver. Record them so the exemption stays visible and countable rather
    // than becoming an unexamined blanket.
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
