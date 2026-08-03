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
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  boundTestRunPayload,
  distillVitestRun,
  mergeDistilledRuns,
  TESTING_RUN_MAX_PAYLOAD_BYTES,
} from '../../testing-run-store';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import {
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
} from '../capability/inspect';

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
    // EI-19324351741370770: `scripts/test-files.mjs` launches the REAL vitest run via
    // `spawnSync('npx', ['vitest', 'run', ...])` — synchronously, and WITHOUT its own
    // `detached: true` — so that vitest process inherits THIS process's process group
    // rather than becoming reparented on its own. Killing only `child` (the router) by
    // its own pid terminates the router but leaves vitest running as an ORPHAN: Unix
    // never cascade-kills a process's children just because the parent died. That
    // orphan then keeps executing (and holding forks) for the suite's real duration,
    // invisible to the caller, who was told `error:'timeout'` and reasonably assumes
    // nothing is still running. Following the tool's own "re-run it detached" hint then
    // launches a SECOND concurrent run of the same suite.
    //
    // Fix: spawn the router `detached: true` so it becomes the leader of a NEW process
    // group (pgid === its own pid); vitest, spawned without its own `detached`, inherits
    // THAT group. On timeout, signal the NEGATIVE pid — killing the whole process group,
    // router and every child/grandchild it spawned — instead of just the router itself.
    const child = spawn(process.execPath, [join(cwd, 'scripts', 'test-files.mjs'), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Group already gone, or (non-POSIX) negative-pid kill unsupported — fall back
        // to at least killing the router itself so we never silently no-op.
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
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
    'Run exact Vitest files through the repo router (scripts/test-files.mjs) and return a DISTILLED result — { passed, failed, skipped, files, failures:[{file,test,message}], durationMs, runId, root } — instead of raw reporter output you have to tail/grep. `root` is the resolved workspace root the run actually executed in (WI-7189: a run against the wrong tree used to be silent — check `root` if a result looks stale or surprising, e.g. it names a clone under .papercusp-workspaces/clones/ instead of the canonical staging checkout). Routes each file to its owning workspace config and hard-refuses a zero/partial-match false-green run (error `route_error`), or a resolved root that is not a papercusp checkout at all (error `invalid_root`). `failed` is always the TRUE total; `failures` is a bounded sample of it, so when `failuresTruncated` is set read `failuresOmitted`, never `failures.length`. Stamps PAPERCUSP_TEST_RUN_GROUP so the run correlates in harness_shared.test_runs.',
  guidance: {
    when: 'You edited code and want to know whether specific test files pass, and which tests failed and why. The default way to run named test files.',
    notWhen: 'Running everything your edits affected (use `npm run test:affected` — not covered here), a non-Vitest suite (cargo/playwright), or when you genuinely need raw reporter output.',
    chaining: 'testing:run → a red here is real (the router refuses false-greens); testing:flakiness { } on a failing file tells you whether it is a known flake before you treat it as your regression.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  // EI-18803497769946984: the handler shells out to Vitest and blocks for the whole
  // run without ever reading `ctx.tx`. Holding the ambient workspace transaction
  // across that wait trips idle_in_transaction_session_timeout (60s), surfacing as a
  // bare `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    files: z.array(z.string().min(1)).min(1).max(50)
      .describe('Test file paths (repo-root-relative or absolute). Each is routed to its owning workspace + Vitest config; a path matching zero tests fails the call rather than passing vacuously.'),
    testNamePattern: z.string().min(1).max(200).optional()
      .describe("Run only tests whose full name matches (Vitest `-t`). Use to re-run ONE failing test from a previous result's `failures[].test`."),
    timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional()
      .describe(
        `Hard budget for the whole run. Default ${DEFAULT_TIMEOUT_MS}ms, but a FOREGROUND run is clamped to ${FOREGROUND_TIMEOUT_CEILING_MS}ms — below the ~55s MCP transport cap — so a slow suite returns an actionable timeout instead of an opaque transport error. For a longer suite run it detached via capability:inspect { run_in_background: true }.`,
      ),
    maxFailures: z.number().int().min(1).max(100).optional()
      .describe(
        `Cap the returned failures list (default 20). Counts stay complete; \`failuresTruncated\` flags the cut. Note this caps the LIST COUNT, not bytes — the result is separately bounded to ${TESTING_RUN_MAX_PAYLOAD_BYTES} B, which is what actually limits a run with huge assertion diffs.`,
      ),
  }),
  async handler(args, ctx) {
    // EI-1754, again: this tool must judge the tree the AGENT is editing, not the
    // one the operator happens to run from. `inferWorkspaceRoot()` walks up from
    // `process.cwd()`, and the :3070 operator runs FROM the release checkout
    // (papercup-release, pinned to green `main`) — so a superuser's testing:run
    // routed every path into the RELEASE tree. Two failure modes, and the silent
    // one is the dangerous one: a test file present in BOTH trees ran against the
    // stale release copy and came back GREEN for an edit it never saw; a
    // staging-only NEW test file came back `route_error: does not exist`.
    // `resolveCapabilityBaseDir` is the same projectDir → PAPERCUSP_INTEGRATION_ROOT
    // → cwd resolver every capability tool (read/write/edit/bash/inspect) already
    // uses, so this tool now reads the same tree those tools write.
    const root = resolveAgentWorkspaceRoot(ctx);
    const runId = randomUUID();

    // WI-7189 / EI-19383071792758676: a wrong-tree resolution used to be SILENT —
    // a file that happens to exist (with stale content) at the resolved root ran
    // and returned a confident, plausible, WRONG green. `root` is now echoed on
    // EVERY return path below so a wrong-tree run is visible instead of silent
    // (deliberately NOT gated on the requested files existing under root — the
    // router already refuses that loudly via `route_error`/TEST_FILE_ROUTE_ERROR,
    // and duplicating the check here would only race that well-tested path).
    // One additional loud pre-flight refusal catches what the router's own check
    // can't: a root that isn't a papercusp checkout AT ALL — missing the router
    // script itself (e.g. a stale/legacy clone such as
    // `.papercusp-workspaces/clones/papercup`, the known phantom-pot identity
    // `canonicalizeLegacyPapercup` collapses at the registry layer but that a
    // session already scoped to it bypasses). Without this check that case fails
    // as an opaque spawn error two layers down instead of naming the real cause.
    if (!existsSync(join(root, 'scripts', 'test-files.mjs'))) {
      return {
        data: {
          ok: false,
          runId,
          root,
          error: 'invalid_root',
          hint:
            `resolved workspace root '${root}' has no scripts/test-files.mjs — it is not a papercusp ` +
            `checkout (or is a stale/partial one). This usually means the calling session is scoped to ` +
            `the wrong harness/tree (e.g. a legacy standalone clone) rather than the canonical staging ` +
            `checkout. Verify with 'pwd'/'git remote -v' in the tree you intend, and re-check how this ` +
            `session's harness/project is registered.`,
        },
      };
    }
    // EI-18776865728050036 — same clamp as build:typecheck, for the same reason: this tool is
    // dispatched FOREGROUND over an MCP transport that hard-caps a call at ~55s (EI-6073), so a
    // suite slower than that had the call killed before the `error:'timeout'` branch below could
    // return, surfacing as an opaque `CONNECTION_CLOSED`. Clamping makes this handler win the
    // race and hand back an actionable next step.
    const timeoutMs = clampForegroundTimeoutMs(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

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
        return {
          data: {
            ok: false,
            runId,
            root,
            error: 'timeout',
            timeoutMs,
            hint:
              `hit the ${(timeoutMs / 1000).toFixed(0)}s foreground cap (held below the ~55s MCP transport limit so you get this instead of an opaque CONNECTION_CLOSED). ` +
              `This suite is too slow to run inline — re-run it detached: capability:inspect { check: 'test', package: '<owning workspace>', path: '<test file>', run_in_background: true }, then poll capability:bash_output.`,
            routerOutput: outcome.output.slice(-2000),
          },
        };
      }
      // A route/launch error never produced a report — surface the router's own
      // diagnostics (they name the cause: unmatched path, mid-install corruption).
      if (outcome.code === ROUTER_EXIT_ROUTE_ERROR || outcome.code === null) {
        return { data: { ok: false, runId, root, error: 'route_error', routerOutput: outcome.output.slice(-2000) } };
      }

      // EI-18822211427354845: the router runs ONE `vitest run` per owning workspace
      // config, so a request spanning several workspaces writes SEVERAL reports —
      // `report.json`, `report.0.json`, `report.1.json`, … Reading only `reportPath`
      // distilled whichever group happened to write last and reported it as the whole
      // run: a two-workspace request with a RED first group returned `failed:0,
      // failures:[]`. `dir` is a private mkdtemp this handler owns, so every *.json in
      // it belongs to THIS run and can be merged without any output parsing.
      let reportTexts: string[];
      try {
        const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
        reportTexts = (
          await Promise.all(names.map((n) => readFile(join(dir, n), 'utf8').catch(() => null)))
        ).filter((t): t is string => t !== null);
      } catch {
        reportTexts = [];
      }
      if (reportTexts.length === 0) {
        // Exit 1 with no report is the REFUSED false-green (the router bailed
        // before running anything) — the one case where "no results" is the
        // answer, and must never read as a pass.
        return { data: { ok: false, runId, root, error: 'no_report', routerOutput: outcome.output.slice(-2000) } };
      }

      const run = mergeDistilledRuns(
        reportTexts.map((text) => distillVitestRun(text, root, { maxFailures: args.maxFailures })),
        { maxFailures: args.maxFailures },
      );
      // D-062: bound the payload in BYTES, not entries. `maxFailures` caps the
      // LIST COUNT and so cannot bound bytes at all — one long assertion diff
      // outweighs fifty terse failures, which is how this tool reached 20,569 B
      // with 2.6% of calls carrying 28.7% of its total. Counts stay complete and
      // a cut is stated explicitly, so `failures.length` is never readable as
      // "how many failed". A result that already fits is returned untouched.
      return {
        data: boundTestRunPayload(
          { ok: run.failed === 0 && outcome.code === 0, runId, root },
          run,
        ),
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
    }
  },
});
