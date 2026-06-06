/**
 * Coverage for harness-core's pure helpers: isHarnessDriverCmdline (driver
 * process detection — legacy bash + TS orchestrator), harnessDir (.harness
 * join), and rowToFeature (the PG-row → feature-shape mapping with bigint→number
 * coercion, claims JSON parse, and boolean normalization). The fs/PG-backed
 * functions in this module are out of scope here.
 */
import { describe, expect, it } from 'vitest';
import { isHarnessDriverCmdline, harnessDir, rowToFeature } from './harness-core';

describe('isHarnessDriverCmdline', () => {
  it('matches the legacy bash drivers', () => {
    expect(isHarnessDriverCmdline('/home/u/autonomous-harness/run.sh foo')).toBe(true);
    expect(isHarnessDriverCmdline('bash /pkg/harness/run.sh')).toBe(true);
  });
  it('no longer matches the archived TS orchestrator bin/run.ts', () => {
    // orchestrator/bin/run.ts was archived 2026-06-06 (the legacy run-loop is
    // retired; the live pipeline is the in-process DBOS orchestrator, not a
    // separate driver process).
    expect(isHarnessDriverCmdline('node npx tsx /pkg/orchestrator/bin/run.ts')).toBe(false);
  });
  it('does not match unrelated cmdlines', () => {
    expect(isHarnessDriverCmdline('vim run.ts')).toBe(false);
    expect(isHarnessDriverCmdline('node server.js')).toBe(false);
    expect(isHarnessDriverCmdline('')).toBe(false);
  });
});

describe('harnessDir', () => {
  it('joins .harness under the project path', () => {
    expect(harnessDir({ path: '/proj' } as never)).toBe('/proj/.papercusp');
  });
});

describe('rowToFeature', () => {
  it('maps a PG row, coercing bigints, parsing claims, normalizing booleans', () => {
    const f = rowToFeature({
      feature_id: 'F-1',
      title: 'Do the thing',
      status: 'todo',
      attempts: 3n,
      claims: '["agent-a"]',
      needs_human_review: 1,
      ts: 1700n,
      expected_cost_cents: null,
    });
    expect(f).toMatchObject({
      id: 'F-1',
      title: 'Do the thing',
      status: 'todo',
      attempts: 3, // bigint → number
      claims: ['agent-a'], // JSON-parsed
      needs_human_review: true, // 1 → true
      ts: 1700, // bigint → number
      expected_cost_cents: undefined, // null → undefined
    });
  });

  it('passes through already-parsed claims + leaves optional fields undefined', () => {
    const f = rowToFeature({ feature_id: 'F-2', title: 'x', status: 'passed', claims: ['b'] });
    expect(f.claims).toEqual(['b']);
    expect(f.summary).toBeUndefined();
    expect(f.needs_human_review).toBe(false); // falsy → false
  });
});
