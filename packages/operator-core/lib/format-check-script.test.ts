/**
 * EI-20956444543537055 regression guard — repository formatting validation must
 * check changed-line whitespace without imposing a whole-file Prettier baseline
 * on packages that intentionally retain legacy formatting.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// prettier-ignore
// @ts-ignore -- plain .mjs formatter script, no declaration file.
import {
  applyFormattedChangesWithinRange,
  buildPrettierArgs,
  buildPrettierCheckArgs,
  buildPrettierStdinArgs,
  buildPrettierWholeFileArgs,
  changedLineRanges,
  characterRangeForLines,
  formatRangeDiagnostic,
  formatRangeWithPrettier,
  formatWholeFileDiagnostic,
  normalizeScopedPaths,
  parseAddedLineRanges,
  parseFormatCliArgs,
  rangeFormattingDiffers,
  FORMAT_USAGE,
} from '../../../scripts/check-format.mjs';

const REPO_ROOT = resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);

describe('scoped repository format check', () => {
  it('exposes the changed-line whitespace check as the canonical root command', () => {
    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['format:check']).toBe('git diff --check --');
    expect(packageJson.scripts?.['format:check:scoped']).toBe('node scripts/check-format.mjs');
    expect(packageJson.scripts?.['format:write:scoped']).toBe('node scripts/check-format.mjs --write');
  });

  it('checks only added ranges and ignores deletion-only hunks', () => {
    const diff = ['@@ -1,2 +1,3 @@', '@@ -8,1 +9,2 @@', '@@ -20,2 +21,0 @@'].join('\n');

    expect(parseAddedLineRanges(diff)).toEqual([
      { startLine: 1, endLine: 3 },
      { startLine: 9, endLine: 10 },
    ]);
  });

  it('gets changed ranges from the nested repository that owns a submodule file', () => {
    const root = mkdtempSync(join(tmpdir(), 'format-check-nested-repo-'));
    const nested = join(root, 'libs', 'papercusp');
    const file = join(nested, 'src', 'fixture.ts');
    try {
      execFileSync('git', ['init', '-q', nested], { timeout: 30_000, killSignal: 'SIGKILL' });
      execFileSync('git', ['-C', nested, 'config', 'user.email', 'format-check@example.test'], {
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
      execFileSync('git', ['-C', nested, 'config', 'user.name', 'format-check-test'], {
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'const value = 1;\nconst untouched = 2;\n');
      execFileSync('git', ['-C', nested, 'add', '--', 'src/fixture.ts'], {
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
      execFileSync('git', ['-C', nested, 'commit', '-qm', 'baseline'], {
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
      writeFileSync(file, 'const value=1;\nconst untouched = 2;\n');

      expect(changedLineRanges('libs/papercusp/src/fixture.ts', readFileSync(file, 'utf8'), root)).toEqual([
        { startLine: 1, endLine: 1 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps changed lines to character ranges for Prettier', () => {
    expect(characterRangeForLines('one\nchanged();\nlast();\n', { startLine: 2, endLine: 2 })).toEqual({
      start: 4,
      end: 15,
    });
  });

  it('accepts only explicit in-tree files', () => {
    expect(normalizeScopedPaths(['package.json'])).toEqual(['package.json']);
    expect(() => normalizeScopedPaths(['.'])).toThrow(/inside the repository|existing file/);
    expect(() => normalizeScopedPaths(['../package.json'])).toThrow(/inside the repository/);
  });

  it('builds a check-only Prettier invocation', () => {
    const args = buildPrettierCheckArgs('/tmp/prettier.cjs', 'package.json', { start: 0, end: 1 });
    expect(args).toContain('--check');
    expect(args).not.toContain('--write');
  });

  it('builds a range-scoped write invocation without falling back to whole-file formatting', () => {
    const args = buildPrettierArgs('/tmp/prettier.cjs', 'legacy.ts', { start: 20, end: 40 }, 'write');
    expect(args).toContain('--write');
    expect(args).toContain('--range-start');
    expect(args).toContain('20');
    expect(args).toContain('--range-end');
    expect(args).toContain('40');
  });

  it('builds a whole-file stdin invocation for explicitly classified files', () => {
    expect(buildPrettierWholeFileArgs('/tmp/prettier.cjs', 'new-file.ts')).toEqual([
      '/tmp/prettier.cjs',
      '--ignore-unknown',
      '--stdin-filepath',
      'new-file.ts',
    ]);
  });

  it('ignores formatter changes outside the requested range', () => {
    const source = 'changed();\ntrailing();\n';
    const formatted = 'changed();\ntrailing();';

    expect(rangeFormattingDiffers(source, formatted, { start: 0, end: 11 })).toBe(false);
    expect(rangeFormattingDiffers('changed ( );\ntrailing();\n', formatted, { start: 0, end: 11 })).toBe(true);
  });

  it('identifies the file and changed line range for a formatting failure', () => {
    expect(formatRangeDiagnostic('format:check:scoped', 'src/example.ts', { startLine: 12, endLine: 14 })).toBe(
      'format:check:scoped: src/example.ts:12-14: need formatting',
    );
  });

  it('identifies the file for a whole-file formatting failure', () => {
    expect(formatWholeFileDiagnostic('format:check:scoped', 'src/example.ts')).toBe(
      'format:check:scoped: src/example.ts: need formatting',
    );
  });

  it('maps a comment-only range after a reprinted preceding AST node', () => {
    const source = [
      'function formatFixture() {',
      '  const object = {foo:1, bar:2};',
      '  // added comment that is already formatted',
      '  return object;',
      '}',
      '',
    ].join('\n');
    const commentStart = source.indexOf('  // added comment');
    const commentEnd = source.indexOf('\n', commentStart) + 1;
    const prettierCli = require.resolve('prettier/bin/prettier.cjs', {
      paths: [REPO_ROOT],
    });
    const result = spawnSync(
      process.execPath,
      buildPrettierStdinArgs(prettierCli, 'fixture.ts', {
        start: commentStart,
        end: commentEnd,
      }),
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        input: source,
        timeout: 30_000,
        killSignal: 'SIGKILL',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe(source);
    expect(result.stdout.indexOf('// added comment')).not.toBe(commentStart + 2);
    expect(
      rangeFormattingDiffers(source, result.stdout, {
        start: commentStart,
        end: commentEnd,
      }),
    ).toBe(false);
  });

  it('formats a statement range inside an object method without rewriting legacy context', () => {
    const source = [
      'const legacy={untouched:true};',
      'export default defineThing({',
      '  async handler(args) {',
      '    const before = 1;',
      '    // changed block',
      '    const gitSync=await check(args);',
      '    if (gitSync.blocked) {',
      '      return json({ok:false,note:gitSync.note});',
      '    }',
      '',
      '    return before;',
      '  },',
      '});',
      '',
    ].join('\n');
    const start = source.indexOf('    // changed block');
    const end = source.indexOf('\n\n', start) + 1;
    const prettierCli = require.resolve('prettier/bin/prettier.cjs', {
      paths: [REPO_ROOT],
    });

    const formatted = formatRangeWithPrettier(prettierCli, 'fixture.ts', source, { start, end });

    expect(formatted).toContain('const legacy={untouched:true};');
    expect(formatted).toContain('const gitSync = await check(args);');
    expect(formatted).toContain('return json({ ok: false, note: gitSync.note });');
  });

  it('applies only whole-file formatter changes whose source span is inside the requested range', () => {
    const source = 'const legacy={foo:1};\nconst changed={bar:2};\n';
    const formatted = 'const legacy = { foo: 1 };\nconst changed = { bar: 2 };\n';
    const start = source.indexOf('const changed');

    expect(applyFormattedChangesWithinRange(source, formatted, { start, end: source.length })).toBe(
      'const legacy={foo:1};\nconst changed = { bar: 2 };\n',
    );
  });

  it('parses write mode separately from explicit paths', () => {
    expect(parseFormatCliArgs(['--write', 'package.json'])).toEqual({
      mode: 'write',
      paths: ['package.json'],
    });
  });

  it('keeps an explicit creation set separate from range-scoped paths', () => {
    expect(parseFormatCliArgs(['--write', '--new-file', 'scripts/check-format.mjs', 'package.json'])).toEqual({
      mode: 'write',
      paths: ['package.json'],
      newFilePaths: ['scripts/check-format.mjs'],
    });
  });

  it('accepts an equals form for the explicit creation set', () => {
    expect(parseFormatCliArgs(['--new-file=scripts/check-format.mjs'])).toEqual({
      mode: 'check',
      paths: [],
      newFilePaths: ['scripts/check-format.mjs'],
    });
  });

  it('parses repeatable whole-file classifications in both flag forms', () => {
    expect(
      parseFormatCliArgs([
        '--whole-file',
        'scripts/check-format.mjs',
        '--whole-file=package.json',
        'packages/operator-core/lib/format-check-script.test.ts',
      ]),
    ).toEqual({
      mode: 'check',
      paths: ['packages/operator-core/lib/format-check-script.test.ts'],
      wholeFilePaths: ['scripts/check-format.mjs', 'package.json'],
    });
  });

  it('rejects a file classified as both range-scoped and whole-file', () => {
    expect(() => parseFormatCliArgs(['--whole-file', 'package.json', 'package.json'])).toThrow(
      /file cannot be both range-scoped and --whole-file: package\.json/,
    );
  });

  it('rejects duplicate whole-file classifications', () => {
    expect(() => parseFormatCliArgs(['--whole-file', 'package.json', '--whole-file=package.json'])).toThrow(
      /file cannot be listed more than once as --whole-file: package\.json/,
    );
  });

  it.each(['--help', '-h'])('prints usage and exits successfully for %s', (flag) => {
    expect(parseFormatCliArgs([flag])).toEqual({ mode: 'help', paths: [] });

    const result = spawnSync(process.execPath, [resolve(REPO_ROOT, 'scripts/check-format.mjs'), flag], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(FORMAT_USAGE.trim());
  });
});
