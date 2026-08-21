/**
 * testing:run — integration coverage for the GLUE (plan
 * `bash-to-tool-substitution-2026-07-26`, P-021 / D-022).
 *
 * Deliberately integration, not unit: this tool's whole job is to shell the
 * real `scripts/test-files.mjs` and read back what Vitest actually wrote. A
 * mocked spawn would pin my MODEL of the router's contract, which is precisely
 * the thing worth verifying — the tool rests on the router forwarding
 * `--reporter=json --outputFile` through its own `--` argument split, and on
 * `inferWorkspaceRoot()` resolving the REPO root (not the package root) so
 * `<root>/scripts/test-files.mjs` exists.
 *
 * The PROJECTION is not retested here — `distillVitestRun` has full unit
 * coverage over hand-built reports in `lib/__tests__/testing-run-store.test.ts`
 * (including the collection-failure case, which is drill-proven). What only a
 * real run can establish is the seam, so that is all this file spends its
 * minutes on.
 *
 * NOTE ON THE MISSING RED-RUN CASE: asserting a real FAILING run would need a
 * deliberately-failing test file inside the repo, which the normal suite would
 * then collect — a committed red that would hold the fleet's green gate. Not
 * worth it: the failure projection is exhaustively unit-tested, and the glue
 * path is identical for pass and fail (same spawn, same report, same distil).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import runTool, { discoverKnownHiveCheckoutRoots, normalizeTestFilePaths } from '../run';

/**
 * Invoke the tool's raw handler. Called directly (rather than through the MCP
 * dispatcher) a handler returns its own return value verbatim — for this tool
 * `{ data }`. The MCP `{ content: [{ text }] }` envelope is applied by the
 * transport layer above, so unwrap both shapes rather than assuming either.
 * `ctx` defaults to `{}` (no projectDir — resolves via PAPERCUSP_INTEGRATION_ROOT
 * or cwd, both the real repo root under vitest); WI-7189's `invalid_root` case
 * overrides it with a fake `projectDir` to exercise the wrong-tree path.
 */
function call(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (runTool as unknown as {
    handler: (a: unknown, c: unknown) => Promise<unknown>;
  }).handler(args, ctx);
}

/** The envelope testing:run returns (success and error shapes together). */
interface RunResult {
  ok: boolean;
  runId?: string;
  root?: string;
  error?: string;
  hint?: string;
  routerOutput?: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  files?: number;
  failures?: Array<{ file: string; test: string; message: string }>;
  failuresTruncated?: boolean;
  durationMs?: number | null;
}

async function body(p: ReturnType<typeof call>): Promise<RunResult> {
  const raw = (await p) as { data?: unknown; content?: Array<{ text: string }> };
  if (raw?.data !== undefined) return raw.data as RunResult;
  if (raw?.content?.[0]?.text) return JSON.parse(raw.content[0].text) as RunResult;
  throw new Error(`unrecognised tool result shape: ${JSON.stringify(raw)?.slice(0, 200)}`);
}

/** A small, stable, PG-free unit suite in this package — a real green target. */
const GREEN_TARGET = 'packages/operator-core/lib/testing-flakiness.test.ts';
const OPERATOR_CORE_RELATIVE_GREEN_TARGET = 'lib/testing-flakiness.test.ts';

/**
 * A name-filter fragment that DOES match inside GREEN_TARGET. Deliberately its top-level
 * `describe` — the name of the exported function under test — so this is only a tripwire for a
 * real API rename, not for incidental edits to the suite (same reasoning as the un-pinned counts
 * above). Vitest matches the FULL name, so a `describe` fragment matches every test beneath it.
 */
const GREEN_TARGET_TEST_NAME_FRAGMENT = 'computeFlakiness';

/**
 * A green target in a DIFFERENT workspace (apps/operator), so a request naming both
 * routes into TWO groups — the only shape that can exhibit EI-18822211427354845.
 * Chosen for being a pure readFileSync text guard: fast, PG-free, no Tauri/Xvfb.
 */
const CROSS_WORKSPACE_GREEN_TARGET = 'apps/operator/lib/verify-tauri-headless-port-straggler.test.ts';

