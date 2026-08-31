/**
 * RECURRENCE GUARD for over-claiming RECOVERY POINTERS (WI-1697551).
 *
 * ## The class being guarded
 *
 * Its sibling guard (`truncation-honesty-guard.test.ts`, plan
 * `agent-context-firewall-and-output-spill-2026-08-02` P-009→P-010) guarantees
 * every truncation door ANNOUNCES its cut in a structured, code-discoverable
 * way. Nothing guaranteed that the recovery route the announcement NAMES
 * actually recovers anything — which is exactly how EI-19371883353428338
 * survived: the door announced its cut perfectly (structured `_projection`,
 * `forced:true`, an exact `omittedCount`) while naming a route that was inert.
 * Measured there: the same request through all three documented routes — a
 * bare re-call, a re-call with `payloadTier:'full'`, and `tools:invoke` with
 * the door's own `rawDispatchTemplate` — returned a BYTE-IDENTICAL truncated
 * body, while the marker fired 5x per result saying otherwise. An announced
 * cut whose escape hatch does not open is worse than an unannounced one,
 * because the reader acts on it.
 *
 * ## What this guard actually asserts — read this before trusting its green
 *
 * It does NOT assert that any named route resolves. That is not decidable from
 * source, and a guard claiming it would be committing the same over-claim it
 * exists to catch. It asserts the strictly weaker, statically decidable
 * property described on `recovery-pointer-scan.ts`: within ONE module, a short
 * inline marker must not name a mechanism bare while a co-located emitter
 * documents that same mechanism as CONDITIONAL.
 *
 * That is the shape the class actually takes here. Not "someone forgot" — two
 * emitters, one file, disagreeing about one route, where the honest one is the
 * long-form field a reader skips and the bare one is the string inside the
 * truncated payload they act on.
 *
 * ## Why the controls below are not ceremony
 *
 * Every assertion here is a NEGATIVE ("no divergences"), and a negative is
 * satisfiable by a detector that has gone blind, by an empty file population,
 * and by a matcher that only ever matched one literal string. Each of those is
 * a green that measured nothing — the exact failure this lane keeps finding in
 * other instruments. So:
 *
 *   - POSITIVE CONTROL   — a fixture carrying the real divergence must be
 *                          caught. Kept permanently in this file (never a
 *                          mutation of the shared tree: a sweep commits that).
 *   - VACUITY CONTROL    — the tree scan must find real marker sites, so
 *                          "no divergences" can never come from "no sites".
 *   - DISCRIMINATORS     — the same marker text with no caveated sibling, and
 *                          a caveat about a DIFFERENT mechanism, must both come
 *                          back CLEAN. This is what proves the guard reads the
 *                          relationship between two emitters rather than
 *                          string-matching a known-bad literal.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scanSource,
  findRecoveryDivergences,
  describeDivergence,
  type RecoverySite,
} from './recovery-pointer-scan.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- .mjs helper shared with the sibling truncation-honesty guard
import { listFilesIncludingUntracked, describeUnscanned } from '../../../scripts/lib/tracked-files.mjs';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/**
 * This guard's own two modules quote the offending literals as fixtures and as
 * regexes. Scanning them would convict the guard of the thing it guards.
 */
const SELF_EXCLUDED = new Set(['packages/operator-core/lib/recovery-pointer-scan.ts']);

// ─────────────────────────────────────────────────────────────────────────────
// Tree scan
// ─────────────────────────────────────────────────────────────────────────────

function scanTree(): { sites: RecoverySite[]; unscanned: string[]; filesScanned: number } {
  const listed = listFilesIncludingUntracked(REPO_ROOT) as {
    files: string[];
    unscanned: string[];
  };
  const sites: RecoverySite[] = [];
  let filesScanned = 0;
  for (const rel of listed.files) {
    if (!rel.endsWith('.ts') && !rel.endsWith('.mts')) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.mts') || rel.endsWith('.d.ts')) continue;
    if (rel.includes('/_retired/') || rel.startsWith('_retired/')) continue;
    if (rel.includes('node_modules/') || rel.includes('/dist/')) continue;
    if (SELF_EXCLUDED.has(rel)) continue;
    let src: string;
    try {
      src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue; // a listed-but-unreadable path emits no marker
    }
    // Cheap pre-filter: a divergence needs a short marker, and every short
    // marker uses the house `recover:` convention.
    if (!src.includes('recover:')) continue;
    filesScanned += 1;
    sites.push(...scanSource(rel, src));
  }
  return { sites, unscanned: listed.unscanned ?? [], filesScanned };
}

