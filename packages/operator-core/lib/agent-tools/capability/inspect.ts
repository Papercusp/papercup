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

import { isAbsolute, basename, dirname, relative, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  runForeground,
  startBackground,
} from './bash-jobs';
import { capabilityExecSandboxEnabled } from './exec-sandbox';
import { resolveCapabilityBaseDir } from './base-dir';
import { TSC_HEAP_MB, tscHeapEnv } from '../tsc-heap';

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

const TSCONFIG_BASENAME = /^tsconfig(\.[\w-]+)?\.json$/;

/**
 * EI-19332092038566982 / EI-19331889744736428: `child_process.spawn`'s `cwd` must be a real
 * DIRECTORY — passing it a FILE fails with an opaque `spawn ENOTDIR` (no path, no hint, nothing
 * an agent can act on). The #1 wrong call shape observed live (6 of 6 sampled watchdog failures,
 * plus an independently-filed duplicate) is `package: '<dir>/tsconfig.json'` — the tsconfig PATH
 * where this tool wants its containing directory. `build:typecheck`'s own `project` arg DOES take
 * the tsconfig path, and its timeout hint carried that convention across by mistake (fixed
 * separately), so this is a call shape agents genuinely produce, not a hypothetical.
 *
 * Auto-correct the common case (a `tsconfig*.json` file) rather than erroring on it — the caller's
 * intent is unambiguous. Anything else that isn't a directory fails with an ACTIONABLE message
 * instead of ever reaching spawn. Pure given the caller's own directory-existence probe, so this
 * stays unit-testable without touching the filesystem.
 */
