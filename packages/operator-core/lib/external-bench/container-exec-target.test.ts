/**
 * container-exec-target.test.ts — benchmark-coverage-frontierswe-v2-2026-10-10 D-026 / P-006.
 *
 * Executes the GENERATED wrapper (not string assertions on its source) against a fake
 * `docker` that records the argv and environment it received, so these pin what the
 * wrapper actually does when psu runs it as `codex`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  CONTAINER_CODEX_BIN_PATH,
  materializeDockerExecWrapper,
  renderDockerExecWrapper,
  validateDockerExecTarget,
  type DockerExecTarget,
} from './container-exec-target';

const target: DockerExecTarget = {
  kind: 'docker-exec',
  containerId: '3f2a9c1b7d4e',
  workdir: '/app',
  binPath: CONTAINER_CODEX_BIN_PATH,
};

let root: string;
let fakeDocker: string;
let argvLog: string;
let envLog: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cexec-test-'));
  argvLog = join(root, 'argv.log');
  envLog = join(root, 'env.log');
  fakeDocker = join(root, 'fake-docker');
  // One argv element per line, then the values docker would read for two forwarded names.
  writeFileSync(
    fakeDocker,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvLog}'\nprintf '%s\\n%s\\n' "$CODEX_HOME" "$PAPERCUSP_TOKEN" > '${envLog}'\nexit "\${FAKE_DOCKER_EXIT:-0}"\n`,
    { mode: 0o755 },
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function runWrapper(args: string[], env: Record<string, string>) {
  const { wrapperPath } = materializeDockerExecWrapper(target, { dir: mkdtempSync(join(root, 'w-')), dockerBin: fakeDocker });
  const r = spawnSync(wrapperPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
  const argv = readFileSync(argvLog, 'utf8').split('\n').slice(0, -1);
  return { r, argv, wrapperPath };
}

describe('validateDockerExecTarget', () => {
  it.each([
    ['a shell-metacharacter container id', { containerId: 'abc;rm -rf /' }],
    ['an empty container id', { containerId: '' }],
    ['a relative workdir', { workdir: 'app' }],
    ['a relative binPath', { binPath: 'codex' }],
  ])('refuses %s', (_label, patch) => {
    expect(() => validateDockerExecTarget({ ...target, ...patch })).toThrow(/container exec target/);
  });

  it('accepts a docker id or name with an absolute workdir and binPath', () => {
    expect(() => validateDockerExecTarget(target)).not.toThrow();
    expect(() => validateDockerExecTarget({ ...target, containerId: 'fswe-task_1.run-2' })).not.toThrow();
  });
});

describe('materializeDockerExecWrapper', () => {
  it('writes an executable named after the agent, so psu still applies --no-daemon', () => {
    const { wrapperPath } = materializeDockerExecWrapper(target, { dir: mkdtempSync(join(root, 'm-')) });
    expect(basename(wrapperPath)).toBe('codex');
    expect(statSync(wrapperPath).mode & 0o111).not.toBe(0);
    expect(readFileSync(wrapperPath, 'utf8').startsWith('#!')).toBe(true);
  });

  it('renders deterministically for the same inputs', () => {
    expect(renderDockerExecWrapper(target, { nodeBin: '/usr/bin/node' })).toBe(
      renderDockerExecWrapper(target, { nodeBin: '/usr/bin/node' }),
    );
  });
});

describe('the generated wrapper, executed', () => {
  const env = {
    CODEX_HOME: '/home/u/.papercusp/codex-homes/s1',
    OPENAI_BASE_URL: 'http://gateway.invalid/v1',
    PAPERCUSP_TOKEN: 'secret-token-value',
    PAPERCUSP_BACKEND_BIN_CODEX: '/tmp/papercusp-cexec-x/codex',
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    UNRELATED_SECRET: 'do-not-forward',
  };

  it('execs the container CLI in the workdir, forwarding allowlisted env by NAME only', () => {
    const { r, argv } = runWrapper(['exec', '--json', 'two words'], env);
    expect(r.status).toBe(0);
    expect(argv).toEqual([
      'exec',
      '-i',
      '-w',
      '/app',
      '-e',
      'CODEX_HOME',
      '-e',
      'OPENAI_BASE_URL',
      '-e',
      'PAPERCUSP_TOKEN',
      target.containerId,
      CONTAINER_CODEX_BIN_PATH,
      'exec',
      '--json',
      'two words',
    ]);
    // Values never reach argv; docker reads them from the inherited environment.
    expect(argv).not.toContain('secret-token-value');
    expect(readFileSync(envLog, 'utf8').split('\n').slice(0, 2)).toEqual([env.CODEX_HOME, env.PAPERCUSP_TOKEN]);
  });

  it('never forwards PATH, HOME, the override key, or non-allowlisted names', () => {
    const { argv } = runWrapper([], env);
    for (const name of ['PATH', 'HOME', 'PAPERCUSP_BACKEND_BIN_CODEX', 'UNRELATED_SECRET']) {
      expect(argv).not.toContain(name);
    }
  });

  it('does not request a TTY when stdin is a pipe', () => {
    const { argv } = runWrapper([], env);
    expect(argv).not.toContain('-t');
  });

  it("exits with the container CLI's exit code", () => {
    const { r } = runWrapper(['exec'], { ...env, FAKE_DOCKER_EXIT: '7' });
    expect(r.status).toBe(7);
  });

  it('exits 127 with a diagnosis when docker cannot be run', () => {
    const { wrapperPath } = materializeDockerExecWrapper(target, {
      dir: mkdtempSync(join(root, 'nod-')),
      dockerBin: join(root, 'no-such-docker'),
    });
    const r = spawnSync(wrapperPath, [], { env, encoding: 'utf8' });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/papercusp container-exec: cannot run/);
  });
});
