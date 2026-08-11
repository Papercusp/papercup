/**
 * work-distribution-drill-probe-symbols.test.ts — recurrence guard for a probe that
 * rots when a symbol is renamed (WI-5135 / P-205).
 *
 * THE BUG THIS EXISTS TO PREVENT (fired 2026-08-09, found by reading):
 * `bin/work-distribution-drill.sh`'s wiring census asks the packaged bundle whether a
 * symbol is present, and treats ABSENCE as "no production path reaches this leg". That
 * oracle is sound — the bundle is tree-shaken — but it silently depends on the probe
 * naming a symbol that STILL EXISTS. The census probed `listWorkOffers`; that function
 * was renamed to `listOffers` on 2026-08-09 (D-023 item 5, 12 files). From that moment
 * the probe could only ever report "in bundle=no", i.e. it would declare a perfectly
 * wired — and separately PROVEN (see seat-chain-composition.integration.test.ts) —
 * publish leg UNWIRED, in a drill whose output is read as release evidence.
 *
 * What makes it worth a guard rather than a one-line fix: the failure was INVISIBLE.
 * The deb on disk predated the rename, so the stale artifact still contained the old
 * symbol and the probe kept passing. The bug was masked by staleness and armed to fire
 * on the next repackage — the single action anyone acting on this drill is most likely
 * to take. A defect that only appears once you refresh your inputs is one nobody
 * attributes to a rename three weeks earlier.
 *
 * THE RULE: every symbol the census greps for must exist in the TypeScript source AS
 * CODE. Comments do not count — and that is the whole subtlety. After the rename,
 * `listWorkOffers` still appeared in source twice, in the doc comment explaining the
 * rename. A naive grep would therefore have found it and PASSED, certifying the very
 * bug it was written to catch. The comment-stripping below is load-bearing, and the
 * control at the bottom is what proves it works.
 *
 * Pure fs + grep — no PG, no bundle, no network. Runs in ms.
 * Run: npm run test:file -- packages/operator-core/lib/p2p/work-distribution-drill-probe-symbols.test.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const DRILL = path.join(REPO_ROOT, 'papercusp-desktop/bin/work-distribution-drill.sh');
const SOURCE_DIRS = ['packages', 'libs', 'apps'];

/** Every symbol the census asks the shipped bundle about. */
function probedSymbols(script: string): string[] {
  const out = new Set<string>();
  for (const m of script.matchAll(/bundle_has\s+'([^']+)'/g)) out.add(m[1]!);
  return [...out].sort();
}

/**
 * Does `symbol` appear in the TypeScript source as CODE (not only in comments)?
 *
 * Comment-stripping is line-based and deliberately conservative: it drops lines whose
 * first non-space character starts a comment (`*`, `//`, `/*`), which is exactly the
 * shape of the doc-comment occurrences that made the original bug invisible. It does
 * NOT try to parse block comments in general — a false POSITIVE here (counting a
 * commented mention as code) is the failure mode that matters, and the control test
 * below pins the one real case.
 */
function existsAsCode(symbol: string): boolean {
  let raw: string;
  try {
    raw = execFileSync(
      'grep',
      [
        '-rna',
        '--include=*.ts',
        '--include=*.tsx',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        '--exclude-dir=.git',
        // SELF-EXCLUSION — this file names every probed symbol as a string literal, so
        // without it the search matches ITSELF and every symbol looks alive forever.
        // Same class as the `pgrep -f <pattern>` self-match trap in CLAUDE.md: a probe
        // specific enough to identify the thing is specific enough to match the prober.
        `--exclude=${path.basename(fileURLToPath(import.meta.url))}`,
        '-F',
        '--',
        symbol,
        ...SOURCE_DIRS,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return false; // grep exits 1 on no match
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .some((line) => {
      // `-a` forces file:line:content even for a file grep would call binary. Without it
      // grep emits a bare "Binary file X matches" line, which has no parseable body and
      // would be counted as CODE — a false positive precisely on a file nobody can read.
      const firstColon = line.indexOf(':');
      const secondColon = firstColon < 0 ? -1 : line.indexOf(':', firstColon + 1);
      if (secondColon < 0) return false; // unparseable grep output is not evidence
      const body = line.slice(secondColon + 1).trimStart();
      return !(body.startsWith('*') || body.startsWith('//') || body.startsWith('/*'));
    });
}

const scriptExists = existsSync(DRILL);

describe.skipIf(!scriptExists)('work-distribution-drill wiring census — probe symbols must still exist', () => {
  it('every bundle_has symbol resolves to real TypeScript code', () => {
    const script = readFileSync(DRILL, 'utf8');
    const symbols = probedSymbols(script);

    // If this ever reads 0, the census was restructured and this guard went blind —
    // a silently-vacuous guard is the failure mode a "passing" test hides best.
    expect(symbols.length, 'no bundle_has probes found — did the census move?').toBeGreaterThan(3);

    const missing = symbols.filter((s) => !existsAsCode(s));
    expect(
      missing,
      `work-distribution-drill.sh probes symbol(s) that no longer exist in the TypeScript source: ` +
        `${missing.join(', ')}. A renamed symbol turns its leg into a permanent FALSE SKIP — the drill ` +
        `will report a wired leg as unwired, and the output is read as release evidence. Update the ` +
        `bundle_has probe to the new name (and check whether the leg's label still describes it).`,
    ).toEqual([]);
  });

  it('CONTROL: the comment-stripper rejects a symbol that survives ONLY in comments', () => {
    // `listWorkOffers` is the real renamed symbol. It still appears in offer-store.ts's
    // doc comment explaining the rename, and NOWHERE as code. If this ever reports true,
    // the stripper has stopped working and the guard above would certify the original
    // bug as healthy — so this control is what makes the guard trustworthy, not decorative.
    expect(
      existsAsCode('listWorkOffers'),
      'listWorkOffers was found as CODE — either it was reintroduced (fine, update this control) ' +
        'or the comment-stripper regressed and the guard above is now vacuous.',
    ).toBe(false);

    // Calibration: the symbol that REPLACED it must be visible as code, otherwise the
    // check above could be passing merely because the search itself is broken.
    expect(existsAsCode('listOffers'), 'listOffers not found as code — the source search is broken').toBe(true);
  });

  it('requires the work-intake routine to be active before SPAWN or RESULTS can pass', () => {
    const script = readFileSync(DRILL, 'utf8');
    const spawnStart = script.indexOf('# SPAWN —');
    const resultsStart = script.indexOf('# RESULTS —', spawnStart);
    const meteringStart = script.indexOf('# METERING —', resultsStart);

    expect(spawnStart, 'SPAWN census section missing').toBeGreaterThanOrEqual(0);
    expect(resultsStart, 'RESULTS census section missing').toBeGreaterThan(spawnStart);
    expect(meteringStart, 'METERING census section missing').toBeGreaterThan(resultsStart);

    const spawn = script.slice(spawnStart, resultsStart);
    const results = script.slice(resultsStart, meteringStart);

    expect(spawn).toMatch(
      /elif routine_active 'p2p-work-intake'; then\s+ok "SPAWN wired:/,
    );
    expect(spawn).toMatch(
      /elif routine_seeded 'p2p-work-intake'; then\s+skipp "SPAWN — DETECTED: p2p-work-intake is seeded but inactive:/,
    );
    expect(results).toMatch(
      /if routine_active 'p2p-work-intake' && bundle_has 'runForeignGitSyncTick'; then\s+ok "RESULTS wired:/,
    );
  });
});
