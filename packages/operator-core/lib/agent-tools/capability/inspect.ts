/**
 * capability:inspect — READ-ONLY code verification (typecheck / test), the
 * sanctioned FOCUSED verify for fleet agents (EI-524, P-035 of
 * `agent-capability-confinement-2026-06-13`).
 *
 * HISTORY + why it still exists: under the original `bee` read-only confinement
 * (`papercusp-fleet-capability-only` cutover) a bee was envelope-denied
 * `capability:bash`, so this was its ONLY way to TYPECHECK or run TESTS before
 * diagnosing — the fix for EI-524's phantom F-FIX escalations (a bee
 * hallucinating a root cause it can't check). The `bee` confinement was LIFTED on
 * 2026-06-14 (bees now have `capability:fs-write` + `capability:bash`), but this
 * tool REMAINS the sanctioned focused verify: it runs a FIXED set of commands
 * (`npx tsc --noEmit`, `npm run test:affected`, `npx vitest run <path>`), never a
 * free-form command — the cheaper, injection-free path for the common "confirm a
 * claim before I report it" case (the verify-before-diagnose DISCIPLINE that
 * survives the capability change). It carries a SEPARATE capability string
 * (`capability:code-inspect`, tier low) distinct from write/exec (D-003).
 *
 * Security: the agent never supplies a command string — it picks a `check` (enum)
 * plus an optional `package` / `path`, both validated against a strict charset
 * (no shell metacharacters, no `..`, must resolve inside the project dir), so the
 * constructed `bash -c` command has no injection or command-chaining surface.
 * Execution reuses the same bash-jobs runner + exec-sandbox as capability:bash.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runForeground, startBackground } from './bash-jobs';
import { capabilityExecSandboxEnabled } from './exec-sandbox';
import { resolveCapabilityBaseDir } from './base-dir';

/**
 * A repo-relative path token safe to embed literally in a `bash -c` command: a
 * single token (no shell metacharacters, so it can't break out of the command),
 * starting with an alnum/underscore, and no `..` escape. Disallows spaces, `*`,
 * `;`, `|`, `&`, `$`, backticks, quotes, redirects, parens — the whole shell-
 * control surface.
 */
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

function validateRelPath(
  p: string,
  baseDir: string,
): { ok: true; abs: string; rel: string } | { ok: false; reason: string } {
  if (!SAFE_PATH.test(p)) {
    return { ok: false, reason: `path "${p}" has illegal characters (allowed: letters, digits, _ . / -)` };
  }
  if (p.split('/').some((seg) => seg === '..')) return { ok: false, reason: `path "${p}" must not contain a ".." segment` };
  if (isAbsolute(p)) return { ok: false, reason: `path "${p}" must be relative to the project dir` };
  const abs = resolve(baseDir, p);
  const rel = relative(baseDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: `path "${p}" escapes the project dir` };
  return { ok: true, abs, rel };
}

export interface InspectArgs {
  check: 'typecheck' | 'test';
  package?: string;
  path?: string;
}

export type InspectResolution =
  | { ok: true; command: string; cwd: string }
  | { ok: false; reason: string; message: string };

/**
 * Pure: map the validated args to the fixed verification command + cwd, or an
 * error. Exported so the (security-load-bearing) command construction is unit-
 * tested without executing anything. The agent's only inputs are `check` (enum)
 * and the charset-validated `package`/`path`; the command verb is never agent text.
 */
export function resolveInspectCommand(args: InspectArgs, baseDir: string): InspectResolution {
  let cwd = baseDir;
  if (args.package !== undefined) {
    const v = validateRelPath(args.package, baseDir);
    if (!v.ok) return { ok: false, reason: 'bad_package', message: v.reason };
    cwd = v.abs;
  }

  let pathArg = '';
  if (args.path !== undefined) {
    if (args.check !== 'test') return { ok: false, reason: 'bad_args', message: '`path` is only valid for check:"test".' };
    if (args.package === undefined) return { ok: false, reason: 'bad_args', message: '`path` requires `package`.' };
    const v = validateRelPath(args.path, cwd);
    if (!v.ok) return { ok: false, reason: 'bad_path', message: v.reason };
    pathArg = v.rel;
  }

  if (args.check === 'typecheck') {
    if (args.package === undefined) {
      return { ok: false, reason: 'bad_args', message: 'typecheck requires `package` (the dir holding tsconfig.json).' };
    }
    return { ok: true, command: 'npx tsc --noEmit', cwd };
  }

  // check === 'test'
  const command = args.package === undefined ? 'npm run test:affected' : `npx vitest run${pathArg ? ` ${pathArg}` : ''}`;
  return { ok: true, command, cwd };
}

/**
 * Filter raw `tsc --noEmit` output to only the error lines referencing one of
 * `onlyPaths`. A package with PRE-EXISTING errors floods the output, so verifying
 * "did MY change add a NEW error" otherwise means hand-grepping for your own files.
 * A tsc error line is `path/to/file.ts(line,col): error TS####: msg`; we match the
 * path token before "(" against each onlyPath loosely (either string contains the
 * other) so package-relative and repo-relative spellings both work. Pure +
 * exported so the (output-only, non-security) filter is unit-tested. `onlyPaths` is
 * NEVER part of the executed command — purely a post-process of the output.
 */
