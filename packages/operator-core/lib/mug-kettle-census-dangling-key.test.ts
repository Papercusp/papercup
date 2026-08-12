/**
 * The mug/kettle census must not carry a FILENAME-KEYED entry that has silently stopped
 * resolving (EI-20059308594618912).
 *
 * WHAT THIS CATCHES. `scripts/mug-kettle-surface-census.mjs` classifies "named control
 * surfaces" by testing literal filename fragments against each file's extension-less
 * BASENAME, and `scripts/ungated-mug-kettle-baseline.json` keys each baselined entry as
 * `tier|SUBJECT|path`. Both couple to filenames by TEXT, with no link to the file — so a
 * rename breaks the coupling with zero signal.
 *
 * It has already happened. P-064 renamed `hive-control-policy.ts` -> `pot-control-policy.ts`
 * (git log --follow: 4220f4dcb8, R100) while the regex still read `hive-control`. The file
 * silently fell OUT of the census, nothing failed, no gate went red — and the baseline was
 * then re-seeded on top of the blind spot, laundering the lost coverage into "known good".
 *
 * WHY A RATCHET CANNOT CATCH THIS AND THIS TEST CAN. The failure direction is a false
 * NEGATIVE: coverage silently DROPS. A ratchet only alarms when the count goes UP, so it is
 * structurally blind to exactly this. A dangling key is the observable residue, and it is
 * cheap to assert.
 *
 * WHY THE OBVIOUS VERSION OF THIS GUARD IS WRONG, AND WHAT REPLACED IT. EI-20059308594618912
 * prescribed "every literal must match an existing file". Implemented literally, that fails
 * on `KettleTab` — which resolves to nothing BY DESIGN, because the kettle tier is retired
 * and that literal is armed to fire if the surface ever comes back. "Matches nothing" is
 * therefore ambiguous on its own: it means a BROKEN literal for a live surface and a WORKING
 * tripwire for a retired one, which need opposite responses. So the census now declares the
 * intent (`LIVE_CONTROL_SURFACES` vs `RETIRED_SURFACE_TRIPWIRES`) and this guard checks each
 * against its own invariant. Asserting the item's version would have forced someone to
 * "fix" the KettleTab red by deleting the literal — disarming a tripwire to silence a guard.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore -- runtime census helper intentionally exercised from TypeScript.
import {
  buildBaselineDocument,
  evaluateBaselineReseed,
} from '../../../scripts/lib/mug-kettle-baseline.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CENSUS = join(REPO_ROOT, 'scripts/mug-kettle-surface-census.mjs');
const BASELINE = join(REPO_ROOT, 'scripts/ungated-mug-kettle-baseline.json');

/**
 * Mirrors `isTestFile` at mug-kettle-surface-census.mjs:81 and the `.tsx?` + basename
 * handling at its D7 loop. Mirrored rather than imported because the census executes its
 * whole scan at module scope, so it cannot be imported for its constants alone. The
 * controls below are what stop this mirror from drifting silently.
 */
