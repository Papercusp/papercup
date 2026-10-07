/**
 * Judge-only, read-only Git evidence. Unlike capability:git, this surface has
 * no arbitrary argv, cwd, ref names, or scratch-clone form: callers can only
 * compare two full commit ids or read one bounded file from a full commit id
 * in their resolved harness repository.
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveCapabilityBaseDir } from './base-dir';
import { capabilityExecSandboxPolicy } from './exec-sandbox';
import { runGit } from './git';

const fullCommitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);

export function isSafeGitEvidencePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

const relativeFilePath = z.string().refine(isSafeGitEvidencePath, {
  message: 'path must be a normalized repository-relative POSIX file path',
});

const gitEvidenceArgs = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('isAncestor').describe('Check whether ancestorSha is in descendantSha’s commit ancestry.'),
    ancestorSha: fullCommitSha.describe('Full 40- or 64-character commit SHA; refs and abbreviations are refused.'),
    descendantSha: fullCommitSha.describe('Full 40- or 64-character commit SHA; refs and abbreviations are refused.'),
  }).strict(),
  z.object({
    op: z.literal('readFileAtCommit').describe('Read one bounded UTF-8 blob from an immutable commit.'),
    commitSha: fullCommitSha.describe('Full 40- or 64-character commit SHA; refs and abbreviations are refused.'),
    path: relativeFilePath.describe('Repository-relative POSIX file path; absolute paths and traversal are refused.'),
  }).strict(),
]);

export type GitEvidenceArgs = z.infer<typeof gitEvidenceArgs>;
export const MAX_GIT_EVIDENCE_FILE_BYTES = 128 * 1024;

export type GitEvidenceResult =
  | { ok: true; op: 'isAncestor'; ancestorSha: string; descendantSha: string; isAncestor: boolean }
  | { ok: true; op: 'readFileAtCommit'; commitSha: string; path: string; bytes: number; content: string }
  | { ok: false; reason: string; message?: string };

interface GitEvidenceOptions {
  repositoryDir: string;
  stateDir?: string;
  signal: AbortSignal;
  sandboxEnabled?: boolean;
  sandboxRequired?: boolean;
  runner?: typeof runGit;
}

/** Execute only the two operations admitted by the judge evidence contract. */
export async function runJudgeGitEvidence(
  args: GitEvidenceArgs,
  options: GitEvidenceOptions,
): Promise<GitEvidenceResult> {
  const runner = options.runner ?? runGit;
  const invoke = (argv: string[]) => runner(
    argv,
    options.repositoryDir,
    options.stateDir,
    options.signal,
    options.sandboxEnabled,
    options.sandboxRequired,
  );

  const top = await invoke(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { ok: false, reason: 'not_git_repository', message: top.output.slice(0, 300) };
  const repositoryRoot = top.output.trim();
  if (!isAbsolute(repositoryRoot)) return { ok: false, reason: 'invalid_repository_root' };

  const resolveCommit = async (input: string): Promise<string | null> => {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input)) return null;
    const pinned = input.toLowerCase();
    const result = await invoke(['rev-parse', '--verify', '--end-of-options', `${pinned}^{commit}`]);
    if (result.code !== 0) return null;
    const resolved = result.output.trim().toLowerCase();
    return resolved === pinned ? resolved : null;
  };

  if (args.op === 'isAncestor') {
    const ancestorSha = await resolveCommit(args.ancestorSha);
    const descendantSha = await resolveCommit(args.descendantSha);
    if (!ancestorSha || !descendantSha) return { ok: false, reason: 'commit_not_found_or_not_pinned' };
    const result = await invoke(['merge-base', '--is-ancestor', ancestorSha, descendantSha]);
    if (result.code === 0) {
      return { ok: true, op: 'isAncestor', ancestorSha, descendantSha, isAncestor: true };
    }
    if (result.code === 1) {
      return { ok: true, op: 'isAncestor', ancestorSha, descendantSha, isAncestor: false };
    }
    return { ok: false, reason: 'ancestry_check_failed', message: result.output.slice(0, 300) };
  }

  if (!isSafeGitEvidencePath(args.path)) return { ok: false, reason: 'invalid_path' };
  const commitSha = await resolveCommit(args.commitSha);
  if (!commitSha) return { ok: false, reason: 'commit_not_found_or_not_pinned' };
  const object = `${commitSha}:${args.path}`;
  const type = await invoke(['cat-file', '-t', object]);
  if (type.code !== 0) return { ok: false, reason: 'file_not_found_at_commit' };
  if (type.output.trim() !== 'blob') return { ok: false, reason: 'path_is_not_a_file' };

  const sizeResult = await invoke(['cat-file', '-s', object]);
  const size = Number(sizeResult.output.trim());
  if (sizeResult.code !== 0 || !Number.isSafeInteger(size) || size < 0) {
    return { ok: false, reason: 'file_size_unavailable', message: sizeResult.output.slice(0, 300) };
  }
  if (size > MAX_GIT_EVIDENCE_FILE_BYTES) {
    return { ok: false, reason: 'file_too_large', message: `file is ${size} bytes; limit is ${MAX_GIT_EVIDENCE_FILE_BYTES}` };
  }

  const contentResult = await invoke(['cat-file', 'blob', object]);
  if (contentResult.code !== 0) return { ok: false, reason: 'file_read_failed', message: contentResult.output.slice(0, 300) };
  const bytes = Buffer.byteLength(contentResult.output, 'utf8');
  if (bytes !== size) return { ok: false, reason: 'file_is_not_valid_utf8' };
  return { ok: true, op: 'readFileAtCommit', commitSha, path: args.path, bytes, content: contentResult.output };
}

export default defineTool({
  name: 'capability:git-evidence',
  description:
    'Judge-only read-only Git evidence: check ancestry between full commit SHAs or read one bounded file pinned to a full commit SHA in the active harness repository.',
  guidance: {
    when: 'A grading method requires proof about commit ancestry or the exact contents of a file at a pinned commit.',
    notWhen: 'For general Git commands, worktree state, mutation, refs, or scratch clones, use the separately authorized engineering tools.',
    chaining: 'Use op:"isAncestor" with two full SHAs, or op:"readFileAtCommit" with a full SHA and repository-relative path.',
  },
  capability: 'capability:git-evidence:read',
  effect: 'read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: ['judge'],
  timeoutSec: 30,
  args: gitEvidenceArgs,
  async handler(args, ctx) {
    const sandboxPolicy = await capabilityExecSandboxPolicy(ctx);
    const result = await runJudgeGitEvidence(args, {
      repositoryDir: resolveCapabilityBaseDir(ctx),
      stateDir: ctx.stateDir,
      signal: ctx.signal,
      sandboxEnabled: sandboxPolicy.enabled,
      sandboxRequired: sandboxPolicy.required,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: !result.ok,
    };
  },
});
