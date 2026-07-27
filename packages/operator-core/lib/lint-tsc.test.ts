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
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import * as lintTscModule from '../../../scripts/lint-tsc.mjs';
// eslint-disable-next-line import/no-relative-packages
import {
  parseTscErrors,
  syntaxBrokenFiles,
  countByFile,
  parseExplicitFiles,
  decidePerFile,
  effectiveBaselineByFile,
  formatAttributionHeadline,
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

describe('scripts/lint-tsc.d.mts stays in sync with scripts/lint-tsc.mjs', () => {
  // WHY. `packages/operator-core/tsconfig.json` sets `allowJs: false`, so TS never reads the
  // .mjs — it reads the HAND-MAINTAINED `lint-tsc.d.mts` beside it. Add an export to the .mjs
  // and forget the declaration and every importer gets `TS2305: has no exported member`, in a
  // file whose only sin was importing it. That is not hypothetical: `parseExplicitFiles` was
  // added by EI-18731016038876755 and never declared, so this test file carried a permanent
  // baseline of 1 error that everyone had learned to look past — which is exactly how the NEXT
  // one hides. (It duly did: `formatAttributionHeadline` made it 2.) A silent, hand-synced
  // projection with no drift check is the same defect D-020 fixed for the substitution
  // registry's CLAUDE.md/DB projections; this is that check for this one.
  it('declares every runtime export (a missing declaration is TS2305 for every importer)', () => {
    const dts = readFileSync(
      new URL('../../../scripts/lint-tsc.d.mts', import.meta.url),
      'utf8',
    );
    const declared = new Set(
      [...dts.matchAll(/^export\s+(?:declare\s+)?(?:function|const)\s+([A-Za-z0-9_$]+)/gm)].map(
        (m) => m[1],
      ),
    );
    const runtimeExports = Object.keys(lintTscModule).filter((k) => k !== 'default');
    const undeclared = runtimeExports.filter((name) => !declared.has(name));

    expect(undeclared, `undeclared in lint-tsc.d.mts: ${undeclared.join(', ')}`).toEqual([]);
  });
});

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

  it('syntax-broken files hard-fail regardless of counts', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 1 },
      baselineByFile: { 'a.ts': 500 },
      brokenFiles: ['lib/broken.ts'],
    });
    expect(r.verdict).toBe('fail-syntax');
    expect(r.brokenFiles).toEqual(['lib/broken.ts']);
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
