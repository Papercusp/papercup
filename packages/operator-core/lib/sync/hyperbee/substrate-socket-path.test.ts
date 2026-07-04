import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveSubstrateSocketPath,
  pinSubstrateSocketForCluster,
  SUBSTRATE_SOCKET_ENV,
} from './substrate-socket-path';

const ORIG = process.env[SUBSTRATE_SOCKET_ENV];
afterEach(() => {
  if (ORIG === undefined) delete process.env[SUBSTRATE_SOCKET_ENV];
  else process.env[SUBSTRATE_SOCKET_ENV] = ORIG;
});

describe('resolveSubstrateSocketPath (P-006)', () => {
  it('honours PAPERCUSP_SUBSTRATE_IPC_SOCKET when set (so spawner + client + child agree)', () => {
    process.env[SUBSTRATE_SOCKET_ENV] = '/run/papercusp/substrate.sock';
    expect(resolveSubstrateSocketPath()).toBe('/run/papercusp/substrate.sock');
  });

  it('ignores an empty/whitespace env value and falls back to the absolute default', () => {
    process.env[SUBSTRATE_SOCKET_ENV] = '   ';
    const p = resolveSubstrateSocketPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });

  it('defaults to an ABSOLUTE tmpdir path keyed by pid — never the CWD-relative .papercusp that EACCES-failed on a packaged root-owned CWD', () => {
    delete process.env[SUBSTRATE_SOCKET_ENV];
    const p = resolveSubstrateSocketPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toBe(path.join(os.tmpdir(), `papercusp-substrate-${process.pid}.sock`));
    // The exact regression: must NOT be a bare/relative `.papercusp/...` path.
    expect(p.startsWith('.papercusp')).toBe(false);
    expect(p).not.toBe(path.join('.papercusp', 'substrate.sock'));
  });
});

describe('pinSubstrateSocketForCluster (WI-1879 — cross-fork socket-path pinning)', () => {
  it('single-process mode (clusterWorkers<=1): no-op, does NOT touch env', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(pinSubstrateSocketForCluster(1, env)).toEqual({});
    expect(env[SUBSTRATE_SOCKET_ENV]).toBeUndefined();
    expect(pinSubstrateSocketForCluster(0, env)).toEqual({});
  });

  it('true-cluster mode (clusterWorkers>1) with no prior env: pins an absolute tmpdir path keyed by THIS (primary) pid, mutates env, and returns the same fragment for workerEnv', () => {
    const env: NodeJS.ProcessEnv = {};
    const frag = pinSubstrateSocketForCluster(4, env);
    const expected = path.join(os.tmpdir(), `papercusp-substrate-${process.pid}.sock`);
    expect(env[SUBSTRATE_SOCKET_ENV]).toBe(expected);
    expect(frag).toEqual({ [SUBSTRATE_SOCKET_ENV]: expected });
  });

  it('honors an existing env override (e.g. systemd-pinned socket) rather than deriving a fresh one', () => {
    const env: NodeJS.ProcessEnv = { [SUBSTRATE_SOCKET_ENV]: '/run/papercusp/substrate.sock' };
    const frag = pinSubstrateSocketForCluster(3, env);
    expect(frag).toEqual({ [SUBSTRATE_SOCKET_ENV]: '/run/papercusp/substrate.sock' });
    expect(env[SUBSTRATE_SOCKET_ENV]).toBe('/run/papercusp/substrate.sock');
  });

  it('ignores an empty/whitespace existing env value and derives fresh, matching resolveSubstrateSocketPath\'s own fallback', () => {
    const env: NodeJS.ProcessEnv = { [SUBSTRATE_SOCKET_ENV]: '   ' };
    const frag = pinSubstrateSocketForCluster(2, env);
    const expected = path.join(os.tmpdir(), `papercusp-substrate-${process.pid}.sock`);
    expect(frag).toEqual({ [SUBSTRATE_SOCKET_ENV]: expected });
  });

  it('the pinned value is exactly what resolveSubstrateSocketPath() resolves once applied to process.env (the cross-process agreement this exists for)', () => {
    const frag = pinSubstrateSocketForCluster(2, process.env);
    try {
      expect(resolveSubstrateSocketPath()).toBe(frag[SUBSTRATE_SOCKET_ENV]);
    } finally {
      delete process.env[SUBSTRATE_SOCKET_ENV];
    }
  });
});
