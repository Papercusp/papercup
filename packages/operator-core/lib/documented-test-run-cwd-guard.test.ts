/**
 * documented-test-run-cwd-guard.test.ts — unit contract for
 * scripts/check-documented-test-run-cwd.mjs (EI-21463787319820028).
 *
 * The guard refuses documented `Run:` commands that only execute from an
 * unstated working directory (they fail before any test runs, and the natural
 * default-config retry times out instead). These tests pin the PREDICATE so the
 * "fails on an unstated-cwd command / passes on each documented-correct shape"
 * property survives refactors of the script — green-on-clean-tree alone would
 * not catch a parser regression that silently stops flagging.
 */
import { describe, expect, it } from 'vitest';
import {
  extractDocumentedRunCommands,
  judgeDocumentedRunCommand,
} from '../../../../scripts/check-documented-test-run-cwd.mjs';

/** Fake tree: only these paths "exist". */
const EXISTS = new Set([
  '.',
  'packages/operator-core',
  'packages/operator-core/vitest.integration.config.ts',
  'packages/operator-core/lib/a.integration.test.ts',
  'packages/agent-mcp',
]);

const exists = (p: string) => EXISTS.has(p.replace(/\/$/, ''));

describe('judgeDocumentedRunCommand', () => {
  it('accepts an explicit cd whose config and test paths exist under that cwd', () => {
    expect(
      judgeDocumentedRunCommand(
        'cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \\\n lib/a.integration.test.ts'.replace('\\\n ', ''),
        exists,
      ),
    ).toBeNull();
  });

  it('refuses an unstated cwd when --config does not exist at the repo root (the filed defect)', () => {
    const err = judgeDocumentedRunCommand(
      'npx vitest run --config vitest.integration.config.ts lib/a.integration.test.ts',
      exists,
    );
    expect(err).toMatch(/no working directory stated/);
    expect(err).toMatch(/vitest\.integration\.config\.ts/);
  });

  it('refuses a stated cwd that does not exist', () => {
    expect(
      judgeDocumentedRunCommand('cd packages/nope && npx vitest run lib/a.integration.test.ts', exists),
    ).toMatch(/stated working directory 'packages\/nope' does not exist/);
  });

  it('refuses an extension-bearing path missing under the stated cwd', () => {
    const err = judgeDocumentedRunCommand(
      'cd packages/operator-core && npx vitest run packages/operator-core/lib/a.integration.test.ts',
      exists,
    );
    expect(err).toMatch(/does not exist under stated working directory/);
  });

  it('accepts the root-executable npm run test:file form', () => {
    expect(
      judgeDocumentedRunCommand('npm run test:file -- packages/operator-core/lib/a.integration.test.ts', exists),
    ).toBeNull();
  });

  it('strips whole-command backticks and trailing punctuation before judging', () => {
    expect(
      judgeDocumentedRunCommand(
        '`cd packages/operator-core && npx vitest run lib/a.integration.test.ts`.',
        exists,
      ),
    ).toBeNull();
  });

  it('honors a parenthesized "(from <dir>)" working-directory tail', () => {
    expect(
      judgeDocumentedRunCommand('`npx vitest run result-format-benchmark` (from packages/agent-mcp).', exists),
    ).toBeNull();
  });

  it('skips env-assignment prefixes and treats -c as --config', () => {
    expect(
      judgeDocumentedRunCommand('cd packages/operator-core && ENV_VAR=1 npx vitest run -c vitest.integration.config.ts lib/a.integration.test.ts', exists),
    ).toBeNull();
    const err = judgeDocumentedRunCommand('ENV_VAR=1 npx vitest run -c vitest.integration.config.ts lib/a.integration.test.ts', exists);
    expect(err).toMatch(/no working directory stated/);
  });

  it('never existence-checks extensionless args (vitest name filters)', () => {
    expect(
      judgeDocumentedRunCommand('cd packages/operator-core && npx vitest run lib/not-a-real-file', exists),
    ).toBeNull();
  });
});

describe('extractDocumentedRunCommands', () => {
  it('joins backslash continuations inside the comment block', () => {
    const text = [
      '/**',
      ' * something.',
      ' *',
      ' * Run: npx vitest run --config vitest.integration.config.ts \\',
      ' *        lib/a.integration.test.ts',
      ' */',
      'import { x } from "y";',
    ].join('\n');
    const cmds = extractDocumentedRunCommands(text);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].line).toBe(4);
    expect(cmds[0].command).toContain('lib/a.integration.test.ts');
  });

  it('ignores Run: prose that names no vitest/test invocation', () => {
    const text = ['/**', ' * Run: the gauntlet.', ' */'].join('\n');
    expect(extractDocumentedRunCommands(text)).toHaveLength(0);
  });
});
