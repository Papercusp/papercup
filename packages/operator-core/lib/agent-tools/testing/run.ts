/**
 * testing:run — run exact test files and return a DISTILLED result.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-021 (D-021 measurement,
 * D-022 design ruling).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * D-021 measured the 7d corpus: 2,645 test-running atoms across 68 of 86 su
 * sessions. Agents already HAVE a good runner and reach for it 70.8% of the
 * time — what they lack is a RESULT. Of 2,620 test-running commands, 84.8%
 * pipe the output to `tail`/`head` (median `tail -60`), 81.7% merge `2>&1`
 * into that pipe, and 15.7% redirect to a log and grep it separately. The
 * command issued immediately after a test run is `cd` 1371x, `grep` 262x,
 * `tail` 109x. The cost this tool removes is the OUTPUT HANDLING, not the
 * execution — which is why it returns counts + per-test failures and offers
 * NO raw-output passthrough (that would re-create the `| tail -80` pipe
 * inside the tool and forfeit the entire saving).
 *
 * ── What it deliberately does NOT reimplement (D-022) ───────────────────────
 * This tool is an ASSEMBLY. `scripts/test-files.mjs` already owns owning-config
 * discovery, the zero/partial-match false-green refusal, the load-adaptive
 * worker cap, mid-install-corruption detection and Vitest-4 silent-collection
 * recovery — so we SHELL it and never re-derive routing. `distillVitestRun`
 * already owns the projection. The `admin-test-runs-reporter` already writes
 * one `harness_shared.test_runs` row per file on every local run, so this tool
 * writes NO rows; it only stamps `PAPERCUSP_TEST_RUN_GROUP=<runId>` so the
 * reporter correlates the run's rows and `testing:flakiness` can find them.
 *
 * ── The correctness argument ────────────────────────────────────────────────
 * 372 raw-`vitest run` commands appear in the corpus across 44 sessions, 107 of
 * them with no `cd` — i.e. root-level `vitest run <path>`, exactly the
 * zero/partial-match false-green the router exists to refuse (a run that
 * silently executes NOTHING and exits 0). ~14% of all test invocations opt out
 * of that guard. Because this tool can only ever go through the router, that
 * bypass is not expressible here.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Exact FILES only — 82% of the measured family ("run these exact file(s)",
 * 69.5% via the router + 12.3% via raw vitest). `test:affected` (7.9%) is NOT
 * covered: `scripts/affected-tests.mjs` runs each workspace's own `npm test`
 * and has no vitest-arg passthrough, so a JSON reporter cannot be plumbed
 * through it without real work. Keep using `npm run test:affected` for that.
 */

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { distillVitestRun } from '../../testing-run-store';
import { inferWorkspaceRoot } from '../../testing-domain-glob';

/** Hard ceiling on a single run, so a wedged suite can never hold a turn open
 *  indefinitely. 21% of corpus commands already hand-wrapped a `timeout`; this
 *  makes that budget the tool's own rather than something each agent re-picks. */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;

/** Router exit codes (scripts/test-files.mjs `main`): 2 = route/launch error,
 *  1 = a refused false-green OR a genuine test failure, 0 = clean pass. */
const ROUTER_EXIT_ROUTE_ERROR = 2;

interface RouterOutcome {
  code: number | null;
  timedOut: boolean;
  output: string;
}

/** Spawn the router, capturing its own diagnostics (TEST_FILE_* lines). */
function runRouter(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RouterOutcome> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(process.execPath, [join(cwd, 'scripts', 'test-files.mjs'), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000).unref();
    }, timeoutMs);
    // Cap retained diagnostics — the router's own output is a fallback for the
    // error paths, never the success path's payload.
    const append = (b: Buffer) => { output = (output + b.toString('utf8')).slice(-8192); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, timedOut, output: `${output}\n[spawn-error] ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, output }); });
  });
}

export default defineTool({
  name: 'testing:run',
  description:
    'Run exact Vitest files through the repo router (scripts/test-files.mjs) and return a DISTILLED result — { passed, failed, skipped, files, failures:[{file,test,message}], durationMs, runId } — instead of raw reporter output you have to tail/grep. Routes each file to its owning workspace config and hard-refuses a zero/partial-match false-green run. Stamps PAPERCUSP_TEST_RUN_GROUP so the run correlates in harness_shared.test_runs.',
  guidance: {
    when: 'You edited code and want to know whether specific test files pass, and which tests failed and why. The default way to run named test files.',
    notWhen: 'Running everything your edits affected (use `npm run test:affected` — not covered here), a non-Vitest suite (cargo/playwright), or when you genuinely need raw reporter output.',
    chaining: 'testing:run → a red here is real (the router refuses false-greens); testing:flakiness { } on a failing file tells you whether it is a known flake before you treat it as your regression.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    files: z.array(z.string().min(1)).min(1).max(50)
      .describe('Test file paths (repo-root-relative or absolute). Each is routed to its owning workspace + Vitest config; a path matching zero tests fails the call rather than passing vacuously.'),
    testNamePattern: z.string().min(1).max(200).optional()
      .describe("Run only tests whose full name matches (Vitest `-t`). Use to re-run ONE failing test from a previous result's `failures[].test`."),
    timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional()
      .describe(`Hard budget for the whole run. Default ${DEFAULT_TIMEOUT_MS}ms.`),
    maxFailures: z.number().int().min(1).max(100).optional()
      .describe('Cap the returned failures list (default 20). Counts stay complete; `failuresTruncated` flags the cut.'),
  }),
  async handler(args, ctx) {
    void ctx;
    const root = inferWorkspaceRoot();
    const runId = randomUUID();
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const dir = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-'));
    const reportPath = join(dir, 'report.json');
    try {
      const vitestArgs = ['--reporter=json', `--outputFile=${reportPath}`];
      if (args.testNamePattern) vitestArgs.push('-t', args.testNamePattern);

      const outcome = await runRouter(
        [...args.files, '--', ...vitestArgs],
        root,
        // The reporter inside the child reads this and stamps run_group_id, so
        // the run's per-file rows are findable afterwards. We write no rows here.
        { ...process.env, PAPERCUSP_TEST_RUN_GROUP: runId },
        timeoutMs,
      );

      if (outcome.timedOut) {
        return { data: { ok: false, runId, error: 'timeout', timeoutMs, routerOutput: outcome.output.slice(-2000) } };
      }
      // A route/launch error never produced a report — surface the router's own
      // diagnostics (they name the cause: unmatched path, mid-install corruption).
      if (outcome.code === ROUTER_EXIT_ROUTE_ERROR || outcome.code === null) {
        return { data: { ok: false, runId, error: 'route_error', routerOutput: outcome.output.slice(-2000) } };
      }

      let reportText: string;
      try {
        reportText = await readFile(reportPath, 'utf8');
      } catch {
        // Exit 1 with no report is the REFUSED false-green (the router bailed
        // before running anything) — the one case where "no results" is the
        // answer, and must never read as a pass.
        return { data: { ok: false, runId, error: 'no_report', routerOutput: outcome.output.slice(-2000) } };
      }

      const run = distillVitestRun(reportText, root, { maxFailures: args.maxFailures });
      return {
        data: {
          ok: run.failed === 0 && outcome.code === 0,
          runId,
          ...run,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
    }
  },
});
