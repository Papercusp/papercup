import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type {} from '../test/admission-http-fixture';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { assertPrivateManagedTaskRoute, preparePrivateOperatorApiBundle,
  privateCompletionFixtureArgs, parsePrivateCompletionFixtureControls,
  parsePrivateHttpScenario } from '../test/private-http-workspace-preflight';
import { isolatedRuntimeEvidenceKeys, isolatedRuntimeInheritedEnvironment, privatePgSeedEnvironment, privatePgCommandEnvironment } from '../../../scripts/lib/with-test-pg-env.mjs';
import { executedSourceMapArmed } from '@papercusp/test-config/vitest-config';

const root = resolve(import.meta.dirname, '../../..');

// These children deliberately stop before PG allocation. Keep their existing
// deadlines, but distinguish a Node preload stall from loader registration or
// the real entry's admission work when a child misses its deadline.
function preflightChildScript(entry: string, hook: string, argv: string[]): string {
  return `import { register } from 'node:module';
    import { writeSync } from 'node:fs';
    const phase = stage => writeSync(2, 'PREFLIGHT_STARTUP ' + JSON.stringify({
      stage, elapsedMs: performance.now(), pid: process.pid,
    }) + '\\n');
    phase('evaluation-entered');
    phase('loader-registration-start');
    register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hook))});
    phase('loader-registration-complete');
    process.argv = ${JSON.stringify(argv)};
    phase('entry-import-start');
    await import(${JSON.stringify(pathToFileURL(entry).href)});
    phase('entry-import-complete');`;
}

describe('private preflight startup diagnostics', () => {
  it('retains separate phase records when loader registration fails', () => {
    const entry = join(root, 'scripts/with-test-pg.mjs');
    const script = preflightChildScript(entry,
      "throw new Error('PREFLIGHT_LOADER_REGISTRATION_FAILURE');", [process.execPath, entry]);
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    const diagnostic = childDiagnostic(result, startedAt);
    expect(result.status, diagnostic).toBe(1);
    expect(result.signal, diagnostic).toBeNull();
    expect(result.stderr, diagnostic).toContain('PREFLIGHT_LOADER_REGISTRATION_FAILURE');
    const phases = result.stderr.split('\n')
      .filter(line => line.startsWith('PREFLIGHT_STARTUP '))
      .map(line => JSON.parse(line.slice('PREFLIGHT_STARTUP '.length)));
    expect(phases.map(row => row.stage), diagnostic).toEqual([
      'evaluation-entered', 'loader-registration-start',
    ]);
  });
});

describe('private runtime inherited environment', () => {
  it('keeps the source-map reporter armed with the launcher evidence allowlist while stripping ambient authority', () => {
    const input = {
      PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/operator-core',
      PC_EXECUTED_SOURCE_MAP_OUT: '/owned-proof/executed-source-map.json',
      PC_EXECUTED_SOURCE_MAP_RESULT: '/owned-proof/source-map-results.jsonl',
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://reporter.invalid/evidence',
      PAPERCUSP_TEST_ARTIFACT_DIR: '/owned-proof/recorder-tapes',
      PAPERCUSP_TEST_ARTIFACT_DIR_COPY: '/live/mutable-destination',
      PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/live/substrate.sock',
      PAPERCUSP_OPERATOR_URL: 'https://live.invalid',
      PAPERCUSP_SID: 'live-owner', EXPERIMENTAL_PROVIDER_TOKEN: 'credential-value',
      PC_EXECUTED_SOURCE_MAP_OUT_COPY: '/live/mutable-destination',
    };
    const result = isolatedRuntimeInheritedEnvironment(input,
      isolatedRuntimeEvidenceKeys('PAPERCUSP_TEST_OWNED_DB_DIR'));
    expect(executedSourceMapArmed(result.environment)).toMatchObject({
      workspaceName: input.PC_EXECUTED_SOURCE_MAP_WORKSPACE,
      outPath: input.PC_EXECUTED_SOURCE_MAP_OUT,
      resultPath: input.PC_EXECUTED_SOURCE_MAP_RESULT,
    });
    expect(result.environment).toEqual({
      PC_EXECUTED_SOURCE_MAP_WORKSPACE: input.PC_EXECUTED_SOURCE_MAP_WORKSPACE,
      PC_EXECUTED_SOURCE_MAP_OUT: input.PC_EXECUTED_SOURCE_MAP_OUT,
      PC_EXECUTED_SOURCE_MAP_RESULT: input.PC_EXECUTED_SOURCE_MAP_RESULT,
      PAPERCUSP_TEST_RUNS_DB_URL: input.PAPERCUSP_TEST_RUNS_DB_URL,
      PAPERCUSP_TEST_ARTIFACT_DIR: input.PAPERCUSP_TEST_ARTIFACT_DIR,
    });
    expect(result.discardedKeys).toEqual(Object.keys(input).filter(key => !(key in result.environment)).sort());
    expect(JSON.stringify(result)).not.toContain('credential-value');
  });

  it('keeps tooling and exact admitted evidence without inheriting unknown mutable destinations', () => {
    const input = {
      PATH: '/tool/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', NODE_OPTIONS: '--enable-source-maps',
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://reporter.invalid/evidence',
      DOCKER_HOST: 'unix:///run/explicit-test-engine.sock',
      ELEVENLABS_WEBHOOK_SECRET: 'credential-value', EXPERIMENTAL_PROVIDER_TOKEN: 'credential-value',
      SMTP_HOST: 'outbound.invalid', REDIS_URL: 'redis://shared.invalid',
      UNCLASSIFIED_MUTABLE_ROOT: '/shared/state', ARBITRARY_SERVICE_ENDPOINT: 'https://shared.invalid',
      MY_PRODUCTION_DATABASE: 'shared', LOCAL_QUEUE_DIR: '/shared/queue',
      PAPERCUSP_SID: 'live-owner', DATABASE_URL: 'postgresql://live.invalid/state',
    };
    const evidence = new Set(['PAPERCUSP_TEST_RUNS_DB_URL', 'DOCKER_HOST']);
    const result = isolatedRuntimeInheritedEnvironment(input, evidence);
    expect(result.environment).toEqual({ PATH: input.PATH, LANG: input.LANG, LC_ALL: input.LC_ALL,
      NODE_OPTIONS: input.NODE_OPTIONS, PAPERCUSP_TEST_RUNS_DB_URL: input.PAPERCUSP_TEST_RUNS_DB_URL,
      DOCKER_HOST: input.DOCKER_HOST });
    expect(result.discardedKeys).toEqual(Object.keys(input).filter(key => !(key in result.environment)).sort());
    expect(input.ELEVENLABS_WEBHOOK_SECRET).toBe('credential-value');
    expect(JSON.stringify(result)).not.toContain('credential-value');
  });

  it('carries only the configured private-PG seed controls into detached test runs', () => {
    const input = {
      PAPERCUSP_PG_SEED_PATH: '/sidecar/db-seed.dump',
      PAPERCUSP_PG_RESTORE_BIN: '/sidecar/bin/pg_restore',
      PAPERCUSP_PG_DISABLE_SEED: '1',
      PAPERCUSP_SID: 'live-owner',
      DATABASE_URL: 'postgresql://live.invalid/state',
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://reporter.invalid/evidence',
    };
    expect(privatePgSeedEnvironment(input)).toEqual({
      PAPERCUSP_PG_SEED_PATH: input.PAPERCUSP_PG_SEED_PATH,
      PAPERCUSP_PG_RESTORE_BIN: input.PAPERCUSP_PG_RESTORE_BIN,
      PAPERCUSP_PG_DISABLE_SEED: input.PAPERCUSP_PG_DISABLE_SEED,
    });
  });

  it('does not infer evidence or tooling authority from a prefix or an undefined value', () => {
    expect(isolatedRuntimeInheritedEnvironment({ PATH: undefined, LC_ALL: 'C', LC_TOKEN: 'secret',
      NODE_PROVIDER_SECRET: 'secret', PC_UNKNOWN_DESTINATION: '/shared',
      PAPERCUSP_TEST_RUNS_DB_URL_COPY: 'postgresql://live.invalid/state' }, new Set())).toEqual({
      environment: { LC_ALL: 'C' },
      discardedKeys: ['LC_TOKEN', 'NODE_PROVIDER_SECRET', 'PAPERCUSP_TEST_RUNS_DB_URL_COPY', 'PC_UNKNOWN_DESTINATION'],
    });
  });
});

