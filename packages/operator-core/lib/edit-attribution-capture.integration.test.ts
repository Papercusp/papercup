/** Native edit receipts against real Git; no publication or live-repo mutation. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveEditGeneration, preserveReleasedEditGenerations, type RecordEditAttributionInput } from './edit-attribution';
import { captureGitSyncCandidate, SOURCE_CUSTODY_REF_PREFIX, type RunGit } from './harness/git-sync/run-git-sync';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function fixture(parent?: string) {
  const repo = parent ? join(parent, 'child') : mkdtempSync(join(tmpdir(), 'edit-capture-'));
  mkdirSync(repo, { recursive: true });
  roots.push(repo);
  function git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
    return result.stdout.trim();
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'base a\n');
  writeFileSync(join(repo, 'b.txt'), 'base b\n');
  git('add', '-A');
  git('commit', '-m', 'base');
  const runGit: RunGit = async (args, cwd, options) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ...options?.env } });
    return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
  const input = { repoRoot: repo, files: ['a.txt', 'b.txt'], agentId: 'A',
    dispatchCallId: 'stable-native-operation', operationState: 'granted' as const };
  const state = () => ({ index: readFileSync(join(repo, '.git/index')).toString('base64'),
    a: readFileSync(join(repo, 'a.txt')).toString('base64'), b: readFileSync(join(repo, 'b.txt')).toString('base64'),
    head: git('rev-parse', 'HEAD') });
  return { repo, git, runGit, input, state };
}

describe('preserveEditGeneration', () => {
  it('fences nested repository aliases before capture, retains lease provenance and replays immutable child bytes', async () => {
    const parent = fixture();
    const child = fixture(parent.repo);
    vi.stubEnv('PAPERCUSP_CANONICAL_TREE', parent.repo);
    parent.git('add', 'child');
    parent.git('commit', '-m', 'nested repository');
    writeFileSync(join(parent.repo, 'a.txt'), 'parent A1\n');
    writeFileSync(join(child.repo, 'a.txt'), 'child A1\n');
    const before = { parent: parent.state(), child: child.state() };
    const rows = ['a.txt', 'child/a.txt'].map(path => ({ path, lock_id: 'original-parent-lease',
      goal_ref: 'WI-original', intent: 'original edit', acquired_ts: new Date('2026-06-01T12:00:00Z'),
      acquired_identity: '1780315200.000001' }));
    const protectRepositoryPaths = vi.fn(async () => {});
    const preserve = vi.fn((input: Parameters<typeof preserveEditGeneration>[0]) => {
      expect(protectRepositoryPaths).toHaveBeenCalledWith(child.repo, ['a.txt']);
      return preserveEditGeneration(input, parent.runGit, async () => []);
    });
    const attribute = vi.fn(async (_input: RecordEditAttributionInput) => {});
    const input = { repoRoot: parent.repo, rows, agentId: 'original-owner', protectRepositoryPaths };
    await preserveReleasedEditGenerations(input, { preserve, attribute });
    const original = attribute.mock.calls.map(([edit]) => edit);
    expect(original).toHaveLength(2);
    for (const edit of original) {
      expect(edit).toMatchObject({ files: ['a.txt'], agentId: 'original-owner', goalRef: 'WI-original', intent: 'original edit',
        captureReceipt: { releaseSource: { coordinationDomain: parent.repo, leases: [
          { path: 'a.txt', lockId: 'original-parent-lease', acquiredAt: '1780315200.000001' },
          { path: 'child/a.txt', lockId: 'original-parent-lease', acquiredAt: '1780315200.000001' },
        ] } } });
    }
    expect({ parent: parent.state(), child: child.state() }).toEqual(before);
    writeFileSync(join(child.repo, 'a.txt'), 'successor B1\n');
    attribute.mockClear();
    await preserveReleasedEditGenerations({ ...input, rows: [...rows].reverse() }, { preserve, attribute });
    expect(attribute.mock.calls.map(([edit]) => edit)).toEqual(original);
    const childCapture = original.find(edit => edit.repoRoot === child.repo)!.captureReceipt!.capture as { ref: string };
    expect(child.git('show', `${childCapture.ref}:payload/a.txt`)).toBe('child A1');
    expect(readFileSync(join(child.repo, 'a.txt'), 'utf8')).toBe('successor B1\n');
  });

  it('refuses nested alias capture without a transaction fence or when the canonical child is held', async () => {
    const parent = fixture();
    const child = fixture(parent.repo);
    vi.stubEnv('PAPERCUSP_CANONICAL_TREE', parent.repo);
    const rows = [{ path: 'child/a.txt', lock_id: 'parent-lease', goal_ref: null,
      intent: 'original edit', acquired_ts: new Date('2026-06-01T12:00:00Z') }];
    const preserve = vi.fn();
    const attribute = vi.fn();
    const input = { repoRoot: parent.repo, rows, agentId: 'A' };
    await expect(preserveReleasedEditGenerations(input, { preserve, attribute }))
      .rejects.toThrow('alias-protection-required');
    const protectRepositoryPaths = vi.fn(async () => { throw new Error('edit-capture-refused:canonical-path-held'); });
    await expect(preserveReleasedEditGenerations({ ...input, protectRepositoryPaths }, { preserve, attribute }))
      .rejects.toThrow('canonical-path-held');
    expect(protectRepositoryPaths).toHaveBeenCalledWith(child.repo, ['a.txt']);
    expect(preserve).not.toHaveBeenCalled();
    expect(attribute).not.toHaveBeenCalled();
  });

  it('refuses re-rooting acknowledged parent custody after a nested repository appears', async () => {
    const parent = fixture();
    vi.stubEnv('PAPERCUSP_CANONICAL_TREE', parent.repo);
    mkdirSync(join(parent.repo, 'child'));
    writeFileSync(join(parent.repo, 'child/a.txt'), 'acknowledged parent A1\n');
    const rows = [{ path: 'child/a.txt', lock_id: 'original-lease', goal_ref: null,
      intent: 'original edit', acquired_ts: new Date('2026-06-01T12:00:00Z') }];
    const preserve = vi.fn((input: Parameters<typeof preserveEditGeneration>[0]) =>
      preserveEditGeneration(input, parent.runGit, async () => []));
    const attribute = vi.fn(async () => {});
    const input = { repoRoot: parent.repo, rows, agentId: 'A' };
    await preserveReleasedEditGenerations(input, { preserve, attribute });
    const child = fixture(parent.repo);
    writeFileSync(join(child.repo, 'a.txt'), 'successor B1\n');
    const before = child.state();
    preserve.mockClear();
    attribute.mockClear();
    await expect(preserveReleasedEditGenerations({ ...input, protectRepositoryPaths: async () => {} }, { preserve, attribute }))
      .rejects.toThrow('acknowledged-alias-remap');
    expect(preserve).not.toHaveBeenCalled();
    expect(attribute).not.toHaveBeenCalled();
    expect(child.state()).toEqual(before);
  });

  it('correlates a staging refusal without exposing Git output or changing shared bytes', async () => {
    const f = fixture();
    const protectedText = 'protected source contents must stay out of diagnostics';
    writeFileSync(join(f.repo, 'a.txt'), protectedText);
    const before = f.state();
    const git = vi.fn<RunGit>(async (args, cwd, options) => args[0] === 'add'
      ? { code: 1, stdout: protectedText, stderr: protectedText }
      : f.runGit(args, cwd, options));

    await expect(preserveEditGeneration(f.input, git, async () => []))
      .rejects.toThrow(/^source-custody-refused:candidate-stage$/);

    const stage = git.mock.calls.find(([args]) => args[0] === 'add');
    expect(stage).toBeDefined();
    expect(stage![2]?.env?.GIT_INDEX_FILE).toBeDefined();
    expect(stage![2]?.env?.GIT_INDEX_FILE).not.toBe(join(f.repo, '.git/index'));
    for (const [, , options] of git.mock.calls) {
      expect(options?.diagnosticTags).toEqual({
        runId: f.input.dispatchCallId, commandClass: 'git',
      });
    }
    expect(f.state()).toEqual(before);
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
  });

  it('labels an external native edit as unpreserved without invoking Git or manufacturing custody', async () => {
    const f = fixture();
    const git = vi.fn(f.runGit);
    const input = { ...f.input, files: ['@external/runtime/settings.json'] };
    const receipt = await preserveEditGeneration(input, git);
    expect(receipt).toMatchObject({ kind: 'unpreserved-edit', pending: false, reason: 'external-path' });
    expect(receipt).not.toHaveProperty('capture');
    expect(await preserveEditGeneration({ ...input, operationState: 'completed', captureReceipt: receipt }, git))
      .toEqual(receipt);
    expect(git).not.toHaveBeenCalled();
  });

  it('reconciles explicit release after attribution failure without capturing successor bytes', async () => {
    const f = fixture();
    const rows = f.input.files.map(path => ({ path, lock_id: 'lease-a', goal_ref: 'WI-A',
      intent: 'edit WI-A', acquired_ts: new Date('2026-06-01T12:00:00Z') }));
    const attribute = vi.fn().mockRejectedValueOnce(new Error('ledger unavailable')).mockResolvedValue(undefined);
    const preserve = (input: Parameters<typeof preserveEditGeneration>[0]) => preserveEditGeneration(input, f.runGit, async () => []);
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const release = { repoRoot: f.repo, rows, agentId: 'A', workspaceId: 'ws' };
    await expect(preserveReleasedEditGenerations(release, { preserve, attribute })).rejects.toThrow('ledger unavailable');
    const original = attribute.mock.calls[0][0];
    writeFileSync(join(f.repo, 'a.txt'), 'B1\n');
    const before = f.state();
    await preserveReleasedEditGenerations({ ...release, rows: [...rows].reverse() }, { preserve, attribute });
    expect(attribute.mock.calls[1][0]).toEqual(original);
    expect(f.git('show', `${original.captureReceipt.capture.ref}:payload/a.txt`)).toBe('A1');
    expect(f.state()).toEqual(before);
    await preserveReleasedEditGenerations({ ...release, rows: rows.map(row => ({ ...row,
      acquired_identity: '2026-06-01 12:00:00.000001+00' })) }, { preserve, attribute });
    const next = attribute.mock.calls[2][0];
    expect(next.dispatchCallId).not.toBe(original.dispatchCallId);
    expect(f.git('show', `${next.captureReceipt.capture.ref}:payload/a.txt`)).toBe('B1');
  });

  it('keeps home/runtime keys outside Git custody and preserves nullable work-item capture', async () => {
    const f = fixture();
    const preserve = vi.fn((input: Parameters<typeof preserveEditGeneration>[0]) => preserveEditGeneration(input, f.runGit));
    const attribute = vi.fn(async () => {});
    const row = { path: '@external/home/settings.json', lock_id: 'lease', goal_ref: null,
      intent: 'edit', acquired_ts: new Date() };
    await preserveReleasedEditGenerations({ repoRoot: f.repo, rows: [row], agentId: 'A' }, { preserve, attribute });
    expect(preserve).not.toHaveBeenCalled();
    await preserveReleasedEditGenerations({ repoRoot: f.repo, rows: [{ ...row, path: 'a.txt' }], agentId: 'A' }, { preserve, attribute });
    expect(preserve).toHaveBeenCalledWith(expect.objectContaining({ goalRef: undefined, files: ['a.txt'] }));
    expect(attribute).toHaveBeenCalledWith(expect.objectContaining({
      captureReceipt: expect.objectContaining({ goalRef: null, pending: true }),
    }));
  });

  it.each(['unused', 'edited', 'deleted'] as const)(
    'releases an unused new-path reservation alongside %s source without changing the shared index', async state => {
      const f = fixture();
      const files = state === 'unused' ? ['never-created.ts']
        : [state === 'edited' ? 'a.txt' : 'b.txt', 'never-created.ts'];
      if (state === 'edited') writeFileSync(join(f.repo, 'a.txt'), 'edited source\n');
      if (state === 'deleted') f.git('rm', '--', 'b.txt');
      const before = {
        index: readFileSync(join(f.repo, '.git/index')),
        head: f.git('rev-parse', 'HEAD'),
        status: f.git('status', '--porcelain=v1', '--untracked-files=all'),
        source: readFileSync(join(f.repo, 'a.txt')),
      };
      const preserve = vi.fn((input: Parameters<typeof preserveEditGeneration>[0]) =>
        preserveEditGeneration(input, f.runGit, async () => []));
      const attribute = vi.fn(async (_input: RecordEditAttributionInput) => {});
      const rows = files.map(path => ({ path, lock_id: 'reserved-path-lease', goal_ref: 'WI-A',
        intent: 'edit source and reserve a new path', acquired_ts: new Date('2026-06-01T12:00:00Z') }));

      expect(await preserveReleasedEditGenerations({ repoRoot: f.repo, rows, agentId: 'A' },
        { preserve, attribute })).toBe(true);

      expect(preserve).toHaveBeenCalledTimes(1);
      expect(attribute).toHaveBeenCalledTimes(1);
      const edit = attribute.mock.calls[0]![0];
      expect(edit.files).toEqual([...files].sort());
      const capture = edit.captureReceipt!.capture as { ref: string; candidate: { tree: string; baseTree: string; paths: string[] } };
      expect(capture.candidate.paths).toEqual([...files].sort());
      expect(f.git('ls-tree', capture.candidate.tree, '--', 'never-created.ts')).toBe('');
      if (state === 'unused') expect(capture.candidate.tree).toBe(capture.candidate.baseTree);
      if (state === 'edited') expect(f.git('show', `${capture.ref}:payload/a.txt`)).toBe('edited source');
      if (state === 'deleted') expect(f.git('ls-tree', capture.candidate.tree, '--', 'b.txt')).toBe('');
      expect(readFileSync(join(f.repo, '.git/index'))).toEqual(before.index);
      expect(f.git('rev-parse', 'HEAD')).toBe(before.head);
      expect(f.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(before.status);
      expect(readFileSync(join(f.repo, 'a.txt'))).toEqual(before.source);
    },
  );

  it('preserves a multi-file edit without requiring a work item or changing the shared index', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    writeFileSync(join(f.repo, 'b.txt'), Buffer.from([0, 255, 128, 1]));
    const before = f.state();
    const receipt = await preserveEditGeneration(f.input, f.runGit);
    expect(receipt).toMatchObject({ pending: true, goalRef: null, workspaceId: null,
      capture: { ok: true, candidate: { paths: ['a.txt', 'b.txt'], requestId: f.input.dispatchCallId } } });
    const capture = receipt.capture as { ref: string };
    expect(f.git('show', `${capture.ref}:payload/a.txt`)).toBe('A1');
    const binary = spawnSync('git', ['show', `${capture.ref}:payload/b.txt`], { cwd: f.repo });
    expect(binary.status).toBe(0);
    expect(binary.stdout).toEqual(Buffer.from([0, 255, 128, 1]));
    expect(f.state()).toEqual(before);
  });

  it('replays A1 after successor B1 and moving HEAD while retaining settled status', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const receipt = await preserveEditGeneration(f.input, f.runGit);
    writeFileSync(join(f.repo, 'a.txt'), 'B1 staged\n');
    f.git('add', '--', 'a.txt');
    writeFileSync(join(f.repo, 'a.txt'), 'B2 working\n');
    const later = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-p', f.git('rev-parse', 'HEAD'), '-m', 'advance');
    f.git('update-ref', 'HEAD', later);
    const before = f.state();
    const settled = { ...receipt, pending: false };
    expect(await preserveEditGeneration({ ...f.input, operationState: 'completed', captureReceipt: settled }, f.runGit))
      .toEqual(settled);
    expect(f.state()).toEqual(before);
    expect(f.git('show', `${(receipt.capture as { ref: string }).ref}:payload/a.txt`)).toBe('A1');
  });

  it('adopts a pinned orphan using its original base after DB receipt loss', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'orphan A1\n');
    const captured = await captureGitSyncCandidate(f.runGit, f.repo, {
      requestId: f.input.dispatchCallId, generation: 1, paths: f.input.files, base: f.git('rev-parse', 'HEAD'),
    });
    if (!captured.ok) throw new Error(captured.error);
    const next = f.git('commit-tree', captured.candidate.baseTree, '-p', captured.candidate.base!, '-m', 'advance');
    f.git('update-ref', 'HEAD', next);
    writeFileSync(join(f.repo, 'a.txt'), 'later B1\n');
    const before = f.state();
    const receipt = await preserveEditGeneration(f.input, f.runGit);
    expect(receipt.capture).toEqual(captured);
    expect(f.state()).toEqual(before);
  });

  it('refuses missing acknowledged custody instead of recreating it from B1', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const receipt = await preserveEditGeneration(f.input, f.runGit);
    f.git('update-ref', '-d', (receipt.capture as { ref: string }).ref);
    writeFileSync(join(f.repo, 'a.txt'), 'B1\n');
    const before = f.state();
    await expect(preserveEditGeneration({ ...f.input, operationState: 'completed', captureReceipt: receipt }, f.runGit))
      .rejects.toThrow('candidate-not-captured');
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
    expect(f.state()).toEqual(before);
  });

  it.each(['pending', 'cancelled', 'completed'] as const)('refuses first capture in %s state', async operationState => {
    const f = fixture();
    const before = f.state();
    await expect(preserveEditGeneration({ ...f.input, operationState }, f.runGit))
      .rejects.toThrow('operation-no-longer-protects-version');
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
    expect(f.state()).toEqual(before);
  });

  it('refuses changed ownership metadata under the same receipt identity', async () => {
    const f = fixture();
    const receipt = await preserveEditGeneration(f.input, f.runGit);
    const before = f.state();
    await expect(preserveEditGeneration({ ...f.input, agentId: 'B', captureReceipt: receipt }, f.runGit))
      .rejects.toThrow('receipt-identity-mismatch');
    expect(f.state()).toEqual(before);
  });

  it('pins predecessor identity before release and retains it after orphan/restart recovery', async () => {
    const f = fixture();
    const dependencies = [{ requestId: 'earlier-A1', generation: 1, paths: ['a.txt'], tree: 'a'.repeat(40) }];
    const read = vi.fn(async () => dependencies);
    const input = { ...f.input, workspaceId: 'ws' };
    writeFileSync(join(f.repo, 'a.txt'), 'B1\n');
    const receipt = await preserveEditGeneration(input, f.runGit, read);
    expect(receipt).toMatchObject({ capture: { candidate: { dependencies } } });
    writeFileSync(join(f.repo, 'a.txt'), 'C1\n');
    read.mockResolvedValue([]);
    const before = f.state();
    expect(await preserveEditGeneration(input, f.runGit, read)).toEqual(receipt);
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.state()).toEqual(before);
  });
});
