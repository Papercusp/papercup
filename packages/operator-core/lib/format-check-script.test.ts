/**
 * EI-20956444543537055 regression guard — repository formatting validation must
 * check changed-line whitespace without imposing a whole-file Prettier baseline
 * on packages that intentionally retain legacy formatting.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPrettierCheckArgs,
  characterRangeForLines,
  normalizeScopedPaths,
  parseAddedLineRanges,
} from '../../../scripts/check-format.mjs';

const REPO_ROOT = resolve(__dirname, '../../..');

describe('scoped repository format check', () => {
  it('exposes the changed-line whitespace check as the canonical root command', () => {
    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['format:check']).toBe('git diff --check --');
    expect(packageJson.scripts?.['format:check:scoped']).toBe('node scripts/check-format.mjs');
  });

  it('checks only added ranges and ignores deletion-only hunks', () => {
    const diff = ['@@ -1,2 +1,3 @@', '@@ -8,1 +9,2 @@', '@@ -20,2 +21,0 @@'].join('\n');

    expect(parseAddedLineRanges(diff)).toEqual([
      { startLine: 1, endLine: 3 },
      { startLine: 9, endLine: 10 },
    ]);
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
});
