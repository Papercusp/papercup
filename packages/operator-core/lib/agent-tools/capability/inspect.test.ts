/**
 * Unit tests for capability:inspect's command resolution (EI-524 / P-035).
 * The exec itself reuses the bash-jobs runner (tested in bash-jobs.test.ts); the
 * security-load-bearing part is the PURE command construction + path validation,
 * which is what these cover — proving the agent can never inject a shell command.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The response contract is independent of child-process execution. Keep this
// regression deterministic by replacing only the launcher while preserving the
// real command-resolution and cwd validation paths below.
vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  startBackground: vi.fn(),
}));
vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxEnabled: vi.fn(async () => false),
}));
vi.mock('../../../../../scripts/lib/tsc-baseline-gate.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../scripts/lib/tsc-baseline-gate.mjs')>()),
  discoverSiblingTypecheckGates: vi.fn(async () => ({
    gates: [{ npmScript: 'lint:tsc', prefixes: ['packages/operator-core/', 'pkg/'] }],
    unresolved: [],
    rosterReadable: true,
  })),
}));

import {
  resolveInspectCommand,
  resolveScopedTypecheckCommand,
  resolveTypecheckCwd,
  filterTscOutputToPaths,
  deadTypecheckVerdict,
} from './inspect';
import inspectTool from './inspect';
import { startBackground } from './bash-jobs';

const BASE = '/repo';
const OPERATOR_CORE_GATES = [{ npmScript: 'lint:tsc', prefixes: ['packages/operator-core/'] }];
const INSPECT_STATE = mkdtempSync(join(tmpdir(), 'cap-inspect-response-'));
const INSPECT_PACKAGE = join(INSPECT_STATE, 'pkg');
mkdirSync(INSPECT_PACKAGE);
mkdirSync(join(INSPECT_PACKAGE, 'src'));
writeFileSync(join(INSPECT_PACKAGE, 'src/a.ts'), 'export const a = 1;\n');

type ToolResultish = { content: Array<{ text: string }>; isError?: boolean };
type Tool = { handler: (a: unknown, c: unknown) => Promise<ToolResultish> };
const inspect = inspectTool as unknown as Tool;

function inspectCtx() {
  return {
    projectDir: INSPECT_STATE,
    stateDir: INSPECT_STATE,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
  } as never;
}

describe('resolveInspectCommand — verb mapping', () => {
  it('typecheck requires a package', () => {
    const r = resolveInspectCommand({ check: 'typecheck' }, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_args');
  });

  it('typecheck with a package → `npx tsc --noEmit` in the package dir', () => {
    expect(resolveInspectCommand({ check: 'typecheck', package: 'packages/operator-core' }, BASE)).toEqual({
      ok: true,
      command: 'npx tsc --noEmit',
      cwd: '/repo/packages/operator-core',
    });
  });

  it('explains that package is a repository path when an npm-style name is supplied', () => {
    const r = resolveInspectCommand({ check: 'typecheck', package: '@papercusp/operator-core' }, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('bad_package');
      expect(r.message).toContain('repository-relative directory path, not an npm package name');
      expect(r.message).toContain('packages/operator-core');
    }
  });

  it('typecheck with package-relative onlyPaths → the package baseline gate with repo-relative files', () => {
    expect(
      resolveScopedTypecheckCommand(
        {
          check: 'typecheck',
          package: 'packages/operator-core',
          onlyPaths: ['lib/agent-tools/git_sync/run.ts', 'lib/agent-tools/git_sync/run.test.ts'],
        },
        BASE,
        OPERATOR_CORE_GATES,
        () => true,
      ),
    ).toEqual({
      ok: true,
      command:
        'npm run lint:tsc -- --files=packages/operator-core/lib/agent-tools/git_sync/run.ts,packages/operator-core/lib/agent-tools/git_sync/run.test.ts',
      cwd: BASE,
    });
  });

  it('typecheck with repo-relative onlyPaths does not double-prefix the package', () => {
    expect(
      resolveScopedTypecheckCommand(
        {
          check: 'typecheck',
          package: 'packages/operator-core',
          onlyPaths: ['packages/operator-core/lib/agent-tools/git_sync/run.ts'],
        },
        BASE,
        OPERATOR_CORE_GATES,
        () => true,
      ),
    ).toEqual({
      ok: true,
      command: 'npm run lint:tsc -- --files=packages/operator-core/lib/agent-tools/git_sync/run.ts',
      cwd: BASE,
    });
  });

  it('refuses a scoped run when no declared baseline gate covers the file', () => {
    const r = resolveScopedTypecheckCommand(
      { check: 'typecheck', package: 'libs/raw-tsc-package', onlyPaths: ['src/a.ts'] },
      BASE,
      OPERATOR_CORE_GATES,
      () => true,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('no_baseline_gate');
      expect(r.message).toContain('cannot honestly judge');
    }
  });

  it('refuses a covered-but-missing onlyPath instead of manufacturing a scoped green', () => {
    const r = resolveScopedTypecheckCommand(
      { check: 'typecheck', package: 'packages/operator-core', onlyPaths: ['lib/does-not-exist.ts'] },
      BASE,
      OPERATOR_CORE_GATES,
      () => false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('only_path_not_found');
      expect(r.message).toContain('never present');
    }
  });

  it('refuses paths spanning multiple baseline gates instead of producing one misleading verdict', () => {
    const r = resolveScopedTypecheckCommand(
      {
        check: 'typecheck',
        package: 'packages/operator-core',
        onlyPaths: [
          'packages/operator-core/lib/a.ts',
          'apps/operator-vite/src/b.ts',
        ],
      },
      BASE,
      [
        ...OPERATOR_CORE_GATES,
        { npmScript: 'lint:tsc:operator-vite', prefixes: ['apps/operator-vite/'] },
      ],
      () => true,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('mixed_baseline_gates');
      expect(r.message).toContain('Split them');
    }
  });

  it('test with no package → repo `npm run test:affected` at the root', () => {
    expect(resolveInspectCommand({ check: 'test' }, BASE)).toEqual({
      ok: true,
      command: 'npm run test:affected',
      cwd: BASE,
    });
  });

  it('test with a package → `npx vitest run` in the package', () => {
    expect(resolveInspectCommand({ check: 'test', package: 'libs/flags' }, BASE)).toEqual({
      ok: true,
      command: 'npx vitest run',
      cwd: '/repo/libs/flags',
    });
  });

  it('test with a package + path → narrows the vitest run to the file', () => {
    expect(resolveInspectCommand({ check: 'test', package: 'libs/flags', path: 'src/x.test.ts' }, BASE)).toEqual({
      ok: true,
      command: 'npx vitest run src/x.test.ts',
      cwd: '/repo/libs/flags',
    });
  });

  it('test with a package + integration path → uses the repository test router', () => {
    expect(
      resolveInspectCommand({
        check: 'test',
        package: 'packages/operator-core',
        path: 'lib/events/await/await-store.integration.test.ts',
      }, BASE),
    ).toEqual({
      ok: true,
      command: 'npm run test:file -- packages/operator-core/lib/events/await/await-store.integration.test.ts',
      cwd: BASE,
    });
  });

  it('test with a repo-relative path and no package → runs that file from the repository root', () => {
    expect(
      resolveInspectCommand({ check: 'test', path: 'packages/operator-core/lib/foo.test.ts' }, BASE),
    ).toEqual({
      ok: true,
      command: 'npx vitest run packages/operator-core/lib/foo.test.ts',
      cwd: BASE,
    });
  });

  it('test with a repo-relative layered path and no package → uses the repository test router', () => {
    expect(
      resolveInspectCommand({
        check: 'test',
        path: 'packages/operator-core/lib/events/await/await-store.integration.test.ts',
      }, BASE),
    ).toEqual({
      ok: true,
      command: 'npm run test:file -- packages/operator-core/lib/events/await/await-store.integration.test.ts',
      cwd: BASE,
    });
  });

  it('path is rejected for typecheck', () => {
    expect(resolveInspectCommand({ check: 'typecheck', package: 'p', path: 'x' }, BASE).ok).toBe(false);
  });

  it('onlyPaths is rejected for tests', () => {
    const r = resolveInspectCommand({ check: 'test', package: 'p', onlyPaths: ['x.test.ts'] }, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('bad_args');
      expect(r.message).toContain('pass one test file or directory with `path`');
      expect(r.message).toContain('repo-relative when it is omitted');
      expect(r.message).toContain('separate capability:inspect calls');
    }
  });

  it('publishes self-correcting guidance for the flattened test/typecheck argument surface', () => {
    const shape = (inspectTool as unknown as { args: { shape: Record<string, { description?: string }> } }).args.shape;
    expect(shape.package.description).toMatch(/Repository-relative directory path \(not an npm package name\)/);
    expect(shape.onlyPaths.description).toMatch(/never pass with check:"test"/);
    expect(shape.path.description).toMatch(/one test file\/dir/);
    expect(shape.path.description).toMatch(/when omitted, it is repo-relative/);
    expect(shape.path.description).toMatch(/one capability:inspect call per path/);
  });
});

describe('capability:inspect — background launch response', () => {
  it('returns the durable task_id alongside the in-memory bash_id', async () => {
    vi.mocked(startBackground).mockReturnValue({
      id: 'bash-response-probe',
      taskId: 'task-response-probe',
      logPath: '/tmp/bash-response-probe.log',
    } as never);

    const result = await inspect.handler(
      { check: 'test', package: 'pkg', run_in_background: true },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-response-probe',
      task_id: 'task-response-probe',
      status: 'running',
    });
    expect(vi.mocked(startBackground)).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'npx vitest run', cwd: INSPECT_PACKAGE }),
      expect.any(Number),
    );
  });

  it('honors onlyPaths in the launched background command instead of silently dropping it', async () => {
    vi.mocked(startBackground).mockReturnValue({
      id: 'bash-scoped-typecheck',
      taskId: 'task-scoped-typecheck',
      logPath: '/tmp/bash-scoped-typecheck.log',
    } as never);

    const result = await inspect.handler(
      { check: 'typecheck', package: 'pkg', onlyPaths: ['src/a.ts'], run_in_background: true },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-scoped-typecheck',
      status: 'running',
      command: 'npm run lint:tsc -- --files=pkg/src/a.ts',
    });
    expect(vi.mocked(startBackground)).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm run lint:tsc -- --files=pkg/src/a.ts',
        cwd: INSPECT_STATE,
      }),
      expect.any(Number),
    );
  });

  it('routes a background integration test through the repository test router', async () => {
    vi.mocked(startBackground).mockReturnValue({
      id: 'bash-integration-router',
      taskId: 'task-integration-router',
      logPath: '/tmp/bash-integration-router.log',
    } as never);

    const result = await inspect.handler(
      { check: 'test', package: 'pkg', path: 'src/foo.integration.test.ts', run_in_background: true },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-integration-router',
      status: 'running',
      command: 'npm run test:file -- pkg/src/foo.integration.test.ts',
      cwd: INSPECT_STATE,
    });
    expect(vi.mocked(startBackground)).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm run test:file -- pkg/src/foo.integration.test.ts',
        cwd: INSPECT_STATE,
      }),
      expect.any(Number),
    );
  });

  it('launches a background repo-relative test path without a package', async () => {
    vi.mocked(startBackground).mockReturnValue({
      id: 'bash-repo-relative-test',
      taskId: 'task-repo-relative-test',
      logPath: '/tmp/bash-repo-relative-test.log',
    } as never);

    const result = await inspect.handler(
      { check: 'test', path: 'packages/operator-core/lib/foo.test.ts', run_in_background: true },
      inspectCtx(),
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-repo-relative-test',
      status: 'running',
      command: 'npx vitest run packages/operator-core/lib/foo.test.ts',
      cwd: INSPECT_STATE,
    });
    expect(vi.mocked(startBackground)).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npx vitest run packages/operator-core/lib/foo.test.ts',
        cwd: INSPECT_STATE,
      }),
      expect.any(Number),
    );
  });
});

describe('resolveInspectCommand — security (no shell injection / traversal)', () => {
  it('rejects shell metacharacters in package', () => {
    for (const bad of ['p; rm -rf /', 'p && curl evil', 'p`whoami`', 'p|tee', 'p$(x)', 'p x', 'p>out', 'p*']) {
      expect(resolveInspectCommand({ check: 'test', package: bad }, BASE).ok, `package "${bad}" must be rejected`).toBe(false);
    }
  });

  it('rejects shell metacharacters in path', () => {
    for (const bad of ['a.test.ts; rm -rf /', 'a && x', 'a|b', 'a $(b)']) {
      expect(resolveInspectCommand({ check: 'test', package: 'pkg', path: bad }, BASE).ok, `path "${bad}" must be rejected`).toBe(false);
    }
  });

  it('rejects shell metacharacters in onlyPaths now that they enter the fixed command', () => {
    for (const bad of ['x.ts; rm -rf /', 'x.ts && curl evil', 'x.ts|tee', 'x $(whoami).ts', 'x,y.ts']) {
      const r = resolveScopedTypecheckCommand(
        { check: 'typecheck', package: 'pkg', onlyPaths: [bad] },
        BASE,
        [{ npmScript: 'lint:tsc', prefixes: ['pkg/'] }],
        () => true,
      );
      expect(r.ok, `onlyPath "${bad}" must be rejected`).toBe(false);
      if (!r.ok) expect(r.reason).toBe('bad_only_path');
    }
  });

  it('rejects parent-dir traversal in package and path', () => {
    expect(resolveInspectCommand({ check: 'test', package: '../etc' }, BASE).ok).toBe(false);
    expect(resolveInspectCommand({ check: 'test', package: 'a/../../etc' }, BASE).ok).toBe(false);
    expect(resolveInspectCommand({ check: 'test', package: 'pkg', path: '../../../etc/passwd' }, BASE).ok).toBe(false);
  });

  it('rejects an absolute package or path', () => {
    expect(resolveInspectCommand({ check: 'test', package: '/etc' }, BASE).ok).toBe(false);
    expect(resolveInspectCommand({ check: 'test', package: 'pkg', path: '/etc/passwd' }, BASE).ok).toBe(false);
  });
});

/**
 * EI-19332092038566982 / EI-19331889744736428: `spawn`'s `cwd` must be a real directory. The
 * #1 wrong call shape observed live (all 6 sampled watchdog failures + an independently-filed
 * duplicate) was passing a tsconfig.json FILE as `package` — the containing directory is what
 * this tool actually needs as its cwd.
 */
