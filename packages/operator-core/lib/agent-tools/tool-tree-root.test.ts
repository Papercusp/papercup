/**
 * tool-tree-root.test.ts — EI-1754, class-wide: an agent-facing tool must operate on
 * the tree the AGENT is editing, never on the tree the operator happens to run from.
 *
 * WHY THIS IS A LINT AND NOT A UNIT TEST: the defect is invisible at runtime in a
 * test environment. `inferWorkspaceRoot()` walks up from `process.cwd()` looking for
 * `pnpm-workspace.yaml` (this repo is npm workspaces — that file does not exist here)
 * and then for `.git`. Under vitest, cwd IS the repo, so it returns the right answer
 * and every behavioural test passes. In production the :3070 operator runs FROM the
 * release checkout (papercup-release, pinned to green `main`), so the SAME call
 * returned the release tree.
 *
 * Observed 2026-07-27 on `testing:run`, and the silent mode is the dangerous one:
 *   - a test file present in BOTH trees ran against the stale RELEASE copy and came
 *     back GREEN (30 passed) for a staging edit it never saw — while the same suite
 *     run locally was 2 failed / 28 passed;
 *   - a staging-only NEW test file came back `route_error: does not exist`.
 * `build:typecheck` carried the identical call and so reported the release tree clean.
 * Both are the tools CLAUDE.md's routing table tells agents to use INSTEAD of the
 * local `npm run test:file` / `npx tsc`, so the blessed path was the wrong-tree path.
 *
 * TEETH: `resolveCapabilityBaseDir(ctx)` (projectDir → PAPERCUSP_INTEGRATION_ROOT →
 * cwd) is the ONE resolver every capability tool already uses; a tool that resolves a
 * tree root any other way reads a different tree than capability:edit/write just wrote.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const AGENT_TOOLS_ROOT = join(__dirname);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
    if (entry.includes('.test.') || entry.includes('.integration.')) continue;
    out.push(full);
  }
  return out;
}

/** Strip line and block comments so the doc-comments explaining this rule — which
 *  necessarily NAME the banned function — are not themselves flagged. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('EI-1754 — agent tools resolve the agent’s tree, not the operator’s cwd', () => {
  it('no agent tool calls inferWorkspaceRoot() (it resolves the operator’s release cwd in prod)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(AGENT_TOOLS_ROOT)) {
      const src = stripComments(readFileSync(file, 'utf-8'));
      if (/\binferWorkspaceRoot\b/.test(src)) {
        offenders.push(relative(AGENT_TOOLS_ROOT, file));
      }
    }
    expect(
      offenders,
      `These agent tools resolve a tree root from process.cwd(), which is the RELEASE\n` +
        `checkout for the :3070 operator — so they judge code the agent never edited\n` +
        `(silently GREEN). Use resolveCapabilityBaseDir(ctx) instead:\n` +
        offenders.map((f) => `  ${f}`).join('\n'),
    ).toEqual([]);
  });

  it('testing:run and build:typecheck resolve their root via resolveAgentWorkspaceRoot(ctx)', () => {
    for (const rel of ['testing/run.ts', 'build/typecheck.ts']) {
      const src = stripComments(readFileSync(join(AGENT_TOOLS_ROOT, rel), 'utf-8'));
      const handler = src.slice(src.indexOf('async handler('));
      expect(handler, `${rel} handler must resolve its root via resolveAgentWorkspaceRoot(ctx)`).toMatch(
        /resolveAgentWorkspaceRoot\(ctx\)/,
      );
      // `void ctx;` was how both tools declared they ignored the caller's tree.
      expect(handler, `${rel} must not discard ctx — it carries the agent's projectDir`).not.toMatch(
        /^\s*void ctx;/m,
      );
    }
  });
});
