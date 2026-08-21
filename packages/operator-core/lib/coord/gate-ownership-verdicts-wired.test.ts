/**
 * Guard: every exported VERDICT helper in gate-ownership.ts has a production caller.
 *
 * ── WHY THIS TEST EXISTS (EI-20209536730887204) ──────────────────────────────
 * `ownershipNeedsLivenessConfirmation()` shipped fully built, fully documented and fully
 * unit-tested — and nothing ever called it. Its own doc-block prescribed a required wake for
 * `draining`/`suspect`; `cell-registrations.ts` described the routing as though it were live; the
 * P-005 suite exercised its branches and passed. The ambiguous case still fell straight through to
 * launch, unprotected and unrecorded, for as long as the helper existed.
 *
 * NO EXISTING TEST COULD HAVE CAUGHT THAT, which is the whole point: a unit test proves a function
 * is CORRECT, never that it is REACHED. The defect lived in the gap between the two — exactly where
 * a decision helper extracted "so it is testable without firing a ~55min suite" tends to die.
 * Extraction makes it easy to test and equally easy to forget to wire.
 *
 * So this asserts REACHABILITY, deliberately by grep over production sources rather than by types:
 * an unused export is valid TypeScript, so tsc is structurally incapable of failing here.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE = 'gate-ownership.ts';
const MODULE_PATH = join(__dirname, MODULE);
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** Exported verdict helpers — the ones whose whole purpose is to be BRANCHED ON by a caller. */
const VERDICT_HELPERS = [
  'ownershipContradicted',
  'ownershipNeedsLivenessConfirmation',
  'ownershipHeldByLiveHolder',
  'shouldStandDownForLivePeer',
] as const;

/**
 * Does this file actually IMPORT `symbol` from gate-ownership.ts?
 *
 * ⚠ THIS IS THE LOAD-BEARING FILTER, and it exists because the first version of this guard
 * was itself a false green — the exact defect it polices, in the policing code.
 *
 * A bare name match counts PROSE. `cell-registrations.ts` carries a long doc-string that
 * discusses `ownershipContradicted()` and `ownershipNeedsLivenessConfirmation()` by name,
 * inside a quoted string, in call-shaped form. Name-matching (and even `symbol(`-shaped
 * matching) scored that documentation as a production call site, so `ownershipContradicted`
 * — which nothing has ever called — was certified WIRED by the guard written to catch
 * exactly that. Documentation describing a helper is the single most likely text to mention
 * it, so the naive detector fails hardest precisely where the risk is highest.
 *
 * An import cannot be faked by prose: a string literal does not create a binding.
 */
function importsSymbolFromModule(relPath: string, symbol: string): boolean {
  let src = '';
  try {
    src = readFileSync(join(REPO_ROOT, relPath), 'utf8');
  } catch {
    return false;
  }
  // Import blocks are routinely multi-line, so match the braces across newlines.
  const importBlocks = src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gs);
  for (const [, names, spec] of importBlocks) {
    if (!spec.includes('gate-ownership')) continue;
    const imported = names.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]?.trim());
    if (imported.includes(symbol)) return true;
  }
  return false;
}

