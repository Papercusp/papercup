/**
 * capability:git — run a git subcommand. A thin wrapper that spawns `git` with
 * argv directly (no shell, so no quoting hazards), routed through dispatch so a
 * distinct `capability:git` capability can be gated by the envelope separately
 * from arbitrary bash (P-010, `agent-capability-confinement-2026-06-13`).
 *
 * `push` is REFUSED — git-sync owns commit+push on the shared tree (mirrors the
 * fleet's `Bash(git push:*)` deny). Everything else (status/diff/log/add/commit
 * within a worktree) is allowed; output spills to a log if large.
 */

import { spawn as childSpawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { augmentedSpawnPath, resolveBin } from '../../plugin-spawn-impl';
import { INLINE_OUTPUT_CAP, scratchDir } from './bash-jobs';
import { buildCapabilitySandboxCommand, capabilityExecSandboxEnabled } from './exec-sandbox';

const REFUSED_SUBCOMMANDS = new Set(['push']);

export default defineTool({
  name: 'capability:git',
  description:
    'Run a git subcommand (argv, no shell) in the project dir. `push` is refused (git-sync owns push). Output spills to a log if large.',
  guidance: {
    when: 'Inspect or stage git state — status, diff, log, show, add, commit (within a worktree). Prefer this over capability:bash for git so the action is gated as git, not arbitrary shell.',
    notWhen: 'Pushing (refused — git-sync owns push). Arbitrary shell — use capability:bash.',
    chaining: 'capability:git { args: ["status","--porcelain"] } → inspect → capability:git { args: ["add","-A"] } etc.',
  },
  capability: 'capability:git',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 120,
  args: z.object({
    args: z.array(z.string()).min(1).describe('git arguments, e.g. ["status","--porcelain"] or ["diff","--stat"].'),
    cwd: z.string().optional().describe('Working dir (absolute, or relative to the project dir). Defaults to the project dir.'),
  }),
  async handler(args, ctx) {
    const sub = args.args.find((a) => !a.startsWith('-')) ?? '';
    if (REFUSED_SUBCOMMANDS.has(sub)) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'refused', message: `git ${sub} is refused — git-sync owns push on the shared tree.` }) },
        ],
        isError: true,
      };
    }
    const baseDir = ctx.projectDir ?? process.cwd();
    const cwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(baseDir, args.cwd)) : baseDir;
    // P-022/D-008: re-apply the OS sandbox to this operator-side git subprocess
    // when the papercusp-capability-exec-sandbox flag is armed (default-OFF, fail-open).
    const sandboxEnabled = await capabilityExecSandboxEnabled();

    const r = await runGit(args.args, cwd, ctx.stateDir, ctx.signal, sandboxEnabled);
    const truncated = r.output.length > INLINE_OUTPUT_CAP;
    let logPath: string | undefined;
    let output = r.output;
    if (truncated) {
      logPath = join(scratchDir(ctx.stateDir), `git-${crypto.randomUUID().slice(0, 12)}.log`);
      try { createWriteStream(logPath, { flags: 'w' }).end(r.output); } catch { /* ignore */ }
      output = `${r.output.slice(0, INLINE_OUTPUT_CAP)}\n… [truncated — full output: ${logPath}]`;
    }
    const header = `git ${args.args.join(' ')} · exit ${r.code ?? 'null'}${truncated ? ` · spilled → ${logPath}` : ''}`;
    return {
      content: [{ type: 'text' as const, text: `${header}\n${output || '(no output)'}` }],
      isError: r.code === null,
    };
  },
});

function runGit(
  argv: string[],
  cwd: string,
  _stateDir: string | undefined,
  signal: AbortSignal,
  sandboxEnabled = false,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const spawnPath = augmentedSpawnPath();
    const decision = buildCapabilitySandboxCommand(
      { cmd: [resolveBin('git', spawnPath), ...argv], cwd },
      { enabled: sandboxEnabled },
    );
    if (sandboxEnabled && !decision.sandboxed) {
      console.warn(
        `[capability:git] exec-sandbox enabled but ${decision.reason} — running unsandboxed in the operator process (cwd ${cwd})`,
      );
    }
    const child = childSpawn(decision.binary, decision.argv, {
      cwd,
      env: { ...process.env, PATH: spawnPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const cap = 8 * 1024 * 1024;
    const onData = (b: Buffer): void => {
      if (output.length < cap) output += b.toString('utf8');
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const onAbort = (): void => { child.kill('SIGKILL'); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise({ code: null, output: output + `\n[spawn error] ${err instanceof Error ? err.message : String(err)}` });
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise({ code, output });
    });
  });
}
