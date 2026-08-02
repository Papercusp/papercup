/**
 * lint:tsc gate logic (audit P-073 / EI-104; per-file migration P-010 / WI-4535):
 *   - per-file baseline: a file above ITS baseline is a NEW, ATTRIBUTED regression,
 *   - --mine scopes the failure to files the caller changed (peer drift is reported, not gated),
 *   - ratchet-only-down per file on --update,
 *   - hard-fail on syntax-broken files (TS1xxx) regardless of counts,
 *   - per-file error attribution from raw tsc output.
 *
 * The script's pure functions are imported directly (same pattern as apps/operator's
 * psu-pty-host / ptool script tests).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import {
  parseTscErrors,
  syntaxBrokenFiles,
  countByFile,
  parseExplicitFiles,
  decidePerFile,
  effectiveBaselineByFile,
  exportedTypeNames,
  filesReferencingTypeNames,
  formatAttributionHeadline,
  formatNewFileGuidance,
  partitionNewFilesByLiveEdit,
  diagnosticLinesForFiles,
  partitionStandingByCommitRecency,
  formatLandingRaceCaveat,
  LANDING_RACE_WINDOW_SEC,
  TSC_COMMAND,
} from '../../../scripts/lint-tsc.mjs';
// eslint-disable-next-line import/no-relative-packages
import {
  TSC_COMMAND as OPERATOR_VITE_TSC_COMMAND,
  FOREIGN_BASELINES,
} from '../../../scripts/lint-tsc-operator-vite.mjs';

describe('TSC_COMMAND (EI-487 regression guard)', () => {
  it('always measures fresh — never trusts a warm/stale incremental cache', () => {
    // A stale tsconfig.tsbuildinfo under-reports errors for files affected-but-
    // not-yet-reindexed (WI-4488). Under THIS script that under-report is worse
    // than a normal false-green: on `--update` it silently ratchets a file's
    // baseline DOWN to the incomplete count, so a later fully-fresh run (CI, or
    // the same file once its cache catches up) trips the gate on code that
    // already passed its author's own `lint:tsc` — the fleet-wide false red
    // EI-487 traced back to this flag being absent. Pin it so nobody removes it
    // as a "harmless" perf tweak without re-deriving why it's here.
    expect(TSC_COMMAND).toContain('--incremental false');
    expect(TSC_COMMAND).toContain('--noEmit');
  });
});

// EI-847: the operator-vite counterpart of the gate above, built on the same shared
// scripts/lib/tsc-baseline-gate.mjs policy (see lint-tsc-operator-vite.mjs).
describe('operator-vite TSC_COMMAND (EI-847)', () => {
  it('targets the operator-vite tsconfig and carries the same fresh-measurement guard', () => {
    expect(OPERATOR_VITE_TSC_COMMAND).toContain('apps/operator-vite/tsconfig.json');
    expect(OPERATOR_VITE_TSC_COMMAND).toContain('--incremental false');
    expect(OPERATOR_VITE_TSC_COMMAND).toContain('--noEmit');
  });
});

// REMOVED (WI-6396): `scripts/lint-tsc.d.mts stays in sync with scripts/lint-tsc.mjs`.
//
// That test existed only because the declaration was HAND-MAINTAINED. It parsed the
// `.d.mts` for `export function|const` names and asserted every runtime export appeared
// there — a hand-rolled drift check policing a hand-synced projection. It was written
// after that projection had already drifted twice (`parseExplicitFiles`, then
// `formatAttributionHeadline`), each drift costing this file a permanent baselined
// TS2305 that everyone learned to look past.
//
// `scripts/lint-tsc.d.mts` is now GENERATED from source via `tsconfig.declarations.json`,
// so an export cannot exist at runtime and be missing from the declaration: the
// declaration is derived from the same file. Two guards replace this one, and both live
// in `generated-declarations.test.ts`:
//   - `gen:declarations:check` fails if any committed declaration is stale, and
//   - semantic assertions fail if a type silently widens to `any`, which a byte-compare
//     provably cannot catch.
//
// Deleting it was the point, not a side effect — the item's own check was that if this
// block could NOT be removed, the conversion had not actually been done.
//
// Worth keeping in view: `lint-tsc.mjs` is a thin re-export shim over
// `scripts/lib/tsc-baseline-gate.mjs`, so the hand-written declaration had been
// hand-syncing a DIFFERENT module's contract across a file boundary — which is almost
// certainly why it drifted both times. The generated declaration re-exports from that
// module instead, so the types now follow the import.

describe('formatAttributionHeadline — the gate may only claim authorship it can actually prove', () => {
  // WHY THIS IS PINNED. `--mine` derives "your" files from `git status`, and this repo has ONE
  // working tree shared by the whole fleet with every agent's edits unstaged until the next
  // git-sync tick. So under --mine the set is "dirty right now" — yours AND every peer's — and
  // a headline saying "YOU changed" over it is simply false. It was filed four separate times
  // (EI-18731016038876755, which added --files, plus three duplicates) because each agent
  // independently burned time chasing a peer's error in a file they had never opened. The
  // costlier direction is the inverse: your OWN regression arrives amid peer noise under the
  // same "YOU changed" label, so the natural read is "fleet drift, not mine" and it ships.
  it('does NOT claim authorship for a git-inferred (--mine) set, and says how to scope it', () => {
    const headline = formatAttributionHeadline({ count: 1, explicit: false });
    expect(headline).not.toMatch(/YOU changed/i);
    expect(headline).toContain('DIRTY IN THE WORKING TREE');
    expect(headline).toContain('--files=');
  });

  it('DOES claim authorship for an explicitly-named (--files) set — there it is a fact', () => {
    const headline = formatAttributionHeadline({ count: 2, explicit: true });
    expect(headline).toContain('YOU NAMED');
    expect(headline).toContain('2 file(s)');
  });
});

describe('formatNewFileGuidance — never prescribe the flag the caller already passed', () => {
  // WHY THIS IS PINNED (EI-18802204276510164). The `fail-new-file` verdict itself is correct and
  // deliberate (EI-18766822535373909) and must not move: a file the baseline has never seen has no
  // known-good state to drift from, so no scoping can exonerate it. What was wrong was only the
  // remedy line — it closed with "re-run with --files=<paths>" even when the caller HAD passed
  // --files (the run echoes `[--files]` in its own header two lines earlier). Prescribing the
  // action already taken reads as "I invoked it wrong", so the reader goes to the script to find
  // their mistake instead of to the actual next step. It lands specifically on the agents doing
  // the right thing — scoping precisely — at the moment they are deciding whether their change is
  // safe to leave in the tree.
  const joined = (explicit: boolean) => formatNewFileGuidance({ explicit }).join('\n');

  it('under --files: does NOT tell the caller to re-run with --files', () => {
    expect(joined(true)).not.toMatch(/re-run with --files/i);
  });

  it('under --files: names the real next step (fix it, or tell its author) instead', () => {
    const text = joined(true);
    expect(text).toMatch(/outside the .*--files.* set|set you named/i);
    expect(text).toMatch(/author/i);
  });

  it('under --mine: still offers --files= as the scoping remedy (it is genuinely next there)', () => {
    const text = joined(false);
    expect(text).toContain('--files=');
    // The git-sync rationale is the whole reason --mine cannot exonerate; it must survive.
    expect(text).toMatch(/git-sync/i);
  });

  // Non-vacuousness: the wording change must not soften the EI-18766822535373909 invariant in
  // EITHER mode. If a future edit ever lets one branch imply the new file can be scoped away,
  // this fails rather than silently greenwashing the verdict the guidance explains.
  it.each([true, false])(
    'explicit=%s: always states that a new file has no baseline to drift from',
    (explicit) => {
      expect(joined(explicit)).toMatch(/baseline has no known-good state|no baseline at all/i);
    },
  );
});

const SAMPLE = [
  "lib/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "lib/foo.ts(22,1): error TS2339: Property 'x' does not exist on type 'Y'.",
  "lib/broken.ts(1,1): error TS1005: ';' expected.",
  'some banner line without an error',
  'error TS5042: Option project cannot be mixed with source files.',
].join('\n');

describe('parseTscErrors', () => {
  it('extracts file + code per diagnostic, tolerating unattributed lines', () => {
    const errors = parseTscErrors(SAMPLE);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toEqual({ file: 'lib/foo.ts', code: 'TS2322' });
    expect(errors[2]).toEqual({ file: 'lib/broken.ts', code: 'TS1005' });
    expect(errors[3]).toEqual({ file: null, code: 'TS5042' });
  });

  it('returns [] for clean output', () => {
    expect(parseTscErrors('')).toEqual([]);
    expect(parseTscErrors('all good\n')).toEqual([]);
  });
});

describe('syntaxBrokenFiles', () => {
  it('flags only files with TS1xxx parse errors', () => {
    expect(syntaxBrokenFiles(parseTscErrors(SAMPLE))).toEqual(['lib/broken.ts']);
  });

  it('does not confuse TS1xxx with longer codes (TS1xxxx)', () => {
    const errors = parseTscErrors('lib/a.ts(1,1): error TS18046: x is of type unknown.');
    expect(syntaxBrokenFiles(errors)).toEqual([]);
  });
});

describe('countByFile', () => {
  it('aggregates errors per file, bucketing unattributed under (unattributed)', () => {
    expect(countByFile(parseTscErrors(SAMPLE))).toEqual({
      'lib/foo.ts': 2,
      'lib/broken.ts': 1,
      '(unattributed)': 1,
    });
  });
});

// EI-18731016038876755: --mine's git-status-derived scoping attributes EVERY dirty file on the
// shared checkout to the caller, including a PEER's in-flight edit — there is no session-scoped
// signal in `git status` to tell the two apart. `--files=` sidesteps the ambiguity: the caller
// states exactly which files are theirs instead of the gate guessing from tree dirt.
describe('parseExplicitFiles (EI-18731016038876755)', () => {
  it('returns null when --files= is absent — falls through to existing --mine/bare behavior', () => {
    expect(parseExplicitFiles([])).toBeNull();
    expect(parseExplicitFiles(['--mine', '--update'])).toBeNull();
  });

  it('parses a comma-separated --files= list into a Set of trimmed paths', () => {
    const s = parseExplicitFiles(['--files=lib/a.ts,lib/b.ts']);
    expect(s).toEqual(new Set(['lib/a.ts', 'lib/b.ts']));
  });

  it('tolerates stray whitespace around entries', () => {
    const s = parseExplicitFiles(['--files= lib/a.ts , lib/b.ts ']);
    expect(s).toEqual(new Set(['lib/a.ts', 'lib/b.ts']));
  });

  it('drops empty entries from a trailing/double comma without erroring', () => {
    const s = parseExplicitFiles(['--files=lib/a.ts,,lib/b.ts,']);
    expect(s).toEqual(new Set(['lib/a.ts', 'lib/b.ts']));
  });

  it('a single file still yields a one-element Set (not null)', () => {
    expect(parseExplicitFiles(['--files=lib/a.ts'])).toEqual(new Set(['lib/a.ts']));
  });

  it('finds --files= among other flags in any position', () => {
    expect(parseExplicitFiles(['--update', '--files=lib/a.ts', '--mine'])).toEqual(new Set(['lib/a.ts']));
  });
});

// Integration with the existing decidePerFile policy: an explicit file list is just another
// `changedFiles` Set from decidePerFile's point of view — this is the shape runTscBaselineGate
// wires it through as, proving --files= gets the SAME peer-drift-vs-attributed semantics --mine
// already has, not a parallel/weaker code path.
describe('parseExplicitFiles feeding decidePerFile (EI-18731016038876755)', () => {
  const brokenFree: string[] = [];

  it('a regression in a file NOT in the explicit list reports as peer drift, not attributed', () => {
    const changedFiles = parseExplicitFiles(['--files=b.ts'])!;
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles,
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
  });

  // EI-18766822535373909 — the live failure this pins: a brand-new file's REAL error was
  // reported under a leading ✓ as "peer drift — not your regression", because git-sync had
  // already auto-committed the file so it was no longer in `git status` and thus not in the
  // caller's changed set. A file the baseline has never seen can never be dismissed that way.
  it('a NEW file (absent from baseline) NOT in the changed set is NOT peer drift — it gates', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 2, 'brand-new.ts': 1 },
      baselineByFile: { 'a.ts': 2 },
      brokenFiles: brokenFree,
      // The caller's changed set does not contain the new file — exactly the live case.
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('fail-new-file');
    expect(r.newFiles!.map((x: { file: string }) => x.file)).toEqual(['brand-new.ts']);
    expect(r.peerDrift).toEqual([]);
  });

  // Non-vacuousness: the case above must fail for the NEW-FILE reason specifically, not because
  // any unchanged regression now gates. A file WITH a baseline still drifts benignly.
  it('a KNOWN file (in the baseline) not in the changed set is STILL benign peer drift', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
    expect(r.newFiles).toEqual([]);
  });

  it('a new file that IS in the changed set stays attributed (fail-attributed, not fail-new-file)', () => {
    const r = decidePerFile({
      currentByFile: { 'brand-new.ts': 1 },
      baselineByFile: {},
      brokenFiles: brokenFree,
      changedFiles: new Set(['brand-new.ts']),
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['brand-new.ts']);
  });

  // EI-19305736771912430 — the same input must gate or not depending ONLY on how the changed set
  // was OBTAINED, because that is what decides whether "absent from the set" is evidence at all.
  // `--mine` INFERS it from git status (absence proves nothing — git-sync commits your new file out
  // of the set within minutes, which is the whole EI-18766822535373909 hazard above). `--files`
  // DECLARES it: the caller enumerated their own files, so a new file outside that list is one they
  // asserted is not theirs. These three cases are deliberately adjacent so the distinction cannot be
  // "simplified" away by a future reader who sees only one of them.
  const newFileOutsideSet = {
    currentByFile: { 'a.ts': 2, 'peer-brand-new.ts': 1 },
    baselineByFile: { 'a.ts': 2 },
    brokenFiles: brokenFree,
    changedFiles: new Set(['b.ts']),
  };

  it('--files (DECLARED): a new file outside the named set does NOT set the exit code — but is still reported', () => {
    const r = decidePerFile({ ...newFileOutsideSet, attributionDeclared: true });
    expect(r.verdict).toBe('ok-peer-drift');
    // Reported, not swallowed: a committed one is a standing red that WILL red the fleet, and the
    // reporter prints it. Not gating is what stops a SCOPED run crying wolf; dropping it entirely
    // would just trade one failure for another.
    expect(r.newFiles!.map((x: { file: string }) => x.file)).toEqual(['peer-brand-new.ts']);
  });

  it('--mine (INFERRED): the SAME input still gates — EI-18766822535373909 is not weakened', () => {
    const r = decidePerFile({ ...newFileOutsideSet, attributionDeclared: false });
    expect(r.verdict).toBe('fail-new-file');
    expect(r.newFiles!.map((x: { file: string }) => x.file)).toEqual(['peer-brand-new.ts']);
  });

  it('--files (DECLARED): a new file that IS in the named set still gates — scoping never excuses your own', () => {
    const r = decidePerFile({
      currentByFile: { 'brand-new.ts': 1 },
      baselineByFile: {},
      brokenFiles: brokenFree,
      changedFiles: new Set(['brand-new.ts']),
      attributionDeclared: true,
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['brand-new.ts']);
  });

  // '(unattributed)' is not a file and is genuinely un-actionable, so it must NOT be pulled into
  // the gating new-file bucket just because it has no baseline entry.
  it("'(unattributed)' errors with no baseline stay in peerDrift, never gating as a new file", () => {
    const r = decidePerFile({
      currentByFile: { '(unattributed)': 2 },
      baselineByFile: {},
      brokenFiles: brokenFree,
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.newFiles).toEqual([]);
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['(unattributed)']);
  });

  it('a regression in a file IN the explicit list fails, attributed', () => {
    const changedFiles = parseExplicitFiles(['--files=a.ts'])!;
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles,
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
  });
});

// P-010 / WI-4535: the per-file gate. The old gate compared ONE integer total against a single pin
// (224) — it could not attribute a regression and flapped ±N under concurrent edits. These pin the
// per-file replacement: a file above ITS baseline is a named regression; a flap in file A never
// reds an agent editing file B; --mine scopes the failure to the caller's changed files.
describe('decidePerFile — per-file attribution + --update-only ratchet + syntax hard-fail', () => {
  const brokenFree: string[] = [];

  it('syntax-broken files hard-fail regardless of counts (unscoped / bare run)', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 1 },
      baselineByFile: { 'a.ts': 500 },
      brokenFiles: ['lib/broken.ts'],
    });
    expect(r.verdict).toBe('fail-syntax');
    expect(r.brokenFiles).toEqual(['lib/broken.ts']);
  });

  // EI-19321179234197157 — the live failure this pins: `--files=b.ts` hard-failed on a TS1xxx
  // parse error in `lib/peer-broken.ts`, a file the caller never named and — on this shared
  // single-worktree box — was simply a peer's in-flight edit. The syntax hard-fail must be scoped
  // the same way a type-error regression already is: unattributed under `--mine`/`--files`, still
  // reported (never silently dropped), never gating.
  it('--files: a syntax-broken file OUTSIDE the named set does NOT gate — reported as unattributedBrokenFiles', () => {
    const r = decidePerFile({
      currentByFile: { 'b.ts': 0 },
      baselineByFile: { 'b.ts': 0 },
      brokenFiles: ['lib/peer-broken.ts'],
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).not.toBe('fail-syntax');
    expect(r.unattributedBrokenFiles).toEqual(['lib/peer-broken.ts']);
  });

  it('--files: a syntax-broken file INSIDE the named set still hard-fails, unconditionally', () => {
    const r = decidePerFile({
      currentByFile: { 'b.ts': 0 },
      baselineByFile: { 'b.ts': 500 },
      brokenFiles: ['b.ts', 'lib/peer-broken.ts'],
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('fail-syntax');
    expect(r.brokenFiles).toEqual(['b.ts']);
    expect(r.unattributedBrokenFiles).toEqual(['lib/peer-broken.ts']);
  });

  it('--mine (inferred changedFiles) scopes the syntax hard-fail identically to --files', () => {
    const r = decidePerFile({
      currentByFile: { 'b.ts': 0 },
      baselineByFile: { 'b.ts': 0 },
      brokenFiles: ['lib/peer-broken.ts'],
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).not.toBe('fail-syntax');
  });

  it('every file at its baseline is ok', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 2, 'b.ts': 1 }, baselineByFile: { 'a.ts': 2, 'b.ts': 1 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('ok');
    expect(r.regressions).toEqual([]);
  });

  it('a file ABOVE its baseline is an attributed regression (fail-regressed, NAMED with old→new)', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 4, 'b.ts': 1 }, baselineByFile: { 'a.ts': 2, 'b.ts': 1 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.regressions).toEqual([{ file: 'a.ts', baseline: 2, current: 4, delta: 2 }]);
  });

  it('a NEW file with errors (absent from baseline ⇒ implicit 0) is a regression', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 2, 'new.ts': 1 }, baselineByFile: { 'a.ts': 2 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.regressions.map((x: { file: string }) => x.file)).toEqual(['new.ts']);
  });

  it('does NOT red an agent editing file B when only file A flapped up (attribution isolates the cause)', () => {
    // file A regressed +1, but the agent only touched b.ts → their change is clean under --mine.
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
    expect(r.attributed).toEqual([]);
  });

  it('--mine FAILS when the regression IS in a file the caller changed', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['a.ts']),
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
  });

  it('a bare run (no --mine) gates ANY regression — CI stays strict', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3 },
      baselineByFile: { 'a.ts': 2 },
      brokenFiles: brokenFree,
      changedFiles: null,
    });
    expect(r.verdict).toBe('fail-regressed');
  });

  it('below baseline on a BARE run is check-only (ok-below) — no ratchet, no baseline rewrite', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 1 }, baselineByFile: { 'a.ts': 3 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('ok-below');
    expect(r.improvements).toEqual([{ file: 'a.ts', baseline: 3, current: 1, delta: -2 }]);
    expect(r.newBaselineByFile).toBeUndefined();
  });

  it('below baseline WITH --update ratchets improved files down (newBaselineByFile = current)', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 1, 'b.ts': 2 }, baselineByFile: { 'a.ts': 3, 'b.ts': 2 }, brokenFiles: brokenFree, updateFlag: true });
    expect(r.verdict).toBe('ok-ratchet');
    expect(r.newBaselineByFile).toEqual({ 'a.ts': 1, 'b.ts': 2 });
  });

  it('regressions win over improvements — --update can never RAISE a file (ratchet-only-down)', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 5, 'b.ts': 1 }, // a regressed, b improved
      baselineByFile: { 'a.ts': 2, 'b.ts': 3 },
      brokenFiles: brokenFree,
      updateFlag: true,
    });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.newBaselineByFile).toBeUndefined();
  });
});

// EI-18649014117371738: two gates over the SAME tree gave OPPOSITE verdicts on the same untouched
// files. `lint:tsc` passed (operator-core's baseline records e.g. memory/search.ts: 1 — known and
// tolerated) while `lint:tsc:operator-vite` failed, because that file was ABSENT from the vite
// baseline and absent⇒0 made it a phantom "0 → 1" regression. 12 operator-core files read as
// regressions to an agent who had opened none of them, which is the exact false signal the per-file
// gate exists to kill (EI-847) leaking back in at the cross-package seam. Absent means "this gate
// never recorded it", NOT "it was clean" — so a file OWNED by another package inherits that
// package's baseline instead of an implicit 0.
describe('effectiveBaselineByFile — cross-package files inherit their OWNER package baseline', () => {
  const FOREIGN = [
    {
      prefix: 'packages/operator-core/',
      files: { 'packages/operator-core/lib/agent-tools/memory/search.ts': 1 },
      label: 'operator-core',
    },
  ];

  it('the reported bug: a foreign file tolerated by its owner is NOT a regression here', () => {
    const currentByFile = { 'packages/operator-core/lib/agent-tools/memory/search.ts': 1 };
    const { effective, inherited } = effectiveBaselineByFile({
      baselineByFile: {}, // absent from THIS gate's baseline — the whole bug
      currentByFile,
      foreignBaselines: FOREIGN,
    });
    expect(effective['packages/operator-core/lib/agent-tools/memory/search.ts']).toBe(1);
    expect(inherited).toEqual([
      { file: 'packages/operator-core/lib/agent-tools/memory/search.ts', baseline: 1, from: 'operator-core' },
    ]);

    // ...and the gate now agrees with lint:tsc instead of contradicting it.
    const r = decidePerFile({ currentByFile, baselineByFile: effective, brokenFiles: [] });
    expect(r.verdict).toBe('ok');
    expect(r.regressions).toEqual([]);
  });

  it('WITHOUT inheritance the same input false-reds — pins that this test guards a real behaviour change', () => {
    const r = decidePerFile({
      currentByFile: { 'packages/operator-core/lib/agent-tools/memory/search.ts': 1 },
      baselineByFile: {},
      brokenFiles: [],
    });
    expect(r.verdict).toBe('fail-regressed');
  });

  it('a foreign file ABOVE its owner baseline is still a NAMED regression (no laundering)', () => {
    const currentByFile = { 'packages/operator-core/lib/agent-tools/memory/search.ts': 3 };
    const { effective } = effectiveBaselineByFile({ baselineByFile: {}, currentByFile, foreignBaselines: FOREIGN });
    const r = decidePerFile({ currentByFile, baselineByFile: effective, brokenFiles: [] });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.regressions).toEqual([
      { file: 'packages/operator-core/lib/agent-tools/memory/search.ts', baseline: 1, current: 3, delta: 2 },
    ]);
  });

  it("this gate's OWN explicit baseline always wins — a foreign count can never loosen the ratchet", () => {
    const { effective, inherited } = effectiveBaselineByFile({
      baselineByFile: { 'packages/operator-core/lib/agent-tools/memory/search.ts': 0 },
      currentByFile: { 'packages/operator-core/lib/agent-tools/memory/search.ts': 1 },
      foreignBaselines: FOREIGN,
    });
    expect(effective['packages/operator-core/lib/agent-tools/memory/search.ts']).toBe(0);
    expect(inherited).toEqual([]);
  });

  it('a foreign file absent from BOTH baselines is still an implicit 0 — genuinely new errors gate', () => {
    const currentByFile = { 'packages/operator-core/lib/brand-new.ts': 2 };
    const { effective } = effectiveBaselineByFile({ baselineByFile: {}, currentByFile, foreignBaselines: FOREIGN });
    expect(effective['packages/operator-core/lib/brand-new.ts']).toBeUndefined();
    expect(decidePerFile({ currentByFile, baselineByFile: effective, brokenFiles: [] }).verdict).toBe('fail-regressed');
  });

  it('a file this gate OWNS is untouched by inheritance — new local files still gate at 0', () => {
    const currentByFile = { 'apps/operator-vite/src/New.tsx': 1 };
    const { effective, inherited } = effectiveBaselineByFile({ baselineByFile: {}, currentByFile, foreignBaselines: FOREIGN });
    expect(effective).toEqual({});
    expect(inherited).toEqual([]);
    expect(decidePerFile({ currentByFile, baselineByFile: effective, brokenFiles: [] }).verdict).toBe('fail-regressed');
  });

  it('never injects foreign files this gate did not MEASURE (no phantom improvements / inflated total)', () => {
    // memory/search.ts is in the owner baseline but not in this run's output: it must NOT appear,
    // or it would read as an "improvement" and inflate the reported baseline total.
    const { effective } = effectiveBaselineByFile({
      baselineByFile: {},
      currentByFile: { 'apps/operator-vite/src/App.tsx': 1 },
      foreignBaselines: FOREIGN,
    });
    expect(effective['packages/operator-core/lib/agent-tools/memory/search.ts']).toBeUndefined();
  });

  it('no foreign sources configured ⇒ byte-identical behaviour (operator-core gate unaffected)', () => {
    const baselineByFile = { 'a.ts': 2 };
    const { effective, inherited } = effectiveBaselineByFile({ baselineByFile, currentByFile: { 'a.ts': 2 } });
    expect(effective).toBe(baselineByFile); // same object — no copy, no change
    expect(inherited).toEqual([]);
  });
});

describe('operator-vite gate wiring (EI-18649014117371738)', () => {
  it('declares packages/operator-core as a foreign owner so the two gates cannot disagree', () => {
    const core = FOREIGN_BASELINES.find((s: { prefix: string }) => s.prefix === 'packages/operator-core/');
    expect(core, 'operator-vite measures operator-core files; it must inherit their owner baseline').toBeDefined();
    expect(core!.baselineFile).toMatch(/packages\/operator-core\/\.tsc-baseline\.json$/);
    // A stale path here would silently degrade to the old absent⇒0 false-red, so pin that it resolves.
    expect(existsSync(core!.baselineFile)).toBe(true);
  });
});

// EI-18756182128903253 — `--mine`/`--files` is structurally BLIND to the single most common
// gate-redding change shape: adding a REQUIRED field to a shared exported interface. By
// definition the new type errors that causes land in files the caller did NOT change (the
// fixtures/constructors that build that type) — so the caller's own `--mine` reads clean and
// the break first surfaces hours later at the fleet-wide green-checkpoint. Fix: widen attribution
// to any file that references a type/interface/class/enum one of the CHANGED files also exports.
describe('exportedTypeNames + filesReferencingTypeNames (EI-18756182128903253)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('extracts exported interface/type/class/enum names, ignoring non-exported and local ones', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    writeFileSync(
      join(dir, 'shape.ts'),
      [
        'interface NotExported { x: number }',
        'export interface PipelinePosition { serving: string }',
        'export type ServingTruth = { ok: boolean };',
        'export class Widget {}',
        'export enum Mode { A, B }',
        'export default function foo() {}',
      ].join('\n'),
    );
    const names = exportedTypeNames(dir, ['shape.ts']);
    expect(names).toEqual(new Set(['PipelinePosition', 'ServingTruth', 'Widget', 'Mode']));
  });

  it('returns an empty set and never throws for an unreadable/missing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    expect(exportedTypeNames(dir, ['does-not-exist.ts'])).toEqual(new Set());
  });

  it('filesReferencingTypeNames finds a whole-word reference and ignores an unrelated file', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    writeFileSync(join(dir, 'fixture.ts'), 'const p: PipelinePosition = { serving: "x" };');
    writeFileSync(join(dir, 'unrelated.ts'), 'const q = 1 + 1;');
    const referencing = filesReferencingTypeNames(dir, ['fixture.ts', 'unrelated.ts'], new Set(['PipelinePosition']));
    expect(referencing).toEqual(new Set(['fixture.ts']));
  });

  it('filesReferencingTypeNames does not partial-match a substring of a longer identifier', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    writeFileSync(join(dir, 'decoy.ts'), 'const x: PipelinePositionExtended = {} as any;');
    const referencing = filesReferencingTypeNames(dir, ['decoy.ts'], new Set(['PipelinePosition']));
    expect(referencing).toEqual(new Set());
  });

  it('short-circuits to an empty set with zero type names — never opens a file needlessly', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    writeFileSync(join(dir, 'anything.ts'), 'export const x = 1;');
    expect(filesReferencingTypeNames(dir, ['anything.ts'], new Set())).toEqual(new Set());
  });
});

// The RECURRENCE GUARD named in the filed bug: "a unit test over lint-tsc's scoping constructing
// the exact shape — file A adds a required field, unchanged file B breaks — asserting --mine does
// NOT report clean. That test fails today." This exercises decidePerFile directly with the
// typeReferencedFiles wiring runTscBaselineGate now computes, reproducing the measured live
// instance (PipelinePosition.serving made required in git-pipeline-position.ts,
// release-trace.test.ts's unchanged fixture broke).
describe('decidePerFile + typeReferencedFiles — the required-field-on-a-shared-interface shape', () => {
  const brokenFree: string[] = [];

  it('a regression OUTSIDE changedFiles gates when it references a type the changed file exports', () => {
    // git-pipeline-position.ts (changed, exports PipelinePosition) added a required field;
    // release-trace.test.ts (NOT in the diff) never updated its fixture and now fails to compile.
    const typeReferencedFiles = new Set(['packages/operator-core/lib/release-trace.test.ts']);
    const r = decidePerFile({
      currentByFile: {
        'packages/operator-core/lib/git-pipeline-position.ts': 0,
        'packages/operator-core/lib/release-trace.test.ts': 1,
      },
      baselineByFile: {
        'packages/operator-core/lib/git-pipeline-position.ts': 0,
        'packages/operator-core/lib/release-trace.test.ts': 0,
      },
      brokenFiles: brokenFree,
      changedFiles: new Set(['packages/operator-core/lib/git-pipeline-position.ts']),
      typeReferencedFiles,
    });
    // This is the assertion the filed bug says fails today (pre-fix, --mine reported ok-peer-drift
    // or ok here because release-trace.test.ts is not in changedFiles).
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual([
      'packages/operator-core/lib/release-trace.test.ts',
    ]);
    expect(r.typeAttributed!.map((x: { file: string }) => x.file)).toEqual([
      'packages/operator-core/lib/release-trace.test.ts',
    ]);
  });

  it('WITHOUT typeReferencedFiles the identical input false-passes as ok-peer-drift — pins the exact live bug', () => {
    // Byte-identical to the first test's inputs, minus typeReferencedFiles: this is precisely
    // "--mine reads clean" from the filed report — release-trace.test.ts has a baseline entry (it
    // is a KNOWN file), so absent any type-reference signal it is dismissed as benign peer drift
    // rather than gated, even though it is the direct, real consequence of the changed file.
    const r = decidePerFile({
      currentByFile: {
        'packages/operator-core/lib/git-pipeline-position.ts': 0,
        'packages/operator-core/lib/release-trace.test.ts': 1,
      },
      baselineByFile: {
        'packages/operator-core/lib/git-pipeline-position.ts': 0,
        'packages/operator-core/lib/release-trace.test.ts': 0,
      },
      brokenFiles: brokenFree,
      changedFiles: new Set(['packages/operator-core/lib/git-pipeline-position.ts']),
      // no typeReferencedFiles — the pre-fix behaviour
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual([
      'packages/operator-core/lib/release-trace.test.ts',
    ]);
  });

  it('a file NOT referencing any changed-file type stays peer drift even with typeReferencedFiles active for others', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 0, 'unrelated.ts': 1, 'referencing.ts': 1 },
      baselineByFile: { 'a.ts': 0, 'unrelated.ts': 0, 'referencing.ts': 0 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['a.ts']),
      typeReferencedFiles: new Set(['referencing.ts']),
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['referencing.ts']);
    // unrelated.ts has its own baseline entry (a KNOWN file), so it is benign peer drift, not
    // attributed — it is neither changed nor type-referenced.
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['unrelated.ts']);
  });

  it('a file directly in changedFiles is attributed but NOT counted in typeAttributed (no double-widening)', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 1 },
      baselineByFile: { 'a.ts': 0 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['a.ts']),
      typeReferencedFiles: new Set(['a.ts']), // even if it were (redundantly) also type-referenced
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
    expect(r.typeAttributed).toEqual([]); // changedFiles wins; not double-counted as type-attributed
  });
});

describe('new files: a peer mid-edit is not the caller’s regression (EI-19278299775574199)', () => {
  // WHY THIS EXISTS. Under `--files` the caller ENUMERATED their own files, so a new-to-the-baseline
  // file outside that set is by definition not one they named. Every such file used to be printed
  // the same way — "If one is yours, fix it" — whether it was a peer's uncommitted, actively-changing
  // buffer or a committed standing red. Those need OPPOSITE actions, and the gate conflated them:
  //
  //   - DIRTY (uncommitted right now): someone else has it open. It is transient, it has not reached
  //     origin, and it is NOT yet a fleet-gate red. Editing it stomps a live peer — the filed report
  //     nearly hand-edited a 3,188-line file another agent was writing to at that moment.
  //   - CLEAN (committed): a standing red that WILL red the fleet at the next bare run. Loud is right.
  //
  // The VERDICT deliberately does not move (EI-18766822535373909 — a file with no baseline has no
  // known-good state to drift from, and git-sync commits the tree every few minutes, so *absence*
  // from the changed set can never exonerate). Only the ATTRIBUTION and the remedy change. Note the
  // distinction is reachable only under `--files`: under `--mine` the changed set IS the dirty set,
  // so a dirty file is already `attributed` and can never land in `newFiles`.
  const brokenFree: string[] = [];

  it('annotates a new file as dirty when it is uncommitted in the shared tree', () => {
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 0, 'peer-new.ts': 5 },
      baselineByFile: { 'mine.ts': 0 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['mine.ts']),
      dirtyFiles: new Set(['peer-new.ts']),
    });
    expect(r.verdict).toBe('fail-new-file');
    expect(r.newFiles!.map((x: { file: string; dirty?: boolean }) => [x.file, x.dirty])).toEqual([
      ['peer-new.ts', true],
    ]);
  });

  it('annotates a COMMITTED new file as not-dirty (a standing red, not a live edit)', () => {
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 0, 'landed-new.ts': 2 },
      baselineByFile: { 'mine.ts': 0 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['mine.ts']),
      dirtyFiles: new Set(), // nothing uncommitted — it has landed
    });
    expect(r.newFiles!.map((x: { file: string; dirty?: boolean }) => [x.file, x.dirty])).toEqual([
      ['landed-new.ts', false],
    ]);
  });

  it('NEVER greenwashes: a dirty peer new-file still fails the run', () => {
    // The one invariant this change must not break (tsc-baseline-gate.mjs: "Never greenwash this
    // one"). Attribution softens; the verdict does not.
    const r = decidePerFile({
      currentByFile: { 'peer-new.ts': 5 },
      baselineByFile: {},
      brokenFiles: brokenFree,
      changedFiles: new Set(['mine.ts']),
      dirtyFiles: new Set(['peer-new.ts']),
    });
    expect(r.verdict).toBe('fail-new-file');
  });

  it('splits new files into live peer edits vs standing reds', () => {
    const { liveEdits, standing } = partitionNewFilesByLiveEdit([
      { file: 'peer-new.ts', baseline: 0, current: 5, delta: 5, dirty: true },
      { file: 'landed-new.ts', baseline: 0, current: 2, delta: 2, dirty: false },
    ]);
    expect(liveEdits.map((x: { file: string }) => x.file)).toEqual(['peer-new.ts']);
    expect(standing.map((x: { file: string }) => x.file)).toEqual(['landed-new.ts']);
  });

  it('treats an unknown dirty state as standing — never invents an exoneration', () => {
    // dirtyFiles was unavailable (git failed, or --mine): `dirty` is undefined. The safe reading is
    // "cannot show it is a live edit", so it stays in the loud bucket.
    const { liveEdits, standing } = partitionNewFilesByLiveEdit([
      { file: 'unknown.ts', baseline: 0, current: 1, delta: 1 },
    ]);
    expect(liveEdits).toEqual([]);
    expect(standing.map((x: { file: string }) => x.file)).toEqual(['unknown.ts']);
  });

  it('guidance tells the caller a live edit is NOT theirs and not to edit it', () => {
    const text = formatNewFileGuidance({ explicit: true, liveEditCount: 1, standingCount: 0 }).join('\n');
    expect(text).toMatch(/uncommitted|mid-edit/i);
    expect(text).toMatch(/not attributed to you|isn’t yours|not yours/i);
    // The actively harmful instruction the old text gave for this case.
    expect(text).not.toMatch(/If one is yours, fix it/i);
  });

  it('guidance still says "fix it" when the new file is a committed standing red', () => {
    const text = formatNewFileGuidance({ explicit: true, liveEditCount: 0, standingCount: 1 }).join('\n');
    expect(text).toMatch(/fix/i);
    expect(text).not.toMatch(/mid-edit/i);
  });

  it('with NO split supplied, falls back to the full standing text (unknown ⇒ loud)', () => {
    // Caught by the pre-existing EI-18802204276510164 tests when this split was first added: with
    // both counts defaulting to 0 the guidance collapsed to a single line, silently dropping the
    // "outside the --files set" explanation and the tell-the-author remedy. Same rule as
    // partitionNewFilesByLiveEdit — absence of evidence is never evidence of a live edit.
    const text = formatNewFileGuidance({ explicit: true }).join('\n');
    expect(text).toMatch(/set you named|outside the .*--files.* set/i);
    expect(text).toMatch(/author/i);
    expect(text).not.toMatch(/mid-edit/i);
  });

  it('keeps the EI-18802204276510164 fix: never re-prescribes --files to a --files caller', () => {
    for (const opts of [
      { explicit: true, liveEditCount: 1, standingCount: 0 },
      { explicit: true, liveEditCount: 0, standingCount: 1 },
      { explicit: true, liveEditCount: 1, standingCount: 1 },
    ]) {
      expect(formatNewFileGuidance(opts).join('\n')).not.toMatch(/re-run with --files/i);
    }
  });
});

describe('new-file reds: the count alone withholds the diagnosis (WI-6767)', () => {
  // WHY THIS EXISTS. The `fail-new-file` report said `file: 0 → 1 (+1)` and stopped. Recovering the
  // actual message from that costs a fresh full-project compile (~100s here under contention), so
  // the WI-6764 filer recorded — verbatim — that they could not capture the TSxxxx because a full
  // `tsc -p packages/operator-core` blew their shell budget TWICE, and filed a major bug without
  // ever seeing the error. The next agent then spent ~20 minutes re-deriving it. The line was in a
  // string the gate already held.
  const SAMPLE = [
    "lib/a.ts(10,3): error TS2322: Type '\"memory-recall-scale\"' is not assignable to type 'WatchdogSource'.",
    'lib/a.ts(11,3): error TS2339: Property x does not exist.',
    'lib/a.ts(12,3): error TS2339: Property y does not exist.',
    'lib/a.ts(13,3): error TS2339: Property z does not exist.',
    'lib/other.ts(1,1): error TS2554: Expected 1 arguments.',
    'error TS5042: Option project cannot be mixed with source files.',
  ].join('\n');

  it('quotes the real compiler lines for the requested files only', () => {
    const got = diagnosticLinesForFiles(SAMPLE, ['lib/a.ts']);
    expect([...got.keys()]).toEqual(['lib/a.ts']);
    // The message — not just the code — is what makes a landing race self-evident: it names a type
    // that lives in a DIFFERENT file.
    expect(got.get('lib/a.ts')![0]).toContain("not assignable to type 'WatchdogSource'");
  });

  it('caps the quote per file so one noisy file cannot bury the guidance', () => {
    expect(diagnosticLinesForFiles(SAMPLE, ['lib/a.ts']).get('lib/a.ts')).toHaveLength(3);
    expect(diagnosticLinesForFiles(SAMPLE, ['lib/a.ts'], { maxPerFile: 1 }).get('lib/a.ts')).toHaveLength(1);
  });

  it('asks for nothing → returns nothing, and never attributes a global (unattributed) error', () => {
    expect(diagnosticLinesForFiles(SAMPLE, []).size).toBe(0);
    // TS5042 has no file; it must not be smuggled under some file's heading.
    const all = diagnosticLinesForFiles(SAMPLE, ['lib/a.ts', 'lib/other.ts']);
    expect([...all.values()].flat().join('\n')).not.toContain('TS5042');
  });

  it('cannot drift from the counter: every file counted +N can produce its lines', () => {
    // The anti-drift pin. Both read the same LOCATED_DIAGNOSTIC grammar, so a file that shows a
    // count in the summary must be quotable — otherwise the report would print "+1" above silence.
    const counted = Object.keys(countByFile(parseTscErrors(SAMPLE))).filter((f) => f !== '(unattributed)');
    const quoted = diagnosticLinesForFiles(SAMPLE, counted);
    for (const file of counted) expect(quoted.get(file)?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('new-file reds: COMMITTED does not mean SETTLED (WI-6767)', () => {
  // WHY THIS EXISTS. EI-19278299775574199 split new-file reds into a peer's UNCOMMITTED live edit
  // (don't touch) and a COMMITTED standing red (fix it now). That split is right — but it assumes
  // `committed` implies `settled`, and on this repo it does not: git-sync commits the WHOLE shared
  // tree on a schedule, so ONE logical multi-file change routinely lands across TWO ticks.
  //
  // Measured (WI-6764): commit 133317acd0 @20:25:57 landed a file emitting `source:
  // 'memory-recall-scale'`; the union accepting that value landed in watchdog.ts at 82a0d03bef
  // @20:33:46. For 7m49s the committed tree held exactly one real type error belonging to nobody.
  // An agent ran this gate inside that window, checked `git status` (clean), correctly concluded
  // "committed ⇒ standing red", and filed a major bug for something that had healed itself ~1
  // minute earlier. The reasoning was sound; the report had no way to say "wait a moment first".
  const NOW = 1_800_000_000;
  const row = (file: string) => ({ file, baseline: 0, current: 1, delta: 1 });

  it('flags a file committed inside the window as a possible landing race', () => {
    const { recent, settled } = partitionStandingByCommitRecency(
      [row('fresh.ts')],
      new Map([['fresh.ts', NOW - 120]]),
      NOW,
    );
    expect(recent.map((r: { file: string }) => r.file)).toEqual(['fresh.ts']);
    expect(settled).toEqual([]);
  });

  it('leaves a file committed long ago as a genuine standing red', () => {
    const { recent, settled } = partitionStandingByCommitRecency(
      [row('old.ts')],
      new Map([['old.ts', NOW - LANDING_RACE_WINDOW_SEC - 1]]),
      NOW,
    );
    expect(recent).toEqual([]);
    expect(settled.map((r: { file: string }) => r.file)).toEqual(['old.ts']);
  });

  it('treats an UNREADABLE commit time as standing — unknown is never an exoneration', () => {
    // The safety pin, and the same rule partitionNewFilesByLiveEdit applies. This caveat tells a
    // reader it is safe to WAIT rather than act, so it must be earned by positive evidence. A git
    // failure must not manufacture "probably fine, ignore it".
    const { recent, settled } = partitionStandingByCommitRecency(
      [row('unknown.ts')],
      new Map([['unknown.ts', null]]),
      NOW,
    );
    expect(recent).toEqual([]);
    expect(settled.map((r: { file: string }) => r.file)).toEqual(['unknown.ts']);
  });

  it('treats a MISSING entry and a future timestamp as standing too', () => {
    const { recent } = partitionStandingByCommitRecency(
      [row('absent.ts'), row('skewed.ts')],
      new Map([['skewed.ts', NOW + 5_000]]), // clock skew must not read as "just landed"
      NOW,
    );
    expect(recent).toEqual([]);
  });

  it('says nothing at all when no file is recent', () => {
    expect(formatLandingRaceCaveat({ recentCount: 0 })).toEqual([]);
  });

  it('tells the reader to re-run before filing, and never to ignore the failure', () => {
    const text = formatLandingRaceCaveat({ recentCount: 1 }).join('\n');
    expect(text).toMatch(/landing/i);
    expect(text).toMatch(/re-run/i);
    expect(text).toMatch(/before filing/i);
    // It must not greenwash: the run still failed, and this caveat is a diagnosis aid, not a
    // permission slip. "Never greenwash this one" is the invariant the whole new-file branch rests
    // on (EI-18766822535373909).
    expect(text).not.toMatch(/safe to ignore|you can ignore|not a real error|disregard/i);
  });
});
