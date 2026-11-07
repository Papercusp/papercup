import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({ execute: vi.fn(), child: vi.fn(), authenticate: vi.fn(),
  reportRuntime: vi.fn(), end: vi.fn(), postmasterCommand: vi.fn() }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
    String(args[0]) === `/proc/${process.pid}/cmdline` ? seams.postmasterCommand() : actual.readFileSync(...args) };
});
vi.mock('node:child_process', () => ({ execFileSync: seams.execute, execFile: seams.child }));
vi.mock('../../../libs/generic/tauri-verify/src/bridge-client', () => ({ bridgeEval: seams.authenticate }));
vi.mock('./runtime-vintage', () => ({ reportRuntimeVintage: seams.reportRuntime,
  listRuntimeVintage: async () => [], measureRuntimeVintageEnvironment: () => 'measured-native' }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: { end: seams.end } }) }));
import { checkNativeLedger, nativeChildEnvironment, nativeTestDatabaseEnvironment, runNativeChild, runNativeE2e } from '../../../scripts/tauri-surface-verify-reports.mts';
import { verifierSourceFiles } from './verifier-source';

describe('DAO native wrapper scope preflight', () => {
  it.each([0, 37])('runs the maintained scope suite before any native allocation (scope exit %s)', async (scopeExit) => {
    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'dao-wrapper-preflight-'));
    try {
      const order = join(root, 'order');
      for (const directory of ['scripts/fixtures', 'libs/generic/verification-harness/bin', 'papercusp-desktop/bin/lib', 'bin'])
        mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, 'scripts/tauri-surface-verify-dao-workbench.sh'),
        readFileSync(new URL('../../../scripts/tauri-surface-verify-dao-workbench.sh', import.meta.url)));
      writeFileSync(join(root, 'libs/generic/verification-harness/bin/vh.sh'),
        'vh_phase() { :; }\nvh_init() { :; }\nvh_begin() { :; }\nvh_bracket_trap() { :; }\n');
      writeFileSync(join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'exit 0\n');
      const executable = (path: string, body: string) => { writeFileSync(path, '#!/bin/sh\n' + body); chmodSync(path, 0o755); };
      executable(join(root, 'bin/node'), 'printf "postgresql://unused@localhost:1/ledger"\n');
      executable(join(root, 'bin/npm'), 'printf "%s\\n" "$*" >> "$DAO_TEST_ORDER"\nexit "$DAO_SCOPE_PREFLIGHT_EXIT"\n');
      executable(join(root, 'bin/rig'), 'printf "native-rig\\n" >> "$DAO_TEST_ORDER"\n');
      let actualExit = 0;
      try {
        execFileSync('bash', [join(root, 'scripts/tauri-surface-verify-dao-workbench.sh')], {
          cwd: root, stdio: 'pipe', env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH,
            DAO_TEST_ORDER: order, DAO_SCOPE_PREFLIGHT_EXIT: String(scopeExit),
            PAPERCUSP_TEST_RUN_WORKSPACE: 'scope-preflight-test', PAPERCUSP_REPO_DIR: root,
            TAURI_SURFACE_VERIFY_SUITE_VERIFIER: join(root, 'bin/rig') },
        });
      } catch (error) { actualExit = (error as { status: number }).status; }
      expect(actualExit).toBe(scopeExit);
      expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual([
        'run test:file -- packages/operator-core/lib/dao-workbench-scope.integration.test.ts',
        ...(scopeExit === 0 ? ['native-rig', 'native-rig'] : []),
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Reports native launcher at the Vitest temp-directory boundary', () => {
  it('runs the prepared Reports bundle as its entrypoint while keeping imports inert', async () => {
    const { build } = await import('esbuild');
    const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const bundleRoot = mkdtempSync(join(tmpdir(), 'reports-native-entry-'));
    try {
      symlinkSync(join(repoRoot, 'node_modules'), join(bundleRoot, 'node_modules'), 'dir');
      const bundle = join(bundleRoot, 'native-tauri-surface-verify-reports.mjs');
      await build({ entryPoints: [join(repoRoot, 'scripts/tauri-surface-verify-reports.mts')],
        outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
        define: { __PAPERCUSP_BUNDLED_SIDECAR__: 'true' }, logLevel: 'silent' });
      const env = { ...process.env, PAPERCUSP_TEST_RUN_GROUP: '' };
      const imported = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `await import(${JSON.stringify(bundle)}); console.log('NATIVE_BUNDLE_IMPORT_OK');`],
      { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 });
      expect(imported.error).toBeUndefined();
      expect(imported.status, imported.stderr).toBe(0);
      expect(imported.stdout.trim()).toBe('NATIVE_BUNDLE_IMPORT_OK');
      // This preflight fails before any database or desktop effects. A bundle
      // that exits zero silently has never entered the native journey.
      const executed = spawnSync(process.execPath, ['--import', 'tsx', bundle, '--check-ledger'],
        { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 });
      expect(executed.error).toBeUndefined();
      expect(executed.status, executed.stdout + executed.stderr).toBe(1);
      expect(executed.stderr).toContain('Use PAPERCUSP_TEST_RUN_GROUP');
    } finally { rmSync(bundleRoot, { recursive: true, force: true }); }
  }, 75_000);

  it('loads the production launcher and compatibility source API through the actual Node TS runtime', async () => {
    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      'const m=await import("./scripts/tauri-surface-verify-reports.mts"); '
      + 'const old=await import("@papercusp/verification-harness/verifier-source"); '
      + 'if([m.runNativeE2e,m.runNativeChild,m.nativeChildEnvironment,old.verifyVerifierSourceSync].some(x=>typeof x!=="function")) throw Error("Missing native source API"); '
      + 'console.log("NATIVE_SOURCE_RUNTIME_IMPORTS_OK");'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 30_000,
    });
    expect(output.trim()).toBe('NATIVE_SOURCE_RUNTIME_IMPORTS_OK');
  });
  let root: string;
  let nativeRoot: string;
  let runnerRoot: string;
  let sourceRoot: string;
  let receiptPath: string;
  let profilePath: string;
  let dataDir: string;
  beforeEach(() => {
    vi.resetAllMocks();
    seams.authenticate.mockResolvedValue({ ok: true, value: true });
    seams.reportRuntime.mockResolvedValue(undefined);
    seams.end.mockResolvedValue(undefined);
    root = mkdtempSync(join(tmpdir(), 'verify-tauri-headless.'));
    nativeRoot = join(root, 'native');
    runnerRoot = join(root, 'vitest');
    mkdirSync(nativeRoot);
    mkdirSync(runnerRoot);
    mkdirSync(join(root, 'papercusp-home'));
    dataDir = join(root, 'isolated-pgdata');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'postmaster.pid'), `${process.pid}\n${dataDir}\n0\n37461\n`);
    seams.postmasterCommand.mockReturnValue(`/fixture/bin/postgres\0-D\0${dataDir}\0`);
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'papercusp-home'));
    vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', '1');
    vi.stubEnv('PAPERCUSP_PG_PORT', '37461');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgresql://fixture@localhost:37461/papercusp');
    const source = 'a'.repeat(40);
    sourceRoot = join(root, 'source');
    const files = ['packages/operator-core/lib/reports-library-native.e2e.test.ts', 'scripts/tauri-surface-verify-reports.mts',
      'packages/operator-core/lib/blueprint/morning-ai-intelligence.native.e2e.test.ts', 'scripts/native.mts',
      'scripts/lib/native-controls.mts', 'scripts/mutation-probe.sh'];
    for (const file of files) {
      mkdirSync(join(sourceRoot, file, '..'), { recursive: true });
      writeFileSync(join(sourceRoot, file), '// committed native test fixture\n');
    }
    const sourceFiles = verifierSourceFiles(sourceRoot);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: source,
      testedInputs: sourceFiles.map(({ path, sha256 }) => ({ path, sha256 })), files: sourceFiles };
    receiptPath = join(root, 'source.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(sourceRoot, '.verifier-source.json'), JSON.stringify(receipt));
    writeFileSync(join(nativeRoot, `tauri-dev-bridge-${process.pid}.token`),
      JSON.stringify({ pid: process.pid, port: 1234, token: 'fixture-bridge' }));
    vi.stubEnv('TMPDIR', nativeRoot);
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1');
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', 'postgresql://fixture/ledger');
    vi.stubEnv('OPERATOR_SOURCE_ROOT', sourceRoot);
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', source);
    vi.stubEnv('VERIFY_TAURI_PID', String(process.pid));
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'verify-tauri-isolated-90');
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'caller-workspace');
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'native-launcher-fixture');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const preparedProfile = (script = 'scripts/native.mts') => {
    const bundle = join(sourceRoot, 'apps/operator/dist-verify', `native-${script.split('/').at(-1)!.replace('.mts', '')}.mjs`);
    mkdirSync(join(bundle, '..'), { recursive: true });
    writeFileSync(bundle, 'console.log("prepared native child");\n');
    return { tauriPID: process.pid, nativeTmpDir: nativeRoot, workspaceId: 'verify-tauri-isolated-90',
      nativeChildren: [{ script, bundle,
        sha256: createHash('sha256').update(readFileSync(bundle)).digest('hex') }] };
  };

  it.each([undefined, ''])('refuses a missing canonical run group before ledger or native effects (%s)', async group => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', group);
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP_ID', 'unused-legacy-key');
    expect(() => checkNativeLedger(sourceRoot)).toThrow('PAPERCUSP_TEST_RUN_GROUP');
    await expect(runNativeE2e()).rejects.toThrow('PAPERCUSP_TEST_RUN_GROUP');
    expect(seams.execute).not.toHaveBeenCalled();
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
  });

  it.each([false, true])('checks the ledger before native allocation and propagates handshake failure=%s', fail => {
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', 'postgresql://fixture@localhost:6432/ledger');
    vi.stubEnv('PAPERCUSP_PGBOUNCER', '0');
    seams.execute.mockImplementation(() => { if (fail) throw new Error('ledger startup refused'); });
    const check = () => checkNativeLedger(sourceRoot);
    if (fail) expect(check).toThrow('ledger startup refused');
    else expect(check).not.toThrow();
    const [command, args, options] = seams.execute.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 2)).toEqual(['--input-type=module', '-e']);
    expect(args[2]).toContain('connectExecutedMapPg');
    expect(args[2]).toContain('SELECT 1');
    expect(args[2]).not.toContain('@papercusp/db-org');
    expect(options.cwd).toBe(sourceRoot);
    expect(options.timeout).toBe(10_000);
    expect(options.env.DATABASE_URL).toBe('postgresql://fixture@localhost:6432/ledger');
    expect(options.env.PAPERCUSP_PGBOUNCER).toBe('1');
    expect(options.env.PAPERCUSP_PG_PORT).toBeUndefined();
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { failure: null, code: 'E_LEDGER_FIXTURE', errorClass: 'unknown' },
    ...['connect', 'query', 'close'].map(failure => ({ failure, code: 'E_LEDGER_FIXTURE', errorClass: 'unknown' })),
    { failure: 'connect', code: null, message: 'timeout expired sensitive-fixture-credential', errorClass: 'timeout' },
    { failure: 'connect', code: 'ECONNREFUSED', errorClass: 'connection-refused' },
    { failure: 'connect', code: 'EAI_AGAIN', errorClass: 'dns' },
    { failure: 'connect', code: '28P01', errorClass: 'authentication' },
    { failure: 'connect', code: '08P01', errorClass: 'protocol' },
    { failure: 'connect', code: 'ERR_TLS_CERT_ALTNAME_INVALID', errorClass: 'tls' },
    { failure: 'connect', code: 'sensitive-fixture-credential', errorClass: 'unknown' },
    { failure: 'connect', code: null, nestedCode: 'ECONNREFUSED', errorClass: 'connection-refused' },
  ])('executes the ledger child: $failure / $errorClass / $code', async ({ failure, code, errorClass, ...detail }) => {
    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const trace = join(root, 'ledger-calls');
    mkdirSync(join(sourceRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(join(sourceRoot, 'scripts/lib/executed-source-map.mjs'), `
      import assert from 'node:assert/strict';
      import { appendFileSync } from 'node:fs';
      const call = stage => {
        appendFileSync(${JSON.stringify(trace)}, stage + '\\n');
        if (stage === ${JSON.stringify(failure)})
          throw Object.assign(new Error(${JSON.stringify('message' in detail ? detail.message : 'sensitive-fixture-credential')}),
            { code: ${JSON.stringify(code)}, errors: [{ code: ${JSON.stringify('nestedCode' in detail ? detail.nestedCode : null)} }] });
      };
      export async function connectExecutedMapPg({ env, timeoutMs, onProgress }) {
        assert.equal(env.PAPERCUSP_TEST_RUNS_DB_URL, 'postgresql://fixture:secret-password@localhost:5432/private-db?application_name=private-query');
        assert.equal(env.HARNESS_ADMIN_DATABASE_URL, env.PAPERCUSP_TEST_RUNS_DB_URL);
        assert.equal(env.DATABASE_URL, env.PAPERCUSP_TEST_RUNS_DB_URL);
        assert.equal(env.PAPERCUSP_PGBOUNCER, '0');
        assert.equal(env.PAPERCUSP_PG_PORT, undefined);
        assert.equal(timeoutMs, 5000);
        onProgress('connect');
        onProgress('authenticationSASL');
        call('connect');
        return { query: async sql => { assert.equal(sql, 'SELECT 1'); call('query'); },
          end: async () => call('close') };
      }
    `);
    let output = '';
    let childError: { status: number; stdout: string; stderr: string } | undefined;
    seams.execute.mockImplementation((command, args, options) => {
      try { output = execFileSync(command, args, { ...options, stdio: 'pipe', encoding: 'utf8' }); }
      catch (error) { childError = error as typeof childError; throw error; }
    });
    const check = () => checkNativeLedger(sourceRoot, { ...process.env,
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://fixture:secret-password@localhost:5432/private-db?application_name=private-query' });
    if (failure) {
      expect(check).toThrow();
      expect(childError?.status).toBe(1);
      expect(childError?.stderr).not.toContain('sensitive-fixture-credential');
      // Query failures still close the connection; report the original stage.
      const failed = JSON.parse(childError!.stderr.trim().replace('NATIVE_LEDGER_PREFLIGHT ', ''));
      expect(failed).toMatchObject({ stage: failure, status: 'failed', errorClass,
        protocolStage: 'authenticationSASL', endpoint: { host: 'localhost', port: 5432, protocol: 'postgres', pooled: false } });
      expect(failed.codes).toEqual(code === 'sensitive-fixture-credential' ? []
        : 'nestedCode' in detail ? [detail.nestedCode] : code ? [code] : []);
      expect(failed.activeResources).toEqual(expect.any(Object));
      expect(childError?.stdout).not.toContain('"stage":"complete"');
    } else {
      expect(check).not.toThrow();
      expect(output).toContain('"stage":"complete"');
    }
    expect((childError?.stdout ?? output)).toContain('NATIVE_LEDGER_PROTOCOL');
    const diagnostics = (childError?.stdout ?? output) + (childError?.stderr ?? '');
    for (const privateField of ['secret-password', 'private-db', 'private-query', 'sensitive-fixture-credential'])
      expect(diagnostics).not.toContain(privateField);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(
      failure === 'connect' ? ['connect'] : ['connect', 'query', 'close']);
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { url: 'postgresql://fixture@localhost:6432/ledger', pooled: true },
    { url: 'postgresql://fixture@127.0.0.1:6432/ledger', pooled: true },
    { url: 'postgresql://fixture@localhost:6439/ledger', poolerPort: '6439', pooled: true },
    { url: 'postgresql://fixture@localhost:5432/ledger', pooled: false },
    { url: 'postgresql://fixture@localhost:45000/ledger', pooled: false },
    { url: 'postgresql://fixture@db.example:6432/ledger', pooled: false },
  ])('keeps ledger $url exact and separates its startup policy from the private app PG', async ({ url, poolerPort, pooled }) => {
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', url);
    vi.stubEnv('PAPERCUSP_PGBOUNCER', '0');
    vi.stubEnv('PAPERCUSP_PGBOUNCER_PORT', poolerPort ?? '6432');
    await runNativeE2e();
    const ledgerEnv = seams.execute.mock.calls[0][2].env;
    const appEnv = seams.execute.mock.calls[1][2].env;
    expect(ledgerEnv.HARNESS_ADMIN_DATABASE_URL).toBe(url);
    expect(ledgerEnv.DATABASE_URL).toBe(url);
    expect(ledgerEnv.PAPERCUSP_PG_PORT).toBeUndefined();
    expect(ledgerEnv.PAPERCUSP_PGBOUNCER).toBe(pooled ? '1' : '0');
    expect(appEnv.HARNESS_ADMIN_DATABASE_URL).toBe('postgresql://fixture@localhost:37461/papercusp');
    expect(appEnv.PAPERCUSP_PG_PORT).toBe('37461');
    expect(appEnv.PAPERCUSP_PGBOUNCER).toBe('0');
    expect(process.env.PAPERCUSP_PG_PORT).toBe('37461');
    expect(process.env.HARNESS_ADMIN_DATABASE_URL).toBe(appEnv.HARNESS_ADMIN_DATABASE_URL);
    const { buildConnectionOptions, maybePgbouncer, pgbouncerEnabled } =
      await vi.importActual<typeof import('../../../libs/papercusp/libs/db/src/connection')>(
        '../../../libs/papercusp/libs/db/src/connection');
    vi.stubEnv('PAPERCUSP_PG_PORT', ledgerEnv.PAPERCUSP_PG_PORT);
    vi.stubEnv('PAPERCUSP_PGBOUNCER', ledgerEnv.PAPERCUSP_PGBOUNCER);
    expect(maybePgbouncer(url)).toBe(url);
    const startup = buildConnectionOptions({ searchPath: 'harness_shared,public',
      applicationName: 'reports-ledger-regression', idleInTxMs: 60_000,
      stmtTimeoutMs: 30_000, clientConnCheckMs: 30_000, pooled: pgbouncerEnabled() });
    if (pooled) {
      for (const key of ['client_connection_check_interval', 'idle_in_transaction_session_timeout',
        'statement_timeout', 'tcp_keepalives_idle', 'tcp_keepalives_interval', 'tcp_keepalives_count'])
        expect(startup).not.toHaveProperty(key);
    } else expect(startup.client_connection_check_interval).toBe('30000');
  });

  it.each([false, true])('preserves the parent discovery root and removes the profile after runner failure=%s', async (fail) => {
    seams.execute.mockImplementation((_command, args, options) => {
      if (_command === process.execPath) return '';
      profilePath = options.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
      // This is the boundary that caused the incident: the running native
      // bridge stays in its original directory while the test runner moves.
      vi.stubEnv('TMPDIR', runnerRoot);
      expect(tmpdir()).toBe(runnerRoot);
      const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
      expect(profile.nativeTmpDir).toBe(nativeRoot);
      expect(profile.tauriPID).toBe(process.pid);
      expect(profile.workspaceId).toBe('verify-tauri-isolated-90');
      expect(existsSync(join(tmpdir(), `tauri-dev-bridge-${profile.tauriPID}.token`))).toBe(false);
      expect(JSON.parse(readFileSync(join(profile.nativeTmpDir,
        `tauri-dev-bridge-${profile.tauriPID}.token`), 'utf8')).pid).toBe(process.pid);
      expect(existsSync(join(options.cwd, '.git'))).toBe(false);
      expect(options.cwd).toBe(sourceRoot);
      expect(options.env.PAPERCUSP_TEST_RUN_COMMIT).toBe('a'.repeat(40));
      expect(options.env.PAPERCUSP_TEST_PG_ADMIN_URL).toBe('postgresql://fixture@localhost:37461/papercusp');
      expect(args).toEqual(['run', 'test:file', '--', 'packages/operator-core/lib/reports-library-native.e2e.test.ts']);
      expect(args.at(-1)).toBe('packages/operator-core/lib/reports-library-native.e2e.test.ts');
      if (fail) throw new Error('native test failed');
      return '';
    });
    if (fail) await expect(runNativeE2e()).rejects.toThrow('native test failed');
    else await runNativeE2e();
    expect(seams.execute).toHaveBeenCalledTimes(2);
    expect(existsSync(profilePath)).toBe(false);
  });

  it('runs the AI consumer through the same committed-source and native runtime boundary', async () => {
    const file = 'packages/operator-core/lib/blueprint/morning-ai-intelligence.native.e2e.test.ts';
    await runNativeE2e([file]);
    const [command, args, options] = seams.execute.mock.calls[1];
    expect(command).toBe('npm');
    expect(args).toEqual(['run', 'test:file', '--', file]);
    expect(options.cwd).toBe(sourceRoot);
    expect(seams.execute.mock.calls[0][0]).toBe(process.execPath);
    expect(existsSync(options.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE)).toBe(false);
  });

  it('runs the maintained overlay probe inside the final native source root with the same app and ledger scope', async () => {
    const probe = { subject: 'scripts/lib/native-controls.mts', expression: 's/true/false/' };
    await runNativeE2e(undefined, { mutationProbe: probe });
    const [command, args, options] = seams.execute.mock.calls[1];
    expect(command).toBe('bash');
    expect(args.slice(0, 7)).toEqual([join(sourceRoot, 'scripts/mutation-probe.sh'), '--file', probe.subject,
      '--relocation', 'overlay', '--mutate', probe.expression]);
    expect(args.at(-1)).toContain('scripts/test-files.mjs packages/operator-core/lib/reports-library-native.e2e.test.ts');
    expect(options.cwd).toBe(sourceRoot);
    expect(options.env.PAPERCUSP_TEST_RUN_COMMIT).toBe('a'.repeat(40));
    expect(options.env.HARNESS_ADMIN_DATABASE_URL).toBe('postgresql://fixture@localhost:37461/papercusp');
    expect(options.env.PAPERCUSP_TEST_RUNS_DB_URL).toBe('postgresql://fixture/ledger');
    expect(existsSync(options.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE)).toBe(false);
  });

  it('refuses an out-of-source mutation before recording a runtime or executing tests', async () => {
    await expect(runNativeE2e(undefined, { mutationProbe: { subject: '../outside.mts', expression: 's/true/false/' } }))
      .rejects.toThrow('Native mutation subject');
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it('rechecks the original source receipt after a successful probe command', async () => {
    seams.execute.mockImplementation(command => {
      if (command === 'bash') writeFileSync(join(sourceRoot, 'scripts/native.mts'), '// unexpected source drift');
      return '';
    });
    await expect(runNativeE2e(undefined, { mutationProbe: { subject: 'scripts/lib/native-controls.mts', expression: 's/true/false/' } }))
      .rejects.toThrow('tampered verification source archive');
  });

  it.each(['scripts/native.mts', 'scripts/tauri-surface-verify-reports.mts'])(
    'prepares and hashes %s before launching the test runner', async script => {
    const bundle = join(sourceRoot, 'apps/operator/dist-verify', `native-${script.split('/').at(-1)!.replace('.mts', '')}.mjs`);
    const order: string[] = [];
    seams.execute.mockImplementation((command, args, options) => {
      order.push(command);
      if (command === 'bash') {
        expect(args).toEqual([join(sourceRoot, 'apps/operator/bin/bundle-host.sh'),
          join(sourceRoot, script), bundle]);
        expect(options.env.PAPERCUSP_WORKSPACE_ID).toBe('verify-tauri-isolated-90');
        mkdirSync(join(args[2], '..'), { recursive: true });
        writeFileSync(args[2], 'console.log("frozen child");\n');
      }
      if (command === 'npm') {
        const profile = JSON.parse(readFileSync(options.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE, 'utf8'));
        expect(profile.nativeChildren).toEqual([{ script,
          bundle,
          sha256: createHash('sha256').update('console.log("frozen child");\n').digest('hex') }]);
      }
      return '';
    });
    await runNativeE2e(undefined, { nativeScripts: [script] });
    expect(order).toEqual([process.execPath, 'bash', 'npm']);
  });

  it.each(['compiler failure', 'empty bundle', 'source changed'])('refuses %s before the native test runner', async reason => {
    seams.execute.mockImplementation((command, args) => {
      if (command !== 'bash') return '';
      if (reason === 'compiler failure') throw new Error('compiler failed');
      mkdirSync(join(args[2], '..'), { recursive: true });
      writeFileSync(args[2], reason === 'empty bundle' ? '' : 'console.log("child");');
      if (reason === 'source changed') writeFileSync(join(sourceRoot, 'scripts/native.mts'), '// changed after compilation\n');
      return '';
    });
    await expect(runNativeE2e(undefined, { nativeScripts: ['scripts/native.mts'] })).rejects.toThrow();
    expect(seams.execute.mock.calls.some(([command]) => command === 'npm')).toBe(false);
  });

  it.each([['../foreign.mts'], ['scripts/missing.mts'], ['scripts/native.mts', 'scripts/native.mts']])(
    'refuses an unattested or duplicate child selection %j before native effects', async (...nativeScripts) => {
      await expect(runNativeE2e(undefined, { nativeScripts })).rejects.toThrow('Native child selection');
      expect(seams.authenticate).not.toHaveBeenCalled();
      expect(seams.execute).not.toHaveBeenCalled();
    });

  it('admits the owned native postmaster through the existing test-PG seam without disabling the live guard', () => {
    vi.stubEnv('PAPERCUSP_FORBID_LIVE_PG', '1');
    vi.stubEnv('PAPERCUSP_TEST_PG_ADMIN_URL', 'postgresql://other@localhost:45000/postgres');
    const profile = { tauriPID: process.pid, nativeTmpDir: nativeRoot, workspaceId: 'verify-tauri-isolated-90' };
    const env = nativeTestDatabaseEnvironment(profile);
    expect(env.PAPERCUSP_TEST_PG_ADMIN_URL).toBe('postgresql://fixture@localhost:37461/papercusp');
    expect(env.PAPERCUSP_FORBID_LIVE_PG).toBe('1');
    expect(process.env.PAPERCUSP_TEST_PG_ADMIN_URL).toBe('postgresql://other@localhost:45000/postgres');
  });

  it.each(['shared discovery', 'foreign home', 'live port', 'remote host', 'wrong port',
    'foreign data', 'stale pid', 'foreign postmaster', 'missing ownership'])(
    'refuses %s before bridge authentication, shared runtime writes or test launch', async changed => {
      if (changed === 'shared discovery') vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', '0');
      if (changed === 'foreign home') vi.stubEnv('PAPERCUSP_HOME', runnerRoot);
      if (changed === 'live port') vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgresql://fixture@localhost:5432/papercusp');
      if (changed === 'remote host') vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgresql://fixture@192.0.2.1:37461/papercusp');
      if (changed === 'wrong port') vi.stubEnv('PAPERCUSP_PG_PORT', '45000');
      if (changed === 'foreign data') writeFileSync(join(dataDir, 'postmaster.pid'), `${process.pid}\n/foreign\n0\n37461\n`);
      if (changed === 'stale pid') writeFileSync(join(dataDir, 'postmaster.pid'), `0\n${dataDir}\n0\n37461\n`);
      if (changed === 'foreign postmaster') seams.postmasterCommand.mockReturnValue(`/fixture/bin/postgres\0-D\0/foreign\0`);
      if (changed === 'missing ownership') rmSync(join(dataDir, 'postmaster.pid'));
      await expect(runNativeE2e()).rejects.toThrow();
      expect(seams.authenticate).not.toHaveBeenCalled();
      expect(seams.reportRuntime).not.toHaveBeenCalled();
      expect(seams.execute).not.toHaveBeenCalled();
    });

  it.each([{ files: [] }, { files: ['../foreign.e2e.test.ts'] }, { files: ['--ref=other'] }])(
    'refuses invalid native test selection $files', async ({ files }) => {
    await expect(runNativeE2e(files)).rejects.toThrow('Use maintained operator-core native E2E or integration test files');
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it('refuses a shared live desktop before authentication, runtime writes or test launch', async () => {
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '0');
    await expect(runNativeE2e()).rejects.toThrow('Use the isolated native verifier');
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it('refuses an unconfigured shared ledger before bridge authentication or runtime writes', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', '');
    await expect(runNativeE2e()).rejects.toThrow('Keep native results in the shared test ledger');
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it.each(['source bytes', 'archive manifest', 'source root', 'source commit'] as const)(
    'refuses changed %s before authentication, runtime writes or test launch', async (changed) => {
    if (changed === 'source bytes') writeFileSync(join(sourceRoot,
      'packages/operator-core/lib/reports-library-native.e2e.test.ts'), '// foreign bytes\n');
    if (changed === 'archive manifest') writeFileSync(join(sourceRoot, '.verifier-source.json'), '{}');
    if (changed === 'source root') vi.stubEnv('OPERATOR_SOURCE_ROOT', runnerRoot);
    if (changed === 'source commit') vi.stubEnv('VERIFY_TAURI_SOURCE_REF', 'b'.repeat(40));
    await expect(runNativeE2e()).rejects.toThrow();
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it('refuses a maintained test absent from the attested snapshot before any native effects', async () => {
    await expect(runNativeE2e(['packages/operator-core/lib/missing.native.e2e.test.ts']))
      .rejects.toThrow('Native test selection must belong to the verified source snapshot');
    expect(seams.authenticate).not.toHaveBeenCalled();
    expect(seams.reportRuntime).not.toHaveBeenCalled();
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it('restores the private workspace after the worker scrub, preserving caller ledger attribution', async () => {
    const profile = preparedProfile();
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    vi.stubEnv('TMPDIR', runnerRoot);
    seams.child.mockImplementation((_command, _args, options, callback) => {
      expect(_args).toEqual([profile.nativeChildren[0].bundle]);
      expect(options.env.PAPERCUSP_WORKSPACE_ID).toBe(profile.workspaceId);
      expect(options.env.PAPERCUSP_WORKSPACE).toBe(profile.workspaceId);
      expect(options.env.PAPERCUSP_TEST_RUN_WORKSPACE).toBe('caller-workspace');
      expect(options.env.TMPDIR).toBe(nativeRoot);
      callback(null, 'journey output', '');
    });
    expect(await runNativeChild(profile, sourceRoot, 'scripts/native.mts')).toEqual({ stdout: 'journey output', stderr: '' });
    expect(process.env.PAPERCUSP_WORKSPACE_ID).toBeUndefined();
    expect(process.env.TMPDIR).toBe(runnerRoot);
  });

  it.each([undefined, 'caller-workspace'])('refuses missing or live workspace=%s before starting the child', async workspaceId => {
    const profile = { tauriPID: process.pid, nativeTmpDir: nativeRoot, workspaceId: workspaceId as string };
    expect(() => nativeChildEnvironment(profile)).toThrow('explicit private workspace');
    expect(seams.child).not.toHaveBeenCalled();
  });

  it.each(['scripts/native.mts', 'scripts/tauri-surface-verify-reports.mts'])(
    'retains the startup stack, stdout and stderr when %s fails', async script => {
    const failure = Object.assign(new Error('child startup'), { code: 1, signal: null });
    seams.child.mockImplementation((_command, _args, options, callback) => {
      expect(options.timeout).toBe(280_000);
      callback(failure, 'child manifest', 'assert.match: undefined workspace');
    });
    const profile = preparedProfile(script);
    await expect(runNativeChild(profile, sourceRoot, script, [], 280_000)).rejects.toThrow(
      /child startup[\s\S]*stdout:\nchild manifest[\s\S]*stderr:\nassert.match: undefined workspace/);
  });

  it.each([0, 300_001, NaN])('refuses unbounded child deadline %s before launch', timeout => {
    expect(() => runNativeChild(preparedProfile(), sourceRoot, 'scripts/native.mts', [], timeout))
      .toThrow('deadline must fit');
    expect(seams.child).not.toHaveBeenCalled();
  });

  it.each(['missing preparation', 'changed bytes', 'foreign path', 'missing hash'])(
    'refuses %s without falling back to a runtime compiler', reason => {
      const profile = preparedProfile();
      if (reason === 'missing preparation') profile.nativeChildren = [];
      if (reason === 'changed bytes') writeFileSync(profile.nativeChildren[0].bundle, 'foreign bytes');
      if (reason === 'foreign path') profile.nativeChildren[0].bundle = join(root, 'foreign.mjs');
      if (reason === 'missing hash') profile.nativeChildren[0].sha256 = '';
      expect(() => runNativeChild(profile, sourceRoot, 'scripts/native.mts')).toThrow();
      expect(seams.child).not.toHaveBeenCalled();
    });
});
