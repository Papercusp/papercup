/**
 * foreign-git-sync.test.ts — P-109 leg (ii), the per-foreign-workspace commit
 * lane. Real temp git repos, no PG (every store/receipt seam injected).
 *
 * Includes the design-doc §3 MANDATED regression (C3/WI-1564 class): the
 * canonical sweep scope and the foreign lane scope are DISJOINT — the
 * canonical tick never stages a path under the foreign root, and the foreign
 * lane never stages a path outside its clone.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunGit } from '../harness/git-sync/run-git-sync';
import type { ForeignWorkspace } from './foreign-workspaces';
import {
  commitForeignWorkspace,
  foreignCommitTrailers,
  originNoreplyEmail,
  runForeignGitSyncTick,
} from './foreign-git-sync';

const execFileP = promisify(execFile);

const runGit: RunGit = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(e) };
  }
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Init a repo with one seed commit (host identity). */
async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.name', 'Host User');
  await git(dir, 'config', 'user.email', 'host@example.com');
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-m', 'seed');
}

function wsFor(clonePath: string, over: Partial<ForeignWorkspace> = {}): ForeignWorkspace {
  return {
    workspaceId: 'ws-1',
    offerId: 'offer-abc',
    fleetSlug: 'gh-777/widgets',
    originGithubUserId: 777,
    executorDevice: 'ab12cd34',
    rootPath: join(clonePath, '..'),
    clonePath,
    sessionId: 'sess-1',
    executionEpoch: 3,
    state: 'active',
    parkReason: null,
    baseSha: null,
    ...over,
  };
}

const identity = {
  name: 'Origin Dev',
  email: originNoreplyEmail(777, 'origindev'),
  githubUserId: 777,
};

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'foreign-git-sync-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('originNoreplyEmail', () => {
  it('composes the modern noreply form the P-110 gate resolves back to the id', () => {
    expect(originNoreplyEmail(777, 'origindev')).toBe('777+origindev@users.noreply.github.com');
  });
});

