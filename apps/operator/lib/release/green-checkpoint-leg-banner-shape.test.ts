import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WI-9613 — every post-suite gate leg that can hold the release must announce its failure
 * in a shape the standard triage grep can see.
 *
 * The repo's own guidance tells agents to resolve a red with:
 *
 *     grep -oE 'FAILED \(npm run [a-z:-]+' <verdict log>
 *
 * That works only because 9 of the 12 leg banners happen to spell `<LABEL> FAILED (npm run
 * <script>)`. It was an unenforced convention, and three legs did not follow it —
 * `lint:no-control-bytes`, `lint:guard-reachability`, `lint:mock-cast-escape` — so a red
 * caused by any of them was invisible to that grep.
 *
 * Measured on candidate dca4c291 (verdict 2026-08-03T17:27:30Z, part of the 6-red streak
 * that held main at 5b898b7b for ~4h): `AFFECTED_TESTS_RESULT status=passed tasks=58
 * failed=0`, no AFFECTED_TESTS_FAILING_FILES line at all, and zero `FAILED (npm run ...)`
 * matches — a genuine red whose cause appeared in NEITHER line the guidance names. The
 * cause (`lint:no-control-bytes`) occurred twice in 12,562 lines, both inside the leg's own
 * output block.
 *
 * The durable fix is the canonical GATE_HELD_BY line (asserted behaviourally in
 * green-checkpoint.test.ts). This ratchet is the second half: it stops the banner class
 * from silently returning when a NEW leg is added, since a new leg is exactly where an
 * author re-invents the wording.
 *
 * FALSIFIABILITY (CLAUDE.md "Proving a guard is falsifiable", tier 1): the checker is a
 * pure function over a string, so deliberately-wrong CONTROLS live permanently in this file
 * rather than being produced by mutating the shared tree. The calibration case pins the
 * other direction, so the controls cannot pass by the checker being broken-open.
 */

/** A banner is a `=== ... (npm run <script> ...) ===` header emitted on a leg failure. */
export type LegBanner = { label: string; script: string; raw: string };

export function extractLegBanners(source: string): LegBanner[] {
  const out: LegBanner[] = [];
  // Deliberately narrow: a single-line `===` header that names an npm script. `[^=\n]` keeps
  // it from spanning banners; the script may be a `${...}` template hole.
  const re = /===\s*([^=\n]*?)\s*\(npm run\s+([^),\s]+)[^=\n]*===/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ label: m[1], script: m[2], raw: m[0] });
  }
  return out;
}

/** The property under test: the banner must contain the word the triage grep anchors on. */
export function bannerIsGreppable(banner: LegBanner): boolean {
  return /FAILED\s*\(npm run/.test(banner.raw);
}

const SOURCE_PATH =
  process.env.PROBE_GREEN_CHECKPOINT_SOURCE ?? join(__dirname, 'green-checkpoint.ts');

describe('WI-9613: every gate-leg failure banner is greppable', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const banners = extractLegBanners(source);

  it('finds the leg banners at all (guards a vacuous green from a broken extractor)', () => {
    // A regex that silently stops matching would yield "0 banners, 0 violations" — a pass
    // that measured nothing, the exact zero-work false-green class this repo keeps hitting
    // (`tsc -p .`, a name-filter matching no tests, an empty affected set).
    expect(banners.length).toBeGreaterThanOrEqual(10);
    // Sanity: the well-known conforming legs are actually in the extracted set.
    const scripts = banners.map((b) => b.script);
    expect(scripts).toContain('lint:tsc');
    expect(scripts).toContain('lint:migration-forward-compat');
  });

  it('⭐ no leg announces its failure in a shape the triage grep cannot see', () => {
    const bad = banners.filter((b) => !bannerIsGreppable(b));
    expect(
      bad.map((b) => `${b.script}: ${b.label}`),
      'a leg banner must read "<LABEL> FAILED (npm run <script>)" — otherwise a red caused ' +
        'by this leg is invisible to `grep -oE "FAILED \\(npm run [a-z:-]+"` and the verdict ' +
        'log reads as "red with no cause" (WI-9613, candidate dca4c291)',
    ).toEqual([]);
  });

  it('the three legs that regressed this in the first place now conform', () => {
    for (const script of ['lint:no-control-bytes', 'lint:guard-reachability', 'lint:mock-cast-escape']) {
      const banner = banners.find((b) => b.script === script);
      expect(banner, `expected a leg banner for ${script}`).toBeDefined();
      expect(bannerIsGreppable(banner!), `${script} banner is not greppable: ${banner!.raw}`).toBe(true);
    }
  });

  // ---- permanent controls: prove the checker discriminates -------------------------

  it('CONTROL: rejects the exact pre-fix banner that hid the dca4c291 red', () => {
    const preFix =
      '=== RAW CONTROL BYTES IN SOURCE (npm run lint:no-control-bytes) — a byte that makes git diff and ugrep skip the file silently ===';
    const [banner] = extractLegBanners(preFix);
    expect(banner).toBeDefined();
    expect(banner.script).toBe('lint:no-control-bytes');
    expect(bannerIsGreppable(banner)).toBe(false);
  });

  it('CONTROL: rejects a plausible new leg whose author invented fresh wording', () => {
    const invented = '=== SCHEMA DRIFT DETECTED (npm run lint:schema-drift) — the projection is stale ===';
    const [banner] = extractLegBanners(invented);
    expect(bannerIsGreppable(banner)).toBe(false);
  });

  it('CALIBRATION: accepts the conforming shape (so the controls above are not vacuous)', () => {
    const conforming =
      '=== MIGRATION FORWARD-COMPAT LINT FAILED (npm run lint:migration-forward-compat) — destructive DDL ===';
    const [banner] = extractLegBanners(conforming);
    expect(banner).toBeDefined();
    expect(bannerIsGreppable(banner)).toBe(true);
  });
});
