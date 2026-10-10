import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from '@papercusp/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessRegistry } from '../../harness-registry';
import { runGit } from './git';
import gitEvidence, {
  MAX_GIT_EVIDENCE_INLINE_BYTES,
  MAX_GIT_EVIDENCE_PAGE_BYTES,
  runJudgeGitEvidence,
} from './git-evidence';

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
    expect(schema.safeParse({ op: 'readFileAtCommit', commitSha: sha, path: 'evidence.txt', byte_offset: 0 }).success).toBe(false);
    expect(schema.safeParse({ op: 'readFileAtCommit', commitSha: sha, path: 'evidence.txt', byte_limit: MAX_GIT_EVIDENCE_PAGE_BYTES }).success).toBe(false);
    expect(schema.safeParse({ op: 'readFileAtCommit', commitSha: sha, path: 'evidence.txt', byte_offset: 0, byte_limit: MAX_GIT_EVIDENCE_PAGE_BYTES }).success).toBe(true);
    expect(schema.safeParse({ op: 'readFileAtCommit', commitSha: sha, path: 'evidence.txt', rootHarnessSlug: 'portal' }).success).toBe(true);
    expect(schema.safeParse({ op: 'readFileAtCommit', commitSha: sha, path: 'evidence.txt', cwd: '/external' }).success).toBe(false);
    expect(schema.safeParse({ op: 'readFileAtCommit', commitSha: sha, path: 'evidence.txt', rootHarnessSlug: ' ' }).success).toBe(false);
    expect(schema.safeParse({ op: 'isAncestor', ancestorSha: sha, descendantSha: sha, rootHarnessSlug: 'portal' }).success).toBe(false);
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

  it('keeps interrupted or ambiguous repository probes out of the not-repository verdict', async () => {
    const args = {
      op: 'readFileAtCommit' as const,
      commitSha: 'a'.repeat(40),
      path: 'evidence.txt',
    };
    const aborted = new AbortController();
    const interrupted = await runJudgeGitEvidence(args, {
      repositoryDir: '/repo',
      signal: aborted.signal,
      runner: async () => {
        aborted.abort();
        return { code: null, output: '' };
      },
    });
    const ambiguous = await runJudgeGitEvidence(args, {
      repositoryDir: '/repo',
      signal: never,
      runner: async () => ({ code: 128, output: '' }),
    });
    const confirmedNotRepository = await runJudgeGitEvidence(args, {
      repositoryDir: '/not-a-repository',
      signal: never,
      runner: async () => ({ code: 128, output: 'fatal: not a git repository (or any of the parent directories): .git' }),
    });

    expect(interrupted).toMatchObject({ ok: false, reason: 'git_command_interrupted' });
    expect(ambiguous).toMatchObject({ ok: false, reason: 'repository_probe_failed' });
    expect(confirmedNotRepository).toMatchObject({ ok: false, reason: 'not_git_repository' });
  });

  it('distinguishes cancellation during pinned reads from a genuine Git failure', async () => {
    const commitSha = 'a'.repeat(40);
    const args = {
      op: 'readFileAtCommit' as const,
      commitSha,
      path: 'large.txt',
      rootHarnessSlug: 'portal',
    };
    const stages = ['commit', 'type', 'size', 'blob', 'size-failure'] as const;

    for (const stage of stages) {
      const controller = new AbortController();
      const calls: string[][] = [];
      const runner = async (argv: string[]) => {
        calls.push(argv);
        const interrupted =
          stage === 'commit'
            ? argv[0] === 'rev-parse' && argv[1] === '--verify'
            : stage === 'type'
              ? argv[0] === 'cat-file' && argv[1] === '-t'
              : stage === 'size'
                ? argv[0] === 'cat-file' && argv[1] === '-s'
                : stage === 'blob'
                  ? argv[0] === 'cat-file' && argv[1] === 'blob'
                  : false;
        if (interrupted) {
          controller.abort();
          return { code: null, output: '' };
        }
        if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') {
          return { code: 0, output: '/registered/portal\n' };
        }
        if (argv[0] === 'rev-parse' && argv[1] === '--verify') return { code: 0, output: `${commitSha}\n` };
        if (argv[0] === 'cat-file' && argv[1] === '-t') return { code: 0, output: 'blob\n' };
        if (argv[0] === 'cat-file' && argv[1] === '-s') {
          return stage === 'size-failure'
            ? { code: 128, output: 'fatal: simulated size probe failure' }
            : { code: 0, output: '100\n' };
        }
        if (argv[0] === 'cat-file' && argv[1] === 'blob') return { code: 0, output: 'x'.repeat(100) };
        throw new Error(`Unexpected Git invocation: ${argv.join(' ')}`);
      };

      const result = await runJudgeGitEvidence(args, {
        repositoryDir: '/active',
        workspaceId: 'test-workspace',
        loadRegistry: async () => ({ projects: [{ slug: 'portal', path: '/registered/portal' }] }) as HarnessRegistry,
        signal: controller.signal,
        runner,
      });

      expect(result).toMatchObject(
        stage === 'size-failure'
          ? { ok: false, reason: 'file_size_unavailable', message: 'fatal: simulated size probe failure' }
          : { ok: false, reason: 'git_command_interrupted' },
      );
      expect(calls[calls.length - 1]).toEqual(
        expect.arrayContaining(
          stage === 'commit'
            ? ['rev-parse', '--verify']
            : stage === 'type'
              ? ['cat-file', '-t']
              : stage === 'size' || stage === 'size-failure'
                ? ['cat-file', '-s']
                : ['cat-file', 'blob'],
        ),
      );
    }
  });

  it('reads external evidence from the registered workspace repository without substituting HEAD', async () => {
    const activeRoot = repository();
    const externalRoot = repository();
    writeFileSync(join(externalRoot, 'evidence.txt'), 'external pinned contents\n');
    git(externalRoot, ['commit', '--quiet', '-am', 'external evidence']);
    const commitSha = git(externalRoot, ['rev-parse', 'HEAD']);
    writeFileSync(join(externalRoot, 'evidence.txt'), 'mutable external contents\n');
    const loadRegistry = vi.fn(async () => ({ projects: [
      { slug: 'portal', path: externalRoot },
    ] } as HarnessRegistry));
    const args = { op: 'readFileAtCommit' as const, commitSha, path: 'evidence.txt' };

    expect(await runJudgeGitEvidence(args, { repositoryDir: activeRoot, signal: never }))
      .toMatchObject({ ok: false, reason: 'commit_not_found_or_not_pinned' });
    const result = await runJudgeGitEvidence({ ...args, rootHarnessSlug: 'portal' }, {
      repositoryDir: activeRoot, workspaceId: 'test-workspace', loadRegistry, signal: never,
    });

    expect(loadRegistry).toHaveBeenCalledWith('test-workspace');
    expect(result).toMatchObject({ ok: true, commitSha, content: 'external pinned contents\n' });
  });

  it('refuses missing workspace or unregistered external roots before running Git', async () => {
    const args = { op: 'readFileAtCommit' as const, commitSha: 'a'.repeat(40), path: 'evidence.txt', rootHarnessSlug: 'portal' };
    const loadRegistry = vi.fn(async () => ({ projects: [] } as HarnessRegistry));
    const runner = vi.fn();
    for (const workspaceId of [undefined, '*']) {
      expect(await runJudgeGitEvidence(args, { repositoryDir: '/active', workspaceId, loadRegistry, runner, signal: never }))
        .toMatchObject({ ok: false, reason: 'root_harness_requires_concrete_workspace' });
    }
    expect(loadRegistry).not.toHaveBeenCalled();
    expect(await runJudgeGitEvidence(args, { repositoryDir: '/active', workspaceId: 'test-workspace', loadRegistry, runner, signal: never }))
      .toMatchObject({ ok: false, reason: 'root_harness_not_registered' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('preserves the registered root when following exact byte page cursors', async () => {
    const activeRoot = repository();
    const externalRoot = repository();
    writeFileSync(join(externalRoot, 'evidence.txt'), 'external contents with two pages\n');
    git(externalRoot, ['commit', '--quiet', '-am', 'paged external evidence']);
    const commitSha = git(externalRoot, ['rev-parse', 'HEAD']);
    const options = { repositoryDir: activeRoot, workspaceId: 'test-workspace', signal: never,
      loadRegistry: async () => ({ projects: [{ slug: 'portal', path: externalRoot }] } as HarnessRegistry) };
    const first = await runJudgeGitEvidence({ op: 'readFileAtCommit', commitSha, path: 'evidence.txt', rootHarnessSlug: 'portal', byte_offset: 0, byte_limit: 12 }, options);
    if (!first.ok || first.op !== 'readFileAtCommit' || !('next_cursor' in first) || !first.next_cursor) throw new Error('Expected external byte cursor');
    expect(first.next_cursor.args.rootHarnessSlug).toBe('portal');
    const second = await runJudgeGitEvidence(first.next_cursor.args, options);
    expect(second).toMatchObject({ ok: true, byte_offset: 12 });
    if (!second.ok || !('data' in second)) throw new Error('Expected second byte page');
    expect(Buffer.from(second.data, 'base64').toString('utf8')).toBe('tents with t');
  });

  it('returns a 94,304-byte pinned historical blob inline in one call', async () => {
    const root = repository();
    const committedContent = 'x'.repeat(94_304);
    const path = 'large-inline-evidence.txt';
    writeFileSync(join(root, path), committedContent);
    git(root, ['add', path]);
    git(root, ['commit', '--quiet', '-m', 'large inline evidence']);
    const commitSha = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(join(root, path), 'uncommitted replacement\n');

    const result = await runJudgeGitEvidence(
      { op: 'readFileAtCommit', commitSha, path },
      { repositoryDir: root, workspaceId: 'test-workspace', signal: never },
    );

    if (!result.ok || result.op !== 'readFileAtCommit' || !('content' in result)) {
      throw new Error(`Expected one inline pinned blob read, got ${JSON.stringify(result)}`);
    }
    expect(result).toMatchObject({ ok: true, commitSha, path, bytes: 94_304 });
    expect(result.content).toBe(committedContent);
  });

  it('pages oversized pinned UTF-8 blobs as exact bounded bytes', async () => {
    const root = repository();
    const largeContent = '€'.repeat(Math.ceil((MAX_GIT_EVIDENCE_INLINE_BYTES + 1) / 3));
    const expectedBytes = Buffer.from(largeContent, 'utf8');
    writeFileSync(join(root, 'large.txt'), largeContent);
    git(root, ['add', 'large.txt']);
    git(root, ['commit', '--quiet', '-m', 'large file']);
    const commitSha = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'large.txt'), 'uncommitted replacement\n');
    const gitCalls: string[][] = [];
    const runner: typeof runGit = async (...args) => {
      gitCalls.push(args[0]);
      return runGit(...args);
    };
    const readOptions = {
      repositoryDir: root,
      workspaceId: 'test-workspace',
      signal: never,
      runner,
      cache: createCache({ maxL1Entries: 16 }),
    };

    let result = await runJudgeGitEvidence(
      { op: 'readFileAtCommit', commitSha, path: 'large.txt' },
      readOptions,
    );
    const pages: Buffer[] = [];
    let totalRead = 0;
    let pageCount = 0;
    while (true) {
      if (!result.ok || result.op !== 'readFileAtCommit' || !('data' in result)) {
        throw new Error(`Expected a pinned byte page, got ${JSON.stringify(result)}`);
      }
      const page = Buffer.from(result.data, 'base64');
      expect(result.byte_offset).toBe(totalRead);
      expect(result.byte_length).toBe(page.length);
      expect(result.byte_length).toBeLessThanOrEqual(MAX_GIT_EVIDENCE_PAGE_BYTES);
      expect(result.total_bytes).toBe(expectedBytes.length);
      expect(result.eof).toBe(result.next_cursor === null);
      pages.push(page);
      totalRead += page.length;
      pageCount += 1;
      if (!result.next_cursor) break;
      result = await runJudgeGitEvidence(result.next_cursor.args, readOptions);
    }

    expect(pageCount).toBeGreaterThan(1);
    expect(totalRead).toBe(expectedBytes.length);
    expect(Buffer.concat(pages)).toEqual(expectedBytes);
    expect(gitCalls).toHaveLength(5);
  });
});
