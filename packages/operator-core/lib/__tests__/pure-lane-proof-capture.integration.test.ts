import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { createOrgTestDb } from '../../test/_org-test-db';
import { loadCapturedProofRows, runPureLaneProofCapture } from '../../../../scripts/lib/pure-lane-proof-capture.mjs';
import { armTargetedTaskReuse, defaultRunnerIdentity } from '../../../../scripts/lib/targeted-task-reuse.mjs';

describe('capture proof archive — actual Postgres identities', () => {
  let db: FreshPgDb;
  const sha = 'a'.repeat(40);
  const startedAt = Date.parse('2026-10-05T10:00:00Z');
  const file = 'packages/operator-core/lib/a.test.ts';
  beforeAll(async () => {
    db = await createFreshPgDb('captureproof');
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.test_executed_sources (
        workspace_name text, test_file text, recorded_sha text, run_group_id text,
        recorded_at timestamptz, runner_identity text, run_context text
      );
      CREATE TABLE harness_shared.test_runs (
        id bigserial PRIMARY KEY, file_path text, commit_sha text, run_group_id text,
        source text, status text, worktree_dirty boolean, finished_at timestamptz
      );
    `);
  });
  afterAll(async () => { await db?.cleanup(); });

  it('keeps only matching source=local pass/proof rows, excluding old, dirty and foreign evidence', async () => {
    await db.sql`INSERT INTO harness_shared.test_executed_sources
      VALUES ('@papercusp/operator-core', ${file}, ${sha}, 'capture',
        ${new Date(startedAt + 1000)}, 'runner', 'green-checkpoint')`;
    const add = async (group: string, source: string, dirty: boolean, at: number, status = 'pass') => {
      await db.sql`INSERT INTO harness_shared.test_runs
        (file_path, commit_sha, run_group_id, source, status, worktree_dirty, finished_at)
        VALUES (${file}, ${sha}, ${group}, ${source}, ${status}, ${dirty}, ${new Date(at)})`;
    };
    const read = () => loadCapturedProofRows({ client: {
      query: async (text: string, values: unknown[]) => ({ rows: await db.sql.unsafe(text, values as never[]) }),
    }, sha, runGroupId: 'capture', files: [file], sinceMs: startedAt });
    await add('foreign', 'local', false, startedAt + 2000);
    await add('capture', 'ci', false, startedAt + 2000);
    await add('capture', 'local', true, startedAt + 2000);
    await add('capture', 'local', false, startedAt - 1);
    await add('foreign', 'local', false, startedAt + 2000, 'fail');
    expect(await read()).toEqual([]);
    await add('capture', 'local', false, startedAt + 3000);
    expect(await read()).toEqual([{ file, testRunId: '6', recordedAtMs: startedAt + 1000,
      runnerIdentity: 'runner', runContext: 'green-checkpoint', runGroupId: 'capture', source: 'local' }]);
    await add('capture', 'local', false, startedAt + 4000, 'fail');
    expect(await read()).toEqual([]);
    await db.sql`DELETE FROM harness_shared.test_runs WHERE status = 'fail'`;
    await db.sql`UPDATE harness_shared.test_executed_sources SET run_group_id = 'foreign'`;
    expect(await read()).toEqual([]);
  });
});

describe('P001 authentic proof producer and intended child baseline', () => {
  it('consumes native warmed proofs after lint repair and executes changed or unproven inputs', async () => {
    const source = fileURLToPath(new URL('../../../../', import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), 'proof-warming-native-'));
    const root = join(directory, 'source');
    const workspace = join(root, 'packages/operator-core');
    const org = await createOrgTestDb();
    let lease: string | undefined;
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = (message: string) => {
      git('add', '.');
      git('-c', 'user.name=Proof fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_CHECKPOINT_', 'PAPERCUSP_MUTATION_', 'AFFECTED_']
        .some(prefix => key.startsWith(prefix))) env[key] = value;
    }
    try {
      mkdirSync(join(root, 'libs/test-config'), { recursive: true });
      cpSync(join(source, 'libs/test-config/src'), join(root, 'libs/test-config/src'), { recursive: true });
      // The bundled config and Vitest's external reporter can load the same
      // helper through different hooks. Preserve the real fail-open result,
      // while retaining the originating loader error for a failed preflight.
      const runtimeWrapper = join(root, 'libs/test-config/src/runtime-proof.ts');
      const runtimeWrapperSource = readFileSync(runtimeWrapper, 'utf8');
      const runtimeHostCatch = "catch { return null; }\n}\nexport function captureCurrentRuntimeProofIdentity";
      expect(runtimeWrapperSource).toContain(runtimeHostCatch);
      const runtimeReturn = 'return hostProof()?.captureCurrentRuntimeProofIdentity?.(options) ?? null;';
      expect(runtimeWrapperSource).toContain(runtimeReturn);
      writeFileSync(runtimeWrapper, runtimeWrapperSource.replace(runtimeHostCatch,
        "catch (error) { console.error('P001_HOST_PROOF_ERROR', import.meta.url, String(error)); return null; }\n}\nexport function captureCurrentRuntimeProofIdentity")
        .replace(runtimeReturn, "const host = hostProof(); const measured = host?.captureCurrentRuntimeProofIdentity?.(options) ?? null; console.error('P001_RECORDER_RUNTIME ' + JSON.stringify({ module: import.meta.url, root: options.root, available: !!measured, fingerprint: host?.runtimeProofFingerprint?.(measured), identity: measured, execArgv: process.execArgv, helperExports: Object.keys(host ?? {}) })); return measured;"));
      cpSync(join(source, 'libs/test-config/package.json'), join(root, 'libs/test-config/package.json'));
      mkdirSync(join(root, 'libs/generic'), { recursive: true });
      cpSync(join(source, 'libs/generic/module-singleton'), join(root, 'libs/generic/module-singleton'), { recursive: true });
      mkdirSync(join(root, 'libs/test-config/node_modules/@papercusp'), { recursive: true });
      symlinkSync(join(root, 'libs/generic/module-singleton'),
        join(root, 'libs/test-config/node_modules/@papercusp/module-singleton'), 'dir');
      cpSync(join(source, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
      cpSync(join(source, 'package-lock.json'), join(root, 'package-lock.json'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module',
        workspaces: ['packages/operator-core'] }));
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n.vitest-tmp/\n');
      mkdirSync(join(workspace, 'lib'), { recursive: true });
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: '@papercusp/operator-core',
        private: true, type: 'module', scripts: { test: 'vitest run' } }));
      writeFileSync(join(workspace, 'vitest.config.ts'),
        "import { defineVitestConfig } from '../../libs/test-config/src/vitest-config.ts';\n" +
        "import { inferWorkspaceRoot } from '../../libs/test-config/src/admin-test-runs-reporter.ts';\n" +
        "import * as wrapper from '../../libs/test-config/src/runtime-proof.ts';\n" +
        "import * as helper from '../../scripts/lib/runtime-compatibility.mjs';\n" +
        "import { createRequire } from 'node:module'; import { existsSync } from 'node:fs';\n" +
        "const root = inferWorkspaceRoot();\n" +
        "const direct = helper.runtimeProofFingerprint(helper.captureCurrentRuntimeProofIdentity({ root }));\n" +
        "const wrapped = wrapper.runtimeProofFingerprint(wrapper.captureCurrentRuntimeProofIdentity({ root }));\n" +
        "let required = null, requireError = null;\n" +
        "try { const host = createRequire(new URL('../../libs/test-config/src/runtime-proof.ts', import.meta.url))('../../../scripts/lib/runtime-compatibility.mjs'); required = host.runtimeProofFingerprint(host.captureCurrentRuntimeProofIdentity({ root })); } catch (error) { requireError = String(error); }\n" +
        "const runtime = { root, marker: existsSync(root + '/node_modules/.papercusp-dependency-generation'), direct, wrapped, required, requireError, execArgv: process.execArgv };\n" +
        "console.error('P001_RUNTIME_PREFLIGHT ' + JSON.stringify(runtime));\n" +
        "if (!direct || wrapped !== direct) throw Error('Native recorder runtime unavailable: ' + JSON.stringify(runtime));\n" +
        "const config = defineVitestConfig({ layer: 'unit', include: ['lib/*.test.ts'], laneSplit: true });\n" +
        // A CLI --reporter replaces ALL configured reporters, including the
        // native ledger/proof producers. Change only the display reporter.
        "config.test.reporters = config.test.reporters.map(reporter => reporter === 'default' ? 'json' : reporter);\n" +
        "export default config;\n");
      for (const name of ['a', 'b']) {
        writeFileSync(join(workspace, `lib/${name}.ts`), 'export const value = true;\n');
        writeFileSync(join(workspace, `lib/${name}.test.ts`),
          `import { it, expect } from 'vitest'; import { value } from './${name}';\n` +
          `it('${name}', () => expect(value).toBe(true));\n`);
      }
      // Reuse the native qualification fixture's leased immutable dependency
      // publication. Neither a marker nor a runner fingerprint is invented.
      if (existsSync(join(source, 'node_modules/.papercusp-dependency-generation'))) {
        symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
      } else {
        const origin = execFileSync('git', ['-C', source, 'remote', 'get-url', 'origin'],
          { encoding: 'utf8', timeout: 10_000 }).trim();
        const storeOwner = origin.startsWith('/') && existsSync(origin) ? origin : source;
        const selected = execFileSync('bash', ['-c',
          'source "$1"; store=$(dependency_generation_resolve_root "$4"); ' +
          'dependency_generation_select_inputs "$2" "$store" || exit $?; ' +
          'dependency_generation_acquire_selector_lease "$store" "$DEPENDENCY_GENERATION_ID" "$3" "$DEPENDENCY_GENERATION_TOKEN" || exit $?; ' +
          'printf "FIXTURE_GENERATION=%s\\nFIXTURE_LEASE=%s\\n" "$DEPENDENCY_GENERATION_PATH" "$DEPENDENCY_GENERATION_SELECTOR_LEASE"',
          '--', join(source, 'apps/operator/bin/release/dependency-generation.sh'), source, String(process.pid), storeOwner],
        { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
        const generation = selected.split('\n').find(line => line.startsWith('FIXTURE_GENERATION='))?.slice('FIXTURE_GENERATION='.length);
        lease = selected.split('\n').find(line => line.startsWith('FIXTURE_LEASE='))?.slice('FIXTURE_LEASE='.length);
        if (!generation || !lease) throw new Error('native proof fixture dependency generation unmeasured');
        mkdirSync(join(root, 'node_modules'));
        for (const entry of readdirSync(join(generation, 'tree/node_modules'))
          .filter(entry => entry !== '.papercusp-dependency-generation')) {
          symlinkSync(join(generation, 'tree/node_modules', entry), join(root, 'node_modules', entry));
        }
        const marker = Object.fromEntries(readFileSync(join(generation, '.papercusp-dependency-generation'), 'utf8')
          .trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        writeFileSync(join(root, 'node_modules/.papercusp-dependency-generation'),
          `identity=${marker.identity}\nsource=${marker.source}\n`);
      }
      git('init', '--quiet');
      const baselineSha = commit('native proof workload baseline');
      Object.assign(env, { GREEN_CHECKPOINT: '1', AFFECTED_RECORD_EXECUTED_SOURCES: '1',
        PAPERCUSP_TEST_RUNS_DB_URL: org.adminDsn, PAPERCUSP_TEST_PG_ADMIN_URL: org.adminDsn,
        PATH: [join(root, 'node_modules/.bin'), env.PATH ?? ''].join(delimiter),
        PC_PURE_PROOF_CAPTURE_SLICE: '1', PAPERCUSP_TEST_RUN_GROUP: 'p001-native-suite',
        PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/operator-core',
        PC_EXECUTED_SOURCE_MAP_OUT: join(directory, 'initial-source-map.json'),
        PAPERCUSP_TEST_RUN_SOURCE: 'ci' });
      // Collection-only preflight isolates host loading, root inference and the
      // real dependency pin before any producer or intended consumer is run.
      const preflight = spawnSync(join(root, 'node_modules/.bin/vitest'),
        ['list', '--configLoader', 'bundle', '--filesOnly'],
        { cwd: workspace, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
      expect(preflight.error, preflight.stdout + preflight.stderr).toBeUndefined();
      expect(preflight.status, preflight.stdout + preflight.stderr).toBe(0);
      expect(preflight.stderr).toContain('P001_RUNTIME_PREFLIGHT ');
      const run = (environment: NodeJS.ProcessEnv, args: string[] = []) => {
        const child = spawnSync(join(root, 'node_modules/.bin/vitest'),
          ['run', '--configLoader', 'bundle', ...args],
          { cwd: workspace, env: environment, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
        expect(child.error, child.stdout + child.stderr).toBeUndefined();
        expect(child.stdout.trim(), child.stderr).not.toBe('');
        return { status: child.status, report: JSON.parse(child.stdout), stderr: child.stderr };
      };
      const initial = run(env);
      expect(initial.status, initial.stderr).toBe(0);
      expect(initial.report.numPassedTests).toBe(2);
      expect(initial.stderr, initial.stderr).not.toContain('P001_HOST_PROOF_ERROR');
      const originals = await org.adminSql`
        SELECT file_path, status, commit_sha, source, worktree_dirty FROM harness_shared.test_runs
        WHERE run_group_id = 'p001-native-suite' ORDER BY file_path`;
      expect(originals, initial.stderr).toHaveLength(2);
      expect(originals, initial.stderr).toEqual(expect.arrayContaining(['a', 'b'].map(name =>
        expect.objectContaining({ file_path: `packages/operator-core/lib/${name}.test.ts`,
          status: 'pass', commit_sha: baselineSha, source: 'ci', worktree_dirty: false }))));
      const initialProofs = await org.adminSql`
        SELECT test_file, runner_identity, inputs_captured, opaque_reasons FROM harness_shared.test_executed_sources
        WHERE run_group_id = 'p001-native-suite'`;
      const initialSnapshot = JSON.parse(readFileSync(join(directory, 'initial-source-map.json'), 'utf8'));
      const initialRuntimeDiagnostics = JSON.stringify({ initialProofs,
        selectorRunner: defaultRunnerIdentity(root, env),
        workers: initialSnapshot.nativeRun.files.map((file: { testFile: string;
          proof: { inputs: { runtime?: { before?: unknown; after?: unknown };
            workerExecution?: unknown; opaque?: string[] } | null } }) => ({
          file: file.testFile, inputsAvailable: !!file.proof.inputs,
          runtime: { before: file.proof.inputs?.runtime?.before, after: file.proof.inputs?.runtime?.after },
          workerExecution: file.proof.inputs?.workerExecution,
          opaque: file.proof.inputs?.opaque })) }) + '\n' + initial.stderr;
      expect(initialProofs, initial.stderr).toHaveLength(2);
      expect(initialProofs.every(row => row.runner_identity === defaultRunnerIdentity(root, env)),
        initialRuntimeDiagnostics).toBe(true);
      const capture = await runPureLaneProofCapture({ root, env, runGroupId: 'p001-native-capture',
        logFile: join(directory, 'capture.log') });
      const diagnostics = capture.lines.join('\n') + (existsSync(join(directory, 'capture.log'))
        ? readFileSync(join(directory, 'capture.log'), 'utf8') : '\n(no capture child launched)');
      expect(capture.state, diagnostics).toBe('done');
      expect(capture.evidence.clean).toBe(true);
      const recordedProofs = await org.adminSql`
        SELECT test_file, recorded_sha, runner_identity, run_context, run_group_id
        FROM harness_shared.test_executed_sources WHERE run_group_id = 'p001-native-capture'`;
      const capturedOriginals = await org.adminSql`
        SELECT file_path, status, commit_sha, source, worktree_dirty
        FROM harness_shared.test_runs WHERE run_group_id = 'p001-native-capture'`;
      const qualificationDiagnostics = JSON.stringify({ selectorRunner: defaultRunnerIdentity(root, env),
        recordedProofs, capturedOriginals }) + '\n' + diagnostics;
      expect(capture.evidence.proofs, qualificationDiagnostics).toHaveLength(2);
      expect(capture.evidence.proofs!.map((proof: { file: string }) => proof.file).sort())
        .toEqual(['packages/operator-core/lib/a.test.ts', 'packages/operator-core/lib/b.test.ts']);
      expect(capture.evidence.proofs!.every((proof: { source: string }) => proof.source === 'local')).toBe(true);
      mkdirSync(join(root, 'lint'), { recursive: true });
      writeFileSync(join(root, 'lint/repair.mjs'), 'export const repaired = true;\n');
      const repairedSha = commit('lint-only repair outside recorded inputs');
      const preserved = await armTargetedTaskReuse({ root, workspace: '@papercusp/operator-core',
        script: 'test', expectedSha: repairedSha, env });
      try {
        expect(preserved.reused, preserved.lines.join('\n')).toBe(2);
        const child = run(preserved.env, preserved.args);
        expect(child.status).toBe(0);
        expect(child.report.testResults).toEqual([]);
      } finally { preserved.finish(); }
      writeFileSync(join(workspace, 'lib/b.ts'), 'export const value = false;\n');
      writeFileSync(join(workspace, 'lib/c.test.ts'),
        "import { it, expect } from 'vitest'; it('c', () => expect(true).toBe(true));\n");
      const changedSha = commit('changed dependency and unproven test');
      const changed = await armTargetedTaskReuse({ root, workspace: '@papercusp/operator-core',
        script: 'test', expectedSha: changedSha, env });
      try {
        expect(changed.reused, changed.lines.join('\n')).toBe(1);
        const child = run(changed.env, changed.args);
        expect(child.status).toBe(1);
        expect(child.report.testResults.map((row: { name: string }) => row.name.split('/').at(-1)).sort())
          .toEqual(['b.test.ts', 'c.test.ts']);
        expect(child.report.numFailedTests).toBe(1);
        expect(child.report.numPassedTests).toBe(1);
      } finally { changed.finish(); }
      console.info('P001_NATIVE_PROOF_CONSUMPTION_BASELINE', JSON.stringify({ baselineSha,
        repairedSha, changedSha, capture: capture.evidence,
        lintOnlyConsumed: 2, changedInputExecuted: 'b.test.ts', unprovenExecuted: 'c.test.ts',
        plane: 'controlled-native-fixture', remaining: ['live root handoff', 'interrupted capture baseline'] }));
    } finally {
      if (lease) rmSync(lease, { force: true });
      await org.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 420_000);
});
