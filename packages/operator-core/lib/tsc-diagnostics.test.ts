/**
 * Unit tests for the tsc diagnostic projection behind `build:typecheck`
 * (plan `bash-to-tool-substitution-2026-07-26`, P-024).
 *
 * The fixtures are VERBATIM lines from a real
 * `tsc -p packages/operator-core/tsconfig.json --noEmit --pretty false` run
 * (TypeScript 6.0.3) and from the three no-op shapes reproduced live at the
 * repo root — not hand-written approximations of what tsc might print.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_INPUT_CODES,
  errorsOnly,
  filterToFiles,
  noInputDiagnostic,
  parseFoundSummary,
  parseTscDiagnostics,
  summariseByFile,
  syntaxBrokenFiles,
} from './tsc-diagnostics';

/** Verbatim from the live operator-core run. */
const REAL_OUTPUT = [
  "libs/generic/sync/src/index.ts(1,30): error TS6142: Module './SyncProvider' was resolved to '/home/x/SyncProvider.tsx', but '--jsx' is not set.",
  "libs/generic/sync/src/virtualizer/use-sync-virtualizer.ts(283,5): error TS2322: Type '(index: number) => string | number | bigint | unique symbol' is not assignable to type '(index: number) => Key'.",
  "  Type 'string | number | bigint | unique symbol' is not assignable to type 'Key'.",
  "    Type 'typeof React.optimisticKey' is not assignable to type 'Key'.",
  "libs/papercusp/packages/orchestrator/src/invoke.ts(2356,53): error TS2345: Argument of type 'readonly string[]' is not assignable to parameter of type 'string[]'.",
  "  The type 'readonly string[]' is 'readonly' and cannot be assigned to the mutable type 'string[]'.",
  "packages/plugin-loader/src/wasm/jco-transpiler.ts(49,26): error TS2307: Cannot find module '@bytecodealliance/jco' or its corresponding type declarations.",
].join('\n');

describe('parseTscDiagnostics', () => {
  it('parses one diagnostic per top-level line, with full location + code', () => {
    const diagnostics = parseTscDiagnostics(REAL_OUTPUT);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics[0]).toMatchObject({
      file: 'libs/generic/sync/src/index.ts',
      line: 1,
      column: 30,
      code: 'TS6142',
      category: 'error',
    });
    expect(diagnostics[3]).toMatchObject({ file: 'packages/plugin-loader/src/wasm/jco-transpiler.ts', line: 49, column: 26, code: 'TS2307' });
  });

  it('folds nested continuation lines into the preceding diagnostic (that is where the cause is)', () => {
    const [, assignability] = parseTscDiagnostics(REAL_OUTPUT);
    expect(assignability.message).toContain("is not assignable to type '(index: number) => Key'");
    // The nested detail is retained, not dropped — otherwise the agent has to go
    // re-read the raw log, re-creating the pipe this tool removes.
    expect(assignability.message).toContain("Type 'typeof React.optimisticKey' is not assignable");
  });

  it('caps a pathologically nested message rather than returning it unbounded', () => {
    const nested = ['a.ts(1,1): error TS2322: head.', ...Array.from({ length: 200 }, (_, i) => `${'  '.repeat(i % 8 + 1)}nested detail line ${i} with filler text`)].join('\n');
    const [d] = parseTscDiagnostics(nested);
    expect(d.message.length).toBeLessThanOrEqual(410);
    expect(d.message.endsWith('…')).toBe(true);
  });

  it('parses a global (unattributed) error with a null file', () => {
    const [d] = parseTscDiagnostics("error TS5057: Cannot find a tsconfig.json file at the specified directory: '.'.");
    expect(d).toMatchObject({ file: null, line: null, column: null, code: 'TS5057', category: 'error' });
  });

  it('ignores non-diagnostic chatter instead of inventing entries', () => {
    expect(parseTscDiagnostics('Version 6.0.3\n\nCOMMON COMMANDS\n\n  tsc --init\n')).toHaveLength(0);
  });

  it('returns nothing for empty output (never a phantom clean result)', () => {
    expect(parseTscDiagnostics('')).toHaveLength(0);
  });

  it('handles CRLF output', () => {
    expect(parseTscDiagnostics('a.ts(1,2): error TS1005: x\r\n')).toHaveLength(1);
  });
});