describe('commitForeignWorkspace', () => {
  it('clean tree → nothing, no commit created', async () => {
    const clone = join(base, 'clone');
    await mkdir(clone);
    await initRepo(clone);
    const before = await git(clone, 'rev-parse', 'HEAD');

    const out = await commitForeignWorkspace(wsFor(clone), identity, { runGit });
    expect(out.status).toBe('nothing');
    expect(await git(clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('stamps BOTH author and committer with the origin identity + all four trailers (C7)', async () => {
    const clone = join(base, 'clone');
    await mkdir(clone);
    await initRepo(clone);
    await writeFile(join(clone, 'work.txt'), 'foreign work\n');

    const out = await commitForeignWorkspace(wsFor(clone), identity, { runGit });
    expect(out.status).toBe('committed');

    const show = await git(clone, 'show', '-s', '--format=%an|%ae|%cn|%ce|%B', 'HEAD');
    const [an, ae, cn, ce] = show.split('|');
    expect(an).toBe('Origin Dev');
    expect(ae).toBe('777+origindev@users.noreply.github.com');
    expect(cn).toBe('Origin Dev'); // committer slot too — the P-110 gate judges both
    expect(ce).toBe('777+origindev@users.noreply.github.com');
    expect(show).toContain('Papercusp-Offer: offer-abc');
    expect(show).toContain('Papercusp-Origin-User: 777');
    expect(show).toContain('Papercusp-Executor-Device: ab12cd34');
    expect(show).toContain('Papercusp-Execution-Epoch: 3');
  });

  it('excludes oversized blobs from the commit, reports them, commits the rest', async () => {
    const clone = join(base, 'clone');
    await mkdir(clone);
    await initRepo(clone);
    await writeFile(join(clone, 'small.txt'), 'ok\n');
    await writeFile(join(clone, 'huge.bin'), Buffer.alloc(64 * 1024, 7));

    const out = await commitForeignWorkspace(wsFor(clone), identity, {
      runGit,
      maxBlobBytes: 16 * 1024,
    });
    expect(out.status).toBe('committed');
    expect(out.oversized.map((o) => o.path)).toEqual(['huge.bin']);
    const committed = await git(clone, 'show', '--name-only', '--format=', 'HEAD');
    expect(committed).toContain('small.txt');
    expect(committed).not.toContain('huge.bin');
  });

  it('oversized-only dirty tree commits nothing but still reports (EI-18 posture)', async () => {
    const clone = join(base, 'clone');
    await mkdir(clone);
    await initRepo(clone);
    await writeFile(join(clone, 'huge.bin'), Buffer.alloc(64 * 1024, 7));
    const before = await git(clone, 'rev-parse', 'HEAD');

    const out = await commitForeignWorkspace(wsFor(clone), identity, {
      runGit,
      maxBlobBytes: 16 * 1024,
    });
    expect(out.status).toBe('nothing');
    expect(out.oversized.map((o) => o.path)).toEqual(['huge.bin']);
    expect(await git(clone, 'rev-parse', 'HEAD')).toBe(before);
  });
});

describe('runForeignGitSyncTick', () => {
  it('FAIL-CLOSED identity: unresolvable attestation commits NOTHING, parks, emits a loud receipt', async () => {
    const clone = join(base, 'clone');
    await mkdir(clone);
    await initRepo(clone);
    await writeFile(join(clone, 'work.txt'), 'foreign work\n');
    const before = await git(clone, 'rev-parse', 'HEAD');

    const ws = wsFor(clone);
    const setState = vi.fn(async () => ws);
    const emitReceipt = vi.fn(async (_args: unknown) => ({ ok: true }) as never);

    const res = await runForeignGitSyncTick('ws-1', {
      runGit,
      listWorkspaces: async () => [ws],
      resolveIdentity: async () => null, // no attested member
      setState: setState as never,
      emitReceipt,
      hostGithubUserId: 1,
      log: () => {},
    });

    expect(res.workspaces).toHaveLength(1);
    expect(res.workspaces[0].outcome.status).toBe('parked');
    // NOTHING committed — never a host-identity fallback (C7 is absolute).
    expect(await git(clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(setState).toHaveBeenCalledWith(
      'ws-1',
      'offer-abc',
      'parked',
      { parkReason: 'attestation-unresolvable' },
      undefined,
    );
    expect(emitReceipt).toHaveBeenCalledOnce();
    const receipt = emitReceipt.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(receipt.kind).toBe('refusal');
    expect(receipt.offerId).toBe('offer-abc'); // M21 threading
    expect((receipt.refusal as { code: string }).code).toBe('attestation_unresolvable');
  });

  it('one erroring workspace never stalls the others (loud failure separation)', async () => {
    const cloneOk = join(base, 'clone-ok');
    await mkdir(cloneOk);
    await initRepo(cloneOk);
    await writeFile(join(cloneOk, 'work.txt'), 'good\n');
    const wsBroken = wsFor(join(base, 'missing-clone'), { offerId: 'offer-broken' });
    const wsOk = wsFor(cloneOk, { offerId: 'offer-ok' });

    const res = await runForeignGitSyncTick('ws-1', {
      runGit,
      listWorkspaces: async () => [wsBroken, wsOk],
      resolveIdentity: async () => identity,
      setState: vi.fn(async () => wsOk) as never,
      emitReceipt: vi.fn(async () => ({ ok: true }) as never),
      log: () => {},
    });

    expect(res.workspaces.find((w) => w.offerId === 'offer-broken')?.outcome.status).toBe('error');
    expect(res.workspaces.find((w) => w.offerId === 'offer-ok')?.outcome.status).toBe('committed');
  });

  it('DISJOINT SCOPES (mandated §3 regression): the foreign lane never stages outside its clone; the canonical sweep never stages under the foreign root', async () => {
    // Layout: canonical tree and foreign root are SIBLINGS (the Q1 invariant —
    // the foreign root lives outside every host tree).
    const canonical = join(base, 'canonical');
    const foreignRoot = join(base, 'foreign-work');
    const clone = join(foreignRoot, 'gh-777', 'offer-abc', 'repo');
    await mkdir(canonical, { recursive: true });
    await mkdir(clone, { recursive: true });
    await initRepo(canonical);
    await initRepo(clone);

    // Both sides dirty simultaneously.
    await writeFile(join(canonical, 'host-edit.txt'), 'host work\n');
    await writeFile(join(clone, 'foreign-edit.txt'), 'foreign work\n');

    // Foreign lane tick: commits ONLY inside the clone.
    const res = await runForeignGitSyncTick('ws-1', {
      runGit,
      listWorkspaces: async () => [wsFor(clone, { rootPath: foreignRoot })],
      resolveIdentity: async () => identity,
      setState: vi.fn(async () => null) as never,
      emitReceipt: vi.fn(async () => ({ ok: true }) as never),
      log: () => {},
    });
    expect(res.workspaces[0].outcome.status).toBe('committed');

    // The foreign commit contains ONLY clone-internal paths…
    const foreignFiles = await git(clone, 'show', '--name-only', '--format=', 'HEAD');
    expect(foreignFiles.split('\n').filter(Boolean)).toEqual(['foreign-edit.txt']);
    // …and the canonical tree is COMPLETELY untouched by the foreign tick:
    // still dirty (nothing staged/committed there), same HEAD as its seed.
    const canonicalStatus = await git(canonical, 'status', '--porcelain');
    expect(canonicalStatus).toContain('host-edit.txt');
    expect(canonicalStatus.split('\n').filter(Boolean)).toHaveLength(1);

    // Canonical sweep (the git-sync staging step: add -A inside the canonical
    // tree): stages NOTHING under the foreign root — the foreign edit is
    // structurally unreachable (geometry, not filtering).
    await git(canonical, 'add', '-A');
    const staged = await git(canonical, 'diff', '--cached', '--name-only');
    expect(staged.split('\n').filter(Boolean)).toEqual(['host-edit.txt']);
    for (const p of staged.split('\n')) expect(p).not.toContain('foreign-edit');
  });
});
