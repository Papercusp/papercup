/**
 * EI-22189589517637049 — enforcement + falsifiability for
 * `scripts/check-guidance-returns-schema.mjs`.
 *
 * Two jobs, and they are deliberately different:
 *
 *  1. ENFORCEMENT — run the detector over the REAL tree. `check-lint-guard-reachability`
 *     classifies a guard by whether a test EXECUTES it against real repository files;
 *     a test that only feeds fixtures to its helpers is `logic-test` tier, which that
 *     script documents as ADVISORY and explicitly NOT enforcement ("a green logic test
 *     and a rotting guard are perfectly compatible states"). The real-tree case below
 *     is what makes this guard blocking.
 *
 *  2. FALSIFIABILITY — prove the detector can FAIL. Per CLAUDE.md's tier table, a
 *     subject you IMPORT as a module is proved with a deliberately-wrong input kept
 *     permanently in the test file, never by mutating the shared tree (git-sync sweeps
 *     it on a schedule and would commit the mutant). The violating fixtures below are
 *     that control, and `CALIBRATION_COMPLIANT_TOOL` is the paired case the real
 *     detector must pass — without it, a detector that flagged EVERYTHING would satisfy
 *     every "is caught" assertion here.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore — pure .mjs guard module; detector tests intentionally import its source of truth.
import * as guardModule from '../../../../scripts/check-guidance-returns-schema.mjs';

const {
  findGuidanceReturnsWithoutResult,
  parseExemptToolsFromLiveGuard,
  checkGuidanceReturnsSchema,
  LIVE_GUARD_PATH,
  TOOL_ROOTS,
} = guardModule as {
  findGuidanceReturnsWithoutResult: (
    files: { path: string; text: string }[],
    exemptTools?: string[],
  ) => { path: string; tool: string; line: number }[];
  parseExemptToolsFromLiveGuard: (source: string) => string[] | null;
  checkGuidanceReturnsSchema: (root?: string) => {
    violations: { path: string; tool: string; line: number }[];
    scanned: number;
    exemptTools: string[];
  };
  LIVE_GUARD_PATH: string;
  TOOL_ROOTS: readonly string[];
};

const ROOT = resolve(__dirname, '../../../..');

/**
 * FALSIFIABILITY CONTROL — the exact shape of both measured 2026-09-02 violations:
 * `guidance.returns` authored on a tool with no sibling `result:`. If the detector
 * ever stops reporting this, it has silently become a no-op.
 */
const VIOLATING_TOOL = `
export default defineTool({
  name: 'demo:violating',
  description: 'd',
  guidance: {
    when: 'w',
    returns: 'Returns { ok, rows } — prose standing in for a schema.',
  },
});
`;

/** CALIBRATION — the compliant form the real detector MUST pass, or "is caught" proves nothing. */
const CALIBRATION_COMPLIANT_TOOL = `
export default defineTool({
  name: 'demo:compliant',
  description: 'd',
  guidance: {
    when: 'w',
    returns: 'Returns { ok, rows }.',
  },
  result: demoResultSchema,
});
`;

describe('check-guidance-returns-schema detector', () => {
  it('catches guidance.returns authored without a registered result: schema', () => {
    const violations = findGuidanceReturnsWithoutResult([{ path: 'demo/violating.ts', text: VIOLATING_TOOL }]);
    expect(violations).toEqual([{ path: 'demo/violating.ts', tool: 'demo:violating', line: 2 }]);
  });

  it('CALIBRATION: passes the compliant form, so the catch above is not a detector that flags everything', () => {
    expect(findGuidanceReturnsWithoutResult([{ path: 'demo/ok.ts', text: CALIBRATION_COMPLIANT_TOOL }])).toEqual([]);
  });

  it('does not report a tool that authors no returns prose at all', () => {
    const text = `
export default defineTool({
  name: 'demo:no-returns',
  description: 'd',
  guidance: { when: 'w' },
});
`;
    expect(findGuidanceReturnsWithoutResult([{ path: 'demo/none.ts', text }])).toEqual([]);
  });

  it('honours the exemption set for tools that return mixed MCP content', () => {
    const text = VIOLATING_TOOL.replace('demo:violating', 'capability:computer');
    expect(findGuidanceReturnsWithoutResult([{ path: 'demo/mixed.ts', text }], ['capability:computer'])).toEqual([]);
    // …and the exemption is scoped to the named tool, not applied wholesale.
    expect(findGuidanceReturnsWithoutResult([{ path: 'demo/mixed.ts', text }], ['some:other-tool'])).toHaveLength(1);
  });

  it('stays silent when a spread could supply result:, rather than guessing', () => {
    const text = `
export default defineTool({
  ...sharedToolBase,
  name: 'demo:spread',
  guidance: { returns: 'Returns { ok }.' },
});
`;
    expect(findGuidanceReturnsWithoutResult([{ path: 'demo/spread.ts', text }])).toEqual([]);
  });
});

