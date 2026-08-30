/**
 * Recurrence guard for WI-972025 — the mid-run TREE DRIFT advisory.
 *
 * THE CLASS THIS EXISTS TO CATCH. The canonical `npm test` runs for ~45-55 minutes against the
 * SHARED working tree, which git-sync commits continuously. A run therefore can load two halves
 * of one logical change. The pre-existing stale-failure check (`classifyStaleFailureEntries` +
 * `formatStaleFailureSummary`) compares only the FAILING TEST FILE's own blob at run start vs
 * report time — so a failure caused by a mid-run rewrite of a module that file IMPORTS leaves
 * both blobs identical, classifies as `current`, and emits NOTHING.
 *
 * Measured 2026-08-30: a run spanning 00:19:31Z->01:12:29Z absorbed 35 commits over 122 files.
 * `PLAN_ITEM_CLAIM_OP_KINDS.forceRelease` entered claims.ts at 00:37:27Z and its registration
 * entered plan-item-claim-authority-ops.ts at 00:42:29Z. Two apps/operator suites died at
 * COLLECTION with `registerAuthorityOp: kind required` while both test files were UNCHANGED, so
 * the stale-failure advisory stayed silent and the phantom red read as a confident defect. Both
 * files pass individually at HEAD (9 consecutive ledger rows).
 *
 * The load-bearing test here is "fires for the case the stale-failure check is SILENT on" — it
 * asserts the two helpers together, because either one alone still leaves the gap open.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatTreeDriftAdvisory,
  AFFECTED_TESTS_TREE_DRIFT_TOKEN,
  failureEntryKey,
  classifyStaleFailureEntries,
  formatStaleFailureSummary,
} from '../../../../scripts/lib/vitest-summary.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

describe('formatTreeDriftAdvisory', () => {
  it('is silent when HEAD did not move — a settled tree needs no caveat', () => {
    expect(
      formatTreeDriftAdvisory({ runStartHead: 'abc123', reportHead: 'abc123', changedPaths: [] }),
    ).toEqual([]);
  });

  it('is silent when either ref is unknown — an unreadable ref is an attribution gap, not drift', () => {
    // Same rule classifyStaleFailureEntries applies when it routes a missing blob to `unknown`
    // rather than to `stale`. Claiming drift from a failed git read would invent evidence.
    expect(formatTreeDriftAdvisory({ runStartHead: null, reportHead: 'bbb' })).toEqual([]);
    expect(formatTreeDriftAdvisory({ runStartHead: 'aaa', reportHead: null })).toEqual([]);
    expect(formatTreeDriftAdvisory({})).toEqual([]);
  });

  it('emits a greppable token carrying both refs and the drift size', () => {
    const lines = formatTreeDriftAdvisory({
      runStartHead: 'aaa111',
      reportHead: 'bbb222',
      changedPaths: ['packages/operator-core/lib/plan-items/claims.ts'],
      commitCount: 35,
    });
    const marker = lines.join('\n');
    expect(marker).toContain(`${AFFECTED_TESTS_TREE_DRIFT_TOKEN} `);
    expect(marker).toContain('runStartHead=aaa111');
    expect(marker).toContain('reportHead=bbb222');
    expect(marker).toContain('commits=35');
    expect(marker).toContain('changedFiles=1');
  });

  it('reports commits=unknown rather than a fabricated zero when the count is unavailable', () => {
    const marker = formatTreeDriftAdvisory({
      runStartHead: 'aaa',
      reportHead: 'bbb',
      changedPaths: ['x.ts'],
      commitCount: null,
    }).join('\n');
    expect(marker).toContain('commits=unknown');
    expect(marker).not.toContain('commits=0');
  });

  it('caps the sample and points at the full diff instead of dumping every path', () => {
    const paths = Array.from({ length: 122 }, (_, i) => `packages/operator-core/lib/f${i}.ts`);
    const lines = formatTreeDriftAdvisory({
      runStartHead: 'aaa',
      reportHead: 'bbb',
      changedPaths: paths,
      commitCount: 35,
      sampleLimit: 8,
    });
    const body = lines.join('\n');
    expect(body).toContain('packages/operator-core/lib/f0.ts');
    expect(body).not.toContain('packages/operator-core/lib/f9.ts');
    expect(body).toContain('and 114 more');
    expect(body).toContain('git diff --name-only aaa..bbb');
    // The count in the token stays COMPLETE even though the sample is truncated: a bounded
    // display must never become a bounded measurement.
    expect(body).toContain('changedFiles=122');
  });

  it('names the import graph as the reason an unchanged test file proves nothing', () => {
    const body = formatTreeDriftAdvisory({
      runStartHead: 'aaa',
      reportHead: 'bbb',
      changedPaths: ['packages/operator-core/lib/plan-items/claims.ts'],
    }).join('\n');
    expect(body).toMatch(/PHANTOM/);
    expect(body).toMatch(/IMPORTS/);
  });
});

describe('the gap this closes: stale-failure silent, drift still reported', () => {
  // The WI-972025 shape, reconstructed. Both failing suites are UNCHANGED across the run
  // (identical blobs at run start and report time); what moved was a module they import.
  // Keys are built with the exported `failureEntryKey` rather than hand-writing its separator,
  // so this fixture cannot drift from the classifier's own keying.
  const entries = [
    { workspace: '@papercusp/web', file: 'bin/hosted-handler.test.ts' },
    {
      workspace: '@papercusp/web',
      file: 'lib/endpoint-route/__tests__/composed-app-shadowing.test.ts',
    },
  ];
  const unchangedBlobs = Object.fromEntries(
    entries.map((e, i) => [failureEntryKey(e), `blob${i}`]),
  );

  it('confirms the stale-failure check really is silent here (the premise of this guard)', () => {
    const classified = classifyStaleFailureEntries({
      entries,
      runStartBlobs: unchangedBlobs,
      reportBlobs: unchangedBlobs,
    });
    // Unchanged test files ⇒ `current`, not `stale` ⇒ no advisory. This is correct behaviour
    // for that helper; it is simply blind to the import graph.
    expect(classified.stale).toHaveLength(0);
    expect(classified.current).toHaveLength(2);
    expect(
      formatStaleFailureSummary({
        runStartHead: 'aaa',
        reportHead: 'bbb',
        stale: classified.stale,
      }),
    ).toEqual([]);
  });

  it('FIRES for that same run, because HEAD moved even though no test file did', () => {
    const lines = formatTreeDriftAdvisory({
      runStartHead: 'aaa',
      reportHead: 'bbb',
      changedPaths: [
        'packages/operator-core/lib/plan-items/claims.ts',
        'packages/operator-core/lib/plan-items/plan-item-claim-authority-ops.ts',
      ],
      commitCount: 35,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain(AFFECTED_TESTS_TREE_DRIFT_TOKEN);
  });
});

describe('affected-tests.mjs wiring', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');

  it('actually calls the advisory — an unwired helper closes nothing', () => {
    expect(source).toContain('formatTreeDriftAdvisory({');
    expect(source).toContain('formatTreeDriftAdvisory,');
  });

  it('derives the drift set from the run-start ref, not from current HEAD alone', () => {
    expect(source).toContain('RUN_START_HEAD !== reportHead');
    expect(source).toContain('"--name-only"');
    expect(source).toContain('"rev-list"');
  });

  it('keeps the advisory out of the verdict contract', () => {
    // The exit code and AFFECTED_TESTS_RESULT shape are consumed by the gate. Turning a
    // diagnostic into a red would make this a new false-RED generator — the very failure it
    // exists to reduce. Assert the token is not spliced into the result line.
    const resultLine = source.match(/AFFECTED_TESTS_RESULT status=\$\{[^`]*/)?.[0] ?? '';
    expect(resultLine).not.toContain(AFFECTED_TESTS_TREE_DRIFT_TOKEN);
    expect(resultLine).not.toContain('treeDrift');
  });

  it('greps for the token via the shared constant, so a rename cannot desync', () => {
    expect(AFFECTED_TESTS_TREE_DRIFT_TOKEN).toBe('AFFECTED_TESTS_TREE_DRIFT');
  });
});