describe('resolveTypecheckCwd (EI-19332092038566982 / EI-19331889744736428)', () => {
  it('passes a real directory through unchanged', () => {
    expect(resolveTypecheckCwd('/repo/packages/operator-core', true)).toEqual({
      ok: true,
      cwd: '/repo/packages/operator-core',
      corrected: false,
    });
  });

  it('auto-corrects a bare "tsconfig.json" file to its containing directory', () => {
    expect(resolveTypecheckCwd('/repo/packages/operator-core/tsconfig.json', false)).toEqual({
      ok: true,
      cwd: '/repo/packages/operator-core',
      corrected: true,
    });
  });

  it('auto-corrects a named tsconfig variant (e.g. tsconfig.build.json)', () => {
    expect(resolveTypecheckCwd('/repo/apps/operator/tsconfig.build.json', false)).toEqual({
      ok: true,
      cwd: '/repo/apps/operator',
      corrected: true,
    });
  });

  it('refuses a non-directory that is NOT a tsconfig file, with an actionable message', () => {
    const r = resolveTypecheckCwd('/repo/packages/operator-core/README.md', false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('bad_package_not_a_directory');
      expect(r.message).toMatch(/must be a directory/);
      expect(r.message).toContain('README.md');
    }
  });

  it('refuses a nonexistent path the same way (a stat failure is reported as not-a-directory)', () => {
    const r = resolveTypecheckCwd('/repo/does/not/exist', false);
    expect(r.ok).toBe(false);
  });
});