let SCAN: { sites: RecoverySite[]; unscanned: string[]; filesScanned: number };
function scan() {
  SCAN ??= scanTree();
  return SCAN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — permanent controls, never a mutation of the shared tree
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The real shape, reduced: one module, two emitters, one mechanism. The
 * long-form explainer conditions `payloadTier`; the short marker names it bare.
 */
const DIVERGENT_FIXTURE = [
  'const RECOVERY_POINTER = {',
  "  CURSOR: 'recover: see _projection.cursor',",
  '  RE_CALL: "recover: re-call with payloadTier:\'full\'",',
  '};',
  'function buildDefaultRecoveryNext(opts) {',
  '  return (',
  '    `Call ${opts.toolName} again with _projection.cursor.args for full detail. ` +',
  "    `NOTE: 'payloadTier' is FRAMEWORK-RESERVED — stripped before schema validation ` +",
  '    `and absent from the published schema, so a client REJECTS it on a direct call.`',
  '  );',
  '}',
].join('\n');

/** The same bare marker, with NO co-located caveat. Nothing has been claimed. */
const BARE_ONLY_FIXTURE = [
  'const RECOVERY_POINTER = {',
  '  RE_CALL: "recover: re-call with payloadTier:\'full\'",',
  '};',
  'function buildDefaultRecoveryNext(opts) {',
  '  return `Call ${opts.toolName} again with _projection.cursor.args for full detail.`;',
  '}',
].join('\n');

/** A caveat, but about a DIFFERENT mechanism than the marker names. */
const OTHER_MECHANISM_FIXTURE = [
  'const RECOVERY_POINTER = {',
  '  RE_CALL: "recover: re-call with payloadTier:\'full\'",',
  '};',
  'function explain() {',
  "  return `NOTE: 'explicitFullRequest' is stripped before validation and REJECTS a direct call.`;",
  '}',
].join('\n');

/** The fixed form: the marker defers to the field that carries the caveat. */
const DEFERRING_FIXTURE = [
  'const RECOVERY_POINTER = {',
  "  CURSOR: 'recover: see _projection.cursor',",
  "  RE_CALL: 'recover: see _projection.next',",
  '};',
  'function buildDefaultRecoveryNext(opts) {',
  '  return (',
  "    `NOTE: 'payloadTier' is FRAMEWORK-RESERVED — stripped before schema validation ` +",
  '    `and absent from the published schema, so a client REJECTS it on a direct call.`',
  '  );',
  '}',
].join('\n');

function divergencesIn(src: string) {
  return findRecoveryDivergences(scanSource('fixture.ts', src));
}

// ─────────────────────────────────────────────────────────────────────────────

describe('recovery pointers — the detector itself', () => {
  it('POSITIVE CONTROL: catches a bare marker contradicted by a co-located caveat', () => {
    const found = divergencesIn(DIVERGENT_FIXTURE);
    // If this fails, every tree-wide assertion below passes vacuously.
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].mechanism).toBe('payloadTier');
    expect(found[0].marker.text).toContain('re-call');
    expect(found[0].explainer.text).toContain('FRAMEWORK-RESERVED');
  });

  it('DISCRIMINATOR: the same bare marker is CLEAN when nothing conditions it', () => {
    // Proves the guard reads the relationship between two emitters — not the
    // marker string. A module that never documented a condition has not
    // contradicted itself, and convicting it here would make the guard a
    // banned-literal list wearing a structural costume.
    expect(divergencesIn(BARE_ONLY_FIXTURE)).toEqual([]);
  });

  it('DISCRIMINATOR: a caveat about a DIFFERENT mechanism does not convict', () => {
    expect(divergencesIn(OTHER_MECHANISM_FIXTURE)).toEqual([]);
  });

  it('a marker that DEFERS to the field carrying the caveat is honest', () => {
    expect(divergencesIn(DEFERRING_FIXTURE)).toEqual([]);
  });

  it('ignores commentary — prose ABOUT a mechanism is not an emitter', () => {
    const commented = [
      "// RE_CALL: \"recover: re-call with payloadTier:'full'\" — the old form.",
      " * NOTE: 'payloadTier' is stripped before validation and REJECTS a direct call.",
    ].join('\n');
    expect(scanSource('fixture.ts', commented)).toEqual([]);
  });

  it('does not treat a field path as a mechanism', () => {
    // `next` in `_projection.next` and `toolName` in `${opts.toolName}` are
    // things to READ, not arguments to SEND. Conflating them would flag every
    // honest deferral in the tree.
    const sites = scanSource('fixture.ts', "const m = 'recover: see _projection.next';");
    expect(sites).toHaveLength(1);
    expect(sites[0].mechanisms).toEqual([]);
    expect(sites[0].defers).toBe(true);
  });
});

describe('recovery pointers — tree-wide', () => {
  it('states its scan coverage rather than implying a bare ✓', () => {
    const s = scan();
    // Not an assertion about pointers — an assertion that the guard says what
    // it could NOT check, so its green is never read as broader than it is.
    // eslint-disable-next-line no-console
    console.log(
      `[recovery-pointer] ${s.filesScanned} file(s) carry a 'recover:' marker; ` +
        `${s.sites.length} site(s). ${describeUnscanned(s.unscanned, REPO_ROOT)}`,
    );
    expect(Array.isArray(s.unscanned)).toBe(true);
  });

  it('VACUITY CONTROL: the tree scan really found markers (the detector is not blind)', () => {
    const markers = scan().sites.filter((s) => s.kind === 'marker');
    // Without this, "no divergences" is equally produced by a rotted regex, a
    // renamed convention, or a file walker returning nothing — an all-clear
    // that measured an empty set. `findRecoveryDivergences([])` is trivially
    // clean; that is precisely why the POPULATION has to be asserted too.
    expect(findRecoveryDivergences([])).toEqual([]);
    expect(markers.length).toBeGreaterThanOrEqual(2);
  });

  it('no short recovery marker asserts a route its own module documents as conditional', () => {
    const found = findRecoveryDivergences(scan().sites);
    const detail = found.map(describeDivergence).join('\n');
    expect(
      found,
      found.length === 0
        ? ''
        : `A recovery marker names a mechanism bare while a co-located emitter conditions it.\n` +
            `Either the caveat is wrong and should go, or the marker is over-claiming and should\n` +
            `defer to the field that carries the condition (\`recover: see _projection.next\`).\n\n` +
            detail,
    ).toEqual([]);
  });
});
