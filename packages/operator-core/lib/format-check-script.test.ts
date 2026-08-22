/**
 * EI-20956444543537055 regression guard — repository formatting validation must
 * check changed-line whitespace without imposing a whole-file Prettier baseline
 * on packages that intentionally retain legacy formatting.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');

describe('scoped repository format check', () => {
  it('exposes the changed-line whitespace check as the canonical root command', () => {
    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['format:check']).toBe('git diff --check --');
  });
});
