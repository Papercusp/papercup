/**
 * The `build` argument description on `tools:invoke` / `tools:find` must state the
 * default the MCP proxy actually applies (EI-28760058284938978).
 *
 * `apps/operator/lib/mcp-proxy/build-routing.ts` routes a call that names no build to
 * the current build (staging, :3170) for every tool in CURRENT_BUILD_DEFAULT_TOOLS.
 * Both wrappers joined that list on 2026-11-14, but their published `build`
 * description still read "Default main". A long-lived leader therefore believed its
 * deferred-tool calls ran on :3070 while each one ran on :3170, which restarts many
 * times a day. One write was lost to such a restart before the routing was traced.
 *
 * The fixture controls are load-bearing: once the live assertion is green, they are the
 * only evidence that the judge can fail at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BUILD_ROUTING = join(ROOT, 'apps/operator/lib/mcp-proxy/build-routing.ts');
const TOOL_SOURCES: ReadonlyArray<{ tool: string; file: string }> = [
  { tool: 'tools:invoke', file: join(ROOT, 'packages/operator-core/lib/agent-tools/tools/invoke.ts') },
  { tool: 'tools:find', file: join(ROOT, 'packages/operator-core/lib/agent-tools/tools/find.ts') },
];

function readSource(path: string): string {
  const source = readFileSync(path, 'utf8');
  if (source.length < 2_000) {
    throw new Error(`Refusing to judge a ${source.length}-char read of ${path}: a failed read must not look clean`);
  }
  return source;
}

/** The string literals inside CURRENT_BUILD_DEFAULT_TOOLS, comments removed. */
function currentBuildDefaultTools(routingSource: string): string[] {
  const match = /CURRENT_BUILD_DEFAULT_TOOLS\s*:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\];/.exec(routingSource);
  if (!match) throw new Error('CURRENT_BUILD_DEFAULT_TOOLS array literal not found in build-routing.ts');
  const body = match[1].replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

/** The `.describe(...)` text attached to the tool's `build:` zod field. */
function buildFieldDescription(toolSource: string): string {
  const match = /\bbuild:\s*z[\s\S]{0,240}?\.describe\(\s*(["'`])([\s\S]*?)\1\s*\)/.exec(toolSource);
  if (!match) throw new Error('build: z…describe(…) not found in tool source');
  return match[2];
}

/** Violations when the description's stated default disagrees with the proxy's routing. */
function judgeBuildDescription(description: string, defaultsToStaging: boolean): string[] {
  const claimsMainDefault = /\bdefault(?:s)?\s+(?:to\s+)?main\b/i.test(description);
  const claimsStagingDefault = /\bomitted\b[^.]*\bstaging\b/i.test(description);
  const violations: string[] = [];
  if (defaultsToStaging && claimsMainDefault) {
    violations.push('describes main as the default, but the proxy routes an omitted build to staging');
  }
  if (defaultsToStaging && !claimsStagingDefault) {
    violations.push('does not state that an omitted build routes to staging');
  }
  if (!defaultsToStaging && claimsStagingDefault) {
    violations.push('claims an omitted build routes to staging, but the tool is not in CURRENT_BUILD_DEFAULT_TOOLS');
  }
  return violations;
}

describe('build argument description matches proxy default routing', () => {
  const defaults = new Set(currentBuildDefaultTools(readSource(BUILD_ROUTING)));

  it('parses a non-trivial CURRENT_BUILD_DEFAULT_TOOLS list', () => {
    expect(defaults.size).toBeGreaterThanOrEqual(4);
    expect(defaults.has('release:repair-queue')).toBe(true);
  });

  for (const { tool, file } of TOOL_SOURCES) {
    it(`${tool} describes the default it is actually given`, () => {
      const description = buildFieldDescription(readSource(file));
      expect(judgeBuildDescription(description, defaults.has(tool))).toEqual([]);
    });
  }

  describe('fixture controls (the judge can fail)', () => {
    it('flags the pre-fix "Default main" text for a staging-defaulted tool', () => {
      const stale = "'staging' runs the call on the staging operator (:3170), for a tool main does not have yet. Default main.";
      expect(judgeBuildDescription(stale, true)).toHaveLength(2);
    });

    it('flags a staging-default claim for a tool the proxy leaves on main', () => {
      const text = "Omitted: staging (:3170) when this proxy has a staging target, else main.";
      expect(judgeBuildDescription(text, false)).toHaveLength(1);
      expect(judgeBuildDescription(text, true)).toEqual([]);
    });

    it('extracts list entries while ignoring commented-out names', () => {
      const src = 'export const CURRENT_BUILD_DEFAULT_TOOLS: readonly string[] = [\n  // "ghost:tool",\n  "a:b",\n  \'c:d\',\n];';
      expect(currentBuildDefaultTools(src)).toEqual(['a:b', 'c:d']);
    });
  });
});
