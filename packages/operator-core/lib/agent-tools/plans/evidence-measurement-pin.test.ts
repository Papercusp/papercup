/**
 * P-018 (review-system-rework-reduction-2026-09-23): a repo-files proof is pinned to the
 * commit(s) it was measured at, and a stale verdict names exactly which measured files moved
 * and which commits moved them — INSIDE the owning submodule, where a superproject-relative
 * `git log` is always empty.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMeasurementPin,
  diffMeasuredFiles,
  explainMovedPaths,
  gitBlobId,
  owningRepo,
  readMeasurementPin,
  MEASUREMENT_PIN_DETAILS_KEY,
} from './evidence-measurement-pin';
import {
  measureAndPinRepoFilesEvidenceAtRoot,
  measureRepoFilesEvidenceAtRoot,
  measureRepoFilesEvidenceDetailedAtRoot,
  specEvidenceBindingFingerprint,
} from './spec-evidence-store';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

let root: string;

/** Superproject with `src/a.ts` and a NESTED repository `libs/sub` recorded as a gitlink. */
function makeTree() {
  root = mkdtempSync(join(tmpdir(), 'measurement-pin-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  const sub = join(root, 'libs/sub');
  mkdirSync(join(sub, 'sql'), { recursive: true });
  git(sub, 'init', '-q', '-b', 'main');
  writeFileSync(join(sub, 'sql/001.sql'), 'select 1;\n');
  git(sub, 'add', '.');
  git(sub, 'commit', '-q', '-m', 'sub init');
  git(root, 'add', 'src/a.ts', 'libs/sub');
  git(root, 'commit', '-q', '-m', 'root init');
}

beforeEach(makeTree);
afterEach(() => rmSync(root, { recursive: true, force: true }));

const recipe = {
  schemaVersion: 1 as const,
  kind: 'repo-files' as const,
  sourcePaths: ['src/a.ts', 'libs/sub/sql/001.sql'],
};

describe('evidence measurement pin (P-018)', () => {
  it('computes the same blob id as git hash-object', () => {
    const content = readFileSync(join(root, 'src/a.ts'));
    expect(gitBlobId(content)).toBe(git(root, 'hash-object', 'src/a.ts'));
  });

  it('attributes a path to the innermost repository that owns it', async () => {
    expect(await owningRepo(root, 'libs/sub/sql/001.sql')).toBe('libs/sub');
    expect(await owningRepo(root, 'src/a.ts')).toBe('.');
  });

  it('keeps the existing file-set fingerprint byte-identical', async () => {
    const detailed = await measureRepoFilesEvidenceDetailedAtRoot(root, recipe);
    const plain = await measureRepoFilesEvidenceAtRoot(root, recipe);
    expect(detailed.sourceFingerprint).toBe(plain.sourceFingerprint);
    expect(detailed.files.map((file) => file.path)).toEqual(['libs/sub/sql/001.sql', 'src/a.ts']);
  });

  it('pins each file to its owning repo HEAD and resolves the submodule gitlink', async () => {
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    const subHead = git(join(root, 'libs/sub'), 'rev-parse', 'HEAD');
    expect(pin.repos).toEqual([
      { repo: '.', head: git(root, 'rev-parse', 'HEAD'), gitlink: null },
      { repo: 'libs/sub', head: subHead, gitlink: subHead },
    ]);
    const sql = pin.files.find((file) => file.path === 'libs/sub/sql/001.sql')!;
    expect(sql).toMatchObject({ repo: 'libs/sub', clean: true, headBlob: git(join(root, 'libs/sub'), 'rev-parse', 'HEAD:sql/001.sql') });
    expect(pin.errors).toBeUndefined();
  });

  it('records an uncommitted edit as not clean rather than pinning it to HEAD', async () => {
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    expect(pin.files.find((file) => file.path === 'src/a.ts')!.clean).toBe(false);
  });

  it('never throws when git is unavailable: the failure is recorded inside the pin', async () => {
    const files = (await measureRepoFilesEvidenceDetailedAtRoot(root, recipe)).files;
    const pin = await buildMeasurementPin(root, files, {
      git: async () => {
        throw new Error('git exploded');
      },
    });
    expect(pin.repos.every((repo) => repo.head === null)).toBe(true);
    expect(pin.files.every((file) => file.clean === null)).toBe(true);
    expect(pin.errors?.some((error) => error.includes('git exploded'))).toBe(true);
  });

  it('names exactly the moved paths, and says unpinned instead of an empty list', async () => {
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    writeFileSync(join(root, 'libs/sub/sql/001.sql'), 'select 2;\n');
    const now = (await measureRepoFilesEvidenceDetailedAtRoot(root, recipe)).files;
    expect(diffMeasuredFiles(pin, now)).toEqual({
      pinned: true,
      moved: [{ path: 'libs/sub/sql/001.sql', dimension: 'source', change: 'changed' }],
    });
    expect(diffMeasuredFiles(null, now)).toEqual({ pinned: false });
    const widened = [...now, { path: 'src/b.ts', dimension: 'test' as const, sha256: 'x', gitBlob: 'y' }];
    const moved = diffMeasuredFiles(pin, widened.filter((file) => file.path !== 'src/a.ts'));
    expect(moved.pinned && moved.moved.map((entry) => `${entry.path}:${entry.change}`)).toEqual([
      'libs/sub/sql/001.sql:changed',
      'src/a.ts:removed',
      'src/b.ts:added',
    ]);
  });

  it('attributes a committed peer change to its commit INSIDE the submodule, and flags in-flight edits', async () => {
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    const sub = join(root, 'libs/sub');
    writeFileSync(join(sub, 'sql/001.sql'), 'select 3;\n');
    git(sub, 'commit', '-q', '-am', 'peer rewrites migration');
    const peerCommit = git(sub, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 9;\n');
    const now = (await measureRepoFilesEvidenceDetailedAtRoot(root, recipe)).files;
    const diff = diffMeasuredFiles(pin, now);
    if (!diff.pinned) throw new Error('expected a pinned diff');
    const explained = await explainMovedPaths(root, pin, diff.moved, new Map(now.map((file) => [file.path, file])));
    const sql = explained.find((entry) => entry.path === 'libs/sub/sql/001.sql')!;
    expect(sql.repo).toBe('libs/sub');
    expect(sql.commits.map((commit) => commit.sha)).toEqual([peerCommit]);
    expect(sql.commits[0]!.subject).toBe('peer rewrites migration');
    expect(sql.uncommitted).toBe(false);
    const src = explained.find((entry) => entry.path === 'src/a.ts')!;
    expect(src.commits).toEqual([]);
    expect(src.uncommitted).toBe(true);
  });

  it('round-trips through binding details and is excluded from the binding fingerprint', async () => {
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    expect(readMeasurementPin({ [MEASUREMENT_PIN_DETAILS_KEY]: pin })).toEqual(pin);
    expect(readMeasurementPin({ [MEASUREMENT_PIN_DETAILS_KEY]: { schemaVersion: 2 } })).toBeNull();
    const base = {
      workspaceId: 'ws', harnessSlug: 'h', workItemId: 'WI-1', planSlug: 'p', specId: 'S-1', specRevision: 1,
      specFingerprint: 'f', evidenceKind: 'test' as const, evidenceRef: 'r', sourceFingerprint: 's',
      testFingerprint: null, fixtureFingerprint: null, rubricFingerprint: null, environmentFingerprint: null,
      coverageEvidenceRef: null, testRunId: null,
    };
    const without = specEvidenceBindingFingerprint({ ...base, details: { currentMeasurement: recipe } });
    const withPin = specEvidenceBindingFingerprint({ ...base, details: { currentMeasurement: recipe, [MEASUREMENT_PIN_DETAILS_KEY]: pin } });
    const otherHead = specEvidenceBindingFingerprint({
      ...base,
      details: { currentMeasurement: recipe, [MEASUREMENT_PIN_DETAILS_KEY]: { ...pin, repos: [] } },
    });
    expect(withPin).toBe(without);
    expect(otherHead).toBe(without);
    // Control: the fingerprint still moves when real proof metadata moves.
    expect(specEvidenceBindingFingerprint({ ...base, details: { currentMeasurement: { ...recipe, sourcePaths: ['src/a.ts'] } } })).not.toBe(without);
  });
});