describe('filterTscOutputToPaths — "did MY change add a NEW error" (WI-1255)', () => {
  const OUT = [
    "lib/agent-tools/docs/author.ts(46,26): error TS2307: Cannot find module 'x'.",
    "../plugin-loader/src/wasm/jco-transpiler.ts(46,26): error TS2307: Cannot find module '@bytecodealliance/jco'.",
    "lib/other/foo.ts(1,1): error TS1005: ';' expected.",
    'Found 3 errors in 3 files.',
  ].join('\n');

  it('counts all errors but matches only the requested file', () => {
    const r = filterTscOutputToPaths(OUT, ['lib/agent-tools/docs/author.ts']);
    expect(r.totalErrors).toBe(3);
    expect(r.matchedErrors).toBe(1);
    expect(r.matchedLines[0]).toContain('author.ts');
  });

  it('matches loosely (a basename fragment finds the file)', () => {
    expect(filterTscOutputToPaths(OUT, ['author.ts']).matchedErrors).toBe(1);
  });

  it('a directory fragment matches every file under it (and excludes others)', () => {
    const r = filterTscOutputToPaths(OUT, ['lib/']);
    expect(r.matchedErrors).toBe(2); // author.ts + other/foo.ts, NOT the ../plugin-loader one
  });

  it('an unmatched path → 0 matched, full total (the clean signal)', () => {
    const r = filterTscOutputToPaths(OUT, ['lib/nope/missing.ts']);
    expect(r.matchedErrors).toBe(0);
    expect(r.totalErrors).toBe(3);
  });

  it('ignores non-error lines (summary, blank)', () => {
    expect(filterTscOutputToPaths('Found 3 errors in 3 files.\n\n', ['x']).totalErrors).toBe(0);
  });

  it('empty output → zeros', () => {
    expect(filterTscOutputToPaths('', ['x'])).toEqual({ matchedErrors: 0, totalErrors: 0, matchedLines: [] });
  });
});