function directProductionCallSites(symbol: string): string[] {
  let out = '';
  try {
    out = execFileSync('grep', ['-rl', '--include=*.ts', symbol, 'packages', 'libs', 'apps'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch {
    return []; // grep exits 1 on no match
  }
  return (
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // the definition itself, any test, and THIS guard are not production callers
      .filter((f) => !f.endsWith(`coord/${MODULE}`))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      // …and a mention is not a call. See importsSymbolFromModule.
      .filter((f) => importsSymbolFromModule(f, symbol))
  );
}

/**
 * Follow verdict-helper calls inside this module until they reach a production
 * caller. A helper used by another helper is wired when that outer helper is
 * itself wired; discarding gate-ownership.ts wholesale made that real path look
 * dead. The visited set keeps a dead/cyclic helper chain from passing itself.
 */
function productionCallSites(symbol: string, visited: ReadonlySet<string> = new Set()): string[] {
  const direct = directProductionCallSites(symbol);
  if (visited.has(symbol)) return direct;

  const source = readFileSync(MODULE_PATH, 'utf8');
  const nextVisited = new Set(visited).add(symbol);
  const callers = new Set<string>();
  const occurrence = new RegExp(`\\b${symbol}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = occurrence.exec(source)) !== null) {
    const before = source.slice(0, match.index);
    const definitions = [...before.matchAll(/export function\s+(\w+)\s*\(/g)];
    const caller = definitions.at(-1)?.[1];
    if (caller && caller !== symbol && VERDICT_HELPERS.includes(caller as (typeof VERDICT_HELPERS)[number])) {
      callers.add(caller);
    }
  }

  const indirect = [...callers].flatMap((caller) =>
    productionCallSites(caller, nextVisited).map((site) => `${MODULE} -> ${caller} -> ${site}`),
  );
  // A helper can be BOTH called directly and wrapped by another wired helper.
  // Returning early on the first direct site hid the wrapper path and made the
  // specific live-holder control fail as soon as release-trace added a direct
  // ownershipHeldByLiveHolder call.
  return [...new Set([...direct, ...indirect])];
}

describe('gate-ownership verdict helpers are WIRED, not merely correct', () => {
  it('the helpers this guard polices are all still exported (calibration)', () => {
    // Without this, a renamed or deleted helper would make its reachability assertion pass
    // VACUOUSLY — zero expected callers for a symbol that no longer exists. Fail loudly instead.
    const src = readFileSync(MODULE_PATH, 'utf8');
    for (const helper of VERDICT_HELPERS) {
      expect(src, `${helper} is no longer exported from ${MODULE} — update this guard`).toContain(
        `export function ${helper}`,
      );
    }
  });

  it.each(VERDICT_HELPERS)('%s has at least one production call site', (helper) => {
    const callers = productionCallSites(helper);
    expect(
      callers,
      `${helper} is exported from ${MODULE} but NOTHING in production calls it. A decision helper ` +
        'no caller branches on is dead weight that READS as a shipped safeguard — see ' +
        'EI-20209536730887204, where exactly this cost the gate its ambiguous-liveness protection ' +
        'while every unit test stayed green. Either wire it, or delete it together with the ' +
        'documentation claiming it is in use.',
    ).not.toHaveLength(0);
  });

  it('CONTROL: a plausible-looking but non-existent helper resolves to zero call sites', () => {
    // Proves the detector can actually return EMPTY. Without it, a grep that silently matched
    // everything (a wrong cwd, a broken --include) would make every assertion above pass for the
    // wrong reason — the same false-green shape this guard exists to catch.
    expect(productionCallSites('ownershipDefinitelyNotARealHelperName')).toHaveLength(0);
  });

  it('CONTROL: a file that only MENTIONS a helper in prose is not a call site', () => {
    // The regression control for this guard's own first false green, and the reason it is
    // falsifiable without ever mutating the shared tree: cell-registrations.ts genuinely
    // discusses these helpers by name — in call-shaped form — inside a doc-string, and
    // genuinely does not import them. If someone reverts the import filter, THIS reds first
    // and names the reason, instead of the guard quietly going back to certifying dead code.
    const PROSE_ONLY = 'packages/operator-core/lib/cell-registrations.ts';
    const src = readFileSync(join(REPO_ROOT, PROSE_ONLY), 'utf8');
    // Calibration: if the prose ever stops naming the helper, this control proves nothing.
    expect(src, `${PROSE_ONLY} no longer mentions the helper — pick another prose fixture`).toContain(
      'ownershipContradicted(',
    );
    expect(importsSymbolFromModule(PROSE_ONLY, 'ownershipContradicted')).toBe(false);
    expect(directProductionCallSites('ownershipContradicted')).not.toContain(PROSE_ONLY);
  });

  it('recognizes the live-holder verdict through the production-wired stand-down wrapper', () => {
    expect(productionCallSites('ownershipHeldByLiveHolder')).toContain(
      `${MODULE} -> shouldStandDownForLivePeer -> packages/operator-core/lib/agent-tools/release/checkpoint-run.ts`,
    );
  });
});
