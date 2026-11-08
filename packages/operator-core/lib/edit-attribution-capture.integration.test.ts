/** Native edit receipts against real Git; no publication or live-repo mutation. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveEditGeneration, preserveReleasedEditGenerations } from './edit-attribution';
import { captureGitSyncCandidate, SOURCE_CUSTODY_REF_PREFIX, type RunGit } from './harness/git-sync/run-git-sync';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'edit-capture-'));
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
