import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveSubstrateSocketPath,
  pinSubstrateSocketForCluster,
  reapOrphanedSubstrateSockets,
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

describe('reapOrphanedSubstrateSockets (EI-7832 — dead-pid orphaned socket cleanup)', () => {
  it('removes socket files whose pid is confirmed dead and keeps ones whose pid is alive', () => {
    const unlinked: string[] = [];
    const result = reapOrphanedSubstrateSockets({
      tmpdir: '/tmp/fake',
      listDir: () => ['papercusp-substrate-111.sock', 'papercusp-substrate-222.sock', 'not-a-socket.txt'],
      isAlive: (pid) => pid === 222, // 111 dead, 222 alive
      unlink: (p) => {
        unlinked.push(p);
      },
      ownPid: 999,
    });
    expect(result.removed).toEqual(['/tmp/fake/papercusp-substrate-111.sock']);
    expect(result.kept).toEqual(['/tmp/fake/papercusp-substrate-222.sock']);
    expect(unlinked).toEqual(['/tmp/fake/papercusp-substrate-111.sock']);
    expect(result.errors).toEqual([]);
  });

  it('never touches its OWN socket file, even if isAlive would (wrongly) report it dead', () => {
    const result = reapOrphanedSubstrateSockets({
      tmpdir: '/tmp/fake',
      listDir: () => ['papercusp-substrate-500.sock'],
      isAlive: () => false,
      unlink: () => {
        throw new Error('should never be called for our own socket');
      },
      ownPid: 500,
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(['/tmp/fake/papercusp-substrate-500.sock']);
  });

  it('records an unlink failure as an error without aborting the sweep of the remaining files', () => {
    const result = reapOrphanedSubstrateSockets({
      tmpdir: '/tmp/fake',
      listDir: () => ['papercusp-substrate-1.sock', 'papercusp-substrate-2.sock'],
      isAlive: () => false,
      unlink: (p) => {
        if (p.endsWith('-1.sock')) throw new Error('EACCES');
      },
      ownPid: 999,
    });
    expect(result.removed).toEqual(['/tmp/fake/papercusp-substrate-2.sock']);
    expect(result.errors).toEqual([{ path: '/tmp/fake/papercusp-substrate-1.sock', error: 'EACCES' }]);
  });

  it('treats a liveness check that throws EPERM (alive but owned by another user) as ALIVE — never deletes', () => {
    const result = reapOrphanedSubstrateSockets({
      tmpdir: '/tmp/fake',
      listDir: () => ['papercusp-substrate-42.sock'],
      isAlive: () => {
        const e = new Error('perm') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      },
      unlink: () => {
        throw new Error('should never be called');
      },
      ownPid: 999,
    });
    expect(result.kept).toEqual(['/tmp/fake/papercusp-substrate-42.sock']);
    expect(result.removed).toEqual([]);
    expect(result.errors.length).toBe(1);
  });

  it('ignores files that do not match the papercusp-substrate-<pid>.sock naming pattern', () => {
    const result = reapOrphanedSubstrateSockets({
      tmpdir: '/tmp/fake',
      listDir: () => ['random.sock', 'papercusp-substrate-abc.sock', 'papercusp-substrate-1.sock.bak'],
      isAlive: () => false,
      unlink: () => {},
      ownPid: 999,
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it('a listDir failure (e.g. tmpdir unreadable) is reported as an error and never throws', () => {
    const result = reapOrphanedSubstrateSockets({
      tmpdir: '/tmp/fake',
      listDir: () => {
        throw new Error('ENOENT: no such directory');
      },
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.errors).toEqual([{ path: '/tmp/fake', error: 'ENOENT: no such directory' }]);
  });

  it('the default isAlive (real process.kill(pid,0)) reports the CURRENT process as alive, so its own file is kept even when forced through the isAlive path', () => {
    const result = reapOrphanedSubstrateSockets({
      tmpdir: '/tmp/fake',
      listDir: () => [`papercusp-substrate-${process.pid}.sock`],
      ownPid: -1, // force it through the isAlive check, not the own-pid skip
      unlink: () => {
        throw new Error('should never be called — this pid IS alive');
      },
    });
    expect(result.kept).toEqual([`/tmp/fake/papercusp-substrate-${process.pid}.sock`]);
    expect(result.removed).toEqual([]);
  });
});
