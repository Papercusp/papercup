/**
 * EI-21546829012278002 / D-105: the generated root bootstrap executes eleven
 * fixed release paths. A Server sidecar with only Node + the remote initializer
 * therefore cannot install, migrate, start, attest, or launch an agent even if
 * every pre-publication trust gate is green.
 *
 * These tests execute the maintained overlay against a scratch sidecar and
 * cover both its build integration and its fail-closed wrapper behavior. The
 * real Server is never started; in particular, serve.mjs --help is never used
 * as a probe because that entrypoint treats it as a normal boot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const LIB_DIR = import.meta.dirname ?? __dirname;
const REPO_ROOT = join(LIB_DIR, '..', '..', '..');
const INSTALLER = join(
  REPO_ROOT,
  'papercusp-desktop/bin/install-workspace-host-entrypoints.sh',
);
const BUILDER = join(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh');
const VERIFIER = join(REPO_ROOT, 'papercusp-desktop/bin/verify-sidecar-bundle.sh');
const scratchRoots: string[] = [];

const ENTRYPOINTS = [
  'papercusp-install',
  'papercusp-rollback',
  'node',
  'papercusp-migrate',
  'papercusp-server',
  'papercusp-health',
  'psu',
  'claude',
  'codex',
  'omp',
  'papercusp-remote-initializer',
] as const;
const PG_TOOLS = ['pg_dump', 'psql', 'pg_dumpall', 'pg_restore'] as const;

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-workspace-host-entrypoints-'));
  scratchRoots.push(root);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'db-sql'), { recursive: true });
  const pgNative = join(
    root,
    'node_modules/@papercusp/embedded-postgres-server/node_modules/@embedded-postgres/linux-x64/native/bin',
  );
  mkdirSync(pgNative, { recursive: true });
  symlinkSync(process.execPath, join(root, 'bin/node'));
  for (const tool of PG_TOOLS) {
    writeFileSync(join(pgNative, tool), `#!/usr/bin/env bash\nprintf '${tool} 18.6\\n'\n`);
    chmodSync(join(pgNative, tool), 0o755);
    symlinkSync(
      `/tmp/deleted-sidecar.tmp.238817/node_modules/@papercusp/embedded-postgres-server/node_modules/@embedded-postgres/linux-x64/native/bin/${tool}`,
      join(root, 'bin', tool),
    );
  }
  writeFileSync(
    join(root, 'serve.mjs'),
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(process.env.PC_ENTRYPOINT_OUTPUT, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`,
  );
  writeFileSync(
    join(root, 'scripts/psu.mjs'),
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(process.env.PC_ENTRYPOINT_OUTPUT, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`,
  );
  writeFileSync(join(root, 'db-sql/000-baseline.sql'), 'select 1;\n');
  writeFileSync(join(root, 'bin/papercusp-remote-initializer'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(root, 'bin/papercusp-remote-initializer'), 0o755);
  writeFileSync(
    join(root, 'build-provenance.json'),
    `${JSON.stringify({ version: '2026.8.26-1', buildSha: 'a'.repeat(40), artifacts: [] })}\n`,
  );
  return root;
}

function run(path: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(path, [...args], { encoding: 'utf8', env });
}

function install(root: string) {
  const result = run('bash', [INSTALLER, '--release-root', root]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace-host sidecar entrypoint producer', () => {
  it('fails closed when a real delegate is absent', () => {
    const root = makeFixture();
    rmSync(join(root, 'scripts/psu.mjs'));
    const result = run('bash', [INSTALLER, '--release-root', root]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('scripts/psu.mjs');
    expect(existsSync(join(root, 'bin/papercusp-server'))).toBe(false);
  });

  it('emits all eleven executable paths without replacing Node or the initializer', () => {
    const root = makeFixture();
    const nodeTarget = readlinkSync(join(root, 'bin/node'));
    const initializer = readFileSync(join(root, 'bin/papercusp-remote-initializer'), 'utf8');
    install(root);
    for (const name of ENTRYPOINTS) {
      expect(run('test', ['-x', join(root, 'bin', name)]).status, name).toBe(0);
    }
    expect(readlinkSync(join(root, 'bin/node'))).toBe(nodeTarget);
    expect(readFileSync(join(root, 'bin/papercusp-remote-initializer'), 'utf8')).toBe(initializer);
    for (const tool of PG_TOOLS) {
      const target = readlinkSync(join(root, 'bin', tool));
      expect(target.startsWith('/'), tool).toBe(false);
      expect(target).toContain(`/native/bin/${tool}`);
      expect(run(join(root, 'bin', tool), ['--version']).status, tool).toBe(0);
    }
  });

  it('is invoked for future vm-release builds before prune and finished-bundle verification', () => {
    const builder = readFileSync(BUILDER, 'utf8');
    const emit = builder.indexOf('bash "$HERE/install-workspace-host-entrypoints.sh"');
    const prune = builder.indexOf('--prune-vm-release', emit);
    const verify = builder.indexOf('"$ROOT/bin/verify-sidecar-bundle.sh"', prune);
    expect(emit).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(emit);
    expect(verify).toBeGreaterThan(prune);
    expect(builder.slice(emit - 400, emit)).toContain('DISTRIBUTION_PROFILE');
    expect(builder).toContain('ln -sfn "../$_pg_rel_src"');
    expect(builder).toContain('re-verifying atomically published sidecar at its final path');
  });

  it('makes the finished-bundle verifier require and allowlist every generated wrapper', () => {
    const verifier = readFileSync(VERIFIER, 'utf8');
    for (const name of ENTRYPOINTS.filter((entry) => entry !== 'node')) {
      expect(verifier, name).toContain(name);
    }
    expect(verifier).toContain('install-workspace-host-entrypoints.sh');
  });
});

describe('workspace-host entrypoint behavior', () => {
  it('validates install, rollback, and migration contracts without inventing a second runner', () => {
    const root = makeFixture();
    install(root);
    const state = join(root, 'state');
    const previous = join(root, 'previous');
    mkdirSync(state);
    mkdirSync(join(previous, 'bin'), { recursive: true });
    writeFileSync(join(previous, 'bin/papercusp-server'), '#!/usr/bin/env bash\n');
    chmodSync(join(previous, 'bin/papercusp-server'), 0o755);

    expect(
      run(join(root, 'bin/papercusp-install'), [
        '--action', 'install', '--release-root', root, '--state-root', state,
      ]).status,
    ).toBe(0);
    expect(
      run(join(root, 'bin/papercusp-install'), [
        '--action', 'unknown', '--release-root', root, '--state-root', state,
      ]).status,
    ).not.toBe(0);
    expect(
      run(join(root, 'bin/papercusp-rollback'), [
        '--from', previous, '--to', root, '--state-root', state,
      ]).status,
    ).toBe(0);
    expect(
      run(join(root, 'bin/papercusp-migrate'), [
        '--database-root', state, '--migration-id', 'migration-2026.08.26',
      ]).status,
    ).toBe(0);
    expect(
      run(join(root, 'bin/papercusp-migrate'), [
        '--database-root', state, '--migration-id', '../unsafe',
      ]).status,
    ).not.toBe(0);
  });

  it('maps bootstrap env names, pins immutable runtime policy, and refuses the unsafe help probe', () => {
    const root = makeFixture();
    install(root);
    const output = join(root, 'server-output.json');
    const pgRoot = join(root, 'pgdata');
    mkdirSync(pgRoot);
    const env = {
      ...process.env,
      PC_ENTRYPOINT_OUTPUT: output,
      PAPERCUSP_PORT: '4107',
      PAPERCUSP_EMBEDDED_PG_ROOT: pgRoot,
    };
    const result = run(join(root, 'bin/papercusp-server'), [], env);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(readFileSync(output, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(observed.argv).toEqual([]);
    expect(observed.env.PAPERCUSP_HONO_PORT).toBe('4107');
    expect(observed.env.PAPERCUSP_PG_DATA_DIR).toBe(pgRoot);
    expect(observed.env.PAPERCUSP_PG_SQL_DIR).toBe(join(root, 'db-sql'));
    expect(observed.env.PAPERCUSP_SIDECAR_BIN).toBe(join(root, 'bin'));
    expect(observed.env.PAPERCUSP_BUILD_VERSION).toBe('2026.8.26-1');
    expect(observed.env.PAPERCUSP_BUILD_SHA).toBe('a'.repeat(40));
    expect(observed.env.PAPERCUSP_DISTRIBUTION_PROFILE).toBe('vm-release');
    expect(observed.env.PAPERCUSP_PROVISION_ENV_OPERATORS).toBe('0');

    rmSync(output);
    const help = run(join(root, 'bin/papercusp-server'), ['--help'], env);
    expect(help.status).not.toBe(0);
    expect(help.stderr).toContain('no side-effect-free help mode');
    expect(existsSync(output)).toBe(false);
  });

  it('delegates psu and agent wrappers through the shipped launcher with a pinned backend', () => {
    const root = makeFixture();
    install(root);
    const output = join(root, 'psu-output.json');
    const env = { ...process.env, PC_ENTRYPOINT_OUTPUT: output };

    expect(run(join(root, 'bin/psu'), ['--help'], env).status).toBe(0);
    let observed = JSON.parse(readFileSync(output, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(observed.argv).toEqual(['--help']);
    expect(observed.env.PAPERCUSP_SIDECAR_BIN).toBe(join(root, 'bin'));

    expect(run(join(root, 'bin/claude'), ['--no-picker'], env).status).toBe(0);
    observed = JSON.parse(readFileSync(output, 'utf8'));
    expect(observed.argv).toEqual(['--agent=claude', '--no-picker']);
    expect(run(join(root, 'bin/claude'), ['--agent=codex'], env).status).not.toBe(0);
  });

  it('retries the bounded loopback health probe and rejects non-loopback targets', () => {
    const root = makeFixture();
    install(root);
    const fakeBin = join(root, 'fake-bin');
    const countFile = join(root, 'curl-count');
    const argsFile = join(root, 'curl-args');
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'curl'),
      '#!/usr/bin/env bash\n' +
        'n=0; [[ ! -f "$PC_CURL_COUNT_FILE" ]] || n="$(cat "$PC_CURL_COUNT_FILE")"\n' +
        'n=$((n + 1)); printf "%s" "$n" > "$PC_CURL_COUNT_FILE"\n' +
        'printf "%s\\n" "$*" > "$PC_CURL_ARGS_FILE"\n' +
        '[[ "$n" -ge 2 ]]\n',
    );
    chmodSync(join(fakeBin, 'curl'), 0o755);
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PC_CURL_COUNT_FILE: countFile,
      PC_CURL_ARGS_FILE: argsFile,
      PAPERCUSP_HEALTH_TIMEOUT_SEC: '4',
    };
    const health = run(
      join(root, 'bin/papercusp-health'),
      ['--host', '127.0.0.1', '--port', '4107'],
      env,
    );
    expect(health.status, health.stderr).toBe(0);
    expect(readFileSync(countFile, 'utf8')).toBe('2');
    expect(readFileSync(argsFile, 'utf8')).toContain('http://127.0.0.1:4107/api/health');
    expect(
      run(join(root, 'bin/papercusp-health'), ['--host', '0.0.0.0', '--port', '4107'], env)
        .status,
    ).not.toBe(0);
  });
});