// The real SideStage checkout is the measured external-Hive case. Keep the target discovery
// dynamic so this suite remains portable to boxes that do not have a local Hive seed; the test
// is skipped there, while the live validation lane runs it whenever the target exists.
const SIDESTAGE_HIVE_ROOT = discoverKnownHiveCheckoutRoots().find(
  (root) => root.endsWith('/sidestage') && existsSync(join(root, 'apps/web/src/auction.test.tsx')),
);

/**
 * Every process in a `testing:run` invocation's tree (the router + the vitest
 * it spawns via `spawnSync`) inherits `PAPERCUSP_TEST_RUN_GROUP=<runId>` in its
 * environment (run.ts stamps it explicitly for the admin-test-runs-reporter).
 * That makes it a reliable, collision-free marker for "is anything from THIS
 * specific run still alive" on a box where many other agents' unrelated vitest
 * processes are routinely running concurrently — scanning by test-file name or
 * `vitest` alone would false-positive on their traffic.
 */
async function pidsTaggedWithRun(runId: string): Promise<number[]> {
  const marker = `PAPERCUSP_TEST_RUN_GROUP=${runId}`;
  const entries = await readdir('/proc').catch(() => [] as string[]);
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const environ = await readFile(`/proc/${entry}/environ`, 'utf8').catch(() => null);
    // /proc/<pid>/environ is NUL-separated, not newline-separated — a plain
    // .includes() still finds the marker fine since we only need substring presence.
    if (environ && environ.includes(marker)) pids.push(Number(entry));
  }
  return pids;
}

