import { describe, expect, it } from 'vitest';
import { lintAcceptanceCriterionMethods } from './rubrics-method-lint';

describe('lintAcceptanceCriterionMethods', () => {
  it('finds the narrow shell-shaped method markers', () => {
    const findings = lintAcceptanceCriterionMethods([
      { key: 'npm', method: 'Run npm run measure:launch-cost -- --since 2026-09-08.' },
      { key: 'proc', method: 'Read /proc/<pid>/environ for the running proxy.' },
      { key: 'pgrep', method: 'Use pgrep -f the proxy pattern.' },
      { key: 'inline', method: 'Inspect `cat /tmp/measurement.json` and compare the output.' },
    ]);

    expect(findings).toHaveLength(4);
    expect(findings.map((finding) => finding.markers)).toEqual([
      ['npm-run'],
      ['proc-path'],
      ['pgrep'],
      ['backticked-shell'],
    ]);
    expect(findings[0]?.message).toMatch(/cannot run native shell commands/i);
  });

  it('does not flag MCP procedures or ordinary cited-file prose', () => {
    expect(
      lintAcceptanceCriterionMethods([
        { key: 'mcp', method: 'Run `testing:run { files: ["packages/foo.test.ts"] }` and inspect the result.' },
        { key: 'mcp-ledger', method: 'Read `testing:runs` and cite the matching test-run ledger row.' },
        { key: 'source', method: 'Inspect `packages/operator-core/lib/rubrics.ts` at the cited symbol.' },
        { key: 'empty', method: null },
      ]),
    ).toEqual([]);
  });

  it('returns no standard-rubric policy by construction when given no acceptance criteria', () => {
    expect(lintAcceptanceCriterionMethods([])).toEqual([]);
  });
});

