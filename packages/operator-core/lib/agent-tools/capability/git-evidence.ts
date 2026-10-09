/**
 * Judge-only, read-only Git evidence. Unlike capability:git, this surface has
 * no arbitrary argv, cwd, ref names, or scratch-clone form: callers can only
 * compare two full commit ids or read one bounded file from a full commit id
 * in their resolved harness repository.
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createCache, type Cache } from '@papercusp/cache';
import { defineTool } from '@papercusp/agent-mcp';
import { pinModuleState } from '@papercusp/module-singleton';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { resolveCapabilityBaseDir } from './base-dir';
import { capabilityExecSandboxPolicy } from './exec-sandbox';
import { runGitReadOnlyEvidence } from './git';

const fullCommitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
/** Keep small blobs on the original one-call text response; larger blobs are paged. */
export const MAX_GIT_EVIDENCE_INLINE_BYTES = 128 * 1024;
export const MAX_GIT_EVIDENCE_PAGE_BYTES = 4 * 1024;
const PAGE_RESPONSE_MARGIN_CHARS = 256;
const MAX_CACHED_GIT_EVIDENCE_BLOB_BYTES = 1024 * 1024;
const GIT_EVIDENCE_CACHE_MAX_ENTRIES = 16;
const GIT_EVIDENCE_CACHE_TTL_MS = 5 * 60_000;

// A byte-page cursor is a separate tool invocation. Cache the validated immutable
// blob so following its cursor does not repeat repository discovery, commit/type/
// size probes, or re-read the complete blob for every page. The generic cache and
// module-singleton helpers keep the working set bounded across operator module
// graphs; 16 entries × 1 MiB is the maximum retained payload.
const gitEvidenceCacheState = pinModuleState<{ cache: Cache | null }>(
  '@papercusp/operator-core.gitEvidenceBlobCache',
  () => ({ cache: null }),
);

function getGitEvidenceBlobCache(): Cache {
  if (!gitEvidenceCacheState.cache) {
    gitEvidenceCacheState.cache = createCache({ maxL1Entries: GIT_EVIDENCE_CACHE_MAX_ENTRIES });
  }
  return gitEvidenceCacheState.cache;
}

type GitEvidenceFailure = Extract<GitEvidenceResult, { ok: false }>;

class GitEvidenceReadFailure extends Error {
  readonly gitEvidenceFailure: GitEvidenceFailure;

  constructor(readonly result: GitEvidenceFailure) {
    super(result.message ?? result.reason);
    this.name = 'GitEvidenceReadFailure';
    this.gitEvidenceFailure = result;
  }
}

function evidenceFailureFrom(error: unknown): GitEvidenceFailure | null {
  if (typeof error !== 'object' || error === null) return null;
  const failure = (error as { gitEvidenceFailure?: unknown }).gitEvidenceFailure;
  if (
    typeof failure === 'object' && failure !== null &&
    (failure as { ok?: unknown }).ok === false &&
    typeof (failure as { reason?: unknown }).reason === 'string'
  ) {
    return failure as GitEvidenceFailure;
  }
  return null;
}

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

const readFileAtCommitArgs = z.object({
  op: z.literal('readFileAtCommit').describe('Read a UTF-8 blob from an immutable commit. Oversized blobs are returned in bounded byte pages.'),
  commitSha: fullCommitSha.describe('Full 40- or 64-character commit SHA; refs and abbreviations are refused.'),
  path: relativeFilePath.describe('Repository-relative POSIX file path; absolute paths and traversal are refused.'),
  rootHarnessSlug: z.string().trim().min(1).max(120).optional().describe('Registered harness whose repository contains the cited commit, taken from the evidence measurement. Resolved only in the caller workspace; no arbitrary directory is accepted.'),
  byte_offset: z.number().int().nonnegative().optional().describe('0-based byte offset for an exact page. Pair with byte_limit; the first page of an oversized blob defaults to 0.'),
  byte_limit: z.number().int().positive().max(MAX_GIT_EVIDENCE_PAGE_BYTES).optional().describe(`Maximum exact bytes in this page (≤${MAX_GIT_EVIDENCE_PAGE_BYTES}). Follow next_cursor for the next page.`),
}).strict();

