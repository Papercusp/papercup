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
import { resolveCapabilityBaseDir } from './base-dir';
import { INLINE_OUTPUT_CAP, scratchDir } from './bash-jobs';
import { buildCapabilitySandboxCommand, capabilityExecSandboxEnabled, scrubExecEnv } from './exec-sandbox';

/**
 * Exported so the bash-substitution audit can PIN its model to it
 * (`pairs/model-drift.test.ts`, WI-6157/D-015): `pairs/git-read.ts` claims a
 * closed list of read subcommands as substitutable, and every one of them must
 * be a subcommand this tool actually accepts. Refusing a new subcommand here
 * without removing it there would make the registry advise a substitution that
 * returns `refused`.
 */
export const REFUSED_SUBCOMMANDS = new Set(['push']);

export default defineTool({
  name: 'capability:git',
  description:
    'Run a git subcommand (argv, no shell) in the project dir. `push` is refused (git-sync owns push). Output spills to a log if large.',
  guidance: {
    when: 'Inspect or stage git state — status, diff, log, show, add, commit (within a worktree). Prefer this over capability:bash for git so the action is gated as git, not arbitrary shell.',
    notWhen: 'Pushing (refused — git-sync owns push). Arbitrary shell — use capability:bash.',
    chaining: 'capability:git { args: ["status","--porcelain"] } → inspect → capability:git { args: ["add","-A"] } etc.',
    seeAlso: [
      'capability:bash (run an arbitrary shell command)',
      'dev:pipeline_position (where a committed edit is in the pipeline)',
    ],
  },
  capability: 'capability:git',
  requirePrincipal: false,
  // EI-18803497769946984: shells out to git (a fetch/clone can run minutes) and never
  // reads ctx.tx — holding the ambient workspace transaction across that wait trips
  // idle_in_transaction_session_timeout (60s), surfacing as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
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
    // EI-20881501070735530: this was `ctx.projectDir ?? process.cwd()` — the ONE
    // capability tool missed when EI-1754 migrated read/write/edit/inspect/bash to
    // the shared resolver. A superuser ctx has `projectDir: undefined`, so git ran
    // in the :3070 operator's own cwd — the RELEASE checkout's `apps/operator/`
    // subdir (a different worktree, pinned to green `main`). Measured: `rev-parse
    // --show-toplevel` returned papercup-release with prefix `apps/operator/`, so a
    // repo-relative pathspec after `--` resolved to `apps/operator/<path>`, matched
    // nothing, and printed nothing at exit 0 — a confident FALSE ABSENCE for every
    // agent using `git log -- <path>` for landing/containment triage.
    const baseDir = resolveCapabilityBaseDir(ctx);
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
    // The cwd is part of the ANSWER, not debug noise: every result below is scoped
    // to this directory (and, for a worktree, to ITS branch). capability:bash has
    // always printed its cwd; capability:git printing none is what let the wrong-tree
    // reading above look like a normal empty result. (EI-20881501070735530)
    const header = `git ${args.args.join(' ')} · exit ${r.code ?? 'null'} · cwd ${cwd}${truncated ? ` · spilled → ${logPath}` : ''}`;
    const body = output || `(no output)${emptyPathspecNote(args.args, r.code, output, cwd)}`;
    return {
      content: [{ type: 'text' as const, text: `${header}\n${body}` }],
      isError: r.code === null,
    };
  },
});

/**
 * The other half of EI-20881501070735530, kept even though the cwd bug above is
 * fixed: `git <cmd> -- <pathspec>` that matches NOTHING prints nothing and exits
 * **0**, so a wrong path (a typo, a submodule path queried from the superproject,
 * a path that only exists on another branch) is indistinguishable from a real
 * "no commits touch this file". That is the false-absence class this repo keeps
 * paying for, and here the instrument can just say which reading it is.
 *
 * Deliberately narrow: it fires ONLY when an explicit `--` pathspec was given and
 * the command still produced nothing at exit 0. It must never fire on a legitimate
 * empty result such as `git diff` over a clean tree, so no heuristic guesses at
 * bare trailing operands.
 *
 * Exported for unit testing.
 */
export function emptyPathspecNote(argv: string[], code: number | null, output: string, cwd: string): string {
  if (code !== 0 || output.trim() !== '') return '';
  const sep = argv.indexOf('--');
  if (sep === -1) return '';
  const pathspecs = argv.slice(sep + 1);
  if (pathspecs.length === 0) return '';
  return (
    `\n⚠ pathspec matched nothing in ${cwd} — git prints nothing and exits 0 for BOTH ` +
    `"no commits touch this path" and "this path does not exist here", so this is not ` +
    `evidence of absence. Pathspec: ${pathspecs.join(' ')}. Re-check with a positive ` +
    `control (the same query for a path you know is tracked), and note that a path inside ` +
    `a git SUBMODULE never matches from the superproject — run it with cwd set to the submodule.`
  );
}

/** Exported for direct unit testing (mirrors bash-jobs.ts's runForeground export) —
 *  decouples the env-scrub regression test from the flag/DB plumbing the
 *  `handler` above resolves `sandboxEnabled` through. */
export function runGit(
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
      // EI-1617: allowlist, not a full process.env passthrough — this subprocess
      // previously inherited every operator secret (DB creds, webhook/JWT
      // secrets, session keys, …) for no reason a `git status`/`diff`/`commit`
      // needs. See exec-sandbox.ts's scrubExecEnv.
      env: { ...scrubExecEnv(process.env), PATH: spawnPath },
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