describe('testing:run (integration)', () => {
  it('applies the shared tmpdir guard before creating its report directory', () => {
    const source = readFileSync(new URL('../run.ts', import.meta.url), 'utf8');
    const coreStart = source.indexOf('export async function runTestFilesCore');
    const guardCall = source.indexOf('ensurePapercuspTmpdir();', coreStart);
    const reportDirCall = source.indexOf('mkdtemp(join(tmpdir(),', coreStart);

    expect(coreStart).toBeGreaterThan(-1);
    expect(guardCall).toBeGreaterThan(coreStart);
    expect(reportDirCall).toBeGreaterThan(guardCall);
  });

  it.skipIf(!SIDESTAGE_HIVE_ROOT)('routes an absolute test path through its external Hive Vitest checkout', async () => {
    const out = await body(
      call({ files: [join(SIDESTAGE_HIVE_ROOT as string, 'apps/web/src/auction.test.tsx')] }),
    );

    expect(out.ok).toBe(true);
    expect(out.failed).toBe(0);
    expect(out.files).toBe(1);
    expect(out.passed).toBeGreaterThan(0);
    expect(out.root).toBe(SIDESTAGE_HIVE_ROOT);
  }, 180_000);

  it('runs a real file through the router and returns a distilled green result', async () => {
    const out = await body(call({ files: [GREEN_TARGET] }));

    expect(out.ok).toBe(true);
    expect(out.failed).toBe(0);
    // Not pinned to an exact count — that would make this test a tripwire for
    // unrelated edits to the target suite. The contract is "tests ran and the
    // counts came back", not a specific number.
    expect(out.passed).toBeGreaterThan(0);
    expect(out.files).toBe(1);
    expect(out.failures).toEqual([]);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof out.runId).toBe('string');
    // WI-7189: `root` must be echoed so a wrong-tree run is VISIBLE, not silent —
    // and it must be the real repo root (has the router script the run just used),
    // never some other resolved tree such as a stale harness clone.
    expect(typeof out.root).toBe('string');
    const routerScript = await readFile(join(out.root as string, 'scripts', 'test-files.mjs'), 'utf8').catch(() => null);
    expect(routerScript).not.toBeNull();
  }, 180_000);

  it('accepts a workspace-relative test path and expands it before routing', async () => {
    const out = await body(call({ files: [OPERATOR_CORE_RELATIVE_GREEN_TARGET] }));

    expect(out.ok).toBe(true);
    expect(out.failed).toBe(0);
    expect(out.files).toBe(1);
    expect(out.passed).toBeGreaterThan(0);
  }, 180_000);

  it('refuses a workspace-relative path that exists in multiple workspaces', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-ambiguous-'));
    try {
      await mkdir(join(fixture, 'packages', 'one'), { recursive: true });
      await mkdir(join(fixture, 'packages', 'two'), { recursive: true });
      await writeFile(join(fixture, 'packages', 'one', 'shared.test.ts'), '');
      await writeFile(join(fixture, 'packages', 'two', 'shared.test.ts'), '');

      expect(normalizeTestFilePaths(
        ['shared.test.ts'],
        fixture,
        ['packages/one', 'packages/two'],
      )).toEqual({
        ok: false,
        path: 'shared.test.ts',
        matches: ['packages/one/shared.test.ts', 'packages/two/shared.test.ts'],
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  // EI-18822211427354845 — THE case this suite was missing, and the only one that
  // can exhibit the bug. The router runs ONE `vitest run` per owning workspace
  // config, and every group used to be handed the SAME `--outputFile`: each group
  // overwrote the last, so the tool distilled ONE group and reported it as the whole
  // run. Live incident: a RED operator-core file plus a green apps/operator file
  // returned `passed:7, failed:0, files:1, failures:[]` — an empty failure list for a
  // red tree. Every prior case here was single-group, where last-writer-wins is
  // indistinguishable from correct, which is exactly why it went unnoticed.
  it('spans MULTIPLE workspaces without one group\'s report overwriting another', async () => {
    const out = await body(call({ files: [GREEN_TARGET, CROSS_WORKSPACE_GREEN_TARGET] }));

    expect(out.ok).toBe(true);
    expect(out.failed).toBe(0);
    // The field that lied: 1 for a two-workspace request. This is the decisive
    // assertion — `files` is summed across the per-group reports, so it can only
    // reach 2 if BOTH were read and merged rather than one overwriting the other.
    expect(out.files).toBe(2);
    expect(out.passed).toBeGreaterThan(0);
    expect(out.failures).toEqual([]);
    // Deliberately not pinned to exact counts, for the same reason as the
    // single-group case above: that would make this a tripwire for unrelated edits
    // to either target suite.
  }, 300_000);

  // THE load-bearing guarantee. A root-level `vitest run <path>` that matches
  // nothing exits 0 under --passWithNoTests — a run that executed NOTHING and
  // reads as a pass. D-021 measured 107 corpus commands in that exact shape.
  // Going through the router makes it inexpressible; this pins that it does.
  it('refuses a nonexistent path instead of passing vacuously', async () => {
    const out = await body(call({ files: ['packages/operator-core/lib/__no_such_file__.test.ts'] }));

    expect(out.ok).toBe(false);
    expect(out.error).toBe('route_error');
    expect(out.routerOutput).toContain('TEST_FILE_ROUTE_ERROR');
  }, 120_000);

  // EI-19425177453558152 — the SAME vacuous-pass class as the case above, through the one
  // argument this suite never covered. A `testNamePattern` matching zero tests left every test
  // SKIPPED and vitest exited 0, so the router reported `status=passed` and this tool returned a
  // green. It fires in the expensive direction: the canonical reason to pass a name filter is to
  // confirm a pre-fix RED, and a false green there reads as "the defect isn't real", so the
  // natural next move is to stop — having verified nothing.
  it('refuses a testNamePattern that matches ZERO tests instead of passing vacuously', async () => {
    const out = await body(call({ files: [GREEN_TARGET], testNamePattern: 'zzz-no-such-test-name' }));

    expect(out.ok).toBe(false);
    expect(out.error).toBe('name_filter_no_match');
    // The reason must be STATED. `ok:false` next to `failed:0` is exactly the shape an agent
    // misreads as "nothing failed", which is how this bug survives one layer down.
    expect(String(out.hint)).toContain('ZERO tests');
    // The tests really were collected-then-skipped — i.e. this refused a VACUOUS run, it did not
    // merely fail to find the file (which `route_error` already covers).
    expect(out.skipped).toBeGreaterThan(0);
  }, 120_000);

  // Non-vacuousness for the case above: it would also pass if ANY name filter were refused.
  it('still runs normally when the testNamePattern DOES match', async () => {
    const out = await body(call({ files: [GREEN_TARGET], testNamePattern: GREEN_TARGET_TEST_NAME_FRAGMENT }));

    expect(out.ok).toBe(true);
    expect(out.passed).toBeGreaterThan(0);
  }, 120_000);

  // WI-7189 / EI-19383071792758676: the failure mode the router's own check
  // CANNOT catch — a resolved workspace root that isn't a papercusp checkout at
  // all (e.g. a stale/legacy clone missing scripts/test-files.mjs). Before this
  // fix that surfaced two layers down as an opaque spawn error; now it's a named,
  // loud refusal that echoes the wrong root instead of silently running (or
  // failing to run) against it.
  it('refuses a resolved root that is not a papercusp checkout (invalid_root)', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-invalid-root-'));
    try {
      const out = await body(call({ files: ['whatever.test.ts'] }, { projectDir: fakeRoot }));

      expect(out.ok).toBe(false);
      expect(out.error).toBe('invalid_root');
      expect(out.root).toBe(await realpath(fakeRoot));
      expect(out.hint).toContain('scripts/test-files.mjs');
    } finally {
      await rm(fakeRoot, { recursive: true, force: true }).catch(() => { /* best-effort */ });
    }
  }, 30_000);

  // The same false-green in its most tempting form: a path that genuinely
  // EXISTS, so nothing looks wrong, but holds no tests.
  it('refuses an existing NON-TEST source file instead of passing vacuously', async () => {
    const out = await body(call({ files: ['packages/operator-core/lib/testing-run-store.ts'] }));

    expect(out.ok).toBe(false);
    expect(['route_error', 'no_report']).toContain(out.error);
  }, 180_000);

  // EI-19324351741370770: the foreground timeout used to kill only the router
  // process (`scripts/test-files.mjs`'s own pid) — but the router launches the REAL
  // vitest run via a synchronous `spawnSync`, WITHOUT its own `detached: true`, so
  // that vitest process merely inherited the router's process group rather than
  // dying with it. Killing the router by its own pid left vitest running as an
  // orphan for the suite's real duration — invisible to the caller, who was handed
  // `error:'timeout'` and reasonably believed nothing was still running, then
  // (per the tool's own advice) launched a SECOND concurrent run of the same suite.
  //
  // A timeoutMs at zod's floor (1000ms) reliably fires before ANY real vitest cold
  // start completes, so this deterministically exercises the timeout branch rather
  // than racing a fast pass. Two green targets (spanning two workspaces) make the
  // run slower still, widening the margin.
  it(
    'kills the WHOLE process tree on the foreground timeout — no orphan survives',
    async () => {
      const out = await body(call({
        files: [GREEN_TARGET, CROSS_WORKSPACE_GREEN_TARGET],
        timeoutMs: 1000,
      }));

      expect(out.ok).toBe(false);
      expect(out.error).toBe('timeout');
      expect(typeof out.runId).toBe('string');

      // Give the SIGTERM → (5s) → SIGKILL fallback (run.ts's own `killGroup` retry)
      // time to land before asserting on the absence of survivors.
      await new Promise((resolve) => setTimeout(resolve, 8000));

      const survivors = await pidsTaggedWithRun(out.runId as string);
      expect(survivors).toEqual([]);
    },
    30_000,
  );

  // EI-20949515346526475: code:run can terminate its worker while an inner testing:run
  // handler is still blocked in the router. The inner handler must honor that caller-owned
  // signal and kill the SAME process group; otherwise the Vitest suite survives after the
  // outer wrapper already returned and a retry starts a duplicate run.
  it(
    'kills the whole process tree when the caller aborts an in-flight run',
    async () => {
      const controller = new AbortController();
      const runPromise = body(
        call(
          { files: [GREEN_TARGET, CROSS_WORKSPACE_GREEN_TARGET], timeoutMs: 30_000 },
          { signal: controller.signal },
        ),
      );
      setTimeout(() => controller.abort(), 500);

      const out = await runPromise;
      expect(out.ok).toBe(false);
      expect(out.error).toBe('aborted');
      expect(typeof out.runId).toBe('string');

      const survivors = await pidsTaggedWithRun(out.runId as string);
      expect(survivors).toEqual([]);
    },
    30_000,
  );
});