const gitEvidenceArgs = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('isAncestor').describe('Check whether ancestorSha is in descendantSha’s commit ancestry.'),
    ancestorSha: fullCommitSha.describe('Full 40- or 64-character commit SHA; refs and abbreviations are refused.'),
    descendantSha: fullCommitSha.describe('Full 40- or 64-character commit SHA; refs and abbreviations are refused.'),
  }).strict(),
  readFileAtCommitArgs,
]).superRefine((args, ctx) => {
  if (args.op !== 'readFileAtCommit') return;
  if ((args.byte_offset === undefined) !== (args.byte_limit === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'byte_offset and byte_limit must be supplied together.',
      path: [args.byte_offset === undefined ? 'byte_offset' : 'byte_limit'],
    });
  }
});

export type GitEvidenceArgs = z.infer<typeof gitEvidenceArgs>;

export type GitEvidenceResult =
  | { ok: true; op: 'isAncestor'; ancestorSha: string; descendantSha: string; isAncestor: boolean }
  | { ok: true; op: 'readFileAtCommit'; commitSha: string; path: string; bytes: number; content: string }
  | {
      ok: true;
      op: 'readFileAtCommit';
      commitSha: string;
      path: string;
      encoding: 'base64';
      byte_offset: number;
      byte_length: number;
      total_bytes: number;
      eof: boolean;
      data: string;
      next_cursor: {
        tool: 'capability:git-evidence';
        args: Extract<GitEvidenceArgs, { op: 'readFileAtCommit' }>;
      } | null;
    }
  | { ok: false; reason: string; message?: string };

/** Keep a base64 page plus its recovery cursor inside the result door. */
export function doorSafeGitEvidencePageBytes(
  commitSha: string,
  path: string,
  requestedBytes: number,
  rootHarnessSlug?: string,
): number {
  const envelopeChars = JSON.stringify({
    ok: true,
    op: 'readFileAtCommit',
    commitSha,
    path,
    ...(rootHarnessSlug ? { rootHarnessSlug } : {}),
    encoding: 'base64',
    byte_offset: Number.MAX_SAFE_INTEGER,
    byte_length: Number.MAX_SAFE_INTEGER,
    total_bytes: Number.MAX_SAFE_INTEGER,
    eof: false,
    data: '',
    next_cursor: {
      tool: 'capability:git-evidence',
      args: {
        op: 'readFileAtCommit',
        commitSha,
        path,
        ...(rootHarnessSlug ? { rootHarnessSlug } : {}),
        byte_offset: Number.MAX_SAFE_INTEGER,
        byte_limit: MAX_GIT_EVIDENCE_PAGE_BYTES,
      },
    },
  }).length;
  const budgetChars = computeTurnDoors(0).resultEach * CHARS_PER_TOKEN_ESTIMATE;
  const room = budgetChars - envelopeChars - PAGE_RESPONSE_MARGIN_CHARS;
  const fits = Math.floor(Math.max(0, room) / 4) * 3;
  return Math.min(requestedBytes, fits);
}

interface GitEvidenceOptions {
  repositoryDir: string;
  workspaceId?: string;
  loadRegistry?: typeof loadHarnessRegistry;
  stateDir?: string;
  signal: AbortSignal;
  sandboxEnabled?: boolean;
  sandboxRequired?: boolean;
  runner?: typeof runGitReadOnlyEvidence;
  /** Internal cache seam for exercising bounded page reuse. */
  cache?: Cache;
}

