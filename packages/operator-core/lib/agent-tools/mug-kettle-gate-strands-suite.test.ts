/**
 * WI-37732 — the recurrence guard for the "gating an EXISTING tool strands its own
 * suite" class (retire-mug-kettle-su-only-2026-08-09).
 *
 * ## The class
 *
 * `refuseIfMugKettleRetired` (./_mug-kettle-gate) returns a refusal envelope while
 * `FLAGS.MUG_KETTLE_SYSTEM` is OFF — and OFF is the DELIVERED steady state (polarity
 * inverted, D-016). A tool that opens with it therefore returns the refusal BEFORE its
 * handler body runs.
 *
 * That is correct behaviour. The hazard is what it does to tests that already existed:
 * a suite written before the gate exercises `tool.handler(...)` expecting the real
 * orchestration, and now silently gets the refusal instead. Every assertion about a
 * downstream mock fails as `Number of calls: 0`, and assertions on the return shape fail
 * as `Cannot read properties of undefined` — signatures that name neither the gate nor
 * the flag, so the reader looks for a broken store, not a deliberate refusal.
 *
 * ## The incident (2026-08-10)
 *
 * Applying D-048 added the gate to `pot/set_steering.ts` and `pot/survey.ts`. Both
 * source changes were correct and shipped. Three pre-existing suites — set_steering,
 * survey-claim-order-check, survey-workspace-scope — went red with 19 assertions, and
 * that red pinned the SHARED green-checkpoint gate while `main` sat ~147 commits and
 * ~8h behind `staging`, freezing every agent's deploys.
 *
 * It then cost triage three times over: three agents independently rediscovered the
 * same root cause within about thirty minutes and filed it separately
 * (EI-20077735303610259, WI-37745, and this item), because a red shared gate is
 * everyone's to green and nothing marked the cause as already-known.
 *
 * ## Why the existing P-016 guard did not catch it
 *
 * `./mug-kettle-tool-gate.test.ts` pins, for each gated tool, that it REFUSES when the
 * tier is retired and gets PAST the gate when enabled. That is a guard on the GATE, and
 * it is why adding a gate to a NEW tool is safe: you write that tool's tests already
 * knowing the gate is there.
 *
 * The asymmetry it leaves open is the whole class: nothing failed when a gate was added
 * to a tool that ALREADY had its own suite. The gate test went green (its own entry was
 * added correctly), the source was right, and the stranded suites only surfaced later,
 * in someone else's unrelated `test:affected` run. Prose in the gate's header cannot
 * fail a build. This can.
 *
 * ## What the predicate actually claims
 *
 * It flags a test that imports a gated tool module and invokes `.handler(` while showing
 * NO AWARENESS OF THE GATE ANYWHERE IN THE FILE. It is deliberately a detector of
 * *unawareness*, not of correctness — it cannot tell a well-neutralized suite from a
 * badly-neutralized one, and does not try to. Any mention of the gate means a human
 * considered it; absence of every mention means the suite predates it and nobody looked.
 *
 * Awareness is matched at EITHER layer, because both are legitimate and both are in use:
 *   - `pot/started`'s `mugKettleSystemEnabled` mocked true — used by the pot/* suites;
 *   - `@papercusp/flags/server`'s `getFlag` driven on `papercusp-mug-kettle-system` —
 *     used by the overwatch/* suites.
 * A predicate keyed to only the first idiom flags all three overwatch/gate suites as
 * violations. That was measured before this guard landed, and would have re-red-pinned
 * the very gate the guard exists to protect.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentToolsDir = dirname(fileURLToPath(import.meta.url));

/**
 * Suites that import a gated tool and call its handler, yet legitimately show no gate
 * awareness. Adding an entry is a real claim: the suite reaches a gated handler and
 * genuinely does not care which side of the gate it lands on. Prefer making the suite
 * explicit over adding an entry — an entry re-arms the class for that file.
 */
const ALLOW: ReadonlyMap<string, string> = new Map();

const isTestFile = (f: string) => f.endsWith('.test.ts') || f.endsWith('.integration.test.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__snapshots__') continue;
      out.push(...walk(full));
      continue;
    }
    if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Reaches the gate module — by STATIC `from '…/_mug-kettle-gate'` or by DYNAMIC
 * `await import('…/_mug-kettle-gate')`.
 *
 * The dynamic arm WAS load-bearing on a real file: `cup/spawn.ts` gated via
 * `await import(...)`, and a static-only detector silently omitted it from the gated
 * set — a false negative recorded against a different detector in this same migration.
 * P-059 retired that tool, and as of this writing EVERY surviving gated tool imports
 * the gate STATICALLY, so the dynamic arm currently matches nothing in-tree.
 * It is KEPT deliberately: it costs one alternation, the shape is legal and was
 * used here before, and a detector that only recognises the form today's files
 * happen to use is exactly how the original false negative happened. A tool missing
 * from the gated set makes this whole guard quietly weaker rather than loud.
 */
