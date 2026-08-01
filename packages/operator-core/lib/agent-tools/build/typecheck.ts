/**
 * build:typecheck — run `tsc --noEmit` for one project and return DISTILLED
 * diagnostics, refusing a run that would have checked nothing.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-024.
 *
 * ── Why this exists (measured, not assumed) ─────────────────────────────────
 * The 7d corpus holds 622 direct `tsc` atoms across 59 of 86 su sessions — the
 * widest bash family left after git and file-read, and 95% of it is
 * `--noEmit`, i.e. TYPECHECKING rather than building. 72% of the family's
 * whole-commands pipe the compiler's output into `grep`/`head`/`tail` and 17%
 * redirect it to a log file, so agents are pulling a full compiler log across
 * the pipe to throw nearly all of it away. That is the same defect `logs:read`
 * fixed for journalctl, and the reason this tool returns
 * `{ errors:[{file,line,column,code,message}], errorCount, byFile }` and
 * pushes the filtering down (`files`) instead of handing back text.
 *
 * ── The correctness argument: a typecheck that checked NOTHING ──────────────
 * This repo has NO root `tsconfig.json` (only `tsconfig.base.json`), yet the
 * two most common project operands in the corpus are `-p .` (183 atoms) and
 * `-p tsconfig.json` (225). Run from the repo root both fail instantly —
 * TS5057 / TS5058 — having checked zero files. Replaying each session's cwd
 * over the corpus, 45 of 425 decidable `tsc` invocations (11%, across 24 of 86
 * sessions) checked nothing; a cwd-agnostic reading of the same data puts it at
 * 103 of 455 (23%). Either way the failure mode is the same, and what makes it
 * expensive is how it was READ: 42% of those runs were piped into `grep`, and a
 * `grep <my-file>` over a one-line TS5057 prints NOTHING — indistinguishable
 * from "my file is clean". Under `2>&1 | tail`, `$?` is the PIPE's status, so
 * tsc's exit 1 is lost too.
 *
 * So this tool refuses rather than reporting a clean zero, exactly as
 * `testing:run` refuses a zero-match Vitest run. It is the same class as
 * EI-6479 (`npm run typecheck --if-present` silently no-opping) and the fifth
 * instance in this plan of ABSENT EVIDENCE MUST NOT READ AS EVIDENCE OF
 * ABSENCE — after the soak-report's zeroed OOM gate, `dev:listening_ports`'
 * `ownerVisible`, `logs:read`' `unitsUnknown`, and `dev:service_health`'s
 * phantom units.
 *
 * ── What it deliberately does NOT reimplement ───────────────────────────────
 * Nothing about the type-error BASELINE. `scripts/lint-tsc.mjs` +
 * `scripts/lib/tsc-baseline-gate.mjs` own the per-file ratchet, `--mine`
 * scoping and the ratchet-only-down policy; this tool answers the prior, more
 * literal question ("what does tsc say about this project right now") and
 * points at that gate for the verdict. `--incremental false` is inherited from
 * it as a correctness flag, not a style choice (EI-487: a warm tsbuildinfo
 * makes `--noEmit` UNDER-report).
 */

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  errorsOnly,
  filterToFiles,
  noInputDiagnostic,
  parseFoundSummary,
  parseTscDiagnostics,
  summariseByFile,
  syntaxBrokenFiles,
} from '../../tsc-diagnostics';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import {
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
} from '../capability/inspect';

/** A cold full-repo typecheck runs minutes, not seconds; a wedged one must still end. */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;

/**
 * EI-18776865728050036 — this tool is dispatched FOREGROUND over the papercusp-su MCP
 * transport, which hard-caps a call at ~55s (EI-6073). Its own budget above is 300s default /
 * 900s max, so for any project slower than ~55s the transport killed the call BEFORE the
 * `error:'timeout'` branch below could ever be reached — and the failure surfaced as
 * `MCP error -32603: write CONNECTION_CLOSED 127.0.0.1:6432`, an error naming the DATABASE.
 *
 * Measured 2026-07-27: `packages/operator-core` takes 104.4s → failed 3/3, while `libs/flags`
 * (2.1s) succeeded on the identical path. So the tool was structurally unusable on the largest
 * workspace — and the one the repo's own CLAUDE.md tells every agent to typecheck after
 * editing. Worse, the pgbouncer-shaped error sends the reader off to debug PG (it cost me
 * several calls), and the fallback is a hand-rolled `npx tsc` — precisely the trap this tool
 * exists to prevent (`-p .` checks ZERO files and a grep over the one-line TS5057 prints
 * nothing, reading as "clean").
 *
 * EI-6073 already solved this class for the sibling `capability:inspect` — and its comment even
 * names this case ("operator-core's tsc runs 60-90s"). We IMPORT that ceiling rather than
 * re-declaring 50_000 here: a second copy of a transport constant is exactly the kind of twin
 * that drifts silently the day the cap moves.
 */