const isTestFile = (p: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || p.includes('/__tests__/');

/** Extension-less basenames of the tracked .ts/.tsx non-test files the census can see. */
let cachedBases: string[] | null = null;
function trackedBasenames(): string[] {
  if (!cachedBases) {
    const out = execFileSync('git', ['ls-files', '-z', '*.ts', '*.tsx'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 1e8,
    });
    cachedBases = out
      .split('\0')
      .filter((p) => p.length > 0 && !isTestFile(p))
      .map((p) => basename(p, extname(p)));
  }
  return cachedBases;
}

/** Read one of the census's declared literal lists by name. */
function literals(constName: 'LIVE_CONTROL_SURFACES' | 'RETIRED_SURFACE_TRIPWIRES'): string[] {
  const src = readFileSync(CENSUS, 'utf8');
  const m = src.match(new RegExp(`const ${constName} = \\[([^\\]]+)\\]`));
  if (!m) throw new Error(`could not locate ${constName} in the census source`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const resolves = (lit: string): boolean => trackedBasenames().some((b) => new RegExp(lit).test(b));

/** Baseline rows are `tier|SUBJECT|path` under `.entries`; the path is the third field. */
function baselinePaths(): { row: string; path: string }[] {
  const raw = JSON.parse(readFileSync(BASELINE, 'utf8')) as { entries?: unknown };
  const rows = (Array.isArray(raw.entries) ? raw.entries : []) as string[];
  return rows
    .filter((r) => typeof r === 'string')
    .map((row) => ({ row, path: row.split('|')[2] ?? '' }))
    .filter((e) => e.path.length > 0);
}

describe('mug/kettle census — dangling filename-keyed entries (EI-20059308594618912)', () => {
  /**
   * CALIBRATION FIRST. Every guard below is satisfied by an EMPTY input set, so without
   * these the suite would pass most loudly at the moment its own enumeration broke — the
   * same false-negative shape it exists to catch.
   */
  describe('CONTROLS: the guards cannot pass vacuously', () => {
    it('sees a substantial tracked-file domain', () => {
      expect(trackedBasenames().length).toBeGreaterThan(500);
    });

    it('parses both declared literal lists out of the census source', () => {
      expect(literals('LIVE_CONTROL_SURFACES').length).toBeGreaterThanOrEqual(5);
      expect(literals('RETIRED_SURFACE_TRIPWIRES').length).toBeGreaterThanOrEqual(1);
    });

    it('reads a non-empty baseline', () => {
      expect(baselinePaths().length).toBeGreaterThan(100);
    });

    it('the matcher DETECTS a dangling literal (the WI-37687 regression, reproduced)', () => {
      // `hive-control` is exactly what the regex still read after the file was renamed to
      // pot-control-policy.ts. It must resolve to nothing — i.e. be caught.
      expect(resolves('hive-control')).toBe(false);
    });

    it('the matcher ACCEPTS a live literal (so it is not merely matching nothing)', () => {
      expect(resolves('pot-control$')).toBe(true);
    });

    it('the baseline path check DETECTS a bogus path', () => {
      expect(existsSync(join(REPO_ROOT, 'packages/operator-core/lib/definitely-not-a-file.ts'))).toBe(false);
    });
  });

  it('every LIVE_CONTROL_SURFACES literal still resolves to a real file', () => {
    const dangling = literals('LIVE_CONTROL_SURFACES').filter((lit) => !resolves(lit));

    expect(
      dangling,
      `These LIVE_CONTROL_SURFACES literals match NO tracked non-test .ts/.tsx basename, so the ` +
        `census has silently stopped seeing a surface that still exists (a RENAME is the usual ` +
        `cause — check \`git log --follow\`). Re-key the literal in ` +
        `scripts/mug-kettle-surface-census.mjs. If the surface is genuinely gone for good, move ` +
        `the literal to RETIRED_SURFACE_TRIPWIRES rather than deleting it, so it still fires if ` +
        `the surface returns. Do NOT re-seed the baseline first: a re-seed snapshots what the ` +
        `census can currently see and would make the blindness permanent.`,
    ).toEqual([]);
  });

  it('every RETIRED_SURFACE_TRIPWIRES literal still matches nothing (the tripwire is unfired)', () => {
    const fired = literals('RETIRED_SURFACE_TRIPWIRES').filter((lit) => resolves(lit));

    expect(
      fired,
      `These RETIRED_SURFACE_TRIPWIRES literals now MATCH a real file — a retired surface has ` +
        `reappeared in the tree. That is the event they were armed for. Confirm the file is ` +
        `intended; if it is, it belongs in LIVE_CONTROL_SURFACES (and the retirement claim needs ` +
        `revisiting). Do not silence this by deleting the literal.`,
    ).toEqual([]);
  });

  it('every baseline entry points at a file that still exists', () => {
    const missing = baselinePaths()
      .filter((e) => !existsSync(join(REPO_ROOT, e.path)))
      .map((e) => e.row);

    expect(
      missing,
      `These scripts/ungated-mug-kettle-baseline.json entries name a path that no longer exists. ` +
        `Each row is keyed \`tier|SUBJECT|path\` where SUBJECT is ALSO derived from the filename, ` +
        `so a rename desyncs both fields and the entry can never match again — it becomes a ` +
        `permanent phantom the ratchet counts as covered. Re-key the row to the new path (and its ` +
        `SUBJECT), or drop it if the surface was deleted.`,
    ).toEqual([]);
  });
});

describe('mug/kettle baseline re-seed policy (EI-20061934062977012)', () => {
  const previousEntries = [
    'flag|OLD_SURFACE|packages/old.ts',
    'flag|KEEP_SURFACE|packages/keep.ts',
    'flag|KEEP_SURFACE|packages/keep.ts',
  ];

  it('requires an explicit reason when the measured set shrinks', () => {
    const decision = evaluateBaselineReseed({
      previousEntries,
      currentEntries: ['flag|KEEP_SURFACE|packages/keep.ts'],
    });

    expect(decision).toMatchObject({
      previousEntryCount: 2,
      nextEntryCount: 1,
      shrunk: true,
      reasonRequired: true,
      accepted: false,
    });
    expect(decision.removedEntries).toEqual(['flag|OLD_SURFACE|packages/old.ts']);
  });

  it('accepts and records a reason for an intentional shrink', () => {
    const document = buildBaselineDocument({
      baseline: {
        $comment: 'policy',
        reseed: 'node scripts/check-ungated-mug-kettle.mjs --reseed --reason "..."',
        entries: previousEntries,
      },
      currentEntries: ['flag|KEEP_SURFACE|packages/keep.ts'],
      reason: 'Retired OLD_SURFACE; the measured census no longer reports it.',
      generatedAt: '2026-08-12T05:00:00.000Z',
    });

    expect(document.entries).toEqual(['flag|KEEP_SURFACE|packages/keep.ts']);
    expect(document.$comment).toBe('policy');
    expect(document.lastReseed).toEqual({
      at: '2026-08-12T05:00:00.000Z',
      reason: 'Retired OLD_SURFACE; the measured census no longer reports it.',
      previousEntryCount: 2,
      nextEntryCount: 1,
      removedEntries: ['flag|OLD_SURFACE|packages/old.ts'],
      addedEntries: [],
    });
  });

  it('keeps same-sized replacements valid while exposing removed and added keys', () => {
    const decision = evaluateBaselineReseed({
      previousEntries: ['flag|OLD|packages/old.ts'],
      currentEntries: ['flag|NEW|packages/new.ts'],
    });

    expect(decision).toMatchObject({
      previousEntryCount: 1,
      nextEntryCount: 1,
      shrunk: false,
      reasonRequired: false,
      accepted: true,
    });
    expect(decision.removedEntries).toEqual(['flag|OLD|packages/old.ts']);
    expect(decision.addedEntries).toEqual(['flag|NEW|packages/new.ts']);
  });
});