describe('exemptions are derived from the live guard, not restated', () => {
  it('parses NON_OBJECT_RETURN_TOOLS out of the live guard source', () => {
    const source = readFileSync(resolve(ROOT, LIVE_GUARD_PATH), 'utf8');
    const exempt = parseExemptToolsFromLiveGuard(source);
    expect(exempt).not.toBeNull();
    expect(exempt!.length).toBeGreaterThan(0);
    expect(exempt).toContain('capability:computer');
  });

  it('returns null — never a silently empty set — when the declaration is absent', () => {
    // An empty exemption set is indistinguishable from "nothing is exempt" and would
    // red-pin the legitimately-exempt mixed-content tools, so the parse must report
    // absence rather than degrade to [].
    expect(parseExemptToolsFromLiveGuard('const SOMETHING_ELSE = new Set(["a"]);')).toBeNull();
  });
});

describe('real-tree enforcement', () => {
  it('runs clean over the whole repository', () => {
    const { violations, scanned } = checkGuidanceReturnsSchema(ROOT);
    expect(scanned, 'scanned zero tool sources — the guard would pass vacuously').toBeGreaterThan(500);
    expect(
      violations.map((v) => `${v.tool} (${v.path}:${v.line})`),
      'a tool authoring guidance.returns must also register result:',
    ).toEqual([]);
  });

  it('exits 0 from the CLI with a verdict line, so a clean tree cannot read as a silent no-op', () => {
    const out = execFileSync('node', ['scripts/check-guidance-returns-schema.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('every tool authoring guidance.returns also registers result:');
  });

  it('reproduces the measured 2026-09-02 violation from REAL tool source', () => {
    // The synthetic fixtures above prove the detector fires on a shape I wrote. This
    // one proves it fires on the shape that actually red-pinned the gate: take the
    // real `capability:bash_output` source and remove its `result:` registration IN
    // MEMORY — the tree is never touched, so the git-sync sweep has nothing to commit.
    const path = 'packages/operator-core/lib/agent-tools/capability/bash_output.ts';
    const real = readFileSync(resolve(ROOT, path), 'utf8');
    expect(real, 'fixture drifted: bash_output no longer registers this schema').toContain(
      'result: bashOutputResultSchema,',
    );

    expect(findGuidanceReturnsWithoutResult([{ path, text: real }]), 'real source is compliant today').toEqual([]);

    const regressed = real.replace('result: bashOutputResultSchema,', '');
    const violations = findGuidanceReturnsWithoutResult([{ path, text: regressed }]);
    expect(violations.map((v) => v.tool)).toEqual(['capability:bash_output']);
  });

  it('enumerates the roots the affected-tests registration claims to cover', () => {
    expect(TOOL_ROOTS).toContain('packages/operator-core/lib/agent-tools');
    expect(TOOL_ROOTS).toContain('packages/agent-mcp/src');
  });
});

describe('the guard is reachable from the edit that introduces the violation', () => {
  // The whole point of EI-22189589517637049: the live authority already enforced this
  // rule, but only at the fleet gate. If this attachment regresses, the guard still
  // passes everywhere while the defect it exists to catch goes back to being invisible
  // to the author — so assert the routing, not just the detector.
  const dryGuards = (changedPath: string): string =>
    execFileSync('node', ['scripts/affected-tests.mjs', '--changed-paths', changedPath, '--print-affected'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

  it('attaches for an edit to a tool source file', () => {
    expect(dryGuards('packages/operator-core/lib/agent-tools/capability/bash_output.ts')).toContain(
      'lint:guidance-returns-schema',
    );
  });

  it('attaches for an edit to the live guard it derives its exemptions from', () => {
    expect(dryGuards(LIVE_GUARD_PATH)).toContain('lint:guidance-returns-schema');
  });

  it('does not attach for an unrelated prose-only change', () => {
    expect(dryGuards('docs/plans/README.md')).not.toContain('lint:guidance-returns-schema');
  });
});
