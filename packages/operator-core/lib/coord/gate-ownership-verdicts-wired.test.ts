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

function productionCallSites(symbol: string): string[] {
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
  );
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
});
