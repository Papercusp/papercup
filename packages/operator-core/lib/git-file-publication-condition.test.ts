import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRuntimeBlockerBinding, readRuntimeBlockerCondition } from './runtime-blocker-condition';
import { blockerBoundaryContext, createBlockerEvidenceReader } from './blocker-resolution-evidence';
import { validateBlockerDecisionEvidence, type BlockerDecisionInput } from './blocker-resolution-decision';
import type { ExternalBlockerRecord } from './external-blockers';

const registry = vi.hoisted(() => ({ root: vi.fn() }));
vi.mock('./harness/docs/harness-repo', () => ({ resolveHarnessRepoRoot: registry.root }));
vi.mock('./workspace-registry', () => ({ resolveConcreteWorkspaceId: (workspace: string) => workspace }));

const filePath = 'deps/lib/src/value.ts';
let root: string, repository: string, sourceCommit: string, expectedBlob: string, parentCommit: string, oldParent: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(cwd: string, author = 'papercusp-git-sync') {
  git(cwd, '-c', `user.name=${author}`, '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  return git(cwd, 'rev-parse', 'HEAD');
}
const binding = () => ({ schemaVersion: 1 as const, kind: 'git-file-publication' as const, filePath,
  repositoryPath: 'deps/lib', sourceCommit, expectedBlob, parentCommit,
  reason: 'Bind the committed original file and containing parent', reasonRef: 'EI-source#publication-proof' });
const blocker = (): ExternalBlockerRecord => ({ kind: 'runtime', capability: 'live-dependency', capabilitySource: 'explicit',
  ref: `git-sync:file-acceptance:${filePath}`, summary: 'File acceptance and parent commit', status: 'active',
  createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', createdBy: 'su-fixture' });
function prepare(input = binding()) {
  return prepareRuntimeBlockerBinding({ state: 'blocked', assignee: 'su-fixture',
    payload: { externalBlockers: [blocker()] } }, blocker().ref, input, 'su-fixture');
}
function bound(input = binding()) {
  const result = prepare(input);
  if (!result.ok) throw new Error(result.error);
  return result.blockers[0];
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'publication-condition-'));
  registry.root.mockReset().mockImplementation(async (harness: string) => harness === 'publication-fixture' ? root : null);
  git(root, 'init', '-q');
  writeFileSync(join(root, 'root.txt'), 'root');
  git(root, 'add', 'root.txt'); oldParent = commit(root);
  repository = join(root, 'deps/lib'); mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, 'init', '-q');
  writeFileSync(join(repository, 'src/value.ts'), 'export const value = "accepted";\n');
  git(repository, 'add', 'src/value.ts'); sourceCommit = commit(repository);
  expectedBlob = git(repository, 'rev-parse', `${sourceCommit}:src/value.ts`);
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${sourceCommit},deps/lib`);
  parentCommit = commit(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('legacy file-publication condition over real Git objects', () => {
  it('resolves the original alias through the canonical evidence reader, without an event or runtime restart', async () => {
    expect(await readRuntimeBlockerCondition(blocker(), root)).toMatchObject({ status: 'unknown' });
    const current = bound();
    expect(current).toMatchObject({ ref: blocker().ref, status: 'active',
      runtimeConditionBinding: { ...binding(), boundBy: 'su-fixture' } });
    const ref = { kind: 'runtime' as const, ref: current.ref };
    const decision: BlockerDecisionInput = { schemaVersion: 1, idempotencyKey: 'published-source', disposition: 'self_resolve',
      symptom: 'Legacy publication alias could not be measured', evidenceRefs: [ref], attempts: [],
      investigation: [{ action: 'Measure committed source and parent pin', outcome: 'Exact accepted blob is present', evidenceRefs: [ref] }],
      verification: { outcome: 'Original file-acceptance condition is satisfied', evidenceRefs: [ref] } };
    const context = await blockerBoundaryContext({ workspaceId: 'default', role: 'operator' },
      'su-fixture', 'publication-fixture');
    const readEvidence = createBlockerEvidenceReader({ ...context, workItemId: 'EI-source', blockers: [current] });
    expect(await validateBlockerDecisionEvidence(decision, { ownerId: 'su-fixture', workItemId: 'EI-source',
      obligationRefs: [ref], readEvidence })).toEqual({ ok: true });
    expect(registry.root).toHaveBeenCalledWith('publication-fixture');
  });
  it('keeps an unavailable registered root unknown instead of substituting the process directory', async () => {
    const context = await blockerBoundaryContext({ workspaceId: 'default', role: 'operator' },
      'su-fixture', 'unregistered-fixture');
    const readEvidence = createBlockerEvidenceReader({ ...context, workItemId: 'EI-source', blockers: [bound()] });
    expect(await readEvidence({ kind: 'runtime', ref: blocker().ref })).toMatchObject({ status: 'unknown' });
    registry.root.mockRejectedValueOnce(new Error('registry unavailable'));
    expect(await readEvidence({ kind: 'runtime', ref: blocker().ref })).toMatchObject({ status: 'unknown' });
  });
  it('does not accept an old parent, a mismatched blob, or dirty working content', async () => {
    expect(await readRuntimeBlockerCondition(bound({ ...binding(), parentCommit: oldParent }), root))
      .toMatchObject({ status: 'available', condition: 'pending' });
    expect(await readRuntimeBlockerCondition(bound({ ...binding(), expectedBlob: 'f'.repeat(40) }), root))
      .toMatchObject({ status: 'available', condition: 'pending' });
    writeFileSync(join(repository, 'src/value.ts'), 'different content');
    expect(await readRuntimeBlockerCondition(bound(), root)).toMatchObject({ status: 'available', condition: 'pending' });
  });
  it('rejects a parent pin whose descendant changed the accepted file', async () => {
    writeFileSync(join(repository, 'src/value.ts'), 'changed after acceptance');
    git(repository, 'add', 'src/value.ts'); const newer = commit(repository);
    git(root, 'update-index', '--cacheinfo', `160000,${newer},deps/lib`); parentCommit = commit(root);
    expect(await readRuntimeBlockerCondition(bound(), root)).toMatchObject({ status: 'available', condition: 'pending' });
  });
  it('requires sync acceptance rather than an arbitrary manually authored commit', async () => {
    sourceCommit = commit(repository, 'manual-author');
    git(root, 'update-index', '--cacheinfo', `160000,${sourceCommit},deps/lib`); parentCommit = commit(root);
    expect(await readRuntimeBlockerCondition(bound(), root)).toMatchObject({ status: 'available', condition: 'pending' });
  });
  it('does not accept an unselected parent commit even when its tree contains the right blob', async () => {
    parentCommit = git(root, '-c', 'user.name=papercusp-git-sync', '-c', 'user.email=fixture@example.invalid',
      'commit-tree', git(root, 'rev-parse', 'HEAD^{tree}'), '-p', oldParent, '-m', 'unpublished proof');
    expect(await readRuntimeBlockerCondition(bound(), root)).toMatchObject({ status: 'available', condition: 'pending' });
  });
  it('keeps missing objects, missing canonical roots, and symlink substitutions unknown', async () => {
    expect(await readRuntimeBlockerCondition(bound({ ...binding(), parentCommit: '0'.repeat(40) }), root))
      .toMatchObject({ status: 'unknown' });
    expect(await readRuntimeBlockerCondition(bound())).toMatchObject({ status: 'unknown' });
    rmSync(join(repository, 'src/value.ts')); symlinkSync(join(root, 'root.txt'), join(repository, 'src/value.ts'));
    expect(await readRuntimeBlockerCondition(bound(), root)).toMatchObject({ status: 'unknown' });
  });
  it('cannot bind unrelated aliases, foreign custody, path traversal, or forged provenance', () => {
    const item = { state: 'blocked', assignee: 'su-fixture', payload: { externalBlockers: [blocker()] } };
    expect(prepareRuntimeBlockerBinding(item, 'other-alias', binding(), 'su-fixture')).toMatchObject({ ok: false });
    expect(prepareRuntimeBlockerBinding(item, blocker().ref, binding(), 'other-owner')).toMatchObject({ ok: false });
    expect(prepareRuntimeBlockerBinding(item, blocker().ref, { ...binding(), filePath: '../escape' }, 'su-fixture')).toMatchObject({ ok: false });
    expect(prepareRuntimeBlockerBinding(item, blocker().ref, { ...binding(), boundBy: 'forged' }, 'su-fixture')).toMatchObject({ ok: false });
  });
  it('also verifies a file committed directly in the canonical parent repository', async () => {
    git(root, 'add', 'root.txt'); sourceCommit = parentCommit = commit(root);
    expectedBlob = git(root, 'rev-parse', 'HEAD:root.txt');
    const ref = 'git-sync:file-acceptance:root.txt';
    const result = prepareRuntimeBlockerBinding({ state: 'blocked', assignee: 'su-fixture', payload: {
      externalBlockers: [{ ...blocker(), ref }] } }, ref,
    { ...binding(), filePath: 'root.txt', repositoryPath: undefined }, 'su-fixture');
    expect(result.ok).toBe(true);
    if (result.ok) expect(await readRuntimeBlockerCondition(result.blockers[0], root))
      .toMatchObject({ status: 'available', condition: 'satisfied' });
  });
});