/** Execute only the two operations admitted by the judge evidence contract. */
export async function runJudgeGitEvidence(
  args: GitEvidenceArgs,
  options: GitEvidenceOptions,
): Promise<GitEvidenceResult> {
  try {
    return await runJudgeGitEvidenceInner(args, options);
  } catch (error) {
    if (!options.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const detail = message.startsWith('git_command_interrupted: ')
      ? message.slice('git_command_interrupted: '.length)
      : message;
    return {
      ok: false,
      reason: 'git_command_interrupted',
      message: detail.slice(0, 300) || 'A Git command was aborted before returning a result',
    };
  }
}

async function runJudgeGitEvidenceInner(
  args: GitEvidenceArgs,
  options: GitEvidenceOptions,
): Promise<GitEvidenceResult> {
  let repositoryDir = options.repositoryDir;
  if (args.op === 'readFileAtCommit' && args.rootHarnessSlug !== undefined) {
    if (!options.workspaceId || options.workspaceId === '*') {
      return { ok: false, reason: 'root_harness_requires_concrete_workspace' };
    }
    const registry = await (options.loadRegistry ?? loadHarnessRegistry)(options.workspaceId);
    const registeredRoot = resolveHarnessContentPath(registry, args.rootHarnessSlug);
    if (!registeredRoot || !isAbsolute(registeredRoot)) {
      return { ok: false, reason: 'root_harness_not_registered' };
    }
    repositoryDir = registeredRoot;
  }
  const runner = options.runner ?? runGitReadOnlyEvidence;
  const invoke = async (argv: string[]) => {
    const result = await runner(
      argv,
      repositoryDir,
      options.stateDir,
      options.signal,
      options.sandboxEnabled,
      options.sandboxRequired,
    );
    if (options.signal.aborted && result.code === null) {
      const message = result.output.slice(0, 300);
      throw new Error(
        `git_command_interrupted: ${message || `git ${argv.join(' ')} was aborted before returning a result`}`,
      );
    }
    return result;
  };

  const resolveCommit = async (input: string): Promise<string | null> => {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input)) return null;
    const pinned = input.toLowerCase();
    const result = await invoke(['rev-parse', '--verify', '--end-of-options', `${pinned}^{commit}`]);
    if (result.code !== 0) return null;
    const resolved = result.output.trim().toLowerCase();
    return resolved === pinned ? resolved : null;
  };

  if (args.op === 'readFileAtCommit') {
    if (!isSafeGitEvidencePath(args.path)) return { ok: false, reason: 'invalid_path' };
    if (options.signal.aborted) {
      return {
        ok: false,
        reason: 'git_command_interrupted',
        message: 'Git evidence request was aborted before repository validation',
      };
    }

    const loadPinnedBlob = async (): Promise<{ commitSha: string; contentBytes: Buffer }> => {
      const top = await invoke(['rev-parse', '--show-toplevel']);
      if (top.code !== 0) {
        const message = top.output.slice(0, 300);
        if (options.signal.aborted) {
          throw new GitEvidenceReadFailure({
            ok: false,
            reason: 'git_command_interrupted',
            message: message || 'git rev-parse was aborted before returning a result',
          });
        }
        if (top.code === null) {
          throw new GitEvidenceReadFailure({
            ok: false,
            reason: 'git_command_failed',
            message: message || 'git rev-parse did not exit cleanly',
          });
        }
        if (/not a git repository/i.test(message)) {
          throw new GitEvidenceReadFailure({ ok: false, reason: 'not_git_repository', message });
        }
        throw new GitEvidenceReadFailure({
          ok: false,
          reason: 'repository_probe_failed',
          message: message || `git rev-parse exited with code ${top.code}`,
        });
      }
      if (!isAbsolute(top.output.trim())) {
        throw new GitEvidenceReadFailure({ ok: false, reason: 'invalid_repository_root' });
      }

      const commitSha = await resolveCommit(args.commitSha);
      if (!commitSha) {
        throw new GitEvidenceReadFailure({ ok: false, reason: 'commit_not_found_or_not_pinned' });
      }
      const object = `${commitSha}:${args.path}`;
      const type = await invoke(['cat-file', '-t', object]);
      if (type.code !== 0) {
        throw new GitEvidenceReadFailure({ ok: false, reason: 'file_not_found_at_commit' });
      }
      if (type.output.trim() !== 'blob') {
        throw new GitEvidenceReadFailure({ ok: false, reason: 'path_is_not_a_file' });
      }

      const sizeResult = await invoke(['cat-file', '-s', object]);
      const size = Number(sizeResult.output.trim());
      if (sizeResult.code !== 0 || !Number.isSafeInteger(size) || size < 0) {
        throw new GitEvidenceReadFailure({
          ok: false,
          reason: 'file_size_unavailable',
          message: sizeResult.output.slice(0, 300),
        });
      }

      const contentResult = await invoke(['cat-file', 'blob', object]);
      if (contentResult.code !== 0) {
        throw new GitEvidenceReadFailure({
          ok: false,
          reason: 'file_read_failed',
          message: contentResult.output.slice(0, 300),
        });
      }
      const contentBytes = Buffer.from(contentResult.output, 'utf8');
      if (contentBytes.length !== size) {
        throw new GitEvidenceReadFailure({ ok: false, reason: 'file_is_not_valid_utf8' });
      }
      return { commitSha, contentBytes };
    };

    const workspaceId = options.workspaceId;
    const cache = options.cache ?? (!options.runner ? getGitEvidenceBlobCache() : undefined);
    const cacheableScope = !!workspaceId && workspaceId !== '*' && !!cache;
    const cacheKey = `git-evidence:pinned-blob:${JSON.stringify([
      repositoryDir,
      args.rootHarnessSlug ?? null,
      args.commitSha.toLowerCase(),
      args.path,
      options.sandboxEnabled ?? false,
      options.sandboxRequired ?? false,
    ])}`;
    let pinnedBlob: { commitSha: string; contentBytes: Buffer };
    try {
      pinnedBlob = cacheableScope
        ? await cache!.getOrSet(workspaceId, cacheKey, loadPinnedBlob, {
            hardTtlMs: GIT_EVIDENCE_CACHE_TTL_MS,
          })
        : await loadPinnedBlob();
    } catch (error) {
      const failure = evidenceFailureFrom(error);
      if (failure) return failure;
      throw error;
    }
    if (cacheableScope && pinnedBlob.contentBytes.length > MAX_CACHED_GIT_EVIDENCE_BLOB_BYTES) {
      cache!.forget(workspaceId, cacheKey);
    }

    const { commitSha, contentBytes } = pinnedBlob;
    const size = contentBytes.length;
    if (size <= MAX_GIT_EVIDENCE_INLINE_BYTES && args.byte_offset === undefined) {
      return {
        ok: true,
        op: 'readFileAtCommit',
        commitSha,
        path: args.path,
        bytes: size,
        content: contentBytes.toString('utf8'),
      };
    }

    const requestedLimit = args.byte_limit ?? MAX_GIT_EVIDENCE_PAGE_BYTES;
    const pageLimit = doorSafeGitEvidencePageBytes(commitSha, args.path, requestedLimit, args.rootHarnessSlug);
    if (pageLimit <= 0) {
      return {
        ok: false,
        reason: 'path_too_long_for_byte_page',
        message: 'The commit and path leave no room for a byte page in the result budget.',
      };
    }
    const byteOffset = Math.min(args.byte_offset ?? 0, size);
    const page = contentBytes.subarray(byteOffset, Math.min(byteOffset + pageLimit, size));
    const nextOffset = byteOffset + page.length;
    return {
      ok: true,
      op: 'readFileAtCommit',
      commitSha,
      path: args.path,
      encoding: 'base64',
      byte_offset: byteOffset,
      byte_length: page.length,
      total_bytes: size,
      eof: nextOffset >= size,
      data: page.toString('base64'),
      next_cursor:
        nextOffset < size
          ? {
              tool: 'capability:git-evidence',
              args: {
                op: 'readFileAtCommit',
                commitSha,
                path: args.path,
                ...(args.rootHarnessSlug ? { rootHarnessSlug: args.rootHarnessSlug } : {}),
                byte_offset: nextOffset,
                byte_limit: pageLimit,
              },
            }
          : null,
    };
  }

  const top = await invoke(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    const message = top.output.slice(0, 300);
    if (options.signal.aborted) {
      return {
        ok: false,
        reason: 'git_command_interrupted',
        message: message || 'git rev-parse was aborted before returning a result',
      };
    }
    if (top.code === null) {
      return {
        ok: false,
        reason: 'git_command_failed',
        message: message || 'git rev-parse did not exit cleanly',
      };
    }
    if (/not a git repository/i.test(message)) {
      return { ok: false, reason: 'not_git_repository', message };
    }
    return {
      ok: false,
      reason: 'repository_probe_failed',
      message: message || `git rev-parse exited with code ${top.code}`,
    };
  }
  const repositoryRoot = top.output.trim();
  if (!isAbsolute(repositoryRoot)) return { ok: false, reason: 'invalid_repository_root' };

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

export default defineTool({
  name: 'capability:git-evidence',
  description:
    'Judge-only read-only Git evidence: check ancestry between full commit SHAs or read a file pinned to a full commit SHA in the active harness repository or an explicitly registered evidence harness. Oversized files return bounded byte pages.',
  guidance: {
    when: 'A grading method requires proof about commit ancestry or the exact contents of a file at a pinned commit.',
    notWhen: 'For general Git commands, worktree state, mutation, refs, or scratch clones, use the separately authorized engineering tools.',
    chaining:
      'Use op:"isAncestor" with two full SHAs, or op:"readFileAtCommit" with a full SHA and repository-relative path. For an external test checkout, copy rootHarnessSlug from the cited binding measurement. For a whole-file read, omit byte_offset and byte_limit: blobs up to 128 KiB return {bytes, content} in one call (including a 94,304-byte blob). Larger blobs, or deliberate pages, return {encoding:"base64", byte_offset, byte_length, total_bytes, eof, data, next_cursor} and have no content field. Base64-decode data, follow next_cursor.args unchanged to preserve the pinned commit/path/root, and stop only when eof is true and next_cursor is null.',
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
      workspaceId: ctx.workspaceId,
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
