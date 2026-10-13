/**
 * container-exec-target.ts — run a benchmark arm's agent CLI INSIDE a task container
 * (benchmark-coverage-frontierswe-v2-2026-10-10 D-026, P-006).
 *
 * The maintained launch adapter (capability:launch-agent → headless psu) stays on the
 * host: prompt, MCP surface, gateway accounting and carry-respawn are unchanged. Only
 * the agent CLI process moves. psu resolves the CLI through resolveBackendLaunch, which
 * honours a per-launch override env (backendBinOverrideEnvKey, e.g.
 * PAPERCUSP_BACKEND_BIN_CODEX). This module writes the executable that override points
 * at: a host-side node script named after the agent that `docker exec`s the
 * container's copy of the CLI in the task's working directory, so the CLI's tools and
 * apply_patch act on the container filesystem the task verifier scores.
 *
 * Properties the wrapper guarantees (pinned by container-exec-target.test.ts):
 *   - argv carries env NAMES only (`-e NAME`); docker reads each value from the
 *     wrapper's own environment, so secrets never appear in a process listing.
 *   - only names matching the forward patterns cross into the container, and the
 *     never-forward set (PATH, HOME, the override keys themselves) never does.
 *   - `-t` is requested only when stdin AND stdout are TTYs (psu-pty vs a pipe).
 *   - the CLI's exit code (or terminating signal) is the wrapper's.
 *   - the file is named after the agent (`codex`), so psu's codexManagedDaemonArgs
 *     still adds `--no-daemon` and the CLI runs in-process inside the container.
 *
 * Killing the docker client does not kill the process inside the container; the bench
 * seam's teardown (`docker rm -f`) owns that.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { backendBinOverrideEnvKey, resolveBackendLaunch } from '../backend-bin-resolve.mjs';

export interface DockerExecTarget {
  kind: 'docker-exec';
  /** Container id or name, as `docker run -d` returned it. */
  containerId: string;
  /** Working directory inside the container (FrontierSWE tasks: /app). */
  workdir: string;
  /** Absolute path of the agent CLI inside the container. */
  binPath: string;
}

/** Where the bench seam mounts the static musl Codex CLI inside a task container (D-026 step 1). */
export const CONTAINER_CODEX_BIN_PATH = '/opt/papercusp/codex';

const MUSL_TARGETS: Record<string, { pkg: string; triple: string }> = {
  x64: { pkg: 'codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  arm64: { pkg: 'codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
};

/**
 * The static musl Codex binary that ships inside the SAME `@openai/codex` install the
 * host psu resolves (D-026: "the same version the host psu resolves"). The musl build
 * is self-contained, so it runs in any Linux task image. Throws naming every searched
 * path when the install has no musl build for this arch.
 */
export function resolveContainerCodexBinary(
  opts: { env?: NodeJS.ProcessEnv; arch?: string } = {},
): string {
  const env = { ...(opts.env ?? process.env) };
  delete env[backendBinOverrideEnvKey('codex')];
  const target = MUSL_TARGETS[opts.arch ?? process.arch];
  if (!target) throw new Error(`container codex: no musl Codex build is published for arch ${opts.arch ?? process.arch}`);
  const launch = resolveBackendLaunch('codex', { env });
  if (!launch) throw new Error('container codex: no host codex install found (resolveBackendLaunch returned null)');
  let dir = dirname(realpathSync(launch.bin));
  let pkgRoot: string | null = null;
  for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name === '@openai/codex') {
          pkgRoot = dir;
          break;
        }
      } catch {
        /* not the package we want */
      }
    }
  }
  if (!pkgRoot) throw new Error(`container codex: ${launch.bin} is not inside an @openai/codex npm install`);
  const rel = join('vendor', target.triple, 'bin', 'codex');
  const candidates = [
    join(pkgRoot, 'node_modules', '@openai', target.pkg, rel),
    join(dirname(pkgRoot), target.pkg, rel),
    join(pkgRoot, rel),
  ];
  for (const c of candidates) {
    try {
      const st = statSync(c);
      if (st.isFile() && (st.mode & 0o111) !== 0) return c;
    } catch {
      /* try the next layout */
    }
  }
  throw new Error(`container codex: no executable musl build found; searched ${candidates.join(', ')}`);
}

/** Env names (regex sources) the wrapper forwards into the container. */
export const DEFAULT_FORWARD_ENV_PATTERNS: readonly string[] = [
  '^CODEX_',
  '^OPENAI_',
  '^PAPERCUSP_',
  '^RUST_LOG$',
  '^NO_COLOR$',
  '^TERM$',
  '^COLORTERM$',
  '^LANG$',
  '^LC_',
];