describe('no-op detection — the correctness argument for the tool', () => {
  // Each string is the LIVE output of that command at the papercusp repo root,
  // which has no root tsconfig.json (only tsconfig.base.json).
  it.each([
    ['tsc --noEmit -p .', "error TS5057: Cannot find a tsconfig.json file at the specified directory: '.'.", 'TS5057'],
    ['tsc --noEmit -p tsconfig.json', "error TS5058: The specified path does not exist: 'tsconfig.json'.", 'TS5058'],
    ['a tsconfig matching no inputs', "error TS18003: No inputs were found in config file '/x/tsconfig.json'.", 'TS18003'],
    ['a missing file operand', "error TS6053: File '/x/nope.ts' not found.", 'TS6053'],
  ])('flags %s as having typechecked nothing', (_label, output, code) => {
    const found = noInputDiagnostic(parseTscDiagnostics(output));
    expect(found?.code).toBe(code);
    expect(NO_INPUT_CODES.has(code)).toBe(true);
  });

  it('does NOT flag a real type error as a no-op', () => {
    expect(noInputDiagnostic(parseTscDiagnostics(REAL_OUTPUT))).toBeNull();
  });

  it('does not flag a merely EMPTY result — that is a clean project, not a no-op', () => {
    expect(noInputDiagnostic(parseTscDiagnostics(''))).toBeNull();
  });
});

describe('syntaxBrokenFiles', () => {
  it('names files with a TS1xxx parse error (tsc under-reports behind them)', () => {
    const d = parseTscDiagnostics([
      "a.ts(1,1): error TS1005: ';' expected.",
      'b.ts(2,2): error TS2322: not assignable.',
    ].join('\n'));
    expect(syntaxBrokenFiles(d)).toEqual(['a.ts']);
  });

  it('does not classify TS1320 semantic await/type errors as syntax failures', () => {
    const d = parseTscDiagnostics(
      "a.ts(597,60): error TS1320: Type of 'await' operand must either be a valid promise or must not contain a callable 'then' member.",
    );
    expect(syntaxBrokenFiles(d)).toEqual([]);
  });

  it('is empty when only semantic errors are present', () => {
    expect(syntaxBrokenFiles(parseTscDiagnostics(REAL_OUTPUT))).toEqual([]);
  });
});

describe('summariseByFile', () => {
  it('counts per file, most errors first', () => {
    const d = parseTscDiagnostics([
      'a.ts(1,1): error TS1: x',
      'b.ts(1,1): error TS1: x',
      'b.ts(2,1): error TS1: x',
    ].join('\n'));
    expect(summariseByFile(d)).toEqual([{ file: 'b.ts', count: 2 }, { file: 'a.ts', count: 1 }]);
  });

  it('buckets unattributed errors rather than dropping them', () => {
    expect(summariseByFile(parseTscDiagnostics('error TS5057: nope.'))).toEqual([{ file: '(unattributed)', count: 1 }]);
  });
});

describe('errorsOnly', () => {
  it('excludes warnings so the count matches what gates a build', () => {
    const d = parseTscDiagnostics(['a.ts(1,1): error TS1: x', 'a.ts(2,1): warning TS2: y'].join('\n'));
    expect(errorsOnly(d)).toHaveLength(1);
  });
});

describe('filterToFiles — the server-side form of `| grep myfile`', () => {
  const diagnostics = parseTscDiagnostics([
    'packages/operator-core/lib/run.ts(1,1): error TS1: x',
    'packages/operator-core/lib/prerun.ts(1,1): error TS1: y',
    'apps/operator/lib/run.ts(1,1): error TS1: z',
  ].join('\n'));

  it('matches on a repo-root-relative path', () => {
    expect(filterToFiles(diagnostics, ['packages/operator-core/lib/run.ts'])).toHaveLength(1);
  });

  it('matches a suffix, since tsc emits paths relative to the tsconfig', () => {
    expect(filterToFiles(diagnostics, ['lib/prerun.ts']).map((d) => d.file)).toEqual(['packages/operator-core/lib/prerun.ts']);
  });

  it('anchors the suffix at a segment boundary so run.ts never matches prerun.ts', () => {
    const only = filterToFiles(diagnostics, ['run.ts']).map((d) => d.file);
    expect(only).toEqual(['packages/operator-core/lib/run.ts', 'apps/operator/lib/run.ts']);
    expect(only).not.toContain('packages/operator-core/lib/prerun.ts');
  });

  it('drops unattributed diagnostics (they belong to no file)', () => {
    expect(filterToFiles(parseTscDiagnostics('error TS5057: nope.'), ['a.ts'])).toEqual([]);
  });

  it('normalises windows separators and a leading ./', () => {
    expect(filterToFiles(diagnostics, ['./packages/operator-core/lib/run.ts'])).toHaveLength(1);
    expect(filterToFiles(diagnostics, ['packages\\operator-core\\lib\\run.ts'])).toHaveLength(1);
  });
});

describe('parseFoundSummary — parser drift cross-check', () => {
  it('reads the tally when tsc prints one', () => {
    expect(parseFoundSummary('a.ts(1,1): error TS1: x\nFound 1 error in 1 file.')).toBe(1);
    expect(parseFoundSummary('Found 12 errors in 3 files.')).toBe(12);
    expect(parseFoundSummary('Found 0 errors.')).toBe(0);
  });

  it('returns null when absent — tsc 6.0.3 with --pretty false prints no tally, and a MISSING cross-check must not read as a mismatch', () => {
    expect(parseFoundSummary(REAL_OUTPUT)).toBeNull();
  });
});