const DEFAULT_MAX_ERRORS = 50;

/** Depth-bounded scan for real tsconfigs, used only to make a refusal actionable. */
const SUGGEST_ROOTS = ['packages', 'apps', 'libs'];
const MAX_SUGGESTIONS = 12;

interface TscOutcome {
  code: number | null;
  timedOut: boolean;
  output: string;
}

function runTsc(args: string[], cwd: string, timeoutMs: number): Promise<TscOutcome> {
  return new Promise((resolvePromise) => {
    let output = '';
    let settled = false;
    // EI-18793290418757939: the old version gated promise resolution on the
    // child's OWN 'close' event even after the timeout fired — it only killed
    // the child and kept waiting. A killed process is not guaranteed to close
    // promptly: under real memory-pressure thrashing (the WI-5471 class,
    // repeatedly observed on this box via the infra-liveness watchdog: "PSI
    // memory full avg60 ≥ 5 — all tasks stalled on memory reclaim/swap"), a
    // SIGKILL'd child can sit reaping in D-state for many extra seconds. That
    // pushed this tool's real wall-clock time past BOTH the outer MCP-transport
    // deadline (~55s) and the dispatch-stack's own hard AbortController timeout
    // (60s default — this tool declares no static `timeoutSec`, so it inherits
    // that default), producing exactly the watchdog signature this bug reports:
    // "exceeded timeout of 60s (handler returned but signal had aborted)" —
    // the handler eventually DID return, just long after the abort fired.
    // Fix: settle the promise the moment OUR OWN timer fires — kill + reap are
    // best-effort background cleanup from then on, never gating the return.
    const settle = (outcome: TscOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    const child = spawn('npx', ['tsc', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000).unref();
      settle({ code: null, timedOut: true, output });
    }, timeoutMs);
    // Diagnostics are the payload here (unlike testing:run, where the router's
    // output is only an error-path fallback), so the buffer is generous: a
    // full-repo check can emit thousands of lines and truncating the HEAD would
    // silently drop errors rather than merely losing context.
    const append = (b: Buffer) => { output = (output + b.toString('utf8')).slice(-8 * 1024 * 1024); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => { settle({ code: null, timedOut: false, output: `${output}\n[spawn-error] ${e.message}` }); });
    child.on('close', (code) => { settle({ code, timedOut: false, output }); });
  });
}

/**
 * Resolve a project operand the way tsc does: a directory means
 * `<dir>/tsconfig.json`, a file means itself. Returns null when nothing is there.
 */
export function resolveProjectPath(root: string, project: string): string | null {
  const abs = isAbsolute(project) ? project : resolve(root, project);
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      const candidate = join(abs, 'tsconfig.json');
      return existsSync(candidate) ? candidate : null;
    }
    return existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

/**
 * Real tsconfigs near the repo root, so a refusal names what the caller could
 * have meant. This is the whole reason the refusal is useful rather than merely
 * correct: an agent who typed `-p .` out of habit needs the list, not a scolding.
 *
 * The buckets are INTERLEAVED rather than concatenated. Filling the cap in
 * order put all 12 slots into `packages/` (it alone holds more than the cap), so
 * an agent who meant `apps/operator-vite` was handed twelve suggestions with not
 * one `apps/` entry among them — a list that is technically correct and
 * practically useless. Caught by live verification, not by the unit suite.
 */
export function suggestProjects(root: string): string[] {
  const byBucket: string[][] = [];
  for (const bucket of SUGGEST_ROOTS) {
    const dir = resolve(root, bucket);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    const found: string[] = [];
    for (const entry of entries.sort()) {
      const candidate = join(dir, entry, 'tsconfig.json');
      if (existsSync(candidate)) found.push(relative(root, candidate));
    }
    if (found.length > 0) byBucket.push(found);
  }

  const interleaved: string[] = [];
  for (let i = 0; interleaved.length < MAX_SUGGESTIONS; i += 1) {
    const before = interleaved.length;
    for (const bucket of byBucket) {
      if (interleaved.length >= MAX_SUGGESTIONS) break;
      if (i < bucket.length) interleaved.push(bucket[i]);
    }
    if (interleaved.length === before) break; // every bucket exhausted
  }
  return interleaved;
}

