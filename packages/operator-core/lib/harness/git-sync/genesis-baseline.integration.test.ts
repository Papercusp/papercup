/**
 * genesis-baseline.integration.test.ts — WI-6243.
 *
 * Real git repos (no mocked seam): the bug this guards was a WRONG ANSWER from
 * git itself under a topology no unit-level fake would have reproduced, so the
 * tests build that topology for real.
 *
 * THE LIVE FAILURE (P-302 rig, 2026-07-27): a seed-snapshot pot's registry
 * entry has `github_remote: null` and its only remote-tracking ref is
 * `refs/remotes/origin/papercusp-seed-snapshot-<uuid>` while the local branch
 * is `main`. The old helper bailed on BOTH counts, returned null, and genesis
 * therefore judged the repo's whole history on every git-sync tick — 27.5 min
 * per fire, always refused, namespace ref never written, forever.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { deriveGenesisBaselineSha } from './genesis-baseline';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  }).trim();
}

function commit(repo: string, name: string): string {
  writeFileSync(join(repo, name), `${name}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', name);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A worktree whose history is fully local, plus whatever remote-tracking refs
 *  the caller plants. `remoteUrl` decides the external-remote gate. */
function makeRepo(remoteUrl: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-baseline-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  if (remoteUrl) git(dir, 'remote', 'add', 'origin', remoteUrl);
  return dir;
}

/** Plant a remote-tracking ref at `sha` WITHOUT any network: exactly the state
 *  a real fetch would have left behind. */
function plantRemoteRef(repo: string, name: string, sha: string): void {
  git(repo, 'update-ref', `refs/remotes/origin/${name}`, sha);
}

describe('deriveGenesisBaselineSha', () => {
  it('THE RIG BUG: a seed-snapshot pot (no github_remote, no origin/<branch>) still gets a baseline', async () => {
    // Exactly the P-302 topology: branch `main`, and the only remote-tracking
    // ref is a snapshot branch that is an ANCESTOR of head.
    const repo = makeRepo('https://github.com/Papercusp/papercup');
    const base = commit(repo, 'seed');
    plantRemoteRef(repo, 'papercusp-seed-snapshot-f740fe8d', base);
    const head = commit(repo, 'local-work');

    const baseline = await deriveGenesisBaselineSha({ path: repo }, 'main');

    // Pre-fix this returned null (github_remote absent ⇒ instant bail), which
    // made the guard judge (null, head] — the entire history.
    expect(baseline).toBe(base);
    expect(baseline).not.toBe(head);
    // And the range it produces is the small one: 1 commit, not the world.
    expect(git(repo, 'rev-list', '--count', `${baseline}..HEAD`)).toBe('1');
  });

  it('prefers the exact origin/<branch> upstream when it exists', async () => {
    const repo = makeRepo('https://github.com/Papercusp/papercup');
    const older = commit(repo, 'older');
    const upstream = commit(repo, 'upstream-tip');
    commit(repo, 'local-only');
    // Both a stale snapshot ref AND the real branch upstream are present.
    plantRemoteRef(repo, 'snapshot-xyz', older);
    plantRemoteRef(repo, 'main', upstream);

    expect(await deriveGenesisBaselineSha({ path: repo }, 'main')).toBe(upstream);
  });

  it('picks the TIGHTEST already-exposed ancestor when several remote refs qualify', async () => {
    const repo = makeRepo('https://github.com/Papercusp/papercup');
    const old = commit(repo, 'old');
    const newer = commit(repo, 'newer');
    commit(repo, 'a');
    commit(repo, 'b');
    plantRemoteRef(repo, 'snap-old', old);
    plantRemoteRef(repo, 'snap-newer', newer);

    // `newer` is the frontier: judging from `old` would needlessly re-scan a
    // commit a remote already serves.
    expect(await deriveGenesisBaselineSha({ path: repo }, 'main')).toBe(newer);
  });

  it('returns the head itself when a remote already serves the whole branch', async () => {
    const repo = makeRepo('https://github.com/Papercusp/papercup');
    commit(repo, 'one');
    const head = commit(repo, 'two');
    plantRemoteRef(repo, 'mirror', head);

    // Nothing is unexposed ⇒ an empty range to judge, not a full-history walk.
    expect(await deriveGenesisBaselineSha({ path: repo }, 'main')).toBe(head);
  });

  it('stays STRICT (null) when no remote-tracking ref reaches the branch at all', async () => {
    const repo = makeRepo('https://github.com/Papercusp/papercup');
    commit(repo, 'one');
    commit(repo, 'two');
    // A remote ref exists, but on a DISJOINT root — nothing on this branch is
    // exposed, so there is no baseline to lean on and the full judge is right.
    git(repo, 'checkout', '-q', '--orphan', 'unrelated');
    git(repo, 'rm', '-rqf', '.');
    const orphanTip = commit(repo, 'unrelated');
    git(repo, 'checkout', '-q', '-f', 'main');
    git(repo, 'branch', '-q', '-D', 'unrelated');
    plantRemoteRef(repo, 'unrelated', orphanTip);

    expect(await deriveGenesisBaselineSha({ path: repo }, 'main')).toBeNull();
  });

  it('stays STRICT (null) when every remote URL is a LOCAL path — no off-box exposure', async () => {
    const repo = makeRepo('/srv/mirrors/papercup.git');
    const base = commit(repo, 'seed');
    plantRemoteRef(repo, 'snapshot', base);
    commit(repo, 'local-work');

    // A remote-tracking ref exists and IS an ancestor, but the remote it tracks
    // never left this machine, so it proves nothing about exposure.
    expect(await deriveGenesisBaselineSha({ path: repo }, 'main')).toBeNull();
  });

  it('the registry github_remote alone satisfies the gate (unchanged fast path)', async () => {
    const repo = makeRepo(null); // no git-level remote configured at all
    const base = commit(repo, 'seed');
    plantRemoteRef(repo, 'snapshot', base);
    commit(repo, 'local-work');

    expect(
      await deriveGenesisBaselineSha({ path: repo, github_remote: 'https://github.com/Papercusp/papercup' }, 'main'),
    ).toBe(base);
  });

  it('never returns a NON-ANCESTOR baseline (a diverged remote cannot smuggle one in)', async () => {
    const repo = makeRepo('https://github.com/Papercusp/papercup');
    const root = commit(repo, 'root');
    // A remote branch that diverged: shares `root` but is not an ancestor of head.
    git(repo, 'checkout', '-q', '-b', 'diverged');
    const divergedTip = commit(repo, 'diverged-work');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'diverged');
    plantRemoteRef(repo, 'main', divergedTip);
    const head = commit(repo, 'local-work');

    const baseline = await deriveGenesisBaselineSha({ path: repo }, 'main');
    expect(baseline).not.toBe(divergedTip);
    // The frontier fallback still finds the shared ancestor, which IS exposed.
    expect(baseline).toBe(root);
    // ...and it really is an ancestor of head (throws non-zero otherwise).
    expect(() => git(repo, 'merge-base', '--is-ancestor', baseline!, head)).not.toThrow();
  });

  it('resolves the branch from HEAD when the caller passes none', async () => {
    const repo = makeRepo('https://github.com/Papercusp/papercup');
    const base = commit(repo, 'seed');
    plantRemoteRef(repo, 'snapshot', base);
    commit(repo, 'local-work');

    expect(await deriveGenesisBaselineSha({ path: repo }, undefined)).toBe(base);
  });
});
