import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import gitEvidence, { MAX_GIT_EVIDENCE_FILE_BYTES, runJudgeGitEvidence } from './git-evidence';

const cleanup: string[] = [];
const never = new AbortController().signal;

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'judge-git-evidence-'));
  cleanup.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Judge Evidence Test']);
  git(root, ['config', 'user.email', 'judge-evidence@example.invalid']);
  writeFileSync(join(root, 'evidence.txt'), 'pinned contents\n');
  git(root, ['add', 'evidence.txt']);
  git(root, ['commit', '--quiet', '-m', 'first']);
  return root;
}

describe('capability:git-evidence', () => {
  it('is judge-only and its strict schema refuses argv, cwd, and scratchClone', () => {
    const schema = gitEvidence.args as { safeParse(value: unknown): { success: boolean } };
    const sha = 'a'.repeat(40);
    expect(gitEvidence.capability).toBe('capability:git-evidence:read');
    expect(gitEvidence.agentRoles).toEqual(['judge']);
    expect(schema.safeParse({ op: 'isAncestor', ancestorSha: sha, descendantSha: sha }).success).toBe(true);
    expect(schema.safeParse({ op: 'isAncestor', ancestorSha: sha, descendantSha: sha, args: ['status'] }).success).toBe(false);
    expect(schema.safeParse({ args: ['status'] }).success).toBe(false);
    expect(schema.safeParse({ scratchClone: { ref: 'HEAD' } }).success).toBe(false);
    expect(schema.safeParse({ op: 'readFileAtCommit', commitSha: sha, path: '../outside.txt' }).success).toBe(false);
    expect(schema.safeParse({ op: 'readFileAtCommit', commitSha: sha.slice(1), path: 'evidence.txt' }).success).toBe(false);
  });

  it('checks ancestry using full local commit ids and distinguishes a non-ancestor', async () => {
    const root = repository();
    const ancestor = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'evidence.txt'), 'later contents\n');
    git(root, ['commit', '--quiet', '-am', 'second']);
    const descendant = git(root, ['rev-parse', 'HEAD']);

    const contained = await runJudgeGitEvidence(
      { op: 'isAncestor', ancestorSha: ancestor, descendantSha: descendant },
      { repositoryDir: root, signal: never },
    );
    const reverse = await runJudgeGitEvidence(
      { op: 'isAncestor', ancestorSha: descendant, descendantSha: ancestor },
      { repositoryDir: root, signal: never },
    );

    expect(contained).toMatchObject({ ok: true, isAncestor: true });
    expect(reverse).toMatchObject({ ok: true, isAncestor: false });
  });

  it('reads the committed blob rather than working-tree contents', async () => {
    const root = repository();
    const pinned = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'evidence.txt'), 'uncommitted current contents\n');

    const result = await runJudgeGitEvidence(
      { op: 'readFileAtCommit', commitSha: pinned, path: 'evidence.txt' },
      { repositoryDir: root, signal: never },
    );

    expect(result).toMatchObject({ ok: true, op: 'readFileAtCommit', content: 'pinned contents\n' });
  });

  it('bounds pinned-file reads and refuses oversized blobs before returning content', async () => {
    const root = repository();
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(MAX_GIT_EVIDENCE_FILE_BYTES + 1));
    git(root, ['add', 'large.txt']);
    git(root, ['commit', '--quiet', '-m', 'large file']);
    const commitSha = git(root, ['rev-parse', 'HEAD']);

    const result = await runJudgeGitEvidence(
      { op: 'readFileAtCommit', commitSha, path: 'large.txt' },
      { repositoryDir: root, signal: never },
    );

    expect(result).toMatchObject({ ok: false, reason: 'file_too_large' });
    expect('content' in result).toBe(false);
  });
});
