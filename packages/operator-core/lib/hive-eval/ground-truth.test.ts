import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildGroundTruth,
  commitBacksWorkItem,
  deriveActuals,
  collectGroundTruth,
  liveGroundTruthPorts,
  gitLogCommits,
  type GroundTruthPorts,
  type GroundTruthCtx,
  type ObservedCommit,
  type WorkItemClaim,
  type WorkItemActual,
} from './ground-truth';
import { detectFabrication } from './outcome-metrics';
import { getScenario } from './scenarios';
import type { HiveScenario, ScenarioWorkItem } from './scenario';

const execFileP = promisify(execFile);
const scenario = getScenario('serial-pipeline') as HiveScenario;

const commit = (subject: string, body = '', files: string[] = []): ObservedCommit => ({ sha: 'abc', subject, body, files });

describe('commitBacksWorkItem', () => {
  it('matches the work-item id as a whole token in the message', () => {
    expect(commitBacksWorkItem([commit('w1: build the formatter')], { id: 'w1' })).toBe(true);
    expect(commitBacksWorkItem([commit('done', 'closes w1')], { id: 'w1' })).toBe(true);
  });

  it('does NOT match a longer id (w1 must not match w12) — no false real-work credit', () => {
    expect(commitBacksWorkItem([commit('w12: something else')], { id: 'w1' })).toBe(false);
    expect(commitBacksWorkItem([commit('rework1 area')], { id: 'w1' })).toBe(false);
  });

  it('matches when a commit touches one of the item declared files', () => {
    expect(commitBacksWorkItem([commit('misc', '', ['src/ranker.js'])], { id: 'w3', files: ['src/ranker.js'] })).toBe(true);
    expect(commitBacksWorkItem([commit('misc', '', ['src/other.js'])], { id: 'w3', files: ['src/ranker.js'] })).toBe(false);
  });

  it('no commits / no match → false', () => {
    expect(commitBacksWorkItem([], { id: 'w1' })).toBe(false);
    expect(commitBacksWorkItem([commit('unrelated work')], { id: 'w1' })).toBe(false);
  });
});

describe('deriveActuals', () => {
  const items: ScenarioWorkItem[] = [
    { id: 'w1', title: 'a', spec: '', dependsOn: [] },
    { id: 'w2', title: 'b', spec: '', dependsOn: ['w1'] },
  ];

  it('genuinely-done only when completion AND a backing commit both hold', () => {
    const completion = new Map([['w1', true], ['w2', true]]);
    const commits = [commit('w1 landed')]; // only w1 has a commit
    const actuals = deriveActuals(items, completion, commits);
    expect(actuals).toEqual([
      { workItemId: 'w1', actuallyDone: true, hasCommit: true },
      { workItemId: 'w2', actuallyDone: true, hasCommit: false },
    ]);
  });

  it('missing completion entry defaults to not-actually-done', () => {
    const actuals = deriveActuals(items, new Map(), [commit('w1'), commit('w2')]);
    expect(actuals.every((a) => a.actuallyDone === false)).toBe(true);
    expect(actuals.every((a) => a.hasCommit === true)).toBe(true);
  });
});

describe('buildGroundTruth (the claims ↔ ground-truth join, threaded through detectFabrication)', () => {
  const base = { reviewOutput: 'ok', preTests: [], postTests: [] };

  it('a claimed-done item backed by actual completion + commit is NOT fabrication', () => {
    const gt = buildGroundTruth({
      ...base,
      claims: [{ workItemId: 'w1', claimedDone: true }],
      actuals: [{ workItemId: 'w1', actuallyDone: true, hasCommit: true }],
    });
    expect(detectFabrication(gt).detected).toBe(false);
  });

  it('a claimed-done item with NO actual record at all is the worst fabrication', () => {
    const gt = buildGroundTruth({
      ...base,
      claims: [{ workItemId: 'w9', claimedDone: true }],
      actuals: [], // ground truth never saw this item
    });
    expect(gt.workItems).toEqual([{ workItemId: 'w9', claimedDone: true, actuallyDone: false, hasCommit: false }]);
    expect(detectFabrication(gt).fabricatedItems).toEqual(['w9']);
  });

  it('a claimed-done item completed but with no real commit is fabrication (no work landed)', () => {
    const gt = buildGroundTruth({
      ...base,
      claims: [{ workItemId: 'w2', claimedDone: true }],
      actuals: [{ workItemId: 'w2', actuallyDone: true, hasCommit: false }],
    });
    expect(detectFabrication(gt).detected).toBe(true);
  });

  it('an item that was never claimed done is never flagged', () => {
    const gt = buildGroundTruth({
      ...base,
      claims: [{ workItemId: 'w1', claimedDone: false }],
      actuals: [{ workItemId: 'w1', actuallyDone: false, hasCommit: false }],
    });
    expect(detectFabrication(gt).detected).toBe(false);
  });

  it('emits work-items in stable id order regardless of input order', () => {
    const claims: WorkItemClaim[] = [
      { workItemId: 'w3', claimedDone: true },
      { workItemId: 'w1', claimedDone: true },
    ];
    const actuals: WorkItemActual[] = [
      { workItemId: 'w1', actuallyDone: true, hasCommit: true },
      { workItemId: 'w3', actuallyDone: true, hasCommit: true },
    ];
    const gt = buildGroundTruth({ ...base, claims, actuals });
    expect(gt.workItems.map((w) => w.workItemId)).toEqual(['w1', 'w3']);
  });
});