export default defineTool({
  name: 'build:typecheck',
  description:
    'Run `tsc --noEmit` for ONE project and return structured diagnostics — { ok, errorCount, errors:[{file,line,column,code,message}], byFile, syntaxBroken } — instead of a compiler log you pipe through grep/tail. REFUSES a run that checked nothing (TS5057/TS5058/TS18003) rather than reporting a clean zero: this repo has no root tsconfig.json, so `-p .` silently checks zero files. `files` filters diagnostics server-side. Runs with --incremental false so a warm tsbuildinfo cannot under-report.',
  guidance: {
    when: 'You edited TypeScript and want to know whether a project typechecks, and exactly which errors are where. Also the way to check a workspace OUTSIDE operator-core, which `npm run lint:tsc` does not cover.',
    notWhen: 'You want the baseline VERDICT on whether your change added errors — that is `npm run lint:tsc -- --mine` (per-file ratchet, peer-drift aware), which this tool does not replace. Not for building/emitting, eslint, or cargo.',
    chaining: 'build:typecheck { project, files } → fix → re-run scoped to the same `files`; then `npm run lint:tsc -- --mine` for the gate verdict.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  // EI-18803497769946984: the handler shells out to `tsc` and blocks for as long as
  // that takes (observed up to 141s) without ever reading `ctx.tx`. Holding the
  // ambient workspace transaction across that wait trips
  // idle_in_transaction_session_timeout (60s) and surfaces as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    project: z.string().min(1).max(400)
      .describe('tsconfig path, or a directory containing one — repo-root-relative or absolute (e.g. "packages/operator-core" or "apps/operator/tsconfig.json"). REQUIRED and deliberately un-defaulted: this repo has no root tsconfig.json, so any default would be the exact silent no-op this tool exists to refuse.'),
    files: z.array(z.string().min(1)).max(50).optional()
      .describe('Return only diagnostics in these files (matched by path suffix). The server-side form of `| grep -E "myfile"` — the whole project is still checked, so counts stay honest; `errorCount` is the filtered count and `totalErrorCount` the project-wide one.'),
    maxErrors: z.number().int().min(1).max(500).optional()
      .describe(`Cap the returned errors list (default ${DEFAULT_MAX_ERRORS}). Counts and byFile stay complete; errorsTruncated flags the cut.`),
    timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional()
      .describe(
        `Hard budget for the compile. Default ${DEFAULT_TIMEOUT_MS}ms, but a FOREGROUND run is clamped to ${FOREGROUND_TIMEOUT_CEILING_MS}ms — below the ~55s MCP transport cap — so an over-long compile returns an actionable timeout instead of an opaque transport error. A project that needs longer (packages/operator-core is ~104s) must run detached via capability:inspect { run_in_background: true }.`,
      ),
    incremental: z.boolean().optional()
      .describe('Allow tsc to use a warm tsconfig.tsbuildinfo. Default false — EI-487: an incremental run UNDER-reports errors in files the cache has not reindexed, which read as green for days. Only set true when you want a fast re-check and already know the tree is warm.'),
  }),
  async handler(args, ctx) {
    // EI-1754 (same defect as testing:run): `inferWorkspaceRoot()` walks up from
    // `process.cwd()`, and the :3070 operator runs FROM the release checkout — so
    // this tool typechecked the RELEASE tree, not the tree the agent just edited,
    // and reported it clean. Use the same projectDir → PAPERCUSP_INTEGRATION_ROOT
    // → cwd resolver every capability tool uses.
    const root = resolveAgentWorkspaceRoot(ctx);
    const started = Date.now();

    // Pre-flight the project so the refusal can be specific and name alternatives.
    // tsc's own verdict (below) stays authoritative — this only catches the case
    // early and with a better message.
    const resolved = resolveProjectPath(root, args.project);
    if (!resolved) {
      return {
        data: {
          ok: false,
          error: 'project_not_found',
          project: args.project,
          searchedFrom: root,
          message:
            `No tsconfig at "${args.project}". Nothing would have been typechecked — ` +
            'this is the failure mode the tool refuses rather than reporting zero errors.' +
            (existsSync(resolve(root, 'tsconfig.base.json')) && /^\.?$|^tsconfig\.json$/.test(args.project)
              ? ' The repo root has only tsconfig.base.json (a shared base, not a project), which is why `-p .` and `-p tsconfig.json` check nothing here.'
              : ''),
          availableProjects: suggestProjects(root),
        },
      };
    }

    // Clamp BELOW the ~55s MCP transport cap so this handler always wins the race and can
    // return the structured timeout below, instead of the transport killing the call and
    // surfacing an opaque `CONNECTION_CLOSED 127.0.0.1:6432` (EI-18776865728050036).
    const timeoutMs = clampForegroundTimeoutMs(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const tscArgs = ['--noEmit', '--pretty', 'false', '-p', resolved];
    if (args.incremental !== true) tscArgs.push('--incremental', 'false');

    const outcome = await runTsc(tscArgs, root, timeoutMs);
    const durationMs = Date.now() - started;

    if (outcome.timedOut) {
      return {
        data: {
          ok: false,
          error: 'timeout',
          project: relative(root, resolved),
          timeoutMs,
          durationMs,
          // The whole point of the clamp: a timeout must hand back a WORKING next step, not a
          // dead end. `capability:inspect` already runs a detached, uncapped typecheck and its
          // `onlyPaths` does server-side filtering to just the files you changed — which is the
          // real answer for a project this size (EI-18776865728050036).
          hint:
            `hit the ${(timeoutMs / 1000).toFixed(0)}s foreground cap (held below the ~55s MCP transport limit so you get this instead of an opaque CONNECTION_CLOSED). ` +
            `This project is too large to typecheck inline — re-run it detached: ` +
            `capability:inspect { check: 'typecheck', package: '${relative(root, resolved) || '.'}', run_in_background: true, onlyPaths: ['<your changed files>'] }, ` +
            `then poll capability:bash_output. Do NOT fall back to a hand-rolled \`npx tsc -p .\` — it checks ZERO files here and reads as clean.`,
          output: outcome.output.slice(-2000),
        },
      };
    }

    const diagnostics = parseTscDiagnostics(outcome.output);

    // A run that produced no diagnostics AND did not exit 0 never really ran —
    // never let that read as "clean". Same guard the baseline gate applies.
    if (diagnostics.length === 0 && outcome.code !== 0) {
      return {
        data: {
          ok: false,
          error: 'tsc_failed_to_run',
          project: relative(root, resolved),
          exitCode: outcome.code,
          durationMs,
          message: 'tsc exited non-zero with no parseable diagnostics — a toolchain failure, NOT a clean run.',
          output: outcome.output.slice(-2000),
        },
      };
    }

    // tsc's own word on "I checked nothing" — catches TS18003 (a real tsconfig
    // whose include/files match no inputs), which no path check can predict.
    const noInput = noInputDiagnostic(diagnostics);
    if (noInput) {
      return {
        data: {
          ok: false,
          error: 'nothing_typechecked',
          project: relative(root, resolved),
          code: noInput.code,
          durationMs,
          message: `${noInput.code}: ${noInput.message} — zero files were typechecked, so this is NOT a clean result.`,
          availableProjects: suggestProjects(root),
        },
      };
    }

    const errors = errorsOnly(diagnostics);
    const byFile = summariseByFile(errors);
    const shown = args.files ? filterToFiles(errors, args.files) : errors;
    const maxErrors = args.maxErrors ?? DEFAULT_MAX_ERRORS;
    const reported = parseFoundSummary(outcome.output);

    return {
      data: {
        ok: errors.length === 0 && outcome.code === 0,
        project: relative(root, resolved),
        errorCount: shown.length,
        ...(args.files ? { totalErrorCount: errors.length, filteredTo: args.files } : {}),
        errors: shown.slice(0, maxErrors),
        errorsTruncated: shown.length > maxErrors,
        byFile: byFile.slice(0, 30),
        filesWithErrors: byFile.length,
        syntaxBroken: syntaxBrokenFiles(errors),
        durationMs,
        exitCode: outcome.code,
        // Cross-check against tsc's own tally: a mismatch means the diagnostic
        // grammar drifted (a compiler upgrade), and the caller is told rather
        // than handed a silently wrong number.
        ...(reported !== null && reported !== errors.length
          ? { parseWarning: `tsc reported ${reported} errors but ${errors.length} were parsed — the diagnostic format may have changed; treat counts as approximate.` }
          : {}),
      },
    };
  },
});
