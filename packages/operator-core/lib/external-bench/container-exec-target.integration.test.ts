/**
 * container-exec-target.integration.test.ts — benchmark-coverage-frontierswe-v2-2026-10-10 D-026 / P-006.
 *
 * Real docker, real alpine container, no network. Pins the chain psu will run:
 * resolveBackendLaunch('codex') honours the per-launch override → the generated
 * wrapper → `docker exec` → a process INSIDE the container, in the task workdir, with
 * only allowlisted env. The last case runs the static musl Codex resolved from the
 * host install, mounted where the FrontierSWE seam mounts it.
 *
 * Requires docker and the local `alpine` image (repo convention: integration suites
 * need Docker). Run: npm run test:file -- <this file>
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backendBinOverrideEnvKey, resolveBackendLaunch } from '../backend-bin-resolve.mjs';
import {
  CONTAINER_CODEX_BIN_PATH,
  materializeDockerExecWrapper,
  resolveContainerCodexBinary,
} from './container-exec-target';

const containers: string[] = [];
let root: string;

function startContainer(extra: string[] = []): string {
  const id = execFileSync('docker', ['run', '-d', '--network', 'none', ...extra, 'alpine', 'sleep', '300'], {
    encoding: 'utf8',
  }).trim();
  containers.push(id);
  return id;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cexec-int-'));
  execFileSync('docker', ['image', 'inspect', 'alpine'], { stdio: 'ignore' });
});

afterAll(() => {
  if (containers.length) spawnSync('docker', ['rm', '-f', ...containers], { stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
});

describe('container exec target against a live container', () => {
  it('resolveBackendLaunch picks the wrapper, which runs inside the container in the workdir', () => {
    const cid = startContainer();
    const { wrapperPath } = materializeDockerExecWrapper(
      { kind: 'docker-exec', containerId: cid, workdir: '/tmp', binPath: '/bin/sh' },
      { dir: mkdtempSync(join(root, 'w-')) },
    );
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      CODEX_HOME: '/codex-home-from-host',
      UNRELATED_SECRET: 'must-not-cross',
      [backendBinOverrideEnvKey('codex')]: wrapperPath,
    };
    const launch = resolveBackendLaunch('codex', { env });
    expect(launch?.bin).toBe(wrapperPath);
    const r = spawnSync(
      launch!.bin,
      ['-c', 'pwd; hostname; printf "%s|%s\\n" "$CODEX_HOME" "${UNRELATED_SECRET:-unset}"'],
      { env, encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['/tmp', cid.slice(0, 12), '/codex-home-from-host|unset']);
  });

  it("returns the in-container process's exit code", () => {
    const cid = startContainer();
    const { wrapperPath } = materializeDockerExecWrapper(
      { kind: 'docker-exec', containerId: cid, workdir: '/', binPath: '/bin/sh' },
      { dir: mkdtempSync(join(root, 'x-')) },
    );
    const r = spawnSync(wrapperPath, ['-c', 'exit 5'], { env: { PATH: process.env.PATH ?? '' } });
    expect(r.status).toBe(5);
  });

  it('runs the musl Codex from the host install, mounted read-only at the seam path, with no network', () => {
    const musl = resolveContainerCodexBinary();
    const cid = startContainer(['-v', `${musl}:${CONTAINER_CODEX_BIN_PATH}:ro`]);
    const { wrapperPath } = materializeDockerExecWrapper(
      { kind: 'docker-exec', containerId: cid, workdir: '/', binPath: CONTAINER_CODEX_BIN_PATH },
      { dir: mkdtempSync(join(root, 'c-')) },
    );
    const r = spawnSync(wrapperPath, ['--version'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/codex-cli \d+\.\d+\.\d+/);
  });
});
