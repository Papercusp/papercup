/**
 * Green-checkpoint orchestration — the advance-only-when-green + FF-only rules
 * are what keep `ready` a trustworthy deployable pin. Real temp repo for the ref
 * logic; stub deps for the (heavy) suite run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGreenCheckpoint, type CheckpointDeps } from './green-checkpoint';
import { git, revParse, advanceReady } from './git-ops';
import { releaseConfig } from './release-config';

let repo: string;
async function commit(file: string, content: string, msg: string): Promise<string> {
  const full = join(repo, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--no-verify', '-q', '-m', msg]);
  return revParse(repo, 'HEAD');
}

function stubDeps(green: boolean): { deps: CheckpointDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: CheckpointDeps = {
    setupTree: async (ref) => {
      calls.push(`setup:${ref.slice(0, 7)}`);
    },
    runGreen: async () => {
      calls.push('runGreen');
      return { green, summary: green ? 'all pass' : '3 failed' };
    },
    advance: (candidate) => {
      calls.push('advance');
      return advanceReady(repo, candidate, 'ready');
    },
    push: async () => {
      calls.push('push');
    },
    broadcast: async () => {
      calls.push('broadcast');
    },
    log: () => {},
  };
  return { deps, calls };
}

const cfg = () => releaseConfig({ integrationRoot: repo, releaseRoot: repo, checkpointRoot: repo, releaseRef: 'ready', integrationBranch: 'main' });

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'green-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 'T']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('runGreenCheckpoint', () => {
  it('advances ready when the candidate is green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2);
    expect(calls).toEqual(['setup:' + c2.slice(0, 7), 'runGreen', 'advance', 'broadcast']);
  });

  it('holds ready when the candidate is NOT green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(false);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: false, green: false, reason: 'not-green' });
    expect(await revParse(repo, 'ready')).toBe(c1); // unchanged
    expect(calls).not.toContain('advance');
  });

  it('is a no-op when ready already at integration HEAD', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const { deps, calls } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('up-to-date');
    expect(calls).toEqual([]); // didn't even build the tree
  });

  it('refuses a non-fast-forward candidate', async () => {
    const c1 = await commit('a', '1', 'c1');
    const cFeat = await commit('a', 'feat', 'feat');
    await git(repo, ['branch', 'ready', cFeat]); // ready ahead on a feature line
    await git(repo, ['reset', '--hard', c1]);
    const cDiv = await commit('b', 'div', 'div'); // main diverged
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { candidate: cDiv, noPush: true });
    expect(r.reason).toBe('not-fast-forward');
    expect(await revParse(repo, 'ready')).toBe(cFeat); // unchanged
  });
});
