/**
 * Recurrence guard for EI-20072082961786945 — per-failure attribution against the CALLER's scope.
 *
 * THE CLASS THIS EXISTS TO CATCH. `test:affected` scans the SHARED working tree while git-sync
 * commits it every few minutes and N agents edit it, so a red can belong to a peer's half-landed
 * edit and the result gives the reader no way to tell. Measured 2026-08-10 (run=3196160-23fbfbf2):
 * a two-file, watchdog-local change came back `failed=2` naming
 * `@papercusp/operator-core :: lib/guard-string-literal-blindness.test.ts` and
 * `@papercusp/web :: app/_lints/design-primitives.test.ts` — both REAL reds at that instant, both
 * belonging to peers caught mid-landing, both green on a re-run two minutes later (59 pass / 0 fail).
 *
 * Two sibling advisories already existed and neither closes this. `formatTreeDriftAdvisory`
 * (WI-972025) says the tree moved; `classifyStaleFailureEntries` (EI-21082496866331715) says a
 * failing file's own blob moved. Neither says whether the failure is in a workspace the caller
 * ever touched, which is the first question a triager asks.
 *
 * BOTH DIRECTIONS OF THE GUESS ARE EXPENSIVE, which is why the assertions below pin the hedging
 * as hard as they pin the labels. CLAUDE.md makes every agent responsible for greening reds, so a
 * red misattributed to you sends you into a file a peer holds; and an agent who learns that
 * unrelated reds are usually peer churn dismisses a genuine regression of their own as "not mine".
 * A label that reads as a verdict causes the second failure, so `possible-peer-churn` must stay
 * the conjunction of two facts and must keep saying it only narrows.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyFailureScope,
  formatFailureScopeSummary,
  AFFECTED_TESTS_FAILURE_SCOPE_TOKEN,
} from '../../../../scripts/lib/vitest-summary.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

// The measured EI-20072082961786945 run, reconstructed: a change confined to the watchdog, and
// two reds in workspaces it never touched.
const MEASURED_ENTRIES = [
  { workspace: '@papercusp/operator-core', file: 'lib/guard-string-literal-blindness.test.ts' },
  { workspace: '@papercusp/web', file: 'app/_lints/design-primitives.test.ts' },
];
const WORKSPACE_DIRS = {
  '@papercusp/operator-core': 'packages/operator-core',
  '@papercusp/web': 'apps/operator',
  '@papercusp/desktop': 'papercusp-desktop',
};
const WATCHDOG_PATHS = [
  'apps/operator/scripts/bghost-watchdog.mjs',
  'apps/operator/scripts/bghost-watchdog.test.mjs',
];

describe('classifyFailureScope', () => {
  it('labels every failure `unscoped-run` when the caller named no paths', () => {
    // The measured case. A bare `npm run test:affected` derives its radius from the shared tree's
    // git state, so there is no caller set to intersect against and inventing a per-file verdict
    // from the fleet's work would be the confident-wrong answer this helper exists to avoid.
    const result = classifyFailureScope({
      entries: MEASURED_ENTRIES,
      callerPaths: null,
      workspaceDirs: WORKSPACE_DIRS,
    });
    expect(result.scoped).toBe(false);
    expect(result.rows.map((r) => r.attribution)).toEqual(['unscoped-run', 'unscoped-run']);
    expect(result.counts.unscoped).toBe(2);
    expect(result.counts.outside).toBe(0);
  });

  it('separates a red in the caller’s own workspace from one outside it', () => {
    // `guard-string-literal-blindness.test.ts` lives in packages/operator-core, which the watchdog
    // change never touched -> outside. `design-primitives.test.ts` lives under apps/operator, which
    // DOES contain a changed path -> caller-workspace, even though the test file itself is not one.
    const { rows, counts } = classifyFailureScope({
      entries: MEASURED_ENTRIES,
      callerPaths: WATCHDOG_PATHS,
      workspaceDirs: WORKSPACE_DIRS,
    });
    expect(rows[0].attribution).toBe('outside-caller-scope');
    expect(rows[1].attribution).toBe('caller-workspace');
    expect(rows[1].matchedPaths).toContain('apps/operator/scripts/bghost-watchdog.mjs');
    expect(counts).toMatchObject({ outside: 1, callerWorkspace: 1, callerFile: 0, unknown: 0 });
  });

  it('calls the failing file itself `caller-file` when the caller named that exact path', () => {
    const { rows } = classifyFailureScope({
      entries: [{ workspace: '@papercusp/web', file: 'app/_lints/design-primitives.test.ts' }],
      callerPaths: ['apps/operator/app/_lints/design-primitives.test.ts'],
      workspaceDirs: WORKSPACE_DIRS,
    });
    expect(rows[0].attribution).toBe('caller-file');
  });

  it('routes an unresolvable workspace to `unknown`, never to `outside-caller-scope`', () => {
    // The load-bearing asymmetry, and the same rule classifyStaleFailureEntries applies to a
    // missing blob. A failed lookup is an attribution GAP; spending it as "not yours" is how a
    // real regression gets dismissed, which is the worse of the two errors this feature can make.
    const { rows, counts } = classifyFailureScope({
      entries: [{ workspace: '@papercusp/not-in-this-tree', file: 'lib/x.test.ts' }],
      callerPaths: WATCHDOG_PATHS,
      workspaceDirs: WORKSPACE_DIRS,
    });
    expect(rows[0].attribution).toBe('unknown');
    expect(counts.outside).toBe(0);
    expect(counts.unknown).toBe(1);
  });

  it('matches a bare workspace dir — the submodule gitlink case', () => {
    // A gitlink change is reported as the bare directory, not as a path beneath it, which is why
    // resolveAffected() carries the same `file === ws.dir` arm. Without it a submodule workspace
    // could never be attributed to the caller and every one of its reds would read as a peer's.
    const { rows } = classifyFailureScope({
      entries: [{ workspace: '@papercusp/desktop', file: 'src/x.test.ts' }],
      callerPaths: ['papercusp-desktop'],
      workspaceDirs: WORKSPACE_DIRS,
    });
    expect(rows[0].attribution).toBe('caller-workspace');
  });

  it('does not let a dir prefix leak across sibling workspaces', () => {
    // `packages/operator-core-extras` must not count as a path inside `packages/operator-core`.
    const { rows } = classifyFailureScope({
      entries: [{ workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' }],
      callerPaths: ['packages/operator-core-extras/lib/y.ts'],
      workspaceDirs: WORKSPACE_DIRS,
    });
    expect(rows[0].attribution).toBe('outside-caller-scope');
  });
});

describe('formatFailureScopeSummary', () => {
  it('emits nothing when there are no failures to attribute', () => {
    expect(
      formatFailureScopeSummary({
        classification: classifyFailureScope({ entries: [], callerPaths: null }),
      }),
    ).toEqual([]);
  });

  it('names the repair for an unscoped run instead of guessing per file', () => {
    const body = formatFailureScopeSummary({
      runToken: 'run-1',
      classification: classifyFailureScope({
        entries: MEASURED_ENTRIES,
        callerPaths: null,
        workspaceDirs: WORKSPACE_DIRS,
      }),
      treeDrifted: true,
    }).join('\n');
    expect(body).toContain('--changed-paths');
    expect(body).toContain('scope=derived');
    // Nothing was attributable, so the churn count must stay 0 even though the tree moved.
    expect(body).toContain('possiblePeerChurn=0');
  });

  it('labels `possible-peer-churn` only when BOTH facts hold', () => {
    const classification = classifyFailureScope({
      entries: MEASURED_ENTRIES,
      callerPaths: WATCHDOG_PATHS,
      workspaceDirs: WORKSPACE_DIRS,
    });
    const drifted = formatFailureScopeSummary({
      runToken: 'run-1',
      classification,
      treeDrifted: true,
    }).join('\n');
    expect(drifted).toContain('attribution=possible-peer-churn');
    expect(drifted).toContain('possiblePeerChurn=1');

    // Same failures, settled tree: outside-the-caller's-paths alone is common and uninformative,
    // so the stronger label must not appear.
    const settled = formatFailureScopeSummary({
      runToken: 'run-1',
      classification,
      treeDrifted: false,
    }).join('\n');
    expect(settled).toContain('attribution=outside-caller-scope');
    expect(settled).not.toContain('possible-peer-churn');
    expect(settled).toContain('possiblePeerChurn=0');
  });

  it('keeps saying the label only NARROWS the search', () => {
    // The whole point of the honest limit: a red outside your paths can still be your regression
    // reached through the dependency graph. Drop this hedging and the label reads as a verdict.
    const body = formatFailureScopeSummary({
      runToken: 'run-1',
      classification: classifyFailureScope({
        entries: MEASURED_ENTRIES,
        callerPaths: WATCHDOG_PATHS,
        workspaceDirs: WORKSPACE_DIRS,
      }),
      treeDrifted: true,
    }).join('\n');
    expect(body).toMatch(/NARROWS/);
    expect(body).toMatch(/dependency graph/);
    // The collision this ticket is really about: being sent into a file a peer holds.
    expect(body).toMatch(/locks:queue/);
  });

  it('always emits the greppable marker, so its absence is unambiguous', () => {
    const marker = formatFailureScopeSummary({
      runToken: 'run-7',
      classification: classifyFailureScope({
        entries: [MEASURED_ENTRIES[1]],
        callerPaths: WATCHDOG_PATHS,
        workspaceDirs: WORKSPACE_DIRS,
      }),
    }).join('\n');
    expect(marker).toContain(`${AFFECTED_TESTS_FAILURE_SCOPE_TOKEN} run=run-7 `);
    expect(marker).toContain('scope=explicit');
    expect(marker).toContain('files=1');
    expect(marker).toContain('callerWorkspace=1');
  });
});

describe('affected-tests.mjs wiring', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');

  it('actually calls the advisory — an unwired helper closes nothing', () => {
    expect(source).toContain('formatFailureScopeSummary({');
    expect(source).toContain('classifyFailureScope({');
    expect(source).toContain('formatFailureScopeSummary,');
  });

  it('feeds it the caller’s explicit scope, not the run’s derived radius', () => {
    // `changedPathsOverride` is null for a bare run, which is exactly what produces the honest
    // `unscoped-run` reading. Passing the derived changed-file set here instead would manufacture
    // a caller scope out of the whole fleet's work and make every label wrong in the common case.
    expect(source).toContain('callerPaths: changedPathsOverride');
  });

  it('keeps the advisory out of the verdict contract', () => {
    // The exit code and AFFECTED_TESTS_RESULT shape are parsed by green-checkpoint. Turning an
    // attribution GUESS into part of a verdict would make this a new false-RED generator — the
    // very failure it exists to reduce.
    const resultLine = source.match(/AFFECTED_TESTS_RESULT status=\$\{[^`]*/)?.[0] ?? '';
    expect(resultLine).not.toContain(AFFECTED_TESTS_FAILURE_SCOPE_TOKEN);
    expect(resultLine).not.toContain('possiblePeerChurn');
    expect(resultLine).not.toContain('attribution=');
  });
});