// EI-6073: a FOREGROUND typecheck/test on a large package (operator-core's tsc ~60-90s) was
// hard-killed by the ~55s MCP transport cap with an opaque request_timeout — the handler never
// got to hint "use run_in_background". These pin the clamp (self-time-out below the cap) + the hint.
// The clamp + hint moved to ./foreground-transport-cap (EI-20645849301780712); their tests
// moved with them, and grew a cross-tool invariant naming every foreground-capable tool.

/**
 * EI-20019651513530828 / EI-20013137550825704 — a typecheck that DIED must never be
 * reportable as clean.
 *
 * The fixture is the real captured output: tsc OOMs before emitting a single
 * diagnostic, so the log contains zero `error TS####` lines. That is byte-for-byte
 * what a clean compile produces, which is the whole defect.
 */
const OOM_OUTPUT = [
  '',
  '<--- Last few GCs --->',
  '[3903:0x7f2c] 79183 ms: Mark-Compact (reduce) 4082.7 (4104.7) -> 4071.3 (4090.0) MB',
  '',
  'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
  'Aborted (core dumped)',
].join('\n');

describe('deadTypecheckVerdict — a crashed typecheck is never a pass', () => {
  it('returns null for a genuinely clean run (CALIBRATION — must not cry wolf)', () => {
    expect(deadTypecheckVerdict({ exitCode: 0, status: 'completed', output: '', parsedErrors: 0 })).toBeNull();
  });

  it('returns null for ordinary type errors — nonzero exit WITH diagnostics is a real result', () => {
    expect(
      deadTypecheckVerdict({
        exitCode: 1,
        status: 'completed',
        output: "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
        parsedErrors: 1,
      }),
    ).toBeNull();
  });

  it('flags the real OOM as out-of-memory, with the heap remedy', () => {
    const v = deadTypecheckVerdict({ exitCode: 134, status: 'failed', output: OOM_OUTPUT, parsedErrors: 0 });
    expect(v).not.toBeNull();
    expect(v!.reason).toBe('typecheck_died_out_of_memory');
    expect(v!.headline).toContain('MEASURED NOTHING');
    expect(v!.advice).toContain('max-old-space-size');
  });

  it('detects the OOM by exit 134 alone, when the trace was truncated away', () => {
    // Output spills to a log on large runs, so the heap banner is often NOT in the
    // buffer the tool still holds. The exit code has to be sufficient on its own.
    const v = deadTypecheckVerdict({ exitCode: 134, status: 'failed', output: '', parsedErrors: 0 });
    expect(v?.reason).toBe('typecheck_died_out_of_memory');
  });

  it('detects the OOM by its message alone, when the exit code was lost', () => {
    const v = deadTypecheckVerdict({ exitCode: null, status: 'failed', output: OOM_OUTPUT, parsedErrors: 0 });
    expect(v?.reason).toBe('typecheck_died_out_of_memory');
  });

  it('flags a timeout that produced no diagnostics, and points at a detached re-run', () => {
    const v = deadTypecheckVerdict({ exitCode: null, status: 'timed_out', output: '', parsedErrors: 0 });
    expect(v?.reason).toBe('typecheck_timed_out_without_diagnostics');
    expect(v?.advice).toContain('run_in_background');
  });

  it('flags any other nonzero exit with no diagnostics (a bad operand, a missing tsconfig)', () => {
    const v = deadTypecheckVerdict({ exitCode: 2, status: 'completed', output: 'nonsense', parsedErrors: 0 });
    expect(v?.reason).toBe('typecheck_died_without_diagnostics');
  });

  it('PRE-FIX CONTROL: the OOM output really is indistinguishable from clean to the filter', () => {
    // This is what made the bug invisible and is why the guard cannot be derived from
    // the output alone: the crashed run yields the SAME zero the old code turned into
    // "(no tsc errors in the specified paths)". If this ever stops being 0, the fixture
    // has drifted and the tests above are no longer reproducing the real failure.
    const f = filterTscOutputToPaths(OOM_OUTPUT, ['packages/operator-core/lib/x.ts']);
    expect(f.totalErrors).toBe(0);
    expect(f.matchedLines).toEqual([]);
    // ...yet the run must still be judged dead, on the exit code / banner instead.
    expect(deadTypecheckVerdict({ exitCode: 134, status: 'failed', output: OOM_OUTPUT, parsedErrors: f.totalErrors })).not.toBeNull();
  });
});