describe('private HTTP scenario controls', () => {
  it.each([
    ['--saved-plan-lines', 'saved-plan-lines'], ['--rubric-coverage', 'rubric-coverage'],
    ['--current-su-recovery-allocation', 'current-su-native-recovery-allocation'],
    ...['private-mcp-preflight-only', 'current-su-native', 'current-su-native-carry',
      'current-su-native-frozen-carry-on', 'current-su-native-frozen-carry-off', 'testing-background']
      .map(scenario => ['--private-http-scenario=' + scenario, scenario]),
  ])('retains %s across the real environment scrub', (selector, scenario) => {
    const result = isolatedRuntimeInheritedEnvironment({ STAGING_FIRST_HTTP_SCENARIO: 'ambient-other-scenario',
      STAGING_FIRST_HTTP_EVIDENCE_DIR: '/owned-proof', PAPERCUSP_SID: 'live-owner' },
    isolatedRuntimeEvidenceKeys('PAPERCUSP_TEST_OWNED_DB_DIR'));
    expect(result.environment).toEqual({ STAGING_FIRST_HTTP_EVIDENCE_DIR: '/owned-proof' });
    expect(result.discardedKeys).toContain('STAGING_FIRST_HTTP_SCENARIO');
    expect(parsePrivateHttpScenario([selector, '--prepared-api-sha=owned'])).toBe(scenario);
    expect(parsePrivateHttpScenario([])).toBeNull();
  });
  it.each([
    ['--private-http-scenario=unknown'], ['--private-http-scenario'],
    ['--private-http-scenario='], ['--rubric-coverage', '--rubric-coverage'],
    ['--saved-plan-lines', '--private-http-scenario=current-su-native'],
    ['--rubric-coverage', '--completion-scenario=report', '--completion-transport=palette'],
  ])('rejects ambiguous or unsupported private HTTP controls %j', (...argv) => {
    expect(() => parsePrivateHttpScenario(argv)).toThrow(/private HTTP scenario/);
  });
});