export function resolveTypecheckCwd(
  cwd: string,
  cwdIsDirectory: boolean,
): { ok: true; cwd: string; corrected: boolean } | { ok: false; reason: string; message: string } {
  if (cwdIsDirectory) return { ok: true, cwd, corrected: false };
  if (TSCONFIG_BASENAME.test(basename(cwd))) {
    return { ok: true, cwd: dirname(cwd), corrected: true };
  }
  return {
    ok: false,
    reason: 'bad_package_not_a_directory',
    message:
      `\`package\` must be a directory (the one holding tsconfig.json) — "${cwd}" is not a directory. ` +
      'Pass the containing directory, e.g. `package: "packages/operator-core"` rather than ' +
      '`package: "packages/operator-core/tsconfig.json"`.',
  };
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
/**
 * Classify a typecheck run that emitted ZERO diagnostics: did it pass, or did it DIE?
 *
 * WHY (EI-20019651513530828 / EI-20013137550825704, both measured 2026-08-09): a
 * `tsc` that OOMs (operator-core is ~9k files and overflows node's default ~4GB
 * old-space) is killed by V8 BEFORE it emits a single diagnostic. Every probe an
 * agent naturally runs on that output then reads as clean:
 *
 *     grep -c "error TS" <log>        -> 0
 *     grep "<my changed file>" <log>  -> (nothing)
 *
 * Both are the SAME output a genuinely clean compile produces, so the natural
 * conclusion is "my change is fine" — reached having verified nothing. One agent
 * got to within one step of recording "operator-core typechecks clean with the new
 * required field", on precisely the question (does a new REQUIRED field strand
 * construction sites in files I never touched?) that this repo flags as the classic
 * silent breaker.
 *
 * Same family as the zero-work false greens already guarded elsewhere (`tsc -p .`
 * checking zero files; `test:affected` selecting zero suites; a `-t` filter matching
 * zero tests) — but reached by a CRASH rather than by selecting nothing, which is
 * why those guards never caught it.
 *
 * Returns null when the run is entitled to be read as clean; otherwise the verdict
 * to surface. Pure + exported so the classification is unit-tested against captured
 * output rather than by inducing a real OOM.
 */
export function deadTypecheckVerdict(run: {
  exitCode: number | null;
  status: string;
  output: string;
  parsedErrors: number;
}): { reason: string; headline: string; advice: string } | null {
  // tsc exits nonzero WITH diagnostics for ordinary type errors — that is a real
  // result, not a dead run. Only silence plus failure is suspect.
  if (run.parsedErrors > 0) return null;
  const clean = run.exitCode === 0 && run.status === 'completed';
  if (clean) return null;

  const out = run.output ?? '';
  const oom =
    /JavaScript heap out of memory|Ineffective mark-compacts near heap limit|FATAL ERROR:.*heap/i.test(out) ||
    // SIGABRT — how V8 terminates on heap exhaustion once it gives up.
    run.exitCode === 134 ||
    /Aborted \(core dumped\)/i.test(out);

  if (oom) {
    return {
      reason: 'typecheck_died_out_of_memory',
      headline:
        '🚨 THIS RUN MEASURED NOTHING — tsc ran out of heap and was killed before emitting any diagnostics. ' +
        'Zero errors here does NOT mean your code typechecks.',
      advice:
        `Re-run with a larger heap: NODE_OPTIONS=--max-old-space-size=${TSC_HEAP_MB} (or \`npm run lint:tsc -- --files=<your files>\`, ` +
        'which pins it for you). This tool now sets that heap itself, so an OOM here means the target needs more than the current ceiling.',
    };
  }
  if (run.status === 'timed_out') {
    return {
      reason: 'typecheck_timed_out_without_diagnostics',
      headline:
        '🚨 THIS RUN MEASURED NOTHING — the typecheck was killed at its timeout before emitting any diagnostics. ' +
        'Zero errors here does NOT mean your code typechecks.',
      advice: 'Re-run detached: capability:inspect { …same args…, run_in_background: true }, then poll capability:bash_output.',
    };
  }
  return {
    reason: 'typecheck_died_without_diagnostics',
    headline:
      `🚨 THIS RUN MEASURED NOTHING — tsc exited ${run.exitCode ?? 'null'} without emitting any diagnostics. ` +
      'Zero errors here does NOT mean your code typechecks.',
    advice:
      'Read the head of the output for the real cause (a bad --project operand, a missing tsconfig, or a crash). ' +
      'A nonzero exit with no diagnostics is never a pass.',
  };
}

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

// EI-6073: the papercusp-su MCP transport hard-caps a tool call at ~55s. A FOREGROUND
// typecheck/test on a large package (operator-core's tsc runs 60-90s) is killed by the
// transport with an opaque `request_timeout` BEFORE this handler can respond — so the agent
// never learns the durable fix is a detached run, and the very capability that exists to
// remove the "shell out + poll" friction pushes them back to it. Clamp the FOREGROUND command
// timeout safely below the cap so the tool ALWAYS self-times-out first (status:'timed_out')
// and returns an actionable "re-run with run_in_background" hint. A background run is not bound
// by the TRANSPORT cap (it returns a bash_id immediately), so this clamp never applies to it.
//
// ⚠ WI-6677: "not bound by the transport cap" is NOT "uncapped", which this comment used to
// claim. A background job still has its own wall-clock deadline and is terminated at it. It
// simply must not be the FOREGROUND default — see DEFAULT_BACKGROUND_TIMEOUT_MS in bash-jobs.ts.
export const MCP_TRANSPORT_CAP_MS = 55_000;
/** Foreground ceiling — below the transport cap, with ~5s headroom to serialize the response. */
export const FOREGROUND_TIMEOUT_CEILING_MS = 50_000;

/** Clamp a FOREGROUND command timeout below the MCP transport cap (EI-6073).
 *  Background runs skip this clamp — they carry their own (much longer) deadline instead. */
export function clampForegroundTimeoutMs(requestedMs: number): number {
  return Math.min(requestedMs, FOREGROUND_TIMEOUT_CEILING_MS);
}

/**
 * The actionable hint appended when a FOREGROUND run hit the clamped ceiling (EI-6073) — turns an
 * opaque timeout into "this is too large to verify inline; re-run detached and poll". Empty for a
 * completed/failed run. Pure + exported for unit testing.
 */
export function foregroundTimeoutHint(status: string, timeoutMs: number): string {
  if (status !== 'timed_out') return '';
  return (
    `\n⏱ hit the ${(timeoutMs / 1000).toFixed(0)}s foreground cap (kept below the ~55s MCP transport limit so this returns a hint instead of an opaque request_timeout). ` +
    `This target is too large to verify inline — re-run detached: capability:inspect { …same args…, run_in_background: true }, then poll capability:bash_output.`
  );
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
      'capability:read / Grep (inspect) → capability:inspect (typecheck/test to CONFIRM) → report a VERIFIED diagnosis. For a long suite pass run_in_background:true and poll capability:bash_output; the launch response includes bash_id plus durable task_id.',
    seeAlso: [
      'capability:read (raw file content)',
      'capability:bash (arbitrary / mutating command — gated)',
      'capability:bash_output (poll a long suite)',
    ],
  },
  capability: 'capability:code-inspect',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  // Mirror capability:bash: the dispatch wall-clock must exceed the max command timeout.
  timeoutSec: Math.floor(MAX_TIMEOUT_MS / 1000) + 30,
  // EI-18666279107998059: same rationale as capability:bash — this handler awaits
  // the same bash-jobs runner and never reads ctx.tx, so it must not hold the
  // ambient workspace transaction open for the whole run. See
  // ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
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
      .max(MAX_BACKGROUND_TIMEOUT_MS)
      .optional()
      .describe(
        `Wall-clock timeout in ms. FOREGROUND: default ${DEFAULT_TIMEOUT_MS}, clamped to ${FOREGROUND_TIMEOUT_CEILING_MS}ms (below the ~55s MCP transport cap) so it returns a hint instead of an opaque request_timeout. BACKGROUND (run_in_background): default ${DEFAULT_BACKGROUND_TIMEOUT_MS}, max ${MAX_BACKGROUND_TIMEOUT_MS} — not bound by the transport cap, but still terminated at its own deadline.`,
      ),
  }),
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);
    const resolved = resolveInspectCommand(args, baseDir);
    if (!resolved.ok) return err(resolved.reason, resolved.message);
    const { command } = resolved;
    let cwd = resolved.cwd;

    // EI-19332092038566982 / EI-19331889744736428: `cwd` must be a real directory or spawn fails
    // with an opaque `spawn ENOTDIR`. Validate (and auto-correct the tsconfig-file case) BEFORE
    // ever reaching spawn, foreground or background.
    let cwdCorrectionNote = '';
    let cwdIsDirectory = false;
    try {
      cwdIsDirectory = (await stat(cwd)).isDirectory();
    } catch {
      cwdIsDirectory = false;
    }
    const cwdResolution = resolveTypecheckCwd(cwd, cwdIsDirectory);
    if (!cwdResolution.ok) return err(cwdResolution.reason, cwdResolution.message);
    if (cwdResolution.corrected) {
      cwd = cwdResolution.cwd;
      cwdCorrectionNote = `⚠ \`package\` named a tsconfig.json file, not its directory — auto-corrected to run in ${relative(baseDir, cwd) || '.'}.\n`;
    }

    // WI-6677: mode-dependent default, same as capability:bash. A detached suite is
    // exactly what run_in_background is FOR here, so it must not inherit the short
    // foreground default that exists to stay under the MCP transport cap.
    const requestedTimeoutMs =
      args.timeout ?? (args.run_in_background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    // Reuse the capability:bash OS sandbox (P-022/D-008) on the operator-side exec.
    const sandboxEnabled = await capabilityExecSandboxEnabled();

    // EI-20019651513530828: pin the tsc child's heap. operator-core overflows node's
    // DEFAULT ~4GB old-space and is killed BEFORE emitting any diagnostics, which reads
    // as a clean compile to every natural probe. Typecheck only — a suite run has its
    // own memory profile and is not the measured failure.
    const execEnv = args.check === 'typecheck' ? tscHeapEnv() : undefined;

    if (args.run_in_background) {
      // Background is uncapped by the MCP transport (returns a bash_id immediately), so it
      // honors the full requested timeout.
      const job = startBackground({ command, cwd, stateDir: ctx.stateDir, sandboxEnabled, env: execEnv }, requestedTimeoutMs);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              bash_id: job.id,
              task_id: job.taskId,
              status: 'running',
              check: args.check,
              command,
              cwd,
              log_path: job.logPath,
              advice: `${cwdCorrectionNote}Verification started. Read output: capability:bash_output { bash_id: "${job.id}" }. Stop: capability:bash_kill { bash_id: "${job.id}" }.`,
            }),
          },
        ],
      };
    }

    // EI-6073: clamp the foreground timeout below the ~55s MCP transport cap so the tool
    // returns a graceful timeout + hint instead of being hard-killed with an opaque
    // request_timeout (the friction on large packages like operator-core).
    const timeoutMs = clampForegroundTimeoutMs(requestedTimeoutMs);
    const r = await runForeground(
      { command, cwd, stateDir: ctx.stateDir, onChunk: (chunk) => ctx.emit('output', chunk), sandboxEnabled, env: execEnv },
      ctx.signal,
      timeoutMs,
    );

    // onlyPaths (typecheck): collapse a noisy package's tsc output to just the
    // errors in the agent's changed files + an "N matching of M total" summary —
    // the answer to "did MY change add a NEW error". Output post-process only.
    if (args.check === 'typecheck' && args.onlyPaths && args.onlyPaths.length > 0) {
      const f = filterTscOutputToPaths(r.output, args.onlyPaths);
      // EI-20019651513530828: a DEAD run reaches here with totalErrors 0, so the filter
      // finds nothing and the body below would assert "(no tsc errors in the specified
      // paths)" — a clean verdict from a compile that never ran. Decide that FIRST.
      const dead = deadTypecheckVerdict({
        exitCode: r.exitCode,
        status: r.status,
        output: r.output,
        parsedErrors: f.totalErrors,
      });
      const summary =
        `${args.check} · exit ${r.exitCode ?? 'null'}` +
        (r.status !== 'completed' ? ` (${r.status})` : '') +
        ` · ${(r.durationMs / 1000).toFixed(1)}s · onlyPaths(${args.onlyPaths.length}): ` +
        (dead
          ? 'NO VERDICT — the run died (see below)'
          : `${f.matchedErrors} matching error(s) of ${f.totalErrors} total`) +
        (r.truncated ? ` · ⚠ output truncated (${r.totalBytes} bytes) → ${r.logPath}; the filter saw the head only` : '');
      const body = dead
        ? `${dead.headline}\n${dead.advice}\nreason: ${dead.reason}\n\n--- raw output ---\n${r.output || '(no output)'}`
        : f.matchedLines.length > 0
          ? f.matchedLines.join('\n')
          : '(no tsc errors in the specified paths)';
      return {
        content: [{ type: 'text' as const, text: `${cwdCorrectionNote}${summary}${foregroundTimeoutHint(r.status, timeoutMs)}\n${body}` }],
        isError: dead !== null,
      };
    }

    // Unfiltered typecheck: the same false green, one step earlier. `(no output)` or a
    // truncated OOM trace reads as "nothing to report" unless the death is NAMED.
    const deadUnfiltered =
      args.check === 'typecheck'
        ? deadTypecheckVerdict({
            exitCode: r.exitCode,
            status: r.status,
            output: r.output,
            parsedErrors: filterTscOutputToPaths(r.output, []).totalErrors,
          })
        : null;

    const header =
      `${args.check} · exit ${r.exitCode ?? 'null'}` +
      (r.status !== 'completed' ? ` (${r.status})` : '') +
      ` · ${(r.durationMs / 1000).toFixed(1)}s · ${command} · cwd ${cwd}` +
      (r.truncated ? ` · output spilled (${r.totalBytes} bytes) → ${r.logPath}` : '');

    const deadBanner = deadUnfiltered
      ? `\n${deadUnfiltered.headline}\n${deadUnfiltered.advice}\nreason: ${deadUnfiltered.reason}`
      : '';

    return {
      content: [
        {
          type: 'text' as const,
          text: `${cwdCorrectionNote}${header}${deadBanner}${foregroundTimeoutHint(r.status, timeoutMs)}\n${r.output || '(no output)'}`,
        },
      ],
      // A crash that produced no diagnostics is an ERROR, not a quiet pass. This used to
      // require exitCode === null, so an OOM (exit 134) was not flagged at all.
      isError: deadUnfiltered !== null || (r.status === 'failed' && r.exitCode === null),
    };
  },
});

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}