export const GATE_SPECIFIER = /(?:from|import)\s*\(?\s*['"][^'"\n]*_mug-kettle-gate['"]/;

/** A suite that actually drives a tool handler (rather than only reading its metadata). */
export const CALLS_HANDLER = /\.handler\s*\(/;

/** Any sign a human considered the retirement gate, at EITHER control layer. */
export const GATE_AWARE =
  /mugKettleSystemEnabled|papercusp-mug-kettle-system|MUG_KETTLE_SYSTEM|_mug-kettle-gate|MUG_KETTLE_RETIRED_ERROR/;

/**
 * Exposed so the guard's own teeth are testable against synthetic sources — never by
 * briefly mutating a file in a tree the whole fleet shares (git-sync sweeps every few
 * minutes and would commit the mutant even if nothing failed).
 *
 * `importsGatedTool` is passed in rather than derived, so a synthetic source needs no
 * resolvable specifier and this file can never classify itself.
 */
export function strandsGatedSuite(src: string, importsGatedTool: boolean): boolean {
  return importsGatedTool && CALLS_HANDLER.test(src) && !GATE_AWARE.test(src);
}

/** Static + dynamic import specifiers pointing at a sibling module, as absolute .ts paths. */
function importedModulePaths(src: string, fromFile: string): Set<string> {
  const out = new Set<string>();
  const specifiers = /(?:from\s*|import\s*\(\s*)['"](\.[^'"\n]+)['"]/g;
  for (const m of src.matchAll(specifiers)) {
    const base = resolve(dirname(fromFile), m[1]);
    out.add(`${base}.ts`);
    out.add(join(base, 'index.ts'));
  }
  return out;
}

describe('gate-strands-suite guard — the predicate has teeth', () => {
  // A guard nobody has watched FAIL is decoration.
  const preGateSuite = `
    import tool from './__synthetic_tool__';
    it('writes', async () => { await tool.handler({}, {}); expect(store).toHaveBeenCalled(); });
  `;

  it('flags a pre-gate suite that drives a gated handler with no gate awareness', () => {
    expect(strandsGatedSuite(preGateSuite, true)).toBe(true);
  });

  it('clears once the suite neutralizes at the pot/started layer', () => {
    const fixed = `vi.mock('../../pot/started', () => ({ mugKettleSystemEnabled: async () => true }));${preGateSuite}`;
    expect(strandsGatedSuite(fixed, true)).toBe(false);
  });

  it('clears once the suite neutralizes at the flags/server layer instead', () => {
    // The overwatch/* idiom. A predicate that only knew the pot/started idiom flagged
    // these as violations — the false positive this arm exists to prevent.
    const fixed = `getFlag.mockImplementation(async (k) => k === 'papercusp-mug-kettle-system');${preGateSuite}`;
    expect(strandsGatedSuite(fixed, true)).toBe(false);
  });

  it('ignores a suite that imports a gated tool but never drives its handler', () => {
    expect(strandsGatedSuite(`import tool from './__synthetic_tool__'; expect(tool.name).toBe('x');`, true)).toBe(
      false,
    );
  });

  it('ignores a handler-driving suite whose tool is not gated at all', () => {
    expect(strandsGatedSuite(preGateSuite, false)).toBe(false);
  });
});

describe('gate module detection — both import forms', () => {
  it('matches a static import of the gate', () => {
    expect(GATE_SPECIFIER.test(`import { refuseIfMugKettleRetired } from '../_mug-kettle-gate';`)).toBe(true);
  });

  it('matches a DYNAMIC import of the gate (the form cup/spawn.ts used before P-059)', () => {
    expect(GATE_SPECIFIER.test(`const g = await import('../_mug-kettle-gate');`)).toBe(true);
  });

  it('does not match an unrelated module whose name merely resembles it', () => {
    expect(GATE_SPECIFIER.test(`import x from '../mug-kettle-notes';`)).toBe(false);
  });
});

describe('gate-strands-suite recurrence guard (WI-37732)', () => {
  const sources = walk(agentToolsDir);

  const gatedModules = new Set(
    sources.filter((f) => !isTestFile(f) && GATE_SPECIFIER.test(readFileSync(f, 'utf8'))),
  );

  it('finds the gated tool modules at all (a guard over an empty set proves nothing)', () => {
    // Without this, deleting the gate — or breaking GATE_SPECIFIER — turns the corpus
    // check below into a vacuous pass over zero modules, which reads exactly like safety.
    expect(gatedModules.size).toBeGreaterThan(0);
  });

  it('every suite that drives a GATED tool handler shows awareness of the gate', () => {
    const offenders: string[] = [];

    for (const file of sources) {
      if (!isTestFile(file)) continue;
      const src = readFileSync(file, 'utf8');

      const imported = importedModulePaths(src, file);
      const gatedHits = [...imported].filter((p) => gatedModules.has(p));
      if (gatedHits.length === 0) continue;

      if (!strandsGatedSuite(src, true)) continue;

      const rel = relative(agentToolsDir, file);
      if (ALLOW.has(rel)) continue;
      offenders.push(`${rel}  (drives: ${gatedHits.map((p) => relative(agentToolsDir, p)).join(', ')})`);
    }

    expect(
      offenders,
      `These suites drive the handler of a tool gated by refuseIfMugKettleRetired, but ` +
        `nothing in the file mentions the gate — so they were almost certainly written ` +
        `BEFORE it and now assert against a refusal envelope instead of the real handler.\n\n` +
        `Symptoms if you ship this: "Number of calls: 0" on a downstream mock, or ` +
        `"Cannot read properties of undefined" on the result — neither of which names the ` +
        `gate, and both of which red-pin the SHARED green-checkpoint gate for the whole fleet.\n\n` +
        `Fix — neutralize the tier for suites that are about the TOOL's behaviour (the ` +
        `refusal itself is already covered by ./mug-kettle-tool-gate.test.ts), at either layer:\n` +
        `  vi.mock('../../pot/started', async (orig) => ({\n` +
        `    ...(await orig<typeof import('../../pot/started')>()),\n` +
        `    mugKettleSystemEnabled: async () => true,\n` +
        `  }));\n` +
        `or drive @papercusp/flags/server's getFlag on 'papercusp-mug-kettle-system'.\n\n` +
        `If the suite genuinely does not care which side of the gate it lands on, add it ` +
        `to ALLOW in this file with the reason.\n\n` +
        `Offenders:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    ).toEqual([]);
  });
});
