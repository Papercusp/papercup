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
import runTool from '../run';

/**
 * Invoke the tool's raw handler. Called directly (rather than through the MCP
 * dispatcher) a handler returns its own return value verbatim — for this tool
 * `{ data }`. The MCP `{ content: [{ text }] }` envelope is applied by the
 * transport layer above, so unwrap both shapes rather than assuming either.
 */
function call(args: Record<string, unknown>) {
  return (runTool as unknown as {
    handler: (a: unknown, c: unknown) => Promise<unknown>;
  }).handler(args, {});
}

/** The envelope testing:run returns (success and error shapes together). */
interface RunResult {
  ok: boolean;
  runId?: string;
  error?: string;
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

/**
 * A green target in a DIFFERENT workspace (apps/operator), so a request naming both
 * routes into TWO groups — the only shape that can exhibit EI-18822211427354845.
 * Chosen for being a pure readFileSync text guard: fast, PG-free, no Tauri/Xvfb.
 */
const CROSS_WORKSPACE_GREEN_TARGET = 'apps/operator/lib/verify-tauri-headless-port-straggler.test.ts';

describe('testing:run (integration)', () => {
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
  }, 180_000);

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

  // The same false-green in its most tempting form: a path that genuinely
  // EXISTS, so nothing looks wrong, but holds no tests.
  it('refuses an existing NON-TEST source file instead of passing vacuously', async () => {
    const out = await body(call({ files: ['packages/operator-core/lib/testing-run-store.ts'] }));

    expect(out.ok).toBe(false);
    expect(['route_error', 'no_report']).toContain(out.error);
  }, 180_000);
});