describe('private completion fixture controls', () => {
  it.each([
    { maintenance: false, transport: 'palette' as const },
    { maintenance: true, transport: 'palette' as const },
    { maintenance: false, transport: 'mcp-proxy' as const },
    { maintenance: true, transport: 'mcp-proxy' as const },
  ])('retains explicit selection after the real environment scrub: %j', controls => {
    const argv = privateCompletionFixtureArgs(controls);
    const { environment, discardedKeys } = isolatedRuntimeInheritedEnvironment({
      STAGING_FIRST_HTTP_SCENARIO: 'ambient-other-scenario', STAGING_FIRST_HTTP_MAINTENANCE: '1',
      STAGING_FIRST_HTTP_EVIDENCE_DIR: '/owned-proof', PAPERCUSP_SID: 'live-owner',
      PAPERCUSP_OPERATOR_URL: 'https://live.invalid',
    }, isolatedRuntimeEvidenceKeys('PAPERCUSP_TEST_OWNED_DB_DIR'));
    expect(environment).toEqual({ STAGING_FIRST_HTTP_EVIDENCE_DIR: '/owned-proof' });
    expect(discardedKeys).toEqual(expect.arrayContaining([
      'STAGING_FIRST_HTTP_SCENARIO', 'STAGING_FIRST_HTTP_MAINTENANCE', 'PAPERCUSP_SID', 'PAPERCUSP_OPERATOR_URL',
    ]));
    expect(parsePrivateCompletionFixtureControls([...argv, '--prepared-api-sha=owned'])).toEqual(controls);
    expect(parsePrivateCompletionFixtureControls([])).toBeNull();
  });
  it.each([
    ['--completion-scenario=maintenance'], ['--completion-transport=palette'],
    ['--completion-scenario=unknown', '--completion-transport=palette'],
    ['--completion-scenario=maintenance', '--completion-transport=unknown'],
    ['--completion-scenario=report', '--completion-scenario=report', '--completion-transport=palette'],
    ['--completion-scenario=report', '--completion-transport=palette', '--completion-transport=palette'],
    ['--completion-unknown=1', '--completion-transport=palette'],
  ])('rejects incomplete, unknown or duplicated controls %j', (...argv) => {
    expect(() => parsePrivateCompletionFixtureControls(argv)).toThrow(/completion fixture/);
  });
});

describe('required private database extensions', () => {
  it.each([false, true])('checks required extensions before runtime allocation (ready=%s)', ready => {
    const entry = join(root, 'scripts/with-test-pg.mjs');
    // Replace only the prerequisite provider. The real entry must call it and
    // stop before importing runtime dependencies when the extension is absent.
    const extension = 'data:text/javascript,' + encodeURIComponent(
      `export function ensureRequiredEmbeddedExtensions() { ${ready ? '' : "throw new Error('REQUIRED_EXTENSION_NOT_READY');"} }`,
    );
    const hook = `export async function resolve(specifier, context, next) {
      if (specifier === './install-embedded-pgvector.mjs') return { url: ${JSON.stringify(extension)}, shortCircuit: true };
      if (specifier === 'async-exit-hook') throw new Error('EXTENSION_ADMISSION_REACHED');
      return next(specifier, context);
    }`;
    const script = preflightChildScript(entry, hook,
      [process.execPath, entry, '--', process.execPath, '-e', 'process.exit(91)']);
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: undefined },
    });
    const diagnostic = childDiagnostic(result, startedAt);
    expect(result.status, diagnostic).toBe(1);
    expect(result.signal, diagnostic).toBeNull();
    expect(result.stderr, diagnostic).toContain(ready ? 'EXTENSION_ADMISSION_REACHED' :
      '[with-test-pg] extension preflight failed: REQUIRED_EXTENSION_NOT_READY');
    expect(result.stderr, diagnostic).not.toContain(ready ? 'REQUIRED_EXTENSION_NOT_READY' : 'EXTENSION_ADMISSION_REACHED');
    expect(result.stdout, diagnostic).not.toContain('booting throwaway PG');
  });
});

describe('private-PG setup budget receipt', () => {
  it('does not hand a consumed setup phase to a nested runtime while retaining task and cleanup bounds', () => {
    const source = {
      PAPERCUSP_TEST_PRIVATE_PG_SETUP_TIMEOUT_MS: '120000',
      PAPERCUSP_TEST_PRIVATE_PG_SETUP_DEADLINE_AT_MS: '1794714610157',
      PAPERCUSP_TEST_TASK_DEADLINE_AT_MS: '1794714880157',
      PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS: '1794714850157',
      PAPERCUSP_TEST_CLEANUP_RESERVE_MS: '30000',
      PAPERCUSP_TEST_FILE_TIMEOUT_MS: '240000',
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://reporter.invalid/evidence',
    };
    const command = privatePgCommandEnvironment(source);
    expect(command.PAPERCUSP_TEST_PRIVATE_PG_SETUP_TIMEOUT_MS).toBeUndefined();
    expect(command.PAPERCUSP_TEST_PRIVATE_PG_SETUP_DEADLINE_AT_MS).toBeUndefined();
    expect(command).toMatchObject({
      PAPERCUSP_TEST_TASK_DEADLINE_AT_MS: source.PAPERCUSP_TEST_TASK_DEADLINE_AT_MS,
      PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS: source.PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS,
      PAPERCUSP_TEST_CLEANUP_RESERVE_MS: source.PAPERCUSP_TEST_CLEANUP_RESERVE_MS,
      PAPERCUSP_TEST_FILE_TIMEOUT_MS: source.PAPERCUSP_TEST_FILE_TIMEOUT_MS,
      PAPERCUSP_TEST_RUNS_DB_URL: source.PAPERCUSP_TEST_RUNS_DB_URL,
    });
    expect(source.PAPERCUSP_TEST_PRIVATE_PG_SETUP_DEADLINE_AT_MS).toBe('1794714610157');
  });

  it('records an expired setup and refuses before allocating Postgres or starting tests', () => {
    const entry = join(root, 'scripts/with-test-pg.mjs');
    const artifactDir = mkdtempSync(join(tmpdir(), 'private-pg-setup-receipt-'));
    const phasesPath = join(artifactDir, 'phases.jsonl');
    writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(phasesPath, '');
    try {
      const startedAt = performance.now();
      const result = spawnSync(process.execPath, [entry, '--', process.execPath, '-e', 'process.exit(91)'], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: undefined,
          PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://reporter.invalid/evidence',
          PAPERCUSP_TEST_ARTIFACT_DIR: artifactDir,
          PAPERCUSP_TEST_PRIVATE_PG_SETUP_TIMEOUT_MS: '300000',
          PAPERCUSP_TEST_PRIVATE_PG_SETUP_DEADLINE_AT_MS: '1' },
      });
      const diagnostic = childDiagnostic(result, startedAt);
      expect(result.status, diagnostic).toBe(1);
      expect(result.stderr, diagnostic).toContain('private-PG setup budget exhausted');
      expect(result.stdout, diagnostic).not.toContain('booting throwaway PG');
      expect(result.stdout, diagnostic).not.toContain('ready —');
      const stages = readFileSync(phasesPath, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line).stage);
      expect(stages).toEqual(expect.arrayContaining([
        'private-pg-setup-start', 'private-pg-seed-preflight', 'private-pg-setup-timeout',
      ]));
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});