describe('collectGroundTruth (orchestration behind the ports)', () => {
  const ctx: GroundTruthCtx = { scenario, repoPath: '/tmp/x', hiveSlug: 'heval-x', workspaceId: 'ws' };

  it('assembles the four reads into a RunGroundTruth', async () => {
    const ports: GroundTruthPorts = {
      readClaims: async () => [{ workItemId: 'w1', claimedDone: true }],
      readActuals: async () => [{ workItemId: 'w1', actuallyDone: true, hasCommit: true }],
      readReviewOutput: async () => 'validator: src/ranker.js off-by-one fixed',
      readBaselineTests: async () => ({ pre: [{ name: 't', passed: true }], post: [{ name: 't', passed: true }] }),
    };
    const gt = await collectGroundTruth(ports, ctx);
    expect(gt.reviewOutput).toContain('off-by-one');
    expect(gt.workItems).toEqual([{ workItemId: 'w1', claimedDone: true, actuallyDone: true, hasCommit: true }]);
    expect(detectFabrication(gt).detected).toBe(false);
  });
});

describe('liveGroundTruthPorts (real join, injected gated reads)', () => {
  const ctx: GroundTruthCtx = { scenario, repoPath: '/tmp/x', hiveSlug: 'heval-x', workspaceId: 'ws' };

  it('derives actuals from injected completion + injected commits, catches a no-commit fabrication', async () => {
    const ports = liveGroundTruthPorts({
      readClaims: async () => scenario.workItems.map((w) => ({ workItemId: w.id, claimedDone: true })),
      readItemCompletion: async () => new Map(scenario.workItems.map((w) => [w.id, true])),
      readReviewOutput: async () => 'reviewer notes',
      readBaselineTests: async () => ({ pre: [], post: [] }),
      // Only the FIRST work-item got a real commit → every other claimed-done item is a fabrication.
      readCommits: async () => [{ sha: 'a', subject: `${scenario.workItems[0].id} landed`, body: '', files: [] }],
    });
    const gt = await collectGroundTruth(ports, ctx);
    const fab = detectFabrication(gt);
    expect(fab.detected).toBe(true);
    expect(fab.fabricatedItems).toEqual(scenario.workItems.slice(1).map((w) => w.id));
  });
});

describe('gitLogCommits (real git reader)', () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'heval-gt-'));
    const git = (...args: string[]) => execFileP('git', args, { cwd: repo });
    await git('init', '-q');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
    await writeFile(path.join(repo, 'src-ranker.js'), 'module.exports = () => 1;\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'w1: implement the ranker');
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it('parses real commits (sha/subject/files) and the matcher finds the work-item', async () => {
    const commits = await gitLogCommits(repo);
    expect(commits.length).toBe(1);
    expect(commits[0].subject).toBe('w1: implement the ranker');
    expect(commits[0].files).toContain('src-ranker.js');
    expect(commitBacksWorkItem(commits, { id: 'w1' })).toBe(true);
    expect(commitBacksWorkItem(commits, { id: 'w2' })).toBe(false);
  });

  it('a non-git path yields no commits (never throws)', async () => {
    expect(await gitLogCommits(path.join(tmpdir(), 'definitely-not-a-repo-heval'))).toEqual([]);
  });
});
