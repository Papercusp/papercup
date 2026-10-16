import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runToolOrchestration, type UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool, ToolResult } from '@papercusp/tooldef';
import { runGit } from '../capability/git';
import { runJudgeGitEvidence, type GitEvidenceArgs } from '../capability/git-evidence';
import { bindCurrentCallerDispatch } from './current-caller-dispatch';

const cleanup: string[] = [];

const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixtureTool(
  root: string,
  observe: (ctx: UnifiedToolContext) => void,
  interrupted: AbortController,
): ProjectedTool {
  const runner = async (
    argv: string[],
    cwd: string,
    stateDir: string | undefined,
    signal: AbortSignal,
  ): Promise<{ code: number | null; output: string }> => {
    if (argv[0] === 'cat-file' && argv[1] === 'blob') {
      const output = execFileSync('git', argv, { cwd, encoding: 'utf8' });
      // Reproduce a killed nested child that already emitted the blob. The old
      // boundary treated this as a file-read failure and exposed the blob in
      // `message`, rather than preserving caller cancellation.
      interrupted.abort();
      return { code: 137, output };
    }
    return runGit(argv, cwd, stateDir, signal, false, false);
  };

  return {
    pluginName: 'judge-git-evidence-fixture',
    description: 'capability:git-evidence',
    inputSchema: { type: 'object' },
    capabilities: [],
    effect: 'read',
    expose: { mcp: { name: 'capability:git-evidence' } },
    fn: async (args: GitEvidenceArgs, ctx: UnifiedToolContext) => {
      observe(ctx);
      const result = await runJudgeGitEvidence(args, {
        repositoryDir: root,
        workspaceId: 'judge-git-evidence-fixture',
        // The orchestration child signal remains the caller's cancellation
        // source; the fixture adds the child-process interruption edge.
        signal: AbortSignal.any([ctx.signal, interrupted.signal]),
        runner,
      });
      return { ...json(result), isError: !result.ok };
    },
  } as unknown as ProjectedTool;
}

describe('nested judge git evidence orchestration', () => {
  it('preserves an interrupted blob read through ToolResult unwrapping and childFailures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'judge-git-evidence-nested-'));
    cleanup.push(root);
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.name', 'Nested Judge Fixture']);
    git(root, ['config', 'user.email', 'nested-judge@example.invalid']);
    const path = 'packages/operator-core/lib/spec-conformance/sweep-action.test.ts';
    mkdirSync(join(root, 'packages/operator-core/lib/spec-conformance'), { recursive: true });
    writeFileSync(join(root, path), 'historical evidence content\n');
    git(root, ['add', path]);
    git(root, ['commit', '--quiet', '-m', 'fixture']);
    const commitSha = git(root, ['rev-parse', 'HEAD']);

    const interrupted = new AbortController();
    let childCtx: UnifiedToolContext | undefined;
    const tool = fixtureTool(root, (ctx) => { childCtx = ctx; }, interrupted);
    const result = await runToolOrchestration(
      `return await tools.capability.gitEvidence({
        op: 'readFileAtCommit',
        commitSha: '${commitSha}',
        path: '${path}'
      });`,
      {
        ctx: {
          log: () => {},
          progress: () => {},
          emit: () => {},
          signal: new AbortController().signal,
          workspaceId: 'judge-git-evidence-fixture',
          harnessSlug: 'papercusp',
          role: 'judge',
          isSuperuser: true,
          projectDir: root,
          deadlineAtMs: Date.now() + 30_000,
          tx: { fixture: true },
        } as unknown as UnifiedToolContext,
        deps: {},
        tools: [tool],
        allowed: new Set(['capability:git-evidence']),
        wrapDispatch: bindCurrentCallerDispatch,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      summary: { ok: false, reason: 'git_command_interrupted' },
      childFailures: [{
        tool: 'capability:git-evidence',
        kind: 'semantic',
        result: { ok: false, reason: 'git_command_interrupted' },
      }],
    });
    expect(result.summary).not.toMatchObject({
      reason: 'file_read_failed',
      message: expect.stringContaining('historical evidence content'),
    });
    expect(childCtx?.role).toBe('judge');
    expect(childCtx?.signal).not.toBe((result as unknown as { signal?: AbortSignal }).signal);
    expect(childCtx?.signal.aborted).toBe(false);
    expect(childCtx?.deadlineAtMs).toEqual(expect.any(Number));
    expect(interrupted.signal.aborted).toBe(true);
  });
});

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});
