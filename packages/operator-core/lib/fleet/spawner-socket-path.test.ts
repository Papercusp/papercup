import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSpawnerSocketPath, SPAWNER_SOCKET_ENV } from './spawner-socket-path';

// Mirror of sync/hyperbee/substrate-socket-path.test.ts for the SPAWNER sidecar
// (WI-344 ③, plan spawner-sidecar-offload-2026-06-30 P-001/P-006). Guards the
// exact packaged-deploy regression the substrate sidecar hit: a CWD-relative
// `.papercusp/*.sock` default `mkdir`s against a root-owned install dir → EACCES →
// silent in-process fallback, so the offload never engages off a dev tree.
const ORIG = process.env[SPAWNER_SOCKET_ENV];
afterEach(() => {
  if (ORIG === undefined) delete process.env[SPAWNER_SOCKET_ENV];
  else process.env[SPAWNER_SOCKET_ENV] = ORIG;
});

describe('resolveSpawnerSocketPath (WI-344 ③)', () => {
  it('honours PAPERCUSP_SPAWNER_IPC_SOCKET when set (so spawner + client + child agree)', () => {
    process.env[SPAWNER_SOCKET_ENV] = '/run/papercusp/spawner.sock';
    expect(resolveSpawnerSocketPath()).toBe('/run/papercusp/spawner.sock');
  });

  it('ignores an empty/whitespace env value and falls back to the absolute default', () => {
    process.env[SPAWNER_SOCKET_ENV] = '   ';
    const p = resolveSpawnerSocketPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });

  it('defaults to an ABSOLUTE tmpdir path keyed by pid — never the CWD-relative .papercusp that EACCES-failed on a packaged root-owned CWD', () => {
    delete process.env[SPAWNER_SOCKET_ENV];
    const p = resolveSpawnerSocketPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toBe(path.join(os.tmpdir(), `papercusp-spawner-${process.pid}.sock`));
    // The exact regression: must NOT be a bare/relative `.papercusp/...` path.
    expect(p.startsWith('.papercusp')).toBe(false);
    expect(p).not.toBe(path.join('.papercusp', 'spawner.sock'));
  });

  it('trims a surrounding-whitespace env value to the bare path', () => {
    process.env[SPAWNER_SOCKET_ENV] = '  /tmp/x/spawner.sock  ';
    expect(resolveSpawnerSocketPath()).toBe('/tmp/x/spawner.sock');
  });
});