export function filterTscOutputToPaths(
  output: string,
  onlyPaths: string[],
): { matchedErrors: number; totalErrors: number; matchedLines: string[] } {
  const errRe = /\berror TS\d+\b/;
  const needles = onlyPaths.map((p) => p.replace(/^\.\//, '').trim()).filter(Boolean);
  const matchedLines: string[] = [];
  let totalErrors = 0;
  for (const ln of output.split('\n')) {
    if (!errRe.test(ln)) continue;
    totalErrors += 1;
    const pathTok = ln.split('(')[0].trim().replace(/^\.\//, '');
    if (pathTok && needles.some((p) => pathTok.includes(p) || p.includes(pathTok))) matchedLines.push(ln);
  }
  return { matchedErrors: matchedLines.length, totalErrors, matchedLines };
}

export default defineTool({
  name: 'capability:inspect',
  description:
    'Run a READ-ONLY code verification (typecheck or test) to confirm a claim about the code before diagnosing. Fixed safe commands only (npx tsc --noEmit, npm run test:affected, npx vitest run); never an arbitrary shell command. Use this — not capability:bash — to verify.',
  guidance: {
    when: 'VERIFY a code claim before you report or diagnose: typecheck a package after a suspected type error, or run a package / test-file suite to confirm a failure actually reproduces. This is the sanctioned read-only exec for confined fleet agents (capability:bash is gated for them).',
    notWhen:
      'To READ a file use capability:read; to SEARCH use the Grep tool. To run an arbitrary or mutating command you need capability:bash (gated — escalate if you truly need it). This tool runs ONLY tsc --noEmit / tests, never a free-form command.',
    chaining:
      'capability:read / Grep (inspect) → capability:inspect (typecheck/test to CONFIRM) → report a VERIFIED diagnosis. For a long suite pass run_in_background:true and poll capability:bash_output.',
  },
  capability: 'capability:code-inspect',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  // Mirror capability:bash: the dispatch wall-clock must exceed the max command timeout.
  timeoutSec: Math.floor(MAX_TIMEOUT_MS / 1000) + 30,
  events: { output: z.string().describe('text/plain') },
  args: z.object({
    check: z
      .enum(['typecheck', 'test'])
      .describe('typecheck = `npx tsc --noEmit` in the package; test = the package suite (`npx vitest run`) or, with no package, the repo `npm run test:affected`.'),
    package: z
      .string()
      .optional()
      .describe('Repo-relative package dir to run in (e.g. "packages/operator-core"). REQUIRED for typecheck. For test, omit to run `npm run test:affected` at the repo root.'),
    path: z
      .string()
      .optional()
      .describe('test only: a package-relative test file/dir to narrow the run (e.g. "lib/foo.test.ts"). Requires package.'),
    onlyPaths: z
      .array(z.string().min(1).max(300))
      .max(50)
      .optional()
      .describe(
        'typecheck only (foreground): post-FILTER the tsc output to error lines referencing these (package- or repo-relative) paths, plus an "N matching of M total" summary. The fix for verifying "did MY change add a NEW error" against a package that has pre-existing errors. Output-filter only — never part of the command.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Run detached; returns a bash_id immediately. Poll with capability:bash_output, stop with capability:bash_kill.'),
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`Wall-clock timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
  }),
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);
    const resolved = resolveInspectCommand(args, baseDir);
    if (!resolved.ok) return err(resolved.reason, resolved.message);
    const { command, cwd } = resolved;

    const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;
    // Reuse the capability:bash OS sandbox (P-022/D-008) on the operator-side exec.
    const sandboxEnabled = await capabilityExecSandboxEnabled();

    if (args.run_in_background) {
      const job = startBackground({ command, cwd, stateDir: ctx.stateDir, sandboxEnabled }, timeoutMs);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              bash_id: job.id,
              status: 'running',
              check: args.check,
              command,
              cwd,
              log_path: job.logPath,
              advice: `Verification started. Read output: capability:bash_output { bash_id: "${job.id}" }. Stop: capability:bash_kill { bash_id: "${job.id}" }.`,
            }),
          },
        ],
      };
    }

    const r = await runForeground(
      { command, cwd, stateDir: ctx.stateDir, onChunk: (chunk) => ctx.emit('output', chunk), sandboxEnabled },
      ctx.signal,
      timeoutMs,
    );

    // onlyPaths (typecheck): collapse a noisy package's tsc output to just the
    // errors in the agent's changed files + an "N matching of M total" summary —
    // the answer to "did MY change add a NEW error". Output post-process only.
    if (args.check === 'typecheck' && args.onlyPaths && args.onlyPaths.length > 0) {
      const f = filterTscOutputToPaths(r.output, args.onlyPaths);
      const summary =
        `${args.check} · exit ${r.exitCode ?? 'null'}` +
        (r.status !== 'completed' ? ` (${r.status})` : '') +
        ` · ${(r.durationMs / 1000).toFixed(1)}s · onlyPaths(${args.onlyPaths.length}): ` +
        `${f.matchedErrors} matching error(s) of ${f.totalErrors} total` +
        (r.truncated ? ` · ⚠ output truncated (${r.totalBytes} bytes) → ${r.logPath}; the filter saw the head only` : '');
      const body = f.matchedLines.length > 0 ? f.matchedLines.join('\n') : '(no tsc errors in the specified paths)';
      return { content: [{ type: 'text' as const, text: `${summary}\n${body}` }], isError: false };
    }

    const header =
      `${args.check} · exit ${r.exitCode ?? 'null'}` +
      (r.status !== 'completed' ? ` (${r.status})` : '') +
      ` · ${(r.durationMs / 1000).toFixed(1)}s · ${command} · cwd ${cwd}` +
      (r.truncated ? ` · output spilled (${r.totalBytes} bytes) → ${r.logPath}` : '');

    return {
      content: [{ type: 'text' as const, text: `${header}\n${r.output || '(no output)'}` }],
      isError: r.status === 'failed' && r.exitCode === null,
    };
  },
});

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}
