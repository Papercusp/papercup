/**
 * EI-20288629053504794 — completion path-vintage detector.
 *
 * The detector is deliberately pure at its decision seam: commit history is
 * injected so both directions (fires and stays silent) are falsifiable without
 * spawning git or depending on the shared checkout.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { preExistingChangedPathsInCompletion } from './complete';

const ROOT = '/repo';
const CREATED = '2026-08-12T22:39:04.318Z';
const BEFORE = '2026-08-12T01:21:00.000Z';
const AFTER = '2026-08-13T01:21:00.000Z';

const item = {
  createdAt: CREATED,
  payload: { paths: ['packages/old.ts', 'packages/new.ts'] },
};

describe('preExistingChangedPathsInCompletion', () => {
  it('fires for a claimed target whose last commit predates item creation', () => {
    const result = preExistingChangedPathsInCompletion(
      item,
      { summary: 'updated the old target', filesChanged: ['packages/old.ts'] },
      { repoRoot: ROOT, lastCommitAt: () => BEFORE },
    );

    expect(result).toEqual({
      createdAt: CREATED,
      paths: [{ path: 'packages/old.ts', lastCommitAt: BEFORE }],
    });
  });

  it('checks every positively claimed target and reports only the stale ones', () => {
    const result = preExistingChangedPathsInCompletion(
      item,
      { summary: 'updated both targets', filesChanged: ['packages/old.ts', 'packages/new.ts'] },
      {
        repoRoot: ROOT,
        lastCommitAt: (path) => (path.endsWith('old.ts') ? BEFORE : AFTER),
      },
    );

    expect(result?.paths).toEqual([{ path: 'packages/old.ts', lastCommitAt: BEFORE }]);
  });

  it('treats an explicit all-target claim as a claim for every payload path', () => {
    const result = preExistingChangedPathsInCompletion(
      item,
      { summary: 'All named target files were remediated' },
      { repoRoot: ROOT, lastCommitAt: () => BEFORE },
    );

    expect(result?.paths.map((entry) => entry.path)).toEqual(item.payload.paths);
  });

  it('stays silent when the path was committed after the item', () => {
    expect(
      preExistingChangedPathsInCompletion(
        item,
        { summary: 'updated the new target', filesChanged: ['packages/new.ts'] },
        { repoRoot: ROOT, lastCommitAt: () => AFTER },
      ),
    ).toBeUndefined();
  });

  it('stays silent when there is no positive path claim', () => {
    expect(
      preExistingChangedPathsInCompletion(
        item,
        { summary: 'ran the focused suite', testsRun: '55/55 passed' },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      ),
    ).toBeUndefined();
  });

  it('fails open for absent metadata, unknown history, and a throwing probe', () => {
    expect(
      preExistingChangedPathsInCompletion(
        { payload: item.payload },
        { filesChanged: ['packages/old.ts'] },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      ),
    ).toBeUndefined();
    expect(
      preExistingChangedPathsInCompletion(
        item,
        { filesChanged: ['packages/old.ts'] },
        { repoRoot: ROOT, lastCommitAt: () => null },
      ),
    ).toBeUndefined();
    expect(
      preExistingChangedPathsInCompletion(
        item,
        { filesChanged: ['packages/old.ts'] },
        {
          repoRoot: ROOT,
          lastCommitAt: () => {
            throw new Error('git unavailable');
          },
        },
      ),
    ).toBeUndefined();
  });

  it('reads a submodule path from the submodule repository, not the superproject', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'completion-vintage-'));
    const submodule = nodePath.join(root, 'libs', 'testing-shell');
    try {
      mkdirSync(nodePath.join(root, '.git'));
      writeFileSync(nodePath.join(root, '.git', 'HEAD'), 'ref: refs/heads/staging\n');
      mkdirSync(submodule, { recursive: true });
      writeFileSync(nodePath.join(submodule, '.git'), 'gitdir: ../../.git/modules/testing-shell\n');

      const calls: Array<{ repoRoot: string; paths: string[] }> = [];
      const result = preExistingChangedPathsInCompletion(
        { createdAt: CREATED, payload: { paths: ['libs/testing-shell/package.json'] } },
        { filesChanged: ['libs/testing-shell/package.json'] },
        {
          repoRoot: root,
          lastCommitTimes: (repoRoot, paths) => {
            calls.push({ repoRoot, paths: [...paths] });
            return new Map([['package.json', BEFORE]]);
          },
        },
      );

      expect(result?.paths).toEqual([
        { path: 'libs/testing-shell/package.json', lastCommitAt: BEFORE },
      ]);
      expect(calls).toEqual([{ repoRoot: submodule, paths: ['package.json'] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not judge an invalid or escaping path', () => {
    expect(
      preExistingChangedPathsInCompletion(
        { createdAt: CREATED, payload: { paths: ['../outside.ts', 'src/**/*.ts'] } },
        { filesChanged: ['../outside.ts', 'src/**/*.ts'] },
        { repoRoot: ROOT, lastCommitAt: () => BEFORE },
      ),
    ).toBeUndefined();
  });
});

describe('complete.ts wiring', () => {
  const source = readFileSync(nodePath.join(__dirname, 'complete.ts'), 'utf8');

  it('computes the detector from the fetched item and raw completion', () => {
    expect(source).toMatch(/preExistingChangedPathsInCompletion\(\s*existing,\s*it\.completion\s*\)/);
  });

  it('returns the warning so a result-door truncation cannot hide the finding', () => {
    expect(source).toMatch(/\.\.\.\(preExistingPathsWarning \? \{ preExistingPathsWarning \} : \{\}\)/);
  });
});