function childDiagnostic(result: SpawnSyncReturns<string>, startedAt: number): string {
  return JSON.stringify({ elapsedMs: performance.now() - startedAt, status: result.status, signal: result.signal,
    error: result.error && { name: result.error.name, message: result.error.message,
      code: (result.error as NodeJS.ErrnoException).code }, stdout: result.stdout, stderr: result.stderr });
}

describe('private Docker endpoint admission', () => {
  it.each([
    { host: undefined, admitted: true },
    { host: 'unix:///run/docker-bench.sock', admitted: true },
    { host: 'tcp://credential@remote.invalid:2376', admitted: false },
    { host: 'unix://relative/docker.sock', admitted: false },
    { host: '', admitted: false },
  ])('checks the selected endpoint before allocating private state: %j', ({ host, admitted }) => {
    const entry = join(root, 'scripts/with-test-pg.mjs');
    const extension = 'data:text/javascript,' + encodeURIComponent(
      'export function ensureRequiredEmbeddedExtensions() {}');
    const hook = `export async function resolve(specifier, context, next) {
      if (specifier === './install-embedded-pgvector.mjs') return { url: ${JSON.stringify(extension)}, shortCircuit: true };
      return next(specifier, context);
    }`;
    const script = preflightChildScript(entry, hook,
      [process.execPath, entry, '--isolated-runtime', '--', '/papercusp-missing-docker-admission-child']);
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      // This child stops before allocation; the enclosing run owns its evidence.
      env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: undefined, DOCKER_HOST: host,
        PAPERCUSP_TEST_RUNS_DB_URL: undefined, PAPERCUSP_TEST_RUN_WORKSPACE: undefined,
        PAPERCUSP_TEST_RUN_RECEIPT_FILE: undefined, PC_EXECUTED_SOURCE_MAP_RESULT: undefined,
        PC_EXECUTED_SOURCE_MAP_OUT: undefined },
    });
    const diagnostic = childDiagnostic(result, startedAt);
    expect(result.status, diagnostic).toBe(1);
    expect(result.signal, diagnostic).toBeNull();
    expect(result.stderr, diagnostic).toContain(admitted ? 'child preflight failed' : 'Docker preflight failed');
    expect(result.stderr, diagnostic).not.toContain(admitted ? 'Docker preflight failed' : 'child preflight failed');
    expect(result.stdout, diagnostic).not.toContain('booting throwaway PG');
    expect(result.stderr, diagnostic).not.toContain('credential@remote.invalid');
  });
});

