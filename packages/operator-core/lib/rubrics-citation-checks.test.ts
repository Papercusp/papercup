/**
 * rubrics-citation-checks.test.ts — recurrence coverage for the acceptance
 * rubric citation guard (EI-21818117666341180).
 *
 * The measured defect was not a missing file.  The cited file existed, but a
 * criterion's symbol-level subject lived in a sibling module, so a grader
 * received a false `unknown`.  These tests keep both halves falsifiable:
 * existence-only would accept the bad fixture, while the content anchor rejects
 * it; matching path + matching literal remains a positive control.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertAcceptanceRubricCitationPathsResolve,
  validateAcceptanceRubricCitationPaths,
  type AcceptanceRubricCitationCriterion,
} from './rubrics-citation-checks';
import { proposeRubric } from './rubrics';

const root = mkdtempSync(join(tmpdir(), 'rubric-citations-test-'));
const store = 'packages/operator-core/lib/events/await/store.ts';
const executor = 'packages/operator-core/lib/events/await/wake-executor.ts';
const executorTest = 'packages/operator-core/lib/events/await/wake-executor.test.ts';
for (const file of [store, executor, executorTest]) {
  mkdirSync(resolve(root, file, '..'), { recursive: true });
}

writeFileSync(resolve(root, store), 'export function takeOverLineage() {}\n');
writeFileSync(resolve(root, executor), '// delivery path\nexport function executeWake() {}\n');
writeFileSync(
  resolve(root, executorTest),
  [
    "describe('cross-lineage delivery case', () => {",
    "  it('rejects a registration and returns the compatible binding', () => {});",
    '});',
    '',
  ].join('\n'),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const deps = {
  statFile: (selectedRoot: string, path: string) => {
    try {
      return { isFile: statSync(resolve(selectedRoot, path)).isFile() };
    } catch {
      return null;
    }
  },
  readFile: (selectedRoot: string, path: string) => {
    try {
      return readFileSync(resolve(selectedRoot, path), 'utf8');
    } catch {
      return null;
    }
  },
};

const c6 = (over: Partial<AcceptanceRubricCitationCriterion> = {}): AcceptanceRubricCitationCriterion => ({
  key: 'C6',
  method:
    'Read the lineage check in packages/operator-core/lib/events/await/store.ts (symbol-level; ~1279 is a hint) and the delivery path in packages/operator-core/lib/events/await/wake-executor.ts.',
  replication:
    "Run testing:run { files: ['packages/operator-core/lib/events/await/wake-executor.test.ts'] }; inspect the test named 'rejects a registration and returns the compatible binding'.",
  ...over,
});

describe('validateAcceptanceRubricCitationPaths — EI-21818117666341180', () => {
  it('resolves a repo-qualified source citation in an admitted independent sibling checkout', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'rubric-citations-sibling-test-'));
    const subjectRoot = join(workspace, 'papercusp');
    const siblingRoot = join(workspace, 'portal');
    const cited = 'packages/contracts/src/index.ts';
    try {
      mkdirSync(join(subjectRoot, '.git'), { recursive: true });
      mkdirSync(join(siblingRoot, '.git'), { recursive: true });
      mkdirSync(resolve(siblingRoot, cited, '..'), { recursive: true });
      writeFileSync(join(subjectRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
      writeFileSync(join(siblingRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
      writeFileSync(resolve(siblingRoot, cited), 'export const PORTAL_APP_KINDS = ["home"];\n');

      const result = validateAcceptanceRubricCitationPaths(
        [
          {
            key: 'cross-repo',
            method: `Inspect symbol: PORTAL_APP_KINDS in portal/${cited}.`,
          },
        ],
        { root: subjectRoot },
      );

      expect(result.failures).toEqual([]);
      expect(result).toMatchObject({ ok: true });
      expect(result.checkedPaths).toBe(1);
      expect(result.checkedAnchors).toEqual([
        expect.objectContaining({
          criterionKey: 'cross-repo',
          path: `portal/${cited}`,
          literal: 'PORTAL_APP_KINDS',
        }),
      ]);
      expect(result.failures).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reproduces the measured false-unknown shape: an existing but misaddressed symbol-level file is refused', () => {
    // FALSIFIABILITY CONTROL: the pre-fix existence-only rule would accept the
    // same fixture, so this red result is caused by content, not path absence.
    expect(deps.statFile(root, store)).toEqual({ isFile: true });
    const existenceOnly = deps.statFile(root, store)?.isFile === true;
    expect(existenceOnly).toBe(true);

    const result = validateAcceptanceRubricCitationPaths([c6()], { root, deps });
    expect(result.ok).toBe(false);
    expect(result.checkedPaths).toBe(3);
    expect(result.failures).toEqual([
      expect.objectContaining({
        criterionKey: 'C6',
        source: 'method',
        path: store,
        reason: 'literal_missing',
        literal: 'lineage check',
      }),
    ]);
  });

  it('accepts the corrected citation when the path and every named anchor are present', () => {
    writeFileSync(
      resolve(root, store),
      '// lineage check\nexport function takeOverLineage() {}\n',
    );
    const result = validateAcceptanceRubricCitationPaths([c6()], { root, deps });
    expect(result.ok).toBe(true);
    expect(result.checkedPaths).toBe(3);
    expect(result.failures).toEqual([]);
    expect(result.checkedAnchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterionKey: 'C6',
          source: 'method',
          path: store,
          literal: 'lineage check',
          kind: 'symbol',
        }),
        expect.objectContaining({
          criterionKey: 'C6',
          path: executorTest,
          literal: 'rejects a registration and returns the compatible binding',
          kind: 'test-case',
        }),
      ]),
    );
  });

  it('refuses a missing path and an explicit symbol absent from an otherwise live file', () => {
    const result = validateAcceptanceRubricCitationPaths(
      [
        {
          key: 'missing',
          method: 'Read packages/operator-core/lib/events/await/no-such.ts.',
        },
        {
          key: 'symbol',
          method: 'Inspect symbol: missingBranch in packages/operator-core/lib/events/await/store.ts.',
        },
      ],
      { root, deps },
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterionKey: 'missing', reason: 'path_missing' }),
        expect.objectContaining({
          criterionKey: 'symbol',
          reason: 'literal_missing',
          literal: 'missingBranch',
        }),
      ]),
    );
  });

  it('ignores prose without an explicit path or named symbol/test anchor', () => {
    const result = validateAcceptanceRubricCitationPaths(
      [
        {
          key: 'fuzzy',
          method: 'Judge the outcome from the current implementation and report any uncertainty.',
          replication: 'Use the normal review procedure; no source file is named.',
        },
      ],
      { root, deps },
    );
    expect(result).toEqual({
      ok: true,
      checkedPaths: 0,
      checkedAnchors: [],
      failures: [],
      planned: [],
    });
  });
});

describe('assertAcceptanceRubricCitationPathsResolve', () => {
  it('throws an invalid_args teaching error naming the criterion, path, and missing literal', () => {
    writeFileSync(resolve(root, store), 'export function takeOverLineage() {}\n');
    expect(() => assertAcceptanceRubricCitationPathsResolve([c6()], { root, deps })).toThrowError(
      /invalid_args:.*C6.*store\.ts.*lineage check/s,
    );
  });

  it('does not throw for a path-only citation that resolves', () => {
    expect(() =>
      assertAcceptanceRubricCitationPathsResolve(
        [{ key: 'path-only', method: `Read ${executor}.` }],
        { root, deps },
      ),
    ).not.toThrow();
  });
});

// EI-24372605712471072: before the subject plan starts, a citation may name code or a test
// case the plan's own items will write. Only "not there yet" is plannable.
describe('allowPlannedPaths — citations to code the plan has not written yet', () => {
  const futureModule = 'packages/operator-core/lib/events/await/written-later.ts';
  const planned = (): AcceptanceRubricCitationCriterion => ({
    key: 'R-1',
    method: `Read the chunker in ${futureModule}.`,
    replication:
      `Run testing:run { files: ['${executorTest}'] }; inspect the test named 'a case the plan will add'.`,
  });

  it('accepts a missing file and a missing named test case as planned, and lists both', () => {
    const result = validateAcceptanceRubricCitationPaths([planned()], { root, deps, allowPlannedPaths: true });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.planned.map((p) => [p.source, p.path, p.reason, p.literal])).toEqual([
      ['method', futureModule, 'path_missing', undefined],
      ['replication', executorTest, 'literal_missing', 'a case the plan will add'],
    ]);
  });

  it('without the allowance the same criterion refuses (a started plan, or plain propose)', () => {
    const strict = validateAcceptanceRubricCitationPaths([planned()], { root, deps });
    expect(strict.ok).toBe(false);
    expect(strict.planned).toEqual([]);
    expect(strict.failures.map((f) => f.reason).sort()).toEqual(['literal_missing', 'path_missing']);
    expect(() => assertAcceptanceRubricCitationPathsResolve([planned()], { root, deps })).toThrowError(
      /invalid_args:.*written-later\.ts/s,
    );
  });

  it('never plans a citation that is wrong regardless of timing (escaping, not a file)', () => {
    const dirLikeFile = 'packages/operator-core/lib/events/await/a-directory.ts';
    mkdirSync(resolve(root, dirLikeFile), { recursive: true });
    const result = validateAcceptanceRubricCitationPaths(
      [
        { key: 'escape', method: 'Read packages/../../etc/written-later.ts.' },
        { key: 'dir', method: `Read ${dirLikeFile}.` },
      ],
      { root, deps, allowPlannedPaths: true },
    );
    expect(result.ok).toBe(false);
    expect(result.planned).toEqual([]);
    expect(result.failures.map((f) => f.reason).sort()).toEqual(['not_a_file', 'path_escapes_repo']);
  });
});

describe('proposeRubric integration wiring', () => {
  it('rejects a misaddressed acceptance citation before checking its subject-plan link', async () => {
    await expect(
      proposeRubric({
        rubricId: 'acceptance-citation-guard-wiring',
        kind: 'acceptance',
        // Deliberately absent: if the citation guard is removed or moved after
        // the async link check, this different error would win instead.
        subjectPlan: 'does-not-exist',
        characteristic: 'citation-guard',
        title: 'Citation guard wiring',
        ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
        criteria: [
          {
            ...c6(),
            title: 'Cross-lineage delivery',
            driftMarkers: 'The cited source or named test case does not establish the outcome.',
          },
        ],
        checkPathRoot: root,
        by: 'su-test',
      }),
    ).rejects.toThrowError(/literal .*lineage check.*does not appear|lineage check.*cited file/s);
  });
});
