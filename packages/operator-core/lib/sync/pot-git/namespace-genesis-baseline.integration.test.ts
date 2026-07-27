/**
 * namespace-genesis-baseline.integration.test.ts — WI-6249.
 *
 * Real git repos (no mocked seam), for the same reason as its WI-6243 sibling:
 * the bug was a wrong answer under a REF TOPOLOGY, and a fake seam would have
 * happily agreed with the wrong answer.
 *
 * THE LIVE FAILURE (P-302 rig, 2026-07-27): ref-announce's publish tick judges
 * every ref under this device's namespace in the BARE pot-git store, but was fed
 * ONE baseline sha derived from the WORKTREE's mainline. The rig's own namespace
 * also carries a `refs/heads/staging` mirrored from a peer, on a different line
 * of history — so `(mainlineBaseline, staging]` spanned 7057 commits, the guard
 * cat-file'd every blob in that range into a JS string, and the sidecar died at
 * the 4GB heap limit every ~20-40 min (EI-18759477854494594). DBOS restarted the
 * fire at the same step after each crash, so it never made progress, ever.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { deriveNamespaceGenesisBaseline } from './namespace-genesis-baseline';

const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

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

/** A working repo we build history in, standing in for the bare pot-git store —
 *  ref topology is all these walks read, and a non-bare repo carries the same
 *  `refs/namespaces/**` refs a bare one does. */
function makeStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ns-genesis-baseline-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

const nsRef = (hex: string, ref: string): string => `refs/namespaces/${hex}/${ref}`;

/** How many objects the publish guard would enumerate for a given baseline —
 *  i.e. the exact cost this fix is about. */
function objectsInRange(store: string, fromOid: string | null, toOid: string): number {
  const args = ['rev-list', '--objects', toOid, ...(fromOid ? [`^${fromOid}`] : [])];
  const out = git(store, ...args);
  return out ? out.split('\n').length : 0;
}

describe('deriveNamespaceGenesisBaseline', () => {
  it('THE RIG BUG: a namespace ref mirrored from a peer judges ZERO new objects, not a whole history', async () => {
    const store = makeStore();
    // A long shared history, then a peer branch that diverges from ours. This is
    // the rig's shape: our namespace carries `staging` at a sha a peer already
    // serves, while our own mainline went somewhere else entirely.
    const root = commit(store, 'root');
    for (let i = 0; i < 12; i++) commit(store, `shared-${i}`);
    const forkPoint = git(store, 'rev-parse', 'HEAD');

    git(store, 'checkout', '-q', '-b', 'peerline');
    for (let i = 0; i < 8; i++) commit(store, `peer-${i}`);
    const peerHead = git(store, 'rev-parse', 'HEAD');

    git(store, 'checkout', '-q', 'main');
    const ourMain = commit(store, 'ours');

    // The peer published `peerHead` under ITS namespace — that content has
    // demonstrably left some machine already.
    git(store, 'update-ref', nsRef(PEER, 'refs/heads/staging'), peerHead);
    // …and we mirror the identical sha under OURS.
    git(store, 'update-ref', nsRef(SELF, 'refs/heads/staging'), peerHead);
    git(store, 'update-ref', nsRef(SELF, 'refs/heads/main'), ourMain);

    const baseline = await deriveNamespaceGenesisBaseline(store, nsRef(SELF, 'refs/heads/staging'), SELF);

    // Nothing under the mirrored ref is unexposed ⇒ the tip itself, which the
    // caller's `fromOid === sha` check turns into "skip this ref".
    expect(baseline).toBe(peerHead);
    expect(objectsInRange(store, baseline, peerHead)).toBe(0);

    // The regression this locks: the OLD behaviour fed the mainline baseline
    // here, which cannot reach the peer line, so the guard walked all of it.
    const mainlineBaseline = forkPoint;
    expect(objectsInRange(store, mainlineBaseline, peerHead)).toBeGreaterThan(8);
    expect(root).toBeTruthy();
  });

  it('our own un-announced content is NOT treated as exposed — it is exactly what gets judged', async () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) commit(store, `shared-${i}`);
    const exposed = git(store, 'rev-parse', 'HEAD');
    git(store, 'update-ref', nsRef(PEER, 'refs/heads/main'), exposed);

    // Two commits only WE have.
    commit(store, 'local-1');
    const ourHead = commit(store, 'local-2');
    git(store, 'update-ref', nsRef(SELF, 'refs/heads/main'), ourHead);

    const baseline = await deriveNamespaceGenesisBaseline(store, nsRef(SELF, 'refs/heads/main'), SELF);

    // The frontier is the peer-exposed tip: our 2 unexposed commits still get
    // judged. Holding out our own namespace is what makes this true — without
    // the `--exclude`, our own ref would "already expose" itself and the guard
    // would judge NOTHING (an under-guard, the dangerous direction).
    expect(baseline).toBe(exposed);
    const revs = git(store, 'rev-list', `${baseline}..${ourHead}`).split('\n').filter(Boolean);
    expect(revs).toHaveLength(2);
  });

  it('a remote-tracking ref counts as already exposed', async () => {
    const store = makeStore();
    for (let i = 0; i < 4; i++) commit(store, `up-${i}`);
    const upstream = git(store, 'rev-parse', 'HEAD');
    git(store, 'update-ref', 'refs/remotes/origin/main', upstream);
    const head = commit(store, 'local');
    git(store, 'update-ref', nsRef(SELF, 'refs/heads/main'), head);

    expect(await deriveNamespaceGenesisBaseline(store, nsRef(SELF, 'refs/heads/main'), SELF)).toBe(upstream);
  });

  it('a non-commit namespace ref (rad/handoff is a blob) returns null rather than a bogus range', async () => {
    const store = makeStore();
    commit(store, 'root');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: store,
      input: 'handoff\n',
      encoding: 'utf8',
    }).trim();
    git(store, 'update-ref', nsRef(SELF, 'refs/rad/handoff'), blob);

    // null ⇒ the caller falls back, and `rev-list --objects <blob>` judges it
    // correctly as the single object it is.
    expect(await deriveNamespaceGenesisBaseline(store, nsRef(SELF, 'refs/rad/handoff'), SELF)).toBeNull();
  });

  it('no already-exposed content at all ⇒ null (strict full-history judge, never a guess)', async () => {
    const store = makeStore();
    const head = commit(store, 'only');
    git(store, 'update-ref', nsRef(SELF, 'refs/heads/main'), head);

    expect(await deriveNamespaceGenesisBaseline(store, nsRef(SELF, 'refs/heads/main'), SELF)).toBeNull();
  });
});