describe('private proof IPC admission', () => {
  it.each([
    { isolated: true, proof: true, ipc: false, command: 'node', admitted: false },
    { isolated: false, proof: true, ipc: true, command: 'node', admitted: false },
    { isolated: true, proof: true, ipc: true, command: 'node', admitted: true },
    { isolated: true, proof: false, ipc: false, command: 'node', admitted: true },
    { isolated: true, proof: true, ipc: true, command: 'other', admitted: false },
    { isolated: true, proof: false, ipc: false, command: 'other', admitted: true },
  ])('checks the parent channel and executable before allocation: %j', async ({ isolated, proof, ipc, command, admitted }) => {
    const entry = join(root, 'scripts/with-test-pg.mjs');
    const directory = mkdtempSync(join(tmpdir(), 'private-proof-command-'));
    const executable = command === 'node' ? process.execPath : join(directory, 'worker');
    if (command !== 'node') writeFileSync(executable, '#!/bin/sh\nexit 91\n', { mode: 0o755 });
    // Stop at the real allocation dependency boundary; admission must not create
    // a database, runtime root, migration copy or test child in any of these cases.
    const hook = `export async function resolve(specifier, context, next) {
      if (specifier === 'async-exit-hook') throw new Error('PROOF_ADMISSION_REACHED');
      return next(specifier, context);
    }`;
    const script = preflightChildScript(entry, hook,
      [process.execPath, entry, ...(isolated ? ['--isolated-runtime'] : []),
        '--', executable, '-e', 'process.exit(91)']);
    const env = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: proof ? '1' : undefined,
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://unused-test-ledger.invalid/test' };
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, env, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const closed = once(child, 'close');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      const [status, signal] = await closed;
      const diagnostic = JSON.stringify({ status, signal, stdout, stderr });
      expect(status, diagnostic).toBe(1);
      expect(signal, diagnostic).toBeNull();
      const refusal = command === 'other' ? 'original lifetime proof requires the maintained Node worker route' :
        'proof preflight failed';
      expect(stderr, diagnostic).toContain(admitted ? 'PROOF_ADMISSION_REACHED' : refusal);
      expect(stderr, diagnostic).not.toContain(admitted ? 'proof preflight failed' : 'PROOF_ADMISSION_REACHED');
      expect(stdout).not.toContain('booting throwaway PG');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('private admission pinned manager route', () => {
  async function withRoute(route: string, check: (fixture: {
    env: NodeJS.ProcessEnv; runtime: string; source: string; alias: string; socket: string;
  }) => void) {
    const directory = mkdtempSync(join(tmpdir(), 'admission-route-'));
    const runtime = join(directory, 'xdg-runtime');
    const source = join(directory, 'source-runtime');
    for (const path of [join(runtime, 'systemd'), join(source, 'systemd')]) mkdirSync(path, { recursive: true });
    const alias = join(runtime, route);
    const socket = join(source, route);
    const server = createServer(connection => connection.destroy());
    try {
      await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(socket, done); });
      symlinkSync(socket, alias);
      check({ runtime, source, alias, socket, env: { HOME: join(directory, 'home'),
        XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${alias}` } });
    } finally {
      if (server.listening) await new Promise<void>(done => server.close(() => done()));
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.each(['systemd/private', 'bus'])('accepts the exact owned %s alias selected by the launcher', async route => {
    await withRoute(route, ({ env, alias, socket }) => {
      expect(assertPrivateManagedTaskRoute(env)).toEqual({ address: `unix:path=${alias}`, alias, socket });
    });
  });

  it.each(['missing', 'ambient', 'fallback', 'options'])('rejects a %s address before admission', async kind => {
    await withRoute('bus', ({ env }) => {
      if (kind === 'missing') delete env.DBUS_SESSION_BUS_ADDRESS;
      if (kind === 'ambient') env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';
      if (kind === 'fallback') env.DBUS_SESSION_BUS_ADDRESS += ';unix:path=/run/user/1000/bus';
      if (kind === 'options') env.DBUS_SESSION_BUS_ADDRESS += ',guid=unverified';
      expect(() => assertPrivateManagedTaskRoute(env)).toThrow('one exact private managed-task bus address required');
    });
  });

  it.each(['systemd/private', 'bus'])('rejects a %s alias for the other socket protocol', async route => {
    const other = route === 'bus' ? 'systemd/private' : 'bus';
    await withRoute(other, ({ env, runtime, socket }) => {
      unlinkSync(join(runtime, other));
      const alias = join(runtime, route);
      symlinkSync(socket, alias);
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${alias}`;
      expect(() => assertPrivateManagedTaskRoute(env)).toThrow('selected alias must preserve the socket protocol');
    });
  });

  it('rejects a second route even when its alias is dangling', async () => {
    await withRoute('bus', ({ env, runtime }) => {
      symlinkSync('/missing/unselected/private', join(runtime, 'systemd/private'));
      expect(() => assertPrivateManagedTaskRoute(env)).toThrow('an unselected manager route must not be exposed');
    });
  });

  it('rejects an alias to a regular file', async () => {
    await withRoute('bus', ({ env, alias, source }) => {
      const file = join(source, 'other/bus');
      mkdirSync(join(source, 'other'));
      writeFileSync(file, 'not a socket');
      unlinkSync(alias); symlinkSync(file, alias);
      expect(() => assertPrivateManagedTaskRoute(env)).toThrow('selected route must reach an owned socket');
    });
  });

  it('rejects a route owned by another uid', async () => {
    await withRoute('bus', ({ env }) => {
      const uid = process.getuid!();
      const getuid = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      try { expect(() => assertPrivateManagedTaskRoute(env)).toThrow('selected route must be an owned alias'); }
      finally { getuid.mockRestore(); }
    });
  });

  it('rejects a runtime outside the disposable home root', async () => {
    await withRoute('bus', ({ env, source }) => {
      env.XDG_RUNTIME_DIR = source;
      expect(() => assertPrivateManagedTaskRoute(env)).toThrow('managed-task route must use the private runtime');
    });
  });
});

describe('private managed task preflight', () => {
  it.each(['--isolated-runtime=operator-api', '--isolated-runtime'])('probes a pinned owned bus for %s when the private socket is unusable, without an ambient fallback', async profile => {
    const directory = mkdtempSync(join(tmpdir(), 'private-task-pinned-route-'));
    mkdirSync(join(directory, 'systemd')); mkdirSync(join(directory, 'bin'));
    const servers = [createServer(socket => socket.destroy()), createServer(socket => socket.destroy())];
    const paths = [join(directory, 'systemd', 'private'), join(directory, 'bus')];
    for (const [index, server] of servers.entries()) await new Promise<void>((done, reject) => {
      server.once('error', reject); server.listen(paths[index], done);
    });
    // Replace only the manager protocol: it rejects the stale route, checks
    // the explicit alias and accepts the owned bus. PG is never allocated.
    writeFileSync(join(directory, 'bin', 'systemd-run'), `#!${process.execPath}\n` +
      `const fs = require('node:fs');\n` +
      `const path = require('node:path');\n` +
      `const alias = path.join(process.env.XDG_RUNTIME_DIR, 'bus');\n` +
      `if (process.env.DBUS_SESSION_BUS_ADDRESS !== 'unix:path=' + alias) process.exit(24);\n` +
      `process.exit(fs.realpathSync(alias) === ${JSON.stringify(paths[1])} ? 0 : 25);\n`, { mode: 0o755 });
    const entry = join(root, 'scripts/with-test-pg.mjs');
    const hook = `export async function resolve(specifier, context, next) {
      if (specifier === 'async-exit-hook') throw new Error('PINNED_MANAGER_PREFLIGHT_REACHED');
      return next(specifier, context);
    }`;
    const script = preflightChildScript(entry, hook,
      [process.execPath, entry, profile, '--managed-tasks', '--', process.execPath, '-e', 'process.exit(91)']);
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: join(directory, 'bin') + ':' + process.env.PATH, XDG_RUNTIME_DIR: directory,
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/unverified-ambient-bus',
          PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://unused-test-ledger.invalid/test' },
      });
      const diagnostic = JSON.stringify(result);
      expect(result.stdout, diagnostic).toContain('managed task preflight passed');
      expect(result.stderr, diagnostic).toContain('PINNED_MANAGER_PREFLIGHT_REACHED');
      expect(result.stdout).not.toContain('booting throwaway PG');
    } finally {
      for (const server of servers) await new Promise<void>(done => server.close(() => done()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.XDG_RUNTIME_DIR || !existsSync(join(process.env.XDG_RUNTIME_DIR, 'bus')))(
    'reaches the allocation boundary through the actual user-manager bus with its native protocol', () => {
      const entry = join(root, 'scripts/with-test-pg.mjs');
      const hook = `export async function resolve(specifier, context, next) {
        if (specifier === 'async-exit-hook') throw new Error('NATIVE_MANAGER_PREFLIGHT_REACHED');
        return next(specifier, context);
      }`;
      const script = `import { register } from 'node:module';
        register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hook))});
        process.argv = [process.execPath, ${JSON.stringify(entry)}, '--isolated-runtime=operator-api', '--managed-tasks',
          '--', process.execPath, '-e', 'process.exit(91)'];
        await import(${JSON.stringify(pathToFileURL(entry).href)});`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/unverified-ambient-bus',
          PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://unused-test-ledger.invalid/test' },
      });
      const diagnostic = JSON.stringify(result);
      expect(result.stdout, diagnostic).toContain('managed task preflight passed');
      expect(result.stderr, diagnostic).toContain('NATIVE_MANAGER_PREFLIGHT_REACHED');
      expect(result.stdout).not.toContain('booting throwaway PG');
    });

  it('refuses an owned socket that cannot serve the private manager before PostgreSQL allocation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'private-task-unusable-'));
    mkdirSync(join(directory, 'systemd'));
    // A real socket and native systemd client exercise the refusal boundary.
    // Ownership and pathname existence alone do not establish a manager route.
    const server = createServer(socket => socket.destroy());
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(join(directory, 'systemd', 'private'), resolveListen);
    });
    const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--managed-tasks', '--', process.execPath, '-e', 'process.exit(91)'], {
      cwd: root, env: { ...process.env, XDG_RUNTIME_DIR: directory,
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/unused-desktop-bus',
        PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://unused-test-ledger.invalid/test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = once(child, 'close');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [status, signal] = await closed;
      const diagnostic = JSON.stringify({ status, signal, stdout, stderr });
      expect(status, diagnostic).toBe(1);
      expect(signal, diagnostic).toBeNull();
      expect(stderr, diagnostic).toContain('private runtime scope probe exited');
      expect(stdout).not.toContain('booting throwaway PG');
      expect(stdout).not.toContain('managed task preflight passed');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await new Promise<void>(done => server.close(() => done()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'regular-file'])('refuses a %s manager socket before PostgreSQL allocation', kind => {
    const directory = mkdtempSync(join(tmpdir(), 'private-task-preflight-'));
    if (kind === 'regular-file') {
      mkdirSync(join(directory, 'systemd'));
      writeFileSync(join(directory, 'systemd', 'private'), 'not a socket');
    }
    try {
      const startedAt = performance.now();
      const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--managed-tasks', '--', process.execPath, '-e', 'process.exit(91)'], {
        cwd: root, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, XDG_RUNTIME_DIR: directory, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/unused-desktop-bus',
          PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://unused-test-ledger.invalid/test' },
      });
      const diagnostic = childDiagnostic(result, startedAt);
      expect(result.status, diagnostic).toBe(1);
      expect(result.stderr, diagnostic).toContain('managed task preflight failed');
      if (kind === 'regular-file') expect(result.stderr).toContain('must be an owned socket');
      expect(result.stdout).not.toContain('booting throwaway PG');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('requires an isolated runtime for an explicit managed task route', () => {
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--managed-tasks', '--', process.execPath, '-e', 'process.exit(91)'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, childDiagnostic(result, startedAt)).toBe(2);
    expect(result.stderr).toContain('isolated runtime only');
    expect(result.stdout).not.toContain('booting throwaway PG');
  });
});

describe('PostgreSQL bootstrap import boundary', () => {
  it.each(['ordinary', 'isolated'])('reaches the %s child preflight without loading runtime or browser bootstrap dependencies', mode => {
    const entry = join(root, 'scripts/with-test-pg.mjs');
    const refusedModules = ['libs/test-config/src/pg-container.ts', 'libs/test-config/src/tmpdir-guard.ts',
      'packages/operator-core/lib/fleet/process-group-lifetime.ts',
      'libs/generic/verification-harness/src/evidence-root.ts'];
    const hook = `export async function load(url, context, nextLoad) {
      if (${JSON.stringify(refusedModules)}.some(path => url.endsWith('/' + path))) {
        throw new Error('RUNTIME_BOOTSTRAP_IMPORT_REFUSED: ' + url);
      }
      return nextLoad(url, context);
    }`;
    const script = `
      import Module from 'node:module';
      import { register } from 'node:module';
      console.error('BOOTSTRAP_PREFLIGHT_STAGE:entry');
      register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hook))});
      console.error('BOOTSTRAP_PREFLIGHT_STAGE:guard-ready');
      const compile = Module.prototype._compile;
      Module.prototype._compile = function (content, filename) {
        if (filename.endsWith('/scripts/lib/playwright-temp-directory.cjs')) {
          throw new Error('BROWSER_COMMONJS_BOOTSTRAP_REFUSED');
        }
        return compile.call(this, content, filename);
      };
      process.argv = [process.execPath, ${JSON.stringify(entry)},
        ...${JSON.stringify(mode === 'isolated' ? ['--isolated-runtime=operator-api'] : [])},
        '--', 'papercusp-missing-child-executable-browser-boundary'];
      console.error('BOOTSTRAP_PREFLIGHT_STAGE:launcher-import');
      await import(${JSON.stringify(pathToFileURL(entry).href)});
    `;
    const startedAt = performance.now();
    // Refusal is a builtin-only Node path. Install the guards before importing
    // the launcher, without first bootstrapping an unrelated transpiler.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://unused-test-ledger.invalid/test' },
    });
    const diagnostic = childDiagnostic(result, startedAt);
    expect(result.status, diagnostic).toBe(1);
    expect(result.stderr, diagnostic).toContain('BOOTSTRAP_PREFLIGHT_STAGE:guard-ready');
    expect(result.stderr, diagnostic).toContain('BOOTSTRAP_PREFLIGHT_STAGE:launcher-import');
    expect(result.stderr, diagnostic).toContain('child preflight failed');
    expect(result.stderr).not.toContain('RUNTIME_BOOTSTRAP_IMPORT_REFUSED');
    expect(result.stderr).not.toContain('BROWSER_COMMONJS_BOOTSTRAP_REFUSED');
    expect(result.stdout).not.toContain('booting throwaway PG');
  });
});

describe('private API bundle durable evidence preflight', () => {
  it.each(['PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PC_EXECUTED_SOURCE_MAP_RESULT', 'PC_EXECUTED_SOURCE_MAP_OUT'])(
    'refuses %s without a ledger sink before compiling the API', receiptKey => {
      const directory = mkdtempSync(join(tmpdir(), 'private-api-ledger-'));
      const marker = join(directory, 'compiled');
      mkdirSync(join(directory, 'apps/operator/bin'), { recursive: true });
      writeFileSync(join(directory, 'apps/operator/bin/bundle-host.sh'),
        'touch "' + marker + '"\nprintf "private test bundle" > "$2"\n');
      const prior = process.env[receiptKey];
      const ledger = process.env.PAPERCUSP_TEST_RUNS_DB_URL;
      process.env[receiptKey] = '/tmp/private-api-receipt';
      delete process.env.PAPERCUSP_TEST_RUNS_DB_URL;
      try {
        expect(() => preparePrivateOperatorApiBundle(directory, directory)).toThrow(
          'PAPERCUSP_TEST_RUNS_DB_URL is required for durable isolated test receipts');
        expect(existsSync(marker)).toBe(false);
      } finally {
        if (prior === undefined) delete process.env[receiptKey]; else process.env[receiptKey] = prior;
        if (ledger === undefined) delete process.env.PAPERCUSP_TEST_RUNS_DB_URL; else process.env.PAPERCUSP_TEST_RUNS_DB_URL = ledger;
        rmSync(directory, { recursive: true, force: true });
      }
    });

  it('retains the prepared bundle when a reporter-only ledger sink is explicit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'private-api-ledger-'));
    mkdirSync(join(directory, 'apps/operator/bin'), { recursive: true });
    writeFileSync(join(directory, 'apps/operator/bin/bundle-host.sh'), 'printf "private test bundle" > "$2"\n');
    const prior = process.env.PC_EXECUTED_SOURCE_MAP_RESULT;
    const ledger = process.env.PAPERCUSP_TEST_RUNS_DB_URL;
    process.env.PC_EXECUTED_SOURCE_MAP_RESULT = '/tmp/private-api-receipt';
    process.env.PAPERCUSP_TEST_RUNS_DB_URL = 'postgresql://unused-test-ledger.invalid/test';
    try {
      expect(preparePrivateOperatorApiBundle(directory, directory)).toMatchObject({
        path: join(directory, 'hono-host.mjs'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(existsSync(join(directory, 'operator-api-preflight.json'))).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.PC_EXECUTED_SOURCE_MAP_RESULT; else process.env.PC_EXECUTED_SOURCE_MAP_RESULT = prior;
      if (ledger === undefined) delete process.env.PAPERCUSP_TEST_RUNS_DB_URL; else process.env.PAPERCUSP_TEST_RUNS_DB_URL = ledger;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('isolated PostgreSQL durable evidence preflight', () => {
  describe.each(['--isolated-runtime', '--isolated-runtime=operator-api'])(
    'shared-ledger workspace admission (%s)', mode => {
      it.each(['missing', 'blank', 'whitespace'] as const)(
        'refuses %s caller attribution before allocating private state', kind => {
          const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://unused.invalid/evidence' };
          for (const key of ['PAPERCUSP_TEST_RUN_WORKSPACE', 'PAPERCUSP_WORKSPACE_ID', 'PAPERCUSP_WORKSPACE']) delete env[key];
          if (kind !== 'missing') {
            env.PAPERCUSP_TEST_RUN_WORKSPACE = kind === 'blank' ? '' : '  ';
            env.PAPERCUSP_WORKSPACE_ID = 'valid-fallback-must-not-hide-invalid-pin';
          }
          const startedAt = performance.now();
          const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), mode,
            '--', 'papercusp-missing-workspace-preflight-child'], {
            cwd: root, env, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
          });
          const diagnostic = childDiagnostic(result, startedAt);
          expect(result.status, diagnostic).toBe(1);
          expect(result.stderr, diagnostic).toContain('isolated shared-ledger runs require a nonblank caller workspace');
          expect(result.stderr).not.toContain('child preflight failed');
          expect(result.stdout).not.toContain('booting throwaway PG');
        });
    });

  describe.each([{ mode: [] }, { mode: ['--isolated-runtime'] },
    { mode: ['--isolated-runtime=operator-api'] }])('explicit sink validation ($mode)', ({ mode }) => {
    it.each(['[object Object]', 'postgresql://fixture:redact-me@[broken/evidence',
      'https://fixture:redact-me@unused.invalid/evidence'])(
      'refuses malformed or non-PostgreSQL sink %j before bootstrapping', sink => {
        const startedAt = performance.now();
        const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), ...mode,
          '--', process.execPath, '-e', 'process.exit(91)'], {
          cwd: root, env: { ...process.env, PAPERCUSP_TEST_RUNS_DB_URL: sink },
          encoding: 'utf8', timeout: 5000, stdio: 'pipe',
        });
        const diagnostic = childDiagnostic(result, startedAt);
        expect(result.status, diagnostic).toBe(1);
        expect(result.stderr, diagnostic).toContain('PAPERCUSP_TEST_RUNS_DB_URL must be a valid PostgreSQL URL');
        expect(result.stderr).not.toContain(sink);
        expect(result.stderr).not.toContain('redact-me');
        expect(result.stdout).not.toContain('booting throwaway PG');
      });
  });

  it.each(['postgres://unused.invalid/evidence', ' postgresql://unused.invalid/evidence ',
    'postgresql:///evidence?host=/tmp/owned-pg'])(
    'accepts a valid explicit sink %j through the next preflight without connecting', sink => {
      const startedAt = performance.now();
      const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--',
        'papercusp-missing-evidence-preflight-child'], {
        cwd: root, env: { ...process.env, PAPERCUSP_TEST_RUNS_DB_URL: sink },
        encoding: 'utf8', timeout: 5000, stdio: 'pipe',
      });
      const diagnostic = childDiagnostic(result, startedAt);
      expect(result.status, diagnostic).toBe(1);
      expect(result.stderr, diagnostic).toContain('child preflight failed');
      expect(result.stderr).not.toContain('evidence preflight failed');
      expect(result.stdout).not.toContain('booting throwaway PG');
    });

  it.each(['', '  '])('refuses an explicitly blank sink before allocating ordinary PostgreSQL (%j)', sink => {
    const env = { ...process.env, PAPERCUSP_TEST_RUNS_DB_URL: sink };
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--', process.execPath, '-e', 'process.exit(91)'], {
      cwd: root, env, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    });
    const diagnostic = childDiagnostic(result, startedAt);
    expect(result.status, diagnostic).toBe(1);
    expect(result.stderr, diagnostic).toContain('PAPERCUSP_TEST_RUNS_DB_URL must not be blank');
    expect(result.stdout).not.toContain('booting throwaway PG');
  });

  describe.each([{ mode: [] }, { mode: ['--isolated-runtime'] },
    { mode: ['--isolated-runtime=operator-api'] }])('durable receipts ($mode)', ({ mode }) => {
    it.each(['PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PC_EXECUTED_SOURCE_MAP_RESULT',
      'PC_EXECUTED_SOURCE_MAP_OUT'])('requires a reporter-only sink for %s before allocating PostgreSQL', receiptKey => {
      const env = { ...process.env, [receiptKey]: '/tmp/unwritten-private-ledger-receipt' };
      delete env.PAPERCUSP_TEST_RUNS_DB_URL;
      const startedAt = performance.now();
      const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), ...mode,
        '--', process.execPath, '-e', 'process.exit(91)'], {
        cwd: root, env, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
      });
      const diagnostic = childDiagnostic(result, startedAt);
      expect(result.status, diagnostic).toBe(1);
      expect(result.stderr, diagnostic).toContain('PAPERCUSP_TEST_RUNS_DB_URL is required for durable test receipts');
      expect(result.stdout).not.toContain('booting throwaway PG');
    });

    it('accepts requested receipts with an explicit sink through the next preflight', () => {
      const startedAt = performance.now();
      const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), ...mode,
        '--', 'papercusp-missing-durable-receipt-child'], {
        cwd: root, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
        env: { ...process.env, PAPERCUSP_TEST_RUN_RECEIPT_FILE: '/tmp/unwritten-private-ledger-receipt',
          PC_EXECUTED_SOURCE_MAP_RESULT: '/tmp/unwritten-private-source-result',
          PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/unwritten-private-source-map',
          PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://unused.invalid/evidence' },
      });
      const diagnostic = childDiagnostic(result, startedAt);
      expect(result.status, diagnostic).toBe(1);
      expect(result.stderr, diagnostic).toContain('child preflight failed');
      expect(result.stderr).not.toContain('evidence preflight failed');
      expect(result.stdout).not.toContain('booting throwaway PG');
    });
  });

  it('allows ordinary runs without durable receipts to reach the next preflight without a sink', () => {
    const env = { ...process.env };
    for (const key of ['PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PC_EXECUTED_SOURCE_MAP_RESULT',
      'PC_EXECUTED_SOURCE_MAP_OUT', 'PAPERCUSP_TEST_RUNS_DB_URL']) delete env[key];
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--',
      'papercusp-missing-ordinary-child'], { cwd: root, env, encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    const diagnostic = childDiagnostic(result, startedAt);
    expect(result.status, diagnostic).toBe(1);
    expect(result.stderr, diagnostic).toContain('child preflight failed');
    expect(result.stderr).not.toContain('evidence preflight failed');
    expect(result.stdout).not.toContain('booting throwaway PG');
  });
});

describe('private PostgreSQL child executable preflight', () => {
  it.each(['missing-name', 'missing-relative', 'directory', 'non-executable'])('refuses %s before allocating PostgreSQL', kind => {
    const directory = mkdtempSync(join(tmpdir(), 'pg-child-preflight-'));
    const file = join(directory, 'not-executable');
    writeFileSync(file, 'not a command', { mode: 0o600 });
    const command = kind === 'missing-name' ? 'papercusp-missing-child-executable-0f38' :
      kind === 'missing-relative' ? './papercusp-missing-relative-executable-0f38' :
        kind === 'directory' ? directory : file;
    try {
      const startedAt = performance.now();
      const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--', command], {
        cwd: join(root, 'packages/operator-core'), encoding: 'utf8', timeout: 5000, stdio: 'pipe',
      });
      const diagnostic = childDiagnostic(result, startedAt);
      expect(result.status, diagnostic).toBe(1);
      expect(result.stderr, diagnostic).toContain('child preflight failed');
      expect(result.stdout).not.toContain('booting throwaway PG');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
