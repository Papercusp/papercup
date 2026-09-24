/**
 * `pui --connect` hands the terminal to psu's connection front controller
 * (plan pui-first-party-public-release-2026-09-07 P-017 / D-025).
 *
 * Runs the ACTUAL `pui` binary with a recording stub `psu` first on PATH and
 * asserts, from outside the process, the exact argv psu receives, that psu's
 * exit status becomes pui's, and that pui refuses instead of launching anything
 * when psu is missing or when it is itself the program psu forwarded to a
 * remote host. What psu then does with `--connect-program=pui` is covered by
 * apps/operator/scripts/psu-connection-front-controller.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensurePuiBinary } from './pui-binary';

const STUB_EXIT = 7;
let pui = '';
let root = '';
let stubDir = '';
let emptyDir = '';

beforeAll(() => {
  pui = ensurePuiBinary();
  root = mkdtempSync(path.join(tmpdir(), 'pui-remote-connect-'));
  stubDir = path.join(root, 'bin');
  emptyDir = path.join(root, 'empty');
  for (const dir of [stubDir, emptyDir]) mkdirSync(dir, { recursive: true });
  const stub = path.join(stubDir, 'psu');
  writeFileSync(
    stub,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$STUB_OUT"',
      'echo "FORWARDED=${PAPERCUSP_PSU_CONNECTION_FORWARDED-unset}" >> "$STUB_OUT"',
      `exit ${STUB_EXIT}`,
    ].join('\n'),
  );
  chmodSync(stub, 0o755);
}, 900_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function runPui(args: string[], env: Record<string, string> = {}) {
  const out = path.join(root, `stub-${Math.random().toString(36).slice(2)}.out`);
  const result = spawnSync(pui, args, {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      HOME: root,
      PATH: `${stubDir}:/usr/bin:/bin`,
      STUB_OUT: out,
      ...env,
    },
  });
  const psuArgv = existsSync(out) ? readFileSync(out, 'utf8').trimEnd().split('\n') : null;
  return { status: result.status, stderr: result.stderr, psuArgv };
}

describe('pui --connect hands off to psu (P-017)', () => {
  test('psu receives the program selector and the whole command line, and its exit status becomes pui’s', () => {
    const run = runPui(['--fleet=f', '--connect=cloud/ws-1', 'workbench', '--seat=s']);
    expect(run.psuArgv).toEqual([
      '--connect-program=pui',
      '--fleet=f',
      '--connect=cloud/ws-1',
      'workbench',
      '--seat=s',
      'FORWARDED=unset',
    ]);
    expect(run.status).toBe(STUB_EXIT);

    // The split form and psu's other connection verbs hand off too.
    expect(runPui(['--connect', 'cloud']).psuArgv?.slice(0, 3)).toEqual([
      '--connect-program=pui',
      '--connect',
      'cloud',
    ]);
    expect(runPui(['--connect-list']).psuArgv?.slice(0, 2)).toEqual([
      '--connect-program=pui',
      '--connect-list',
    ]);
  });

  test('without a --connect cell pui stays local and never runs psu', () => {
    const help = runPui(['--help']);
    expect(help.status).toBe(0);
    expect(help.psuArgv).toBeNull();
    // `--` closes psu's namespace, exactly as it does for psu itself.
    const passthrough = runPui(['--version', '--', '--connect=x']);
    expect(passthrough.status).toBe(0);
    expect(passthrough.psuArgv).toBeNull();
  });

  test('refuses with a next step when psu is not on PATH', () => {
    const run = runPui(['--connect=cloud'], { PATH: emptyDir });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('`psu` is not on PATH');
    expect(run.psuArgv).toBeNull();
  });

  test('a pui that psu already forwarded to a remote host refuses to connect onward', () => {
    const run = runPui(['--connect'], { PAPERCUSP_PSU_CONNECTION_FORWARDED: '1' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('already running on a remote host');
    expect(run.psuArgv).toBeNull();
  });
});