/** Env names (regex sources) that never cross, even when a forward pattern matches. */
export const NEVER_FORWARD_ENV_PATTERNS: readonly string[] = ['^PATH$', '^HOME$', '^PAPERCUSP_BACKEND_BIN_'];

const CONTAINER_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Throws on a target the wrapper could not execute safely. */
export function validateDockerExecTarget(target: DockerExecTarget): void {
  if (target.kind !== 'docker-exec') throw new Error(`container exec target: unsupported kind ${JSON.stringify(target.kind)}`);
  if (!CONTAINER_REF.test(target.containerId)) {
    throw new Error(`container exec target: containerId ${JSON.stringify(target.containerId)} is not a docker container id or name`);
  }
  if (!isAbsolute(target.workdir)) throw new Error(`container exec target: workdir must be absolute, got ${JSON.stringify(target.workdir)}`);
  if (!isAbsolute(target.binPath)) throw new Error(`container exec target: binPath must be absolute, got ${JSON.stringify(target.binPath)}`);
}

export interface RenderWrapperOptions {
  /** docker CLI the wrapper execs. Default 'docker' (resolved on the wrapper's PATH). */
  dockerBin?: string;
  /** Interpreter for the wrapper's shebang. Default: this process's node when its path has no whitespace. */
  nodeBin?: string;
  forwardEnvPatterns?: readonly string[];
  neverForwardEnvPatterns?: readonly string[];
}

function shebangFor(nodeBin: string | undefined): string {
  const candidate = nodeBin ?? process.execPath;
  return /\s/.test(candidate) || !isAbsolute(candidate) ? '#!/usr/bin/env node' : `#!${candidate}`;
}

/** The wrapper's source text. Pure: same inputs, same bytes. */
export function renderDockerExecWrapper(target: DockerExecTarget, opts: RenderWrapperOptions = {}): string {
  validateDockerExecTarget(target);
  const cfg = {
    dockerBin: opts.dockerBin ?? 'docker',
    containerId: target.containerId,
    workdir: target.workdir,
    binPath: target.binPath,
    forward: [...(opts.forwardEnvPatterns ?? DEFAULT_FORWARD_ENV_PATTERNS)],
    never: [...(opts.neverForwardEnvPatterns ?? NEVER_FORWARD_ENV_PATTERNS)],
  };
  return `${shebangFor(opts.nodeBin)}
// Generated by papercusp external-bench/container-exec-target.ts (benchmark-coverage-frontierswe-v2 D-026).
// Runs the agent CLI inside a task container. Do not edit; regenerate.
'use strict';
const { spawn } = require('node:child_process');
const cfg = ${JSON.stringify(cfg)};
const forward = cfg.forward.map((s) => new RegExp(s));
const never = cfg.never.map((s) => new RegExp(s));
const names = Object.keys(process.env)
  .filter((k) => forward.some((r) => r.test(k)) && !never.some((r) => r.test(k)))
  .sort();
const argv = ['exec', '-i'];
if (process.stdin.isTTY && process.stdout.isTTY) argv.push('-t');
argv.push('-w', cfg.workdir);
for (const n of names) argv.push('-e', n);
argv.push(cfg.containerId, cfg.binPath, ...process.argv.slice(2));
const child = spawn(cfg.dockerBin, argv, { stdio: 'inherit' });
const relay = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const sig of relay) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on('error', (e) => {
  process.stderr.write('papercusp container-exec: cannot run ' + cfg.dockerBin + ': ' + e.message + '\\n');
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (signal) {
    for (const sig of relay) process.removeAllListeners(sig);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code == null ? 1 : code);
});
`;
}

export interface MaterializeWrapperOptions extends RenderWrapperOptions {
  /** Directory to write into. Default: a fresh mkdtemp under the OS temp dir. */
  dir?: string;
  /** File name = the agent psu resolves. Default 'codex'. */
  agent?: string;
}

/** Write the wrapper as an executable `<dir>/<agent>` and return its absolute path. */
export function materializeDockerExecWrapper(
  target: DockerExecTarget,
  opts: MaterializeWrapperOptions = {},
): { dir: string; wrapperPath: string } {
  const agent = opts.agent ?? 'codex';
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) throw new Error(`container exec target: invalid agent name ${JSON.stringify(agent)}`);
  const source = renderDockerExecWrapper(target, opts);
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'papercusp-cexec-'));
  const wrapperPath = join(dir, agent);
  writeFileSync(wrapperPath, source, { mode: 0o755 });
  chmodSync(wrapperPath, 0o755);
  return { dir, wrapperPath };
}
