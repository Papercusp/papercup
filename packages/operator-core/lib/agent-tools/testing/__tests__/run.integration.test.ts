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
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { REPO_ROOT } from '../../docs/_repo-paths';
import runTool, {
  buildDetachedMixedTestRunRequest,
  buildDetachedTestRunRequest,
  buildTestProcessDemand,
  classifyTestProcessOutcome,
  checkoutRootForTestFiles,
  createTestProcessDemandSampler,
  detachedTestTimeoutHint,
  discoverKnownHiveCheckoutRoots,
  groupDirectVitestRoutes,
  normalizeTestFilePaths,
  parseRouterTerminalCompletion,
  parseRouterNotMeasuredMarker,
  parseRouterTestResult,
  readTestProcessResourceSnapshot,
  runTestFilesCore,
  runWithTestProcessDeadline,
  resolveAdminTestRunsReporterPath,
  selectTestFileRoot,
  shouldResolveHarnessTestRunIds,
  shouldIngestVitestLedgerInProcess,
} from '../run';
import { cancelRun, getRun } from '../../../testing-run-store';

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
  return (
    runTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<unknown>;
    }
  ).handler(args, ctx);
}

/** The envelope testing:run returns (success and error shapes together). */
interface RunResult {
  ok: boolean;
  runId?: string;
  root?: string;
  rootSource?: string;
  error?: string;
  detachedRunId?: string;
  hint?: string;
  routerOutput?: string;
  status?: 'not-measured';
  reason?: 'admission-starved' | 'undetermined';
  requested?: number;
  executed?: number;
  matched?: number;
  measuredFiles?: 0;
  passed?: number;
  failed?: number;
  skipped?: number;
  files?: number;
  failures?: Array<{ file: string; test: string; message: string; actual?: string; expected?: string }>;
  failuresTruncated?: boolean;
  durationMs?: number | null;
  testRunIds?: number[];
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
 * A real in-repo suite that collects tests and executes NONE of them unless its env var is set
 * (`describe.skipIf(!LIVE)`), for the all-skipped refusal. Deliberately a real file rather than a
 * fixture: an always-skipped fixture committed for this test would itself be collected by every
 * normal run. If this suite is ever un-gated, the case fails loudly instead of going vacuous.
 */
const ENV_GATED_TARGET = 'packages/operator-core/lib/agent-tools/computer/capture-geometry-live.test.ts';
const ENV_GATED_TARGET_VAR = 'PAPERCUSP_CAPTURE_GEOMETRY_LIVE';

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
const NODE_TEST_TARGET = 'papercusp-desktop/test/mac-vm-health.test.js';

// The real SideStage checkout is the measured external-Hive case. Keep the target discovery
// dynamic so this suite remains portable to boxes that do not have a local Hive seed; the test
// is skipped there, while the live validation lane runs it whenever the target exists.
const SIDESTAGE_HIVE_ROOT = discoverKnownHiveCheckoutRoots().find(
  (root) => root.endsWith('/sidestage') && existsSync(join(root, 'apps/web/src/auction.test.tsx')),
);
const SIDESTAGE_LAYERED_TARGET = SIDESTAGE_HIVE_ROOT
  ? join(SIDESTAGE_HIVE_ROOT, 'apps/web/src/CopilotPanel.integration.test.tsx')
  : null;

const selectorRoots: string[] = [];
const selectorPhantom = join(tmpdir(), 'papercusp-testing-run-selector-phantom-does-not-exist');
let selectorCanonical = '';
let selectorRequested = '';

async function makeScratchTestCheckout(prefix: string, file = 'packages/x/real.test.ts'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  selectorRoots.push(root);
  await mkdir(join(root, '.git'));
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
  await writeFile(join(root, file), 'export {};\n');
  return root;
}

beforeAll(async () => {
  selectorCanonical = await makeScratchTestCheckout('papercusp-testing-run-selector-canonical-');
  selectorRequested = await makeScratchTestCheckout('papercusp-testing-run-selector-requested-');
  await rm(selectorPhantom, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(selectorRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('selectTestFileRoot (WI-41400 phantom-root fallback)', () => {
  const files = ['packages/x/real.test.ts'];

  it('falls back to the canonical repo when the requested root is invalid and the canonical repo resolves every file', () => {
    expect(
      selectTestFileRoot(files, selectorPhantom, { discoveredRoots: [], canonicalRepoRoot: selectorCanonical }),
    ).toEqual({ root: selectorCanonical, source: 'canonical-repo' });
  });

  it('keeps a valid requested checkout authoritative even when the canonical repo also resolves every file', () => {
    expect(
      selectTestFileRoot(files, selectorRequested, { discoveredRoots: [], canonicalRepoRoot: selectorCanonical }),
    ).toEqual({ root: selectorRequested, source: 'requested' });
  });

  it('selects exactly one resolving discovered Hive checkout before the canonical repo', async () => {
    const discovered = await makeScratchTestCheckout('papercusp-testing-run-selector-discovered-');
    expect(
      selectTestFileRoot(files, selectorPhantom, {
        discoveredRoots: [discovered],
        canonicalRepoRoot: selectorCanonical,
      }),
    ).toEqual({ root: discovered, source: 'hive-checkout' });
  });

  it('refuses a discovered-root tie instead of letting the canonical repo break the ambiguity', async () => {
    const first = await makeScratchTestCheckout('papercusp-testing-run-selector-tie-a-');
    const second = await makeScratchTestCheckout('papercusp-testing-run-selector-tie-b-');
    expect(
      selectTestFileRoot(files, selectorPhantom, {
        discoveredRoots: [first, second],
        canonicalRepoRoot: selectorCanonical,
      }),
    ).toEqual({ root: selectorPhantom, source: 'requested' });
  });

  it('preserves the requested root when no valid checkout resolves every file', () => {
    expect(
      selectTestFileRoot(['packages/x/missing.test.ts'], selectorPhantom, {
        discoveredRoots: [],
        canonicalRepoRoot: selectorCanonical,
      }),
    ).toEqual({ root: selectorPhantom, source: 'requested' });
  });
});

describe('mixed-checkout test batches (EI-22733560502709681)', () => {
  it('does not switch a mixed relative + absolute request wholesale to the absolute checkout', async () => {
    await mkdir(join(REPO_ROOT, '.papercusp', 'tmp'), { recursive: true });
    const parent = await mkdtemp(join(REPO_ROOT, '.papercusp', 'tmp', 'testing-run-mixed-select-'));
    selectorRoots.push(parent);
    const ambient = join(parent, 'ambient');
    const sibling = join(parent, 'portal');
    for (const root of [ambient, sibling]) {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
      await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
    }
    const siblingFile = join(sibling, 'sibling.test.ts');
    await writeFile(siblingFile, 'export {};\n');

    expect(checkoutRootForTestFiles(['ambient.test.ts', siblingFile], ambient)).toBe(ambient);
  });

  it('runs and reports files from both checkouts instead of silently dropping the ambient file', async () => {
    await mkdir(join(REPO_ROOT, '.papercusp', 'tmp'), { recursive: true });
    const parent = await mkdtemp(join(REPO_ROOT, '.papercusp', 'tmp', 'testing-run-mixed-core-'));
    selectorRoots.push(parent);
    const ambient = join(parent, 'ambient');
    const sibling = join(parent, 'portal');
    for (const [root, label] of [
      [ambient, 'ambient'],
      [sibling, 'sibling'],
    ] as const) {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
      await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
      await writeFile(
        join(root, `${label}.test.ts`),
        `import { expect, it } from 'vitest'; it('${label}', () => expect(1).toBe(1));\n`,
      );
    }
    const siblingFile = join(sibling, 'sibling.test.ts');

    const out = await runTestFilesCore({
      root: ambient,
      files: ['ambient.test.ts', siblingFile],
      timeoutMs: 60_000,
    });

    expect(out.error, JSON.stringify(out)).toBeUndefined();
    if (out.error !== undefined) return;
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.files).toBe(2);
    expect(out.roots).toEqual([ambient, sibling]);
    expect(out.byFile['ambient.test.ts']).toMatchObject({ passed: 1, failed: 0 });
    expect(out.byFile[siblingFile]).toMatchObject({ passed: 1, failed: 0 });
  }, 120_000);

  it('starts one detached recovery containing every checkout after a mixed-root timeout', async () => {
    await mkdir(join(REPO_ROOT, '.papercusp', 'tmp'), { recursive: true });
    const parent = await mkdtemp(join(REPO_ROOT, '.papercusp', 'tmp', 'testing-run-mixed-timeout-'));
    selectorRoots.push(parent);
    const roots = [join(parent, 'ambient'), join(parent, 'portal')];
    const files = roots.map((root, index) => join(root, `${index === 0 ? 'ambient' : 'portal'}.test.ts`));
    const sleepingRouter = 'setTimeout(() => process.exit(0), 10_000);\n';
    for (const [root, file] of roots.map((root, index) => [root, files[index]!] as const)) {
      await mkdir(join(root, '.git'), { recursive: true });
      await mkdir(join(root, 'scripts'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
      await writeFile(join(root, 'scripts', 'test-files.mjs'), sleepingRouter);
      await writeFile(file, 'export {};\n');
    }

    const out = await runTestFilesCore({
      root: roots[0]!,
      files,
      timeoutMs: 1_000,
    });

    expect(out.error, JSON.stringify(out)).toBe('timeout');
    if (out.error !== 'timeout') return;
    expect(out.roots).toEqual(roots);
    const detachedRunId = out.detachedRunId;
    expect(typeof detachedRunId).toBe('string');
    if (typeof detachedRunId !== 'string') return;

    const detached = getRun(detachedRunId);
    expect(detached).not.toBeNull();
    expect(detached?.command.join(' ')).toContain(roots[0]!);
    expect(detached?.command.join(' ')).toContain(roots[1]!);
    expect(detached?.command.join(' ')).toContain(files[0]!);
    expect(detached?.command.join(' ')).toContain(files[1]!);

    // This test proves request construction, but must not leave the fresh
    // all-groups recovery running while the rest of this suite runs.
    expect(cancelRun(detachedRunId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, 30_000);
});

describe('governed test-process admission (P-003)', () => {
  it('returns a timed-out outcome and aborts a governed admission that never settles', async () => {
    let observedSignal: AbortSignal | undefined;
    const out = await runWithTestProcessDeadline({
      timeoutMs: 25,
      run: async ({ signal }) => {
        observedSignal = signal;
        await new Promise<never>(() => {
          /* simulate a durable admission blocked behind the heavy-test gate */
        });
      },
      onAdmissionTimeout: (timeoutMs) => ({ kind: 'timeout', timeoutMs }),
      onAbort: () => ({ kind: 'aborted' }),
    });

    expect(out).toEqual({ kind: 'timeout', timeoutMs: 25 });
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBeInstanceOf(Error);
    expect((observedSignal?.reason as Error).message).toContain('admission exceeded');
  });

  it('gives the child only the budget remaining after admission completes', async () => {
    const out = await runWithTestProcessDeadline<
      { remaining: number; readBack: number } | { kind: 'timeout'; timeoutMs: number } | { kind: 'aborted' }
    >({
      timeoutMs: 100,
      run: async ({ markAdmissionComplete, remainingTimeoutMs }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const remaining = markAdmissionComplete();
        return { remaining, readBack: remainingTimeoutMs() };
      },
      onAdmissionTimeout: (timeoutMs) => ({ kind: 'timeout', timeoutMs }),
      onAbort: () => ({ kind: 'aborted' }),
    });

    expect(out).toMatchObject({ remaining: expect.any(Number), readBack: expect.any(Number) });
    if (!('remaining' in out) || !('readBack' in out)) return;
    expect(out.remaining).toBeGreaterThan(0);
    expect(out.remaining).toBeLessThan(100);
    expect(out.readBack).toBeLessThanOrEqual(out.remaining);
  });

  it('constructs an explicit CPU/memory/disk/fd reservation', () => {
    expect(buildTestProcessDemand({ fileCount: 3 })).toEqual({
      cpuWeight: 1,
      memoryBytes: 1024 * 1024 * 1024,
      diskBytes: 256 * 1024 * 1024,
      fileDescriptors: 19,
    });
  });

  it('records peak child observations as measured actual demand without blocking on async reads', async () => {
    let now = 1_000;
    let sample = { cpuMicros: 100, rssBytes: 10, fileDescriptors: 4 };
    const sampler = createTestProcessDemandSampler(
      buildTestProcessDemand({ fileCount: 1 }),
      async () => sample,
      () => now,
    );
    sampler.attach(42);
    await sampler.sample();
    now = 2_000;
    sample = { cpuMicros: 1_500_100, rssBytes: 30, fileDescriptors: 8 };
    await sampler.sample();
    now = 3_000;
    sample = { cpuMicros: 3_000_100, rssBytes: 20, fileDescriptors: 6 };
    await expect(sampler.stop({ diskBytes: 123 })).resolves.toEqual({
      cpuWeight: 1.5,
      memoryBytes: 30,
      diskBytes: 123,
      fileDescriptors: 8,
    });
    // A stopped sampler is idempotent and cannot restart a timer or overwrite
    // the close-time measurement.
    await expect(sampler.stop({ diskBytes: 999 })).resolves.toEqual({
      cpuWeight: 1.5,
      memoryBytes: 30,
      diskBytes: 123,
      fileDescriptors: 8,
    });
  });

  it('reads the process resource snapshot asynchronously from the live process tree', async () => {
    const pending = readTestProcessResourceSnapshot(process.pid);
    expect(pending).toBeInstanceOf(Promise);

    const snapshot = await pending;
    expect(Object.values(snapshot).every((metric) => metric === null || typeof metric === 'number')).toBe(true);
  });

  it('cancels timeout/abort/signal-only exits but releases real red exits', () => {
    const base = { code: 0, signal: null, timedOut: false, aborted: false, output: '' };
    expect(classifyTestProcessOutcome({ ...base, timedOut: true })).toMatchObject({ kind: 'cancel' });
    expect(classifyTestProcessOutcome({ ...base, aborted: true })).toMatchObject({ kind: 'cancel' });
    expect(classifyTestProcessOutcome({ ...base, code: null, signal: 'SIGTERM' })).toMatchObject({ kind: 'cancel' });
    expect(classifyTestProcessOutcome({ ...base, code: 1, output: 'worker exited before dispatch' })).toMatchObject({
      kind: 'cancel',
    });
    expect(classifyTestProcessOutcome({ ...base, code: 1, actualDemand: { memoryBytes: 7 } })).toEqual({
      kind: 'release',
      actualDemand: { memoryBytes: 7 },
    });
  });
});

describe('groupDirectVitestRoutes (EI-21414388102126733)', () => {
  it('runs an external-Hive file from its owning workspace instead of the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-workspace-'));
    selectorRoots.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'apps/web/src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
    await writeFile(join(root, 'apps/web/package.json'), JSON.stringify({ name: '@example/web' }));
    await writeFile(join(root, 'apps/web/vite.config.ts'), 'export default {};\n');
    await writeFile(join(root, 'apps/web/src/widget.integration.test.tsx'), 'export {};\n');

    expect(groupDirectVitestRoutes(['apps/web/src/widget.integration.test.tsx'], root)).toEqual([
      { cwd: join(root, 'apps/web'), files: ['src/widget.integration.test.tsx'] },
    ]);
  });

  it('selects an owning workspace integration config when one exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-layer-'));
    selectorRoots.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'packages/db/src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    await writeFile(join(root, 'packages/db/package.json'), JSON.stringify({ name: '@example/db' }));
    await writeFile(join(root, 'packages/db/vitest.integration.config.ts'), 'export default {};\n');
    await writeFile(join(root, 'packages/db/src/db.integration.test.ts'), 'export {};\n');

    expect(groupDirectVitestRoutes(['packages/db/src/db.integration.test.ts'], root)).toEqual([
      {
        cwd: join(root, 'packages/db'),
        config: 'vitest.integration.config.ts',
        files: ['src/db.integration.test.ts'],
      },
    ]);
  });
});

describe('shouldIngestVitestLedgerInProcess', () => {
  it('resolves the reporter through the selected checkout package export', async () => {
    const externalRoot = await makeScratchTestCheckout('papercusp-testing-run-package-reporter-');
    const packageRoot = join(externalRoot, 'node_modules/@papercusp/test-config');
    const reporterPath = join(packageRoot, 'src/admin-test-runs-reporter.ts');
    await mkdir(dirname(reporterPath), { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@papercusp/test-config',
        exports: { './admin-test-runs-reporter': './src/admin-test-runs-reporter.ts' },
      }),
    );
    await writeFile(reporterPath, 'export default class Reporter {}\n');

    expect(resolveAdminTestRunsReporterPath(externalRoot)).toBe(reporterPath);
    expect(shouldIngestVitestLedgerInProcess(externalRoot)).toBe(false);
    expect(buildDetachedTestRunRequest({ root: externalRoot, files: ['packages/x/real.test.ts'] }).args).toContain(
      `--reporter=${reporterPath}`,
    );
  });

  it('selects operator-side ingestion for an external checkout', async () => {
    const externalRoot = await makeScratchTestCheckout('papercusp-testing-run-external-reporter-');

    expect(shouldIngestVitestLedgerInProcess(externalRoot)).toBe(true);
  });

  it('leaves a managed checkout own reporter as the single writer', async () => {
    const managedRoot = await makeScratchTestCheckout('papercusp-testing-run-local-reporter-');
    const localReporter = join(managedRoot, 'libs/test-config/src/admin-test-runs-reporter.ts');
    await mkdir(dirname(localReporter), { recursive: true });
    await writeFile(localReporter, 'export default class Reporter {}\n');

    expect(shouldIngestVitestLedgerInProcess(managedRoot)).toBe(false);
  });
});

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

  it.skipIf(!SIDESTAGE_HIVE_ROOT)(
    'routes an absolute test path through its external Hive Vitest checkout',
    async () => {
      const out = await body(call({ files: [join(SIDESTAGE_HIVE_ROOT as string, 'apps/web/src/auction.test.tsx')] }));

      expect(out.ok).toBe(true);
      expect(out.failed).toBe(0);
      expect(out.files).toBe(1);
      expect(out.passed).toBeGreaterThan(0);
      expect(out.root).toBe(SIDESTAGE_HIVE_ROOT);
    },
    180_000,
  );

  it.skipIf(!SIDESTAGE_LAYERED_TARGET || !existsSync(SIDESTAGE_LAYERED_TARGET))(
    'routes a layered external-Hive file through its owning workspace config',
    async () => {
      const out = await body(call({ files: [SIDESTAGE_LAYERED_TARGET as string] }));

      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(out.failed).toBe(0);
      expect(out.files).toBe(1);
      expect(out.passed).toBeGreaterThan(0);
      expect(out.root).toBe(SIDESTAGE_HIVE_ROOT);
    },
    180_000,
  );

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
    const routerScript = await readFile(join(out.root as string, 'scripts', 'test-files.mjs'), 'utf8').catch(
      () => null,
    );
    expect(routerScript).not.toBeNull();
  }, 180_000);

  it('distills a passing node:test router result when no Vitest JSON report exists', async () => {
    const out = await body(call({ files: [NODE_TEST_TARGET] }));

    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.files).toBe(1);
    expect(out.passed).toBeGreaterThan(0);
    expect(out.failed).toBe(0);
    expect(out.failures).toEqual([]);
  }, 180_000);

  it('requires the router marker and a non-zero numeric test summary for the node:test fallback', () => {
    const output = [
      '\u2139 tests 2',
      '\u2139 pass 2',
      '\u2139 fail 0',
      '\u2139 skipped 0',
      'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=abc provenance=stamped',
    ].join('\n');

    expect(parseRouterTestResult(output, [NODE_TEST_TARGET])).toMatchObject({
      passed: 2,
      failed: 0,
      skipped: 0,
      files: 1,
      failures: [],
      byFile: { [NODE_TEST_TARGET]: { passed: 2, failed: 0, skipped: 0, collectionFailed: false } },
    });
    expect(
      parseRouterTestResult('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed', [NODE_TEST_TARGET]),
    ).toBeNull();
  });

  it('requires a finished zero-exit progress line before treating a terminal marker as complete', () => {
    const output = [
      'TEST_FILE_PROGRESS state=finished elapsedMs=14825 capturedBytes=42 completedFiles=["target"] pendingFiles=[] timeoutMs=50000 exitStatus=0 signal=none',
      'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=84e1f9b504',
    ].join('\n');

    expect(parseRouterTerminalCompletion(output)).toEqual({
      requested: 1,
      executed: 1,
      matched: 1,
      status: 'passed',
      runElapsedMs: 14825,
    });
    expect(parseRouterTerminalCompletion(output.replace('exitStatus=0', 'exitStatus=1'))).toBeNull();
    expect(parseRouterTerminalCompletion('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed')).toBeNull();
  });

  it('parses a strict typed NOT-MEASURED router marker without turning ordinary route errors into one', () => {
    const marker = [
      'TEST_FILE_ROUTE_ERROR (group cwd=packages/operator-core) could not launch Vitest: statement timeout',
      'TEST_FILE_NOT_MEASURED requested=2 executed=0 matched=2 measuredFiles=0 status=not-measured reason=admission-starved — governed test-process admission was refused after retryable database contention.',
    ].join('\n');
    expect(parseRouterNotMeasuredMarker(marker)).toEqual({
      requested: 2,
      executed: 0,
      matched: 2,
      measuredFiles: 0,
      status: 'not-measured',
      reason: 'admission-starved',
    });
    expect(parseRouterNotMeasuredMarker('TEST_FILE_ROUTE_ERROR requested=1 matched=0')).toBeNull();
    expect(
      parseRouterNotMeasuredMarker(
        'TEST_FILE_NOT_MEASURED requested=2 executed=0 matched=2 measuredFiles=1 status=not-measured reason=admission-starved',
      ),
    ).toBeNull();
  });

  it('returns structured actual/expected values for a real failing assertion', async () => {
    const relativeFixture = `packages/operator-core/lib/__testing-run-sidecar-${randomUUID()}.test.ts`;
    // testing:run receives repo-root-relative paths. Resolve from the same
    // canonical root under both package-local and repository-root Vitest runs.
    const absoluteFixture = join(REPO_ROOT, relativeFixture);
    await writeFile(
      absoluteFixture,
      [
        "import { expect, it } from 'vitest';",
        "it('preserves the assertion values', () => {",
        "  expect({ service_select: false, other: 'actual' }).toEqual({ service_select: true, other: 'expected' });",
        '});',
        '',
      ].join('\n'),
    );
    try {
      const out = await body(call({ files: [relativeFixture] }));

      expect(out.ok).toBe(false);
      expect(out.failed).toBe(1);
      expect(out.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: relativeFixture,
            test: 'preserves the assertion values',
            actual: expect.stringContaining('service_select'),
            expected: expect.stringContaining('service_select'),
          }),
        ]),
      );
    } finally {
      await rm(absoluteFixture, { force: true });
    }
  }, 180_000);

  it('runs a repo-resolving file from a phantom handler root through the canonical repo and surfaces the source', async () => {
    const phantom = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-handler-phantom-'));
    await rm(phantom, { recursive: true, force: true });
    const out = await body(call({ files: [GREEN_TARGET] }, { projectDir: phantom }));

    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.rootSource).toBe('canonical-repo');
    expect(out.root).not.toBe(phantom);
    expect(existsSync(join(out.root as string, GREEN_TARGET))).toBe(true);
  }, 180_000);

  it('keeps the admin test-run ledger reporter alongside machine-readable JSON output', async () => {
    const out = await body(
      call(
        { files: [GREEN_TARGET], harness: 'papercusp' },
        {
          projectDir: REPO_ROOT,
          harnessSlug: '*',
          workspaceId: 'papercusp-workspace',
        },
      ),
    );

    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (typeof out.runId !== 'string') {
      throw new Error(`testing:run omitted runId: ${JSON.stringify(out)}`);
    }

    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{ id: string; file_path: string; status: string; harness_slug: string | null; workspace_id: string | null }>
    >`
      SELECT id, file_path, status, harness_slug, workspace_id
      FROM harness_shared.test_runs
      WHERE run_group_id = ${out.runId}
    `;
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: expect.anything(),
          file_path: GREEN_TARGET,
          status: 'pass',
          harness_slug: 'papercusp',
          workspace_id: 'papercusp-workspace',
        },
      ]),
    );
    expect(out.testRunIds).toEqual(expect.arrayContaining(rows.map((row) => Number(row.id)).filter(Number.isFinite)));
  }, 180_000);

  it('accepts a workspace-relative test path and expands it before routing', async () => {
    const out = await body(call({ files: [OPERATOR_CORE_RELATIVE_GREEN_TARGET] }, { projectDir: REPO_ROOT }));

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

      expect(normalizeTestFilePaths(['shared.test.ts'], fixture, ['packages/one', 'packages/two'])).toEqual({
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
  it("spans MULTIPLE workspaces without one group's report overwriting another", async () => {
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

  // EI-21909191824649521 — the SAME vacuous-pass class as the two cases above, reached through
  // the argument set that carries NO filter at all, which is why neither of them caught it. An
  // env-gated `describe.skipIf` suite collects every test and executes none; vitest exits 0, so
  // this returned ok:true / passed:0 / failed:0 with `skipped:3` sitting below the two fields a
  // reader actually treats as the verdict. It fires in the expensive direction: acceptance
  // rubrics routinely bind replication drills to `*-live` suites, so a grader following the
  // drill gets a green and credits a criterion on which zero assertions ever ran.
  it('refuses a file whose tests were ALL skipped instead of passing vacuously', async () => {
    // The child inherits this process's env, so pin the gate CLOSED rather than trusting the
    // ambient value — otherwise a box that happens to export it turns this into a false green,
    // which is the very failure under test.
    const prior = process.env[ENV_GATED_TARGET_VAR];
    delete process.env[ENV_GATED_TARGET_VAR];
    let out: RunResult;
    try {
      out = await body(call({ files: [ENV_GATED_TARGET] }));
    } finally {
      if (prior !== undefined) process.env[ENV_GATED_TARGET_VAR] = prior;
    }

    expect(out.ok).toBe(false);
    expect(out.error).toBe('all_tests_skipped');
    // Collected-THEN-skipped, not "the path matched nothing" — `route_error` already owns that,
    // and without this assertion the case would also pass against a missing file.
    expect(out.skipped).toBeGreaterThan(0);
    expect(out.passed ?? 0).toBe(0);
    // The reason must be STATED: `ok:false` beside `failed:0` is the exact shape an agent
    // misreads as "nothing failed".
    expect(String(out.hint)).toContain('NONE executed');
  }, 120_000);

  // Non-vacuousness for the case above, and the specific way its fix could go wrong: refusing on
  // `passed === 0` alone would refuse EVERY green run too. A run that really executed tests must
  // still be green.
  it('still returns a green for a run that actually executed tests', async () => {
    const out = await body(call({ files: [GREEN_TARGET] }));

    expect(out.ok).toBe(true);
    expect(out.error).toBeUndefined();
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
      await rm(fakeRoot, { recursive: true, force: true }).catch(() => {
        /* best-effort */
      });
    }
  }, 30_000);

  // The same false-green in its most tempting form: a path that genuinely
  // EXISTS, so nothing looks wrong, but holds no tests.
  it('refuses an existing NON-TEST source file instead of passing vacuously', async () => {
    const out = await body(call({ files: ['packages/operator-core/lib/testing-run-store.ts'] }));

    expect(out.ok).toBe(false);
    expect(['route_error', 'no_report']).toContain(out.error);
  }, 180_000);

  it('routes integration timeout recovery through the owning test:file router', () => {
    const hint = detachedTestTimeoutHint(['packages/operator-core/lib/example.integration.test.ts']);

    expect(hint).toContain('capability:bash');
    expect(hint).toContain('npm run test:file -- <test path>');
    expect(hint).toContain('owning Vitest config');
    expect(hint).not.toContain('capability:inspect');
    expect(detachedTestTimeoutHint(['packages/operator-core/lib/example.test.ts'])).toContain('capability:inspect');
  });

  it('returns timeout recovery before optional execution-ledger readback', () => {
    expect(shouldResolveHarnessTestRunIds({ ok: false, error: 'timeout' })).toBe(false);
    expect(shouldResolveHarnessTestRunIds({ ok: false, error: 'route_error' })).toBe(true);
    expect(shouldResolveHarnessTestRunIds({ ok: true })).toBe(true);
  });

  it('builds a fresh store-backed router request with the admin ledger reporter but without the foreground report path', () => {
    const request = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files: ['packages/example.test.ts'],
      testNamePattern: 'suite > --focused test',
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      timeoutMs: 900_000,
    });

    expect(request).toMatchObject({
      kind: 'vitest',
      command: process.execPath,
      cwd: REPO_ROOT,
      filePath: 'packages/example.test.ts',
      runtimeMaxSec: 900,
    });
    expect(request.args).toEqual([
      join(REPO_ROOT, 'scripts', 'test-files.mjs'),
      'packages/example.test.ts',
      '--',
      `--reporter=${join(REPO_ROOT, 'libs/test-config/src/admin-test-runs-reporter.ts')}`,
      '--testNamePattern=suite > --focused test',
    ]);
    expect(request.args.some((arg) => arg.includes('papercusp-testing-run-'))).toBe(false);
    expect(request.env).toEqual({
      PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
      PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
    });
  });

  it('gives detached recovery an independent runtime floor beyond the foreground timeout', () => {
    const foregroundTimeoutMs = 45_000;
    const request = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files: ['packages/example.test.ts'],
      timeoutMs: foregroundTimeoutMs,
    });
    const mixedRequest = buildDetachedMixedTestRunRequest({
      groups: [{ root: REPO_ROOT, files: ['packages/example.test.ts'] }],
      timeoutMs: foregroundTimeoutMs,
    });

    // The foreground transport ceiling is about 45s. Detached recovery must
    // not inherit that wall or it reproduces the SIGTERM/143 failure as soon
    // as the recovery starts; the recovery floor is the normal 5-minute run
    // budget for both single-root and mixed-root continuations.
    expect(request.runtimeMaxSec).toBe(300);
    expect(mixedRequest.runtimeMaxSec).toBe(300);
    expect(request.runtimeMaxSec).toBeGreaterThan(Math.ceil(foregroundTimeoutMs / 1000));
    expect(mixedRequest.runtimeMaxSec).toBeGreaterThan(Math.ceil(foregroundTimeoutMs / 1000));
  });

  it('gives every direct Vitest route its own JSON report artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-artifacts-'));
    selectorRoots.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'packages', 'unit', 'src'), { recursive: true });
    await mkdir(join(root, 'packages', 'integration', 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    await writeFile(join(root, 'packages', 'unit', 'package.json'), JSON.stringify({ name: '@example/unit' }));
    await writeFile(
      join(root, 'packages', 'integration', 'package.json'),
      JSON.stringify({ name: '@example/integration' }),
    );
    await writeFile(
      join(root, 'packages', 'integration', 'vitest.integration.config.ts'),
      'export default {}.\n',
    );
    const files = [
      'packages/unit/src/unit.test.ts',
      'packages/integration/src/integration.integration.test.ts',
    ];
    const request = buildDetachedMixedTestRunRequest({ groups: [{ root, files }] });
    const artifacts = request.detachedReportArtifacts ?? [];
    expect(artifacts).toHaveLength(2);

    const reportPaths = artifacts.map((artifact) => artifact.reportPath);
    expect(new Set(reportPaths).size).toBe(reportPaths.length);
    expect(artifacts.every((artifact) => artifact.root === root)).toBe(true);

    const script = request.args[1]!;
    const marker = 'const commands = ';
    const commandsStart = script.indexOf(marker) + marker.length;
    const commandsEnd = script.indexOf(';\nlet exitCode', commandsStart);
    expect(commandsStart).toBeGreaterThan(marker.length);
    expect(commandsEnd).toBeGreaterThan(commandsStart);
    const commands = JSON.parse(script.slice(commandsStart, commandsEnd)) as Array<{ args: string[] }>;
    const commandReportPaths = commands.map((command) => {
      const reportArg = command.args.find((arg) => arg.startsWith('--outputFile='));
      expect(reportArg).toBeDefined();
      return reportArg!.slice('--outputFile='.length);
    });
    expect(commandReportPaths).toHaveLength(2);
    expect(new Set(commandReportPaths).size).toBe(commandReportPaths.length);
    expect(commandReportPaths).toEqual(expect.arrayContaining(reportPaths));
  });

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
  it('kills the WHOLE process tree on the foreground timeout — no orphan survives', async () => {
    const out = await body(
      call({
        files: [GREEN_TARGET, CROSS_WORKSPACE_GREEN_TARGET],
        timeoutMs: 1000,
      }),
    );

    expect(out.ok).toBe(false);
    expect(out.error).toBe('timeout');
    expect(typeof out.runId).toBe('string');
    expect(typeof out.detachedRunId).toBe('string');
    expect(out.hint).toContain('one detached call per file');
    expect(out.hint).toContain('onlyPaths (that field is typecheck-only)');

    // The fallback is deliberately a real store run. Stop it here so this
    // integration test never leaves a detached Vitest tree behind for the
    // remainder of the suite.
    if (typeof out.detachedRunId === 'string') {
      const detached = getRun(out.detachedRunId);
      expect(detached).not.toBeNull();
      if (detached?.status === 'running') expect(cancelRun(out.detachedRunId)).toBe(true);
    }

    // Give the SIGTERM → (5s) → SIGKILL fallback (run.ts's own `killGroup` retry)
    // time to land before asserting on the absence of survivors.
    await new Promise((resolve) => setTimeout(resolve, 8000));

    const survivors = await pidsTaggedWithRun(out.runId as string);
    expect(survivors).toEqual([]);
  }, 30_000);

  // EI-20949515346526475: code:run can terminate its worker while an inner testing:run
  // handler is still blocked in the router. The inner handler must honor that caller-owned
  // signal and kill the SAME process group; otherwise the Vitest suite survives after the
  // outer wrapper already returned and a retry starts a duplicate run.
  it('kills the whole process tree when the caller aborts an in-flight run', async () => {
    const controller = new AbortController();
    const runPromise = body(
      call({ files: [GREEN_TARGET, CROSS_WORKSPACE_GREEN_TARGET], timeoutMs: 30_000 }, { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 500);

    const out = await runPromise;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('aborted');
    expect(typeof out.runId).toBe('string');

    const survivors = await pidsTaggedWithRun(out.runId as string);
    expect(survivors).toEqual([]);
  }, 30_000);
});
