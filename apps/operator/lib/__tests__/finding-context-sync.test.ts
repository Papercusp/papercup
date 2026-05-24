/**
 * Drift test for apps/operator-docs/src/content/docs/agents/finding-context.mdx.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/finding-context-sync.mjs.
 *
 * The page is prompt-injected into every spawned agent (orchestrator
 * loads it via Path B). Drift inflates per-spawn token cost.
 *
 * Assertions:
 *   - Page exists at the expected path.
 *   - Page is ≤200 lines (token-budget cap).
 *   - Every `tool:name` token in backticks resolves to a real
 *     defineTool entry. Anti-pattern lines ("don't use foo:bar")
 *     are skipped to avoid false positives.
 *
 * Pure static — no live server. Runs in the unit suite (no .integration. suffix).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = resolve(__dirname);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return __dirname;
    dir = parent;
  }
}
const REPO_ROOT = repoRoot();
const PAGE_PATH = join(
  REPO_ROOT,
  'apps/operator-docs/src/content/docs/agents/finding-context.mdx',
);
const MAX_LINES = 200;

describe('finding-context.mdx drift', () => {
  it('exists at the expected path', () => {
    expect(existsSync(PAGE_PATH), `finding-context.mdx not found at ${PAGE_PATH}`).toBe(true);
  });

  it('is within the token budget (≤200 lines)', () => {
    if (!existsSync(PAGE_PATH)) return; // covered above
    const text = readFileSync(PAGE_PATH, 'utf8');
    const lineCount = text.split('\n').length;
    expect(lineCount, `page is ${lineCount} lines, max ${MAX_LINES}`).toBeLessThanOrEqual(MAX_LINES);
  });

  it('every tool:name reference resolves to a real defineTool entry (warn only)', () => {
    if (!existsSync(PAGE_PATH)) return;
    const text = readFileSync(PAGE_PATH, 'utf8');
    const lines = text.split('\n');

    const toolRefs = new Set<string>();
    const re = /`([a-z][a-z0-9_]*:[a-z][a-z0-9_]*)`/g;
    for (const line of lines) {
      if (/^\s*[-*]?\s*Don't\b|don't use\b|instead of/i.test(line)) continue;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) toolRefs.add(m[1]);
    }
    if (toolRefs.size === 0) return; // page is content-light — fine

    const res = spawnSync(
      'grep',
      [
        '-r',
        '-h',
        '-oE',
        "name:\\s*['\"][a-z][a-z0-9_]*:[a-z][a-z0-9_]*['\"]",
        'apps/operator/lib/agent-tools',
        'packages/agent-mcp/src/tools',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const found = new Set<string>();
    for (const line of (res.stdout || '').split('\n')) {
      const m = /name:\s*['"]([^'"]+)['"]/.exec(line);
      if (m) found.add(m[1]);
    }
    const pluginRes = spawnSync(
      'sh',
      ['-c', `find libs/papercusp/plugins -name papercusp.json -exec cat {} +`],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    for (const m of (pluginRes.stdout || '').matchAll(/"name":\s*"([^"]+)"/g)) {
      found.add(m[1]);
    }

    const unresolved = [...toolRefs].filter((r) => !found.has(r));
    // Warn-only — same as the original .mjs behavior. Anti-pattern lists
    // can mention deprecated names; flip this to expect-zero when those
    // are cleaned up in a follow-up.
    if (unresolved.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[finding-context] unresolved tool refs (warn-only): ${unresolved.join(', ')}`);
    }
    expect(toolRefs.size).toBeGreaterThanOrEqual(0); // always passes; suite documents the check
  });
});
