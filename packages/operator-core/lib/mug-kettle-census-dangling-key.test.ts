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
import {
  buildBaselineDocument,
  evaluateBaselineReseed,
  // @ts-ignore -- runtime census helper intentionally exercised from TypeScript.
} from '../../../scripts/lib/mug-kettle-baseline.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CENSUS = join(REPO_ROOT, 'scripts/mug-kettle-surface-census.mjs');
const BASELINE = join(REPO_ROOT, 'scripts/ungated-mug-kettle-baseline.json');
// Overridable so falsifiability can be proven against a COPY outside the tree, rather than
// by mutating the shared checkout — where git-sync can commit the mutant mid-probe (CLAUDE.md,
// "Proving a guard is falsifiable"). Defaults to the real path; nothing in CI sets it.
const GUARD =
  process.env.MUG_KETTLE_GUARD_PATH ??
  join(REPO_ROOT, 'scripts/check-ungated-mug-kettle.mjs');

/**
 * Mirrors `isTestFile` at mug-kettle-surface-census.mjs:81 and the `.tsx?` + basename
 * handling at its D7 loop. Mirrored rather than imported because the census executes its
 * whole scan at module scope, so it cannot be imported for its constants alone. The
 * controls below are what stop this mirror from drifting silently.
 */
const isTestFile = (p: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || p.includes('/__tests__/');

/** Extension-less basenames of the tracked .ts/.tsx non-test files the census can see. */
let cachedBases: string[] | null = null;
function trackedBasenames(): string[] {
  if (!cachedBases) {
    const out = execFileSync('git', ['ls-files', '-z', '*.ts', '*.tsx'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 1e8,
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    cachedBases = out
      .split('\0')
      .filter((p) => p.length > 0 && !isTestFile(p))
      // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
      .filter((p) => existsSync(join(REPO_ROOT, p)))
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
        `permanent phantom the ratchet counts as covered.\n` +
        `  If the surface was DELETED or retired, drop the row(s) with:\n` +
        `      npm run lint:no-ungated-mug-kettle -- --reseed --reason "<why the surface was retired>"\n` +
        `  --reseed is the ONLY flag that writes the baseline (--list merely prints to stdout), and a ` +
        `shrinking re-seed REFUSES without --reason, which is what keeps the shrink deliberate.\n` +
        `  If the surface was RENAMED, re-key the row to the new path (and its SUBJECT) by hand — and ` +
        `re-key the census literal too, or a re-seed snapshots a census that has gone blind to a ` +
        `surface that still exists and makes that blindness permanent.`,
    ).toEqual([]);
  });

  /**
   * The detector above already worked; what failed was its LOCALITY. A dangling row is
   * created by whoever retires a file and surfaces hours later, at the gate, to a different
   * agent with no reason to connect a red test to someone else's retirement slice. The only
   * thing that shortens that loop is the failure text naming the exact repair command — so
   * the command is itself load-bearing and pinned here (EI-20203730618121482).
   */
  it('the guard script names the command that actually WRITES the baseline', () => {
    const src = readFileSync(GUARD, 'utf8');

    // Scope to the stale-entry BRANCH, not the whole file. A mutation probe against the
    // pre-fix source proved a file-wide `includes('--reseed --reason')` VACUOUS: the flag
    // pair also appears in the header usage comment (line ~52), so that assertion passed on
    // the very source it was meant to reject. Only the branch that prints the advice can
    // testify about the advice.
    const start = src.indexOf('if (stale.length)');
    expect(
      start,
      'the stale-entry branch must exist in scripts/check-ungated-mug-kettle.mjs — if it was ' +
        'renamed or removed, re-anchor this guard rather than deleting it.',
    ).toBeGreaterThan(-1);
    const rest = src.slice(start);
    const nextBranch = rest.indexOf('\nif (', 1);
    const staleBranch = nextBranch > 0 ? rest.slice(0, nextBranch) : rest;

    expect(
      staleBranch.includes('Prune with --list'),
      'The stale-entry message must not send the reader to --list: it only prints the current ' +
        'entries to stdout (writeStdoutSync) and writes nothing, so the phantom row survives ' +
        'and reds the gate again, hours later, for a different agent.',
    ).toBe(false);

    expect(
      staleBranch.includes('--reseed --reason'),
      'The stale-entry message must name --reseed --reason inline — the only path that reaches ' +
        'writeBaselineAtomically — so a dangling row is a one-command fix rather than a hunt. ' +
        'A mention elsewhere in the file does not count: the reader is looking at this message.',
    ).toBe(true);
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
